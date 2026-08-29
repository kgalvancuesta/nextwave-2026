import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CallEvent,
  CallRecord,
  CommitmentProposal,
  CommitmentRecord,
  CommitmentStatus,
  MandateDecision,
  Operation,
  OperationInput,
} from "../domain/models.js";
import type { StateStore } from "../ports.js";

type Row = Record<string, unknown>;

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  createOperation(input: OperationInput): Operation {
    const operation: Operation = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO operations (id, external_reference, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(operation.id, operation.externalReference, JSON.stringify(input), operation.createdAt);
    return operation;
  }

  getOperation(id: string): Operation | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toOperation(row) : null;
  }

  findOperationByReference(reference: string): Operation | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE external_reference = ?").get(reference) as Row | undefined;
    return row ? this.toOperation(row) : null;
  }

  getOperationSnapshot(id: string) {
    const operation = this.getOperation(id);
    if (!operation) return null;

    const calls = (this.db.prepare("SELECT * FROM calls WHERE operation_id = ? ORDER BY started_at").all(id) as Row[])
      .map((row) => this.toCall(row));
    const commitments = (this.db.prepare("SELECT * FROM commitments WHERE operation_id = ? ORDER BY created_at").all(id) as Row[])
      .map((row) => this.toCommitment(row));
    const events = (this.db.prepare(`
      SELECT events.* FROM events
      JOIN calls ON calls.id = events.call_id
      WHERE calls.operation_id = ?
      ORDER BY events.occurred_at
    `).all(id) as Row[]).map((row) => this.toEvent(row));
    return { operation, calls, commitments, events };
  }

  createCall(input: Omit<CallRecord, "id" | "startedAt" | "endedAt">): CallRecord {
    const call: CallRecord = {
      ...input,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.db.prepare(`
      INSERT INTO calls (
        id, operation_id, direction, counterparty, status, provider_call_id,
        realtime_call_id, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.id,
      call.operationId,
      call.direction,
      call.counterparty,
      call.status,
      call.providerCallId,
      call.realtimeCallId,
      call.startedAt,
      call.endedAt,
    );
    return call;
  }

  getCall(id: string): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toCall(row) : null;
  }

  findCallByRealtimeId(realtimeCallId: string): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE realtime_call_id = ?").get(realtimeCallId) as Row | undefined;
    return row ? this.toCall(row) : null;
  }

  attachCallToOperation(callId: string, operationId: string): void {
    this.db.prepare("UPDATE calls SET operation_id = ? WHERE id = ?").run(operationId, callId);
  }

  updateCall(id: string, patch: Partial<Pick<CallRecord, "status" | "providerCallId" | "realtimeCallId" | "endedAt">>): void {
    const current = this.getCall(id);
    if (!current) throw new Error(`Call not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE calls SET status = ?, provider_call_id = ?, realtime_call_id = ?, ended_at = ?
      WHERE id = ?
    `).run(next.status, next.providerCallId, next.realtimeCallId, next.endedAt, id);
  }

  appendEvent(callId: string, type: string, payload: unknown): CallEvent {
    const event: CallEvent = {
      id: randomUUID(),
      callId,
      type,
      payload,
      occurredAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO events (id, call_id, type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.callId, event.type, JSON.stringify(event.payload), event.occurredAt);
    return event;
  }

  createCommitment(input: {
    operationId: string;
    callId: string;
    proposal: CommitmentProposal;
    decision: MandateDecision;
  }): CommitmentRecord {
    const record: CommitmentRecord = {
      ...input.proposal,
      id: randomUUID(),
      operationId: input.operationId,
      callId: input.callId,
      status: "proposed",
      mandateDecision: input.decision,
      recapDeliveryId: null,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO commitments (
        id, operation_id, call_id, status, proposal, mandate_decision, recap_delivery_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.operationId,
      record.callId,
      record.status,
      JSON.stringify(input.proposal),
      JSON.stringify(input.decision),
      null,
      record.createdAt,
    );
    return record;
  }

  listPendingCommitments(callId: string): CommitmentRecord[] {
    return (this.db.prepare("SELECT * FROM commitments WHERE call_id = ? AND status IN ('proposed', 'recap_failed')").all(callId) as Row[])
      .map((row) => this.toCommitment(row));
  }

  updateCommitment(id: string, status: CommitmentStatus, recapDeliveryId?: string): void {
    this.db.prepare("UPDATE commitments SET status = ?, recap_delivery_id = ? WHERE id = ?")
      .run(status, recapDeliveryId ?? null, id);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        external_reference TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        operation_id TEXT REFERENCES operations(id),
        direction TEXT NOT NULL,
        counterparty TEXT,
        status TEXT NOT NULL,
        provider_call_id TEXT,
        realtime_call_id TEXT UNIQUE,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES calls(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(id),
        call_id TEXT NOT NULL REFERENCES calls(id),
        status TEXT NOT NULL,
        proposal TEXT NOT NULL,
        mandate_decision TEXT NOT NULL,
        recap_delivery_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calls_operation_idx ON calls(operation_id);
      CREATE INDEX IF NOT EXISTS events_call_idx ON events(call_id);
      CREATE INDEX IF NOT EXISTS commitments_call_idx ON commitments(call_id);
    `);
  }

  private toOperation(row: Row): Operation {
    const input = JSON.parse(String(row.payload)) as OperationInput;
    return { ...input, id: String(row.id), createdAt: String(row.created_at) };
  }

  private toCall(row: Row): CallRecord {
    return {
      id: String(row.id),
      operationId: row.operation_id === null ? null : String(row.operation_id),
      direction: row.direction as CallRecord["direction"],
      counterparty: row.counterparty === null ? null : String(row.counterparty),
      status: row.status as CallRecord["status"],
      providerCallId: row.provider_call_id === null ? null : String(row.provider_call_id),
      realtimeCallId: row.realtime_call_id === null ? null : String(row.realtime_call_id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
    };
  }

  private toCommitment(row: Row): CommitmentRecord {
    const proposal = JSON.parse(String(row.proposal)) as CommitmentProposal;
    return {
      ...proposal,
      id: String(row.id),
      operationId: String(row.operation_id),
      callId: String(row.call_id),
      status: row.status as CommitmentStatus,
      mandateDecision: JSON.parse(String(row.mandate_decision)) as MandateDecision,
      recapDeliveryId: row.recap_delivery_id === null ? null : String(row.recap_delivery_id),
      createdAt: String(row.created_at),
    };
  }

  private toEvent(row: Row): CallEvent {
    return {
      id: String(row.id),
      callId: String(row.call_id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload)) as unknown,
      occurredAt: String(row.occurred_at),
    };
  }
}
