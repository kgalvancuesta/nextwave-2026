import "server-only";

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { callStatusRank } from "@/lib/call-status";
import { getDatabase } from "@/lib/db";
import { normalizeOrderReference, publicOrderReference } from "@/lib/market-types";
import type { CallStatus as TelephonyCallStatus } from "@/lib/types";
import type {
  CallEvent,
  CallPatch,
  CallRecord,
  CallStatus,
  CarrierMarket,
  CarrierMarketInput,
  CarrierMarketPatch,
  CarrierMarketSelection,
  CarrierQuote,
  CarrierQuoteInput,
  CommitmentProposal,
  CommitmentRecord,
  CommitmentStatus,
  CreateCallInput,
  MandateDecision,
  Operation,
  OperationInput,
} from "./models";
import type { StateStore } from "./ports";

type Row = Record<string, unknown>;

/**
 * The Volta layer shares the telephony ledger's `calls` table rather than
 * keeping a second one: the dashboard, the Twilio status callbacks and the
 * carrier market must all be looking at the same call. Twilio owns `status`
 * (what the phone leg is doing) and Volta owns `volta_status` (what the agent
 * session is doing). They describe different things, so both are kept.
 */
export class VoltaStore implements StateStore {
  constructor(private readonly db: Database.Database) {}

  createOperation(input: OperationInput): Operation {
    const operation: Operation = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO volta_operations (id, external_reference, payload, created_at)
      VALUES (?, ?, ?, ?)`)
      .run(operation.id, operation.externalReference, JSON.stringify(input), operation.createdAt);
    return operation;
  }

  getOperation(id: string): Operation | null {
    const row = this.db.prepare("SELECT * FROM volta_operations WHERE id = ?").get(id) as Row | undefined;
    return row ? toOperation(row) : null;
  }

  findOperationByReference(reference: string): Operation | null {
    const normalized = normalizeOrderReference(reference);
    if (!normalized) return null;

    const exactRows = this.db.prepare("SELECT * FROM volta_operations WHERE external_reference = ? COLLATE NOCASE")
      .all(reference.trim()) as Row[];
    if (exactRows.length === 1) return toOperation(exactRows[0]!);
    if (exactRows.length > 1) return null;

    const operationRows = this.db.prepare("SELECT * FROM volta_operations").all() as Row[];
    const directMatches = operationRows.filter((row) => normalizeOrderReference(String(row.external_reference)) === normalized);
    if (directMatches.length === 1) return toOperation(directMatches[0]!);
    if (directMatches.length > 1) return null;

    // Orders created before their voice operation used the internal order UUID
    // as external_reference. Keep those operations reachable through the public
    // order/reference number shown in the dashboard.
    const linkedRows = this.db.prepare(`SELECT volta_operations.*,
      orders.id AS linked_order_id, orders.reference AS linked_order_reference
      FROM orders JOIN volta_operations ON volta_operations.id = orders.volta_operation_id`).all() as Row[];
    const linkedMatches = linkedRows.filter((row) => normalizeOrderReference(publicOrderReference({
      id: String(row.linked_order_id),
      reference: nullableString(row.linked_order_reference),
    })) === normalized);
    return linkedMatches.length === 1 ? toOperation(linkedMatches[0]!) : null;
  }

  getOperationSnapshot(id: string) {
    const operation = this.getOperation(id);
    if (!operation) return null;

    const calls = (this.db.prepare("SELECT * FROM calls WHERE volta_operation_id = ? ORDER BY started_at").all(id) as Row[])
      .map(toCall);
    const commitments = (this.db.prepare("SELECT * FROM volta_commitments WHERE operation_id = ? ORDER BY created_at").all(id) as Row[])
      .map(toCommitment);
    const markets = this.listCarrierMarkets(id);
    const quotes = markets.flatMap((market) => this.listCarrierQuotes(market.id));
    const events = calls.length === 0 ? [] : (this.db.prepare(
      `SELECT * FROM volta_call_events WHERE call_id IN (${calls.map(() => "?").join(",")}) ORDER BY occurred_at`,
    ).all(...calls.map((call) => call.id)) as Row[]).map(toEvent);

    return { operation, calls, commitments, events, markets, quotes };
  }

  createCarrierMarket(input: CarrierMarketInput): CarrierMarket {
    const market: CarrierMarket = {
      ...input,
      id: randomUUID(),
      status: "open",
      selectedQuoteId: null,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    this.db.prepare(`INSERT INTO volta_markets (
      id, operation_id, status, candidates, selected_quote_id, created_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      market.id, market.operationId, market.status, JSON.stringify(market.candidates),
      market.selectedQuoteId, market.createdAt, market.closedAt,
    );
    return market;
  }

  getCarrierMarket(id: string): CarrierMarket | null {
    const row = this.db.prepare("SELECT * FROM volta_markets WHERE id = ?").get(id) as Row | undefined;
    return row ? toCarrierMarket(row) : null;
  }

  listCarrierMarkets(operationId: string): CarrierMarket[] {
    return (this.db.prepare("SELECT * FROM volta_markets WHERE operation_id = ? ORDER BY created_at")
      .all(operationId) as Row[]).map(toCarrierMarket);
  }

  updateCarrierMarket(id: string, patch: CarrierMarketPatch): CarrierMarket {
    const current = this.requireCarrierMarket(id);
    const next: CarrierMarket = {
      ...current,
      status: patch.status ?? current.status,
      closedAt: patch.closedAt === undefined ? current.closedAt : patch.closedAt,
    };

    if (next.status === "selected" && !next.selectedQuoteId) {
      throw new Error("A selected carrier market requires a selected quote");
    }
    if (next.status !== "selected" && next.selectedQuoteId) {
      throw new Error("Only a selected carrier market may have a selected quote");
    }

    this.db.prepare("UPDATE volta_markets SET status = ?, closed_at = ? WHERE id = ?")
      .run(next.status, next.closedAt, id);
    return this.requireCarrierMarket(id);
  }

  selectCarrierQuote(input: CarrierMarketSelection): CarrierMarket {
    const market = this.requireCarrierMarket(input.marketId);
    const quote = this.requireCarrierQuote(input.quoteId);
    if (quote.marketId !== market.id) {
      throw new Error(`Quote ${quote.id} does not belong to carrier market ${market.id}`);
    }
    if (market.selectedQuoteId === quote.id) return market;
    if (market.selectedQuoteId) {
      throw new Error(`Carrier market ${market.id} already selected quote ${market.selectedQuoteId}`);
    }
    if (market.status === "exhausted" || market.status === "cancelled") {
      throw new Error(`Cannot select a quote for ${market.status} carrier market ${market.id}`);
    }

    const result = this.db.prepare(`UPDATE volta_markets
      SET status = 'selected', selected_quote_id = ?, closed_at = ?
      WHERE id = ? AND selected_quote_id IS NULL
        AND status NOT IN ('selected', 'exhausted', 'cancelled')`)
      .run(quote.id, new Date().toISOString(), market.id);
    if (result.changes !== 1) {
      const latest = this.requireCarrierMarket(market.id);
      if (latest.selectedQuoteId === quote.id) return latest;
      if (latest.selectedQuoteId) {
        throw new Error(`Carrier market ${market.id} already selected quote ${latest.selectedQuoteId}`);
      }
      throw new Error(`Carrier market ${market.id} is no longer available for selection`);
    }
    return this.requireCarrierMarket(market.id);
  }

  createCarrierQuote(input: CarrierQuoteInput): CarrierQuote {
    const market = this.requireCarrierMarket(input.marketId);
    const call = this.getCall(input.callId);
    if (!call) throw new Error(`Call not found: ${input.callId}`);
    if (call.marketId !== market.id) {
      throw new Error(`Call ${call.id} is not attached to carrier market ${market.id}`);
    }
    if (call.operationId !== market.operationId) {
      throw new Error(`Call ${call.id} does not belong to carrier market operation ${market.operationId}`);
    }

    const quote: CarrierQuote = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO volta_quotes (
      id, market_id, call_id, carrier, terms, mandate_decision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      quote.id, quote.marketId, quote.callId, JSON.stringify(quote.carrier),
      JSON.stringify(quote.terms), JSON.stringify(quote.mandateDecision), quote.createdAt,
    );
    return quote;
  }

  getCarrierQuote(id: string): CarrierQuote | null {
    const row = this.db.prepare("SELECT * FROM volta_quotes WHERE id = ?").get(id) as Row | undefined;
    return row ? toCarrierQuote(row) : null;
  }

  listCarrierQuotes(marketId: string): CarrierQuote[] {
    return (this.db.prepare("SELECT * FROM volta_quotes WHERE market_id = ? ORDER BY created_at")
      .all(marketId) as Row[]).map(toCarrierQuote);
  }

  createCall(input: CreateCallInput): CallRecord {
    const now = new Date().toISOString();
    const call: CallRecord = {
      ...input,
      id: randomUUID(),
      marketId: input.marketId ?? null,
      startedAt: now,
      endedAt: null,
    };
    const telephonyStatus = toTelephonyStatus(call.status);
    this.db.prepare(`INSERT INTO calls (
      id, twilio_call_sid, batch_id, contact_id, direction, from_number, to_number,
      status, status_rank, started_at, answered_at, completed_at, duration_seconds,
      error_code, error_message, created_at, updated_at,
      volta_operation_id, volta_market_id, realtime_call_id, volta_status, volta_counterparty
    ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
      call.id, call.providerCallId, call.direction === "inbound" ? "INBOUND" : "OUTBOUND",
      call.fromNumber, call.toNumber, telephonyStatus, callStatusRank(telephonyStatus), call.startedAt,
      now, now, call.operationId, call.marketId, call.realtimeCallId, call.status, call.counterparty,
    );
    return call;
  }

  getCall(id: string): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as Row | undefined;
    return row ? toCall(row) : null;
  }

  findCallByRealtimeId(realtimeCallId: string): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE realtime_call_id = ?").get(realtimeCallId) as Row | undefined;
    return row ? toCall(row) : null;
  }

  attachCallToOperation(callId: string, operationId: string): void {
    this.db.prepare("UPDATE calls SET volta_operation_id = ?, updated_at = ? WHERE id = ?")
      .run(operationId, new Date().toISOString(), callId);
  }

  attachCallToMarket(callId: string, marketId: string): void {
    const market = this.requireCarrierMarket(marketId);
    const call = this.getCall(callId);
    if (!call) throw new Error(`Call not found: ${callId}`);
    if (call.operationId !== market.operationId) {
      throw new Error(`Call ${call.id} does not belong to carrier market operation ${market.operationId}`);
    }
    this.db.prepare("UPDATE calls SET volta_market_id = ?, updated_at = ? WHERE id = ?")
      .run(market.id, new Date().toISOString(), call.id);
  }

  updateCall(id: string, patch: CallPatch): void {
    const current = this.getCall(id);
    if (!current) throw new Error(`Call not found: ${id}`);
    const next = { ...current, ...patch };
    if (patch.marketId !== undefined && patch.marketId !== null) {
      const market = this.requireCarrierMarket(patch.marketId);
      if (next.operationId !== market.operationId) {
        throw new Error(`Call ${id} does not belong to carrier market operation ${market.operationId}`);
      }
    }

    // The telephony status only moves forward: a Twilio callback that already
    // reported a later state is never rewound by the agent session.
    const telephonyStatus = toTelephonyStatus(next.status);
    const nextRank = callStatusRank(telephonyStatus);
    const currentRow = this.db.prepare("SELECT status_rank FROM calls WHERE id = ?").get(id) as Row | undefined;
    const advance = nextRank > Number(currentRow?.status_rank ?? -1) ? 1 : 0;

    this.db.prepare(`UPDATE calls SET
      volta_market_id = ?, volta_status = ?, twilio_call_sid = COALESCE(?, twilio_call_sid),
      realtime_call_id = ?, completed_at = COALESCE(?, completed_at),
      status = CASE WHEN ? = 1 THEN ? ELSE status END,
      status_rank = CASE WHEN ? = 1 THEN ? ELSE status_rank END,
      updated_at = ?
      WHERE id = ?`).run(
      next.marketId, next.status, next.providerCallId, next.realtimeCallId, next.endedAt,
      advance, telephonyStatus, advance, nextRank, new Date().toISOString(), id,
    );
  }

  appendEvent(callId: string, type: string, payload: unknown): CallEvent {
    const event: CallEvent = {
      id: randomUUID(),
      callId,
      type,
      payload,
      occurredAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO volta_call_events (id, call_id, type, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
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
    this.db.prepare(`INSERT INTO volta_commitments (
      id, operation_id, call_id, status, proposal, mandate_decision, recap_delivery_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.operationId, record.callId, record.status,
      JSON.stringify(input.proposal), JSON.stringify(input.decision), null, record.createdAt,
    );
    return record;
  }

  listPendingCommitments(callId: string): CommitmentRecord[] {
    return (this.db.prepare("SELECT * FROM volta_commitments WHERE call_id = ? AND status IN ('proposed', 'recap_failed')")
      .all(callId) as Row[]).map(toCommitment);
  }

  updateCommitment(id: string, status: CommitmentStatus, recapDeliveryId?: string): void {
    this.db.prepare("UPDATE volta_commitments SET status = ?, recap_delivery_id = ? WHERE id = ?")
      .run(status, recapDeliveryId ?? null, id);
  }

  private requireCarrierMarket(id: string): CarrierMarket {
    const market = this.getCarrierMarket(id);
    if (!market) throw new Error(`Carrier market not found: ${id}`);
    return market;
  }

  private requireCarrierQuote(id: string): CarrierQuote {
    const quote = this.getCarrierQuote(id);
    if (!quote) throw new Error(`Carrier quote not found: ${id}`);
    return quote;
  }
}

let store: VoltaStore | undefined;

export function getVoltaStore(): VoltaStore {
  store ??= new VoltaStore(getDatabase());
  return store;
}

function toTelephonyStatus(status: CallStatus): TelephonyCallStatus {
  switch (status) {
    case "dialing": return "REQUESTED";
    case "active": return "IN_PROGRESS";
    case "completed": return "COMPLETED";
    case "transferred": return "COMPLETED";
    case "failed": return "FAILED";
  }
}

/** Rows created by the telephony dashboard predate the agent and carry no volta_status. */
function toVoltaStatus(status: string): CallStatus {
  switch (status) {
    case "REQUESTED":
    case "INITIATED":
    case "RINGING": return "dialing";
    case "IN_PROGRESS": return "active";
    case "COMPLETED": return "completed";
    default: return "failed";
  }
}

function toOperation(row: Row): Operation {
  const input = JSON.parse(String(row.payload)) as OperationInput;
  return { ...input, id: String(row.id), createdAt: String(row.created_at) };
}

function toCall(row: Row): CallRecord {
  return {
    id: String(row.id),
    operationId: nullableString(row.volta_operation_id),
    marketId: nullableString(row.volta_market_id),
    direction: String(row.direction) === "INBOUND" ? "inbound" : "outbound",
    counterparty: nullableString(row.volta_counterparty),
    fromNumber: String(row.from_number),
    toNumber: String(row.to_number),
    status: row.volta_status === null || row.volta_status === undefined
      ? toVoltaStatus(String(row.status))
      : String(row.volta_status) as CallStatus,
    providerCallId: nullableString(row.twilio_call_sid),
    realtimeCallId: nullableString(row.realtime_call_id),
    startedAt: String(row.started_at),
    endedAt: nullableString(row.completed_at),
  };
}

function toCarrierMarket(row: Row): CarrierMarket {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    status: String(row.status) as CarrierMarket["status"],
    candidates: JSON.parse(String(row.candidates)) as CarrierMarket["candidates"],
    selectedQuoteId: nullableString(row.selected_quote_id),
    createdAt: String(row.created_at),
    closedAt: nullableString(row.closed_at),
  };
}

function toCarrierQuote(row: Row): CarrierQuote {
  return {
    id: String(row.id),
    marketId: String(row.market_id),
    callId: String(row.call_id),
    carrier: JSON.parse(String(row.carrier)) as CarrierQuote["carrier"],
    terms: JSON.parse(String(row.terms)) as CarrierQuote["terms"],
    mandateDecision: JSON.parse(String(row.mandate_decision)) as CarrierQuote["mandateDecision"],
    createdAt: String(row.created_at),
  };
}

function toCommitment(row: Row): CommitmentRecord {
  const proposal = JSON.parse(String(row.proposal)) as CommitmentProposal;
  return {
    ...proposal,
    id: String(row.id),
    operationId: String(row.operation_id),
    callId: String(row.call_id),
    status: String(row.status) as CommitmentStatus,
    mandateDecision: JSON.parse(String(row.mandate_decision)) as MandateDecision,
    recapDeliveryId: nullableString(row.recap_delivery_id),
    createdAt: String(row.created_at),
  };
}

function toEvent(row: Row): CallEvent {
  return {
    id: String(row.id),
    callId: String(row.call_id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)) as unknown,
    occurredAt: String(row.occurred_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
