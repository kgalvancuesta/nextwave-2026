import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { callStatusRank, isTerminalCallStatus } from "./call-status";
import { getDatabase } from "./db";
import type { CallRecord, CallStatus, Contact, RecordingRecord } from "./types";

type Row = Record<string, unknown>;

export class MarketlineRepository {
  constructor(private readonly db: Database.Database) {}

  listContacts(): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts ORDER BY label COLLATE NOCASE").all() as Row[]).map(toContact);
  }

  getContact(id: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
    return row ? toContact(row) : null;
  }

  getContactByE164PhoneNumber(e164PhoneNumber: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE e164_phone_number = ?")
      .get(e164PhoneNumber) as Row | undefined;
    return row ? toContact(row) : null;
  }

  getContacts(ids: string[]): Contact[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`).all(...ids) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), toContact(row)]));
    return ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  }

  createContact(input: { label: string; phoneInput: string; e164PhoneNumber: string; note?: string | null }): Contact {
    const now = new Date().toISOString();
    const contact: Contact = {
      id: randomUUID(),
      label: input.label,
      phoneInput: input.phoneInput,
      e164PhoneNumber: input.e164PhoneNumber,
      note: input.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO contacts (
      id, label, phone_input, e164_phone_number, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      contact.id, contact.label, contact.phoneInput, contact.e164PhoneNumber,
      contact.note, contact.createdAt, contact.updatedAt,
    );
    return contact;
  }

  updateContact(id: string, input: { label: string; phoneInput: string; e164PhoneNumber: string; note?: string | null }): Contact | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE contacts
      SET label = ?, phone_input = ?, e164_phone_number = ?, note = ?, updated_at = ?
      WHERE id = ?`).run(input.label, input.phoneInput, input.e164PhoneNumber, input.note?.trim() || null, now, id);
    return result.changes === 0 ? null : this.getContact(id);
  }

  deleteContact(id: string): boolean {
    return this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
  }

  createOutboundBatch(
    contacts: Contact[],
    fromNumber: string,
    context?: { orderId: string; marketId: string },
  ): { batchId: string; calls: CallRecord[] } {
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const calls = contacts.map((contact): CallRecord => ({
      id: randomUUID(),
      twilioCallSid: null,
      batchId,
      contactId: contact.id,
      contactLabel: contact.label,
      orderId: context?.orderId || null,
      marketId: context?.marketId || null,
      carrierId: context ? contact.id : null,
      direction: "OUTBOUND",
      fromNumber,
      toNumber: contact.e164PhoneNumber,
      status: "REQUESTED",
      startedAt: now,
      answeredAt: null,
      completedAt: null,
      durationSeconds: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }));

    this.db.transaction(() => {
      this.db.prepare("INSERT INTO call_batches (id, created_at) VALUES (?, ?)").run(batchId, now);
      const insert = this.db.prepare(`INSERT INTO calls (
        id, twilio_call_sid, batch_id, contact_id, order_id, market_id, carrier_id, direction, from_number, to_number,
        status, status_rank, started_at, answered_at, completed_at, duration_seconds,
        error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const call of calls) {
        insert.run(
          call.id, null, batchId, call.contactId, call.orderId, call.marketId, call.carrierId,
          call.direction, call.fromNumber, call.toNumber,
          call.status, 0, call.startedAt, null, null, null, null, null, call.createdAt, call.updatedAt,
        );
      }
    })();
    return { batchId, calls };
  }

  setOutboundCallInitiated(callId: string, twilioCallSid: string): CallRecord {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE calls SET twilio_call_sid = ?,
      status = CASE WHEN status_rank < 1 THEN 'INITIATED' ELSE status END,
      status_rank = CASE WHEN status_rank < 1 THEN 1 ELSE status_rank END,
      updated_at = ? WHERE id = ?`).run(twilioCallSid, now, callId);
    this.synchronizeMarketCallState(callId, "INITIATED", "REQUESTED");
    return this.getCall(callId)!;
  }

  attachTwilioSidIfMissing(callId: string, twilioCallSid: string): CallRecord | null {
    const call = this.getCall(callId);
    if (!call) return null;
    if (call.twilioCallSid && call.twilioCallSid !== twilioCallSid) {
      throw new Error(`Call ${callId} is already associated with a different Twilio Call SID.`);
    }
    if (!call.twilioCallSid) {
      this.db.prepare("UPDATE calls SET twilio_call_sid = ?, updated_at = ? WHERE id = ?")
        .run(twilioCallSid, new Date().toISOString(), callId);
    }
    return this.getCall(callId);
  }

  setOutboundCallFailed(callId: string, errorCode: string | null, errorMessage: string): CallRecord {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE calls SET status = 'FAILED', status_rank = 4, completed_at = ?,
      error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`)
      .run(now, errorCode, errorMessage, now, callId);
    this.synchronizeMarketCallState(callId, "FAILED", "REQUESTED");
    return this.getCall(callId)!;
  }

  getCall(id: string): CallRecord | null {
    const row = this.db.prepare(`SELECT calls.*, contacts.id AS resolved_contact_id, contacts.label AS contact_label
      FROM calls LEFT JOIN contacts ON contacts.id = calls.contact_id OR (
        calls.contact_id IS NULL AND calls.direction = 'INBOUND' AND contacts.e164_phone_number = calls.from_number
      ) WHERE calls.id = ?`).get(id) as Row | undefined;
    return row ? toCall(row) : null;
  }

  getCallByTwilioSid(twilioCallSid: string): CallRecord | null {
    const row = this.db.prepare(`SELECT calls.*, contacts.id AS resolved_contact_id, contacts.label AS contact_label
      FROM calls LEFT JOIN contacts ON contacts.id = calls.contact_id OR (
        calls.contact_id IS NULL AND calls.direction = 'INBOUND' AND contacts.e164_phone_number = calls.from_number
      ) WHERE calls.twilio_call_sid = ?`)
      .get(twilioCallSid) as Row | undefined;
    return row ? toCall(row) : null;
  }

  listCalls(limit = 100): CallRecord[] {
    return (this.db.prepare(`SELECT calls.*, contacts.id AS resolved_contact_id, contacts.label AS contact_label
      FROM calls LEFT JOIN contacts ON contacts.id = calls.contact_id OR (
        calls.contact_id IS NULL AND calls.direction = 'INBOUND' AND contacts.e164_phone_number = calls.from_number
      )
      ORDER BY calls.created_at DESC LIMIT ?`).all(limit) as Row[]).map(toCall);
  }

  listCallsForMarket(marketId: string): CallRecord[] {
    return (this.db.prepare(`SELECT calls.*, contacts.id AS resolved_contact_id, contacts.label AS contact_label
      FROM calls LEFT JOIN contacts ON contacts.id = calls.contact_id OR (
        calls.contact_id IS NULL AND calls.direction = 'INBOUND' AND contacts.e164_phone_number = calls.from_number
      )
      WHERE calls.market_id = ? ORDER BY calls.created_at DESC`).all(marketId) as Row[]).map(toCall);
  }

  listCallsForVoltaOperation(operationId: string): CallRecord[] {
    return (this.db.prepare(`SELECT calls.*, contacts.id AS resolved_contact_id, contacts.label AS contact_label
      FROM calls LEFT JOIN contacts ON contacts.e164_phone_number = calls.to_number
      WHERE calls.volta_operation_id = ? ORDER BY calls.created_at DESC`).all(operationId) as Row[]).map(toCall);
  }

  upsertInboundCall(input: {
    twilioCallSid: string;
    fromNumber: string;
    toNumber: string;
    contactId: string | null;
    status: CallStatus;
    rawPayload: Record<string, string>;
  }): CallRecord {
    const existing = this.getCallByTwilioSid(input.twilioCallSid);
    if (existing) {
      if (!existing.contactId && input.contactId) {
        this.db.prepare("UPDATE calls SET contact_id = ? WHERE id = ?").run(input.contactId, existing.id);
      }
      return this.updateCallStatus(input.twilioCallSid, input.status, input.rawPayload);
    }
    const now = new Date().toISOString();
    const terminal = isTerminalCallStatus(input.status);
    this.db.prepare(`INSERT INTO calls (
      id, twilio_call_sid, batch_id, contact_id, direction, from_number, to_number,
      status, status_rank, started_at, answered_at, completed_at, duration_seconds,
      error_code, error_message, raw_status_payload, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'INBOUND', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
      .run(
        randomUUID(), input.twilioCallSid, input.contactId, input.fromNumber, input.toNumber, input.status,
        callStatusRank(input.status), now, input.status === "IN_PROGRESS" ? now : null,
        terminal ? now : null, JSON.stringify(input.rawPayload), now, now,
      );
    return this.getCallByTwilioSid(input.twilioCallSid)!;
  }

  updateCallStatus(
    twilioCallSid: string,
    status: CallStatus,
    rawPayload: Record<string, string>,
    details: { durationSeconds?: number | null; errorCode?: string | null; errorMessage?: string | null } = {},
  ): CallRecord {
    const existing = this.getCallByTwilioSid(twilioCallSid);
    if (!existing) throw new Error(`Unknown Twilio Call SID: ${twilioCallSid}`);
    const oldRank = callStatusRank(existing.status);
    const newRank = callStatusRank(status);
    const shouldAdvance = newRank > oldRank || status === existing.status;
    const nextStatus = shouldAdvance ? status : existing.status;
    const now = new Date().toISOString();
    const answeredAt = existing.answeredAt ?? (nextStatus === "IN_PROGRESS" ? now : null);
    const completedAt = existing.completedAt ?? (isTerminalCallStatus(nextStatus) ? now : null);

    this.db.prepare(`UPDATE calls SET status = ?, status_rank = ?, answered_at = ?, completed_at = ?,
      duration_seconds = COALESCE(?, duration_seconds), error_code = COALESCE(?, error_code),
      error_message = COALESCE(?, error_message), raw_status_payload = ?, updated_at = ?
      WHERE twilio_call_sid = ?`).run(
        nextStatus, callStatusRank(nextStatus), answeredAt, completedAt,
        details.durationSeconds ?? null, details.errorCode ?? null, details.errorMessage ?? null,
        JSON.stringify(rawPayload), now, twilioCallSid,
      );
    this.synchronizeMarketCallState(existing.id, nextStatus, existing.status);
    return this.getCallByTwilioSid(twilioCallSid)!;
  }

  upsertRecording(input: {
    twilioRecordingSid: string;
    twilioCallSid: string;
    status: string;
    recordingUrl?: string | null;
    durationSeconds?: number | null;
    recordingStartTime?: string | null;
    rawPayload: Record<string, string>;
  }): RecordingRecord {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO recordings (
      id, twilio_recording_sid, twilio_call_sid, status, recording_url, duration_seconds,
      recording_start_time, raw_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(twilio_recording_sid) DO UPDATE SET
      status = excluded.status,
      recording_url = COALESCE(excluded.recording_url, recordings.recording_url),
      duration_seconds = COALESCE(excluded.duration_seconds, recordings.duration_seconds),
      recording_start_time = COALESCE(excluded.recording_start_time, recordings.recording_start_time),
      raw_payload = excluded.raw_payload,
      updated_at = excluded.updated_at`).run(
        randomUUID(), input.twilioRecordingSid, input.twilioCallSid, input.status,
        input.recordingUrl ?? null, input.durationSeconds ?? null, input.recordingStartTime ?? null,
        JSON.stringify(input.rawPayload), now, now,
      );
    const row = this.db.prepare("SELECT * FROM recordings WHERE twilio_recording_sid = ?")
      .get(input.twilioRecordingSid) as Row;
    return toRecording(row);
  }

  private synchronizeMarketCallState(callId: string, status: CallStatus, previousStatus: CallStatus) {
    const row = this.db.prepare("SELECT order_id, market_id, carrier_id FROM calls WHERE id = ?").get(callId) as Row | undefined;
    const marketId = nullableString(row?.market_id);
    const orderId = nullableString(row?.order_id);
    const carrierId = nullableString(row?.carrier_id);
    if (!marketId || !orderId || !carrierId) return;
    const now = new Date().toISOString();
    const carrierStatus = status === "IN_PROGRESS" ? "DISCOVERY"
      : ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(status) ? "FAILED"
        : isTerminalCallStatus(status) ? "COMPLETED" : "CALLING";
    this.db.prepare(`UPDATE market_carriers SET status = CASE
      WHEN status IN ('HUMAN', 'RELEASED', 'AWARDED') THEN status ELSE ? END, updated_at = ?
      WHERE market_id = ? AND carrier_id = ?`).run(carrierStatus, now, marketId, carrierId);
    if (status === "IN_PROGRESS" && previousStatus !== "IN_PROGRESS") {
      this.db.prepare(`INSERT INTO order_events (id, order_id, market_id, call_id, event_type, detail, created_at)
        VALUES (?, ?, ?, ?, 'CALL_ANSWERED', 'Carrier answered', ?)`).run(randomUUID(), orderId, marketId, callId, now);
    }
    const active = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM calls WHERE market_id = ?
      AND status IN ('REQUESTED', 'INITIATED', 'RINGING', 'IN_PROGRESS')`).get(marketId) as Row).count);
    const total = Number((this.db.prepare("SELECT COUNT(*) AS count FROM calls WHERE market_id = ?").get(marketId) as Row).count);
    if (total > 0 && active === 0) {
      this.db.prepare("UPDATE markets SET status = CASE WHEN status = 'CALLING' THEN 'OPEN' ELSE status END, updated_at = ? WHERE id = ?")
        .run(now, marketId);
    }
    if (status !== previousStatus) {
      this.db.prepare("UPDATE markets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, marketId);
    }
    this.db.prepare("UPDATE orders SET updated_at = ? WHERE id = ?").run(now, orderId);
  }
}

let repository: MarketlineRepository | undefined;

export function getRepository(): MarketlineRepository {
  repository ??= new MarketlineRepository(getDatabase());
  return repository;
}

function toContact(row: Row): Contact {
  return {
    id: String(row.id), label: String(row.label), phoneInput: String(row.phone_input),
    e164PhoneNumber: String(row.e164_phone_number), note: nullableString(row.note),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toCall(row: Row): CallRecord {
  return {
    id: String(row.id), twilioCallSid: nullableString(row.twilio_call_sid), batchId: nullableString(row.batch_id),
    contactId: nullableString(row.resolved_contact_id ?? row.contact_id), contactLabel: nullableString(row.contact_label),
    orderId: nullableString(row.order_id), marketId: nullableString(row.market_id), carrierId: nullableString(row.carrier_id),
    direction: row.direction as CallRecord["direction"], fromNumber: String(row.from_number),
    toNumber: String(row.to_number), status: row.status as CallStatus, startedAt: String(row.started_at),
    answeredAt: nullableString(row.answered_at), completedAt: nullableString(row.completed_at),
    durationSeconds: nullableNumber(row.duration_seconds), errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toRecording(row: Row): RecordingRecord {
  return {
    id: String(row.id), twilioRecordingSid: String(row.twilio_recording_sid),
    twilioCallSid: String(row.twilio_call_sid), status: String(row.status),
    recordingUrl: nullableString(row.recording_url), durationSeconds: nullableNumber(row.duration_seconds),
    recordingStartTime: nullableString(row.recording_start_time), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
