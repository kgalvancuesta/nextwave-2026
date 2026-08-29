import "server-only";

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isActiveCallStatus } from "./call-status";
import { getDatabase } from "./db";
import type {
  CommitmentRecord,
  DemurrageRiskStatus,
  MandateSnapshot,
  MarketCarrierState,
  MarketRecord,
  MarketState,
  OfferRecord,
  OrderEventRecord,
  OrderRecord,
  OrderStatus,
  OrderWorkspace,
} from "./market-types";
import { MarketlineRepository } from "./repository";
import type { Contact } from "./types";

type Row = Record<string, unknown>;

export interface CreateOrderInput {
  name: string;
  client: string;
  origin: string;
  destination: string;
  reference?: string | null;
  currency: string;
  targetPrice: number;
  maximumPrice: number;
  preferredArrival?: string | null;
  mustArriveBy?: string | null;
  priceWeight: number;
  speedWeight: number;
  minimumValidOffers: number;
  desiredCarriers: number;
  conditions: string[];
  carrierIds: string[];
  freeTimeEndsAt?: string | null;
  currentEta?: string | null;
  dailyDemurrageRate?: number;
}

export interface RecordOfferInput {
  carrierId: string;
  callId?: string | null;
  price: number;
  pickupTime?: string | null;
  expectedArrival?: string | null;
  waitingTimeIncluded?: string | null;
  extraFees?: string | null;
  conditions?: string | null;
  isFinalOffer?: boolean;
  requiresImmediateDecision?: boolean;
  callbackAllowed?: boolean;
}

export class OrderMarketService {
  private readonly calls: MarketlineRepository;

  constructor(private readonly db: Database.Database) {
    this.calls = new MarketlineRepository(db);
  }

  createOrder(input: CreateOrderInput): OrderWorkspace {
    validateOrderInput(input);
    const contacts = this.calls.getContacts(input.carrierIds);
    if (contacts.length !== input.carrierIds.length) throw new Error("One or more selected carriers no longer exist.");
    const now = new Date().toISOString();
    const orderId = randomUUID();
    const marketId = randomUUID();
    const conditions = input.conditions.map((condition) => condition.trim()).filter(Boolean);
    const mandate = mandateFromInput(input, conditions);

    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO orders (
        id, name, client, origin, destination, reference, currency, target_price, maximum_price,
        preferred_arrival, must_arrive_by, price_weight, speed_weight, minimum_valid_offers,
        desired_carriers, lifecycle_status, free_time_ends_at, current_eta, daily_demurrage_rate, risk_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SOURCING', ?, ?, ?, ?, ?, ?)`).run(
        orderId, input.name.trim(), input.client.trim(), input.origin.trim(), input.destination.trim(),
        input.reference?.trim() || null, input.currency, input.targetPrice, input.maximumPrice,
        nullableDate(input.preferredArrival), nullableDate(input.mustArriveBy), input.priceWeight,
        input.speedWeight, input.minimumValidOffers, input.desiredCarriers, nullableDate(input.freeTimeEndsAt), nullableDate(input.currentEta),
        input.dailyDemurrageRate || 0, initialRiskStatus(input, now), now, now,
      );
      const conditionInsert = this.db.prepare(`INSERT INTO order_conditions
        (id, order_id, condition_text, position, created_at) VALUES (?, ?, ?, ?, ?)`);
      conditions.forEach((condition, index) => conditionInsert.run(randomUUID(), orderId, condition, index, now));
      const orderCarrierInsert = this.db.prepare(`INSERT INTO order_carriers
        (order_id, carrier_id, selected_at) VALUES (?, ?, ?)`);
      input.carrierIds.forEach((carrierId) => orderCarrierInsert.run(orderId, carrierId, now));
      this.db.prepare(`INSERT INTO markets
        (id, order_id, sequence_number, status, reason, mandate_snapshot, created_at, updated_at)
        VALUES (?, ?, 1, 'DRAFT', 'INITIAL_PROCUREMENT', ?, ?, ?)`).run(marketId, orderId, JSON.stringify(mandate), now, now);
      const marketCarrierInsert = this.db.prepare(`INSERT INTO market_carriers
        (market_id, carrier_id, status, created_at, updated_at) VALUES (?, ?, 'SELECTED', ?, ?)`);
      input.carrierIds.forEach((carrierId) => marketCarrierInsert.run(marketId, carrierId, now, now));
      this.insertEvent(orderId, null, null, "ORDER_CREATED", input.name.trim(), now);
      this.insertEvent(orderId, marketId, null, "MARKET_CREATED", "Initial procurement market", now);
    })();

    return this.getOrder(orderId)!;
  }

  listOrders(): OrderWorkspace[] {
    const rows = this.db.prepare(`SELECT id FROM orders ORDER BY
      CASE lifecycle_status
        WHEN 'EXCEPTION' THEN 0 WHEN 'CANCELED' THEN 0
        WHEN 'SOURCING' THEN 1 WHEN 'NEGOTIATING' THEN 1
        WHEN 'COMMITTED' THEN 2 WHEN 'IN_PROCESS' THEN 2
        ELSE 3 END,
      updated_at DESC`).all() as Row[];
    return rows.map((row) => this.getOrder(String(row.id))!).filter(Boolean);
  }

  getOrder(orderId: string): OrderWorkspace | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Row | undefined;
    if (!row) return null;
    const order = this.toOrder(row);
    const marketRows = this.db.prepare("SELECT * FROM markets WHERE order_id = ? ORDER BY sequence_number DESC").all(orderId) as Row[];
    const markets = marketRows.map((market) => this.getMarketState(String(market.id))!);
    const commitments = this.listCommitments(orderId);
    const events = (this.db.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 100").all(orderId) as Row[])
      .map(toEvent);
    const nautaCalls = order.voltaOperationId ? this.calls.listCallsForVoltaOperation(order.voltaOperationId) : [];
    const activeMarket = markets.find((market) => ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "COMMITTED"].includes(market.market.status));
    const currentMarket = ["COMPLETED", "ARCHIVED"].includes(order.lifecycleStatus)
      ? markets[0] || null
      : activeMarket || markets[0] || null;
    return { order, currentMarket, markets, commitments, events, nautaCalls, collapsedSummary: summarizeOrder(order, currentMarket, commitments) };
  }

  getMarket(marketId: string): MarketRecord | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE id = ?").get(marketId) as Row | undefined;
    return row ? toMarket(row) : null;
  }

  getMarketCarrierIds(marketId: string): string[] {
    return (this.db.prepare("SELECT carrier_id FROM market_carriers WHERE market_id = ? ORDER BY created_at").all(marketId) as Row[])
      .map((row) => String(row.carrier_id));
  }

  startMarket(marketId: string): { market: MarketRecord; carrierIds: string[] } {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    if (["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(market.status)) throw new Error("This market cannot start calls in its current state.");
    if (this.calls.listCallsForMarket(marketId).length > 0) throw new Error("Calls have already been started for this market.");
    const carrierIds = this.getMarketCarrierIds(marketId);
    if (carrierIds.length < 1 || carrierIds.length > 3) throw new Error("A market must have between one and three selected carriers to start calls.");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE markets SET status = 'CALLING', updated_at = ? WHERE id = ?").run(now, marketId);
      this.db.prepare("UPDATE market_carriers SET status = 'CALLING', updated_at = ? WHERE market_id = ?").run(now, marketId);
      this.db.prepare(`UPDATE orders SET lifecycle_status = CASE WHEN lifecycle_status = 'EXCEPTION' THEN lifecycle_status ELSE 'SOURCING' END,
        updated_at = ? WHERE id = ?`).run(now, market.orderId);
      this.insertEvent(market.orderId, marketId, null, "CALL_STARTED", `${carrierIds.length} carrier calls requested`, now);
    })();
    return { market: this.getMarket(marketId)!, carrierIds };
  }

  getMarketState(marketId: string): MarketState | null {
    const market = this.getMarket(marketId);
    if (!market) return null;
    const carrierRows = this.db.prepare(`SELECT contacts.*, market_carriers.status AS market_carrier_status
      FROM market_carriers JOIN contacts ON contacts.id = market_carriers.carrier_id
      WHERE market_carriers.market_id = ? ORDER BY contacts.label COLLATE NOCASE`).all(marketId) as Row[];
    const calls = this.calls.listCallsForMarket(marketId);
    const offerRows = this.db.prepare(`SELECT offers.*, contacts.label AS carrier_label FROM offers
      JOIN contacts ON contacts.id = offers.carrier_id WHERE offers.market_id = ?
      ORDER BY offers.created_at DESC, offers.id DESC`).all(marketId) as Row[];
    const offers = offerRows.map((row) => evaluateOffer(toOffer(row), market.mandate));
    const latestByCarrier = new Map<string, OfferRecord>();
    for (const offer of offers) if (!latestByCarrier.has(offer.carrierId)) latestByCarrier.set(offer.carrierId, offer);
    const latestOffers = [...latestByCarrier.values()];
    const validLatest = latestOffers.filter((offer) => offer.isValid);
    const ranked = [...validLatest].sort((a, b) => b.score - a.score || a.price - b.price || a.createdAt.localeCompare(b.createdAt));
    const ranks = new Map(ranked.map((offer, index) => [offer.id, index + 1]));
    const activeCommitment = this.getActiveCommitment(marketId);
    const carriers: MarketCarrierState[] = carrierRows.map((row) => {
      const carrier = toContact(row);
      const latestOffer = latestByCarrier.get(carrier.id) || null;
      const latestCall = calls.find((call) => (call.carrierId || call.contactId) === carrier.id) || null;
      return {
        carrier,
        status: derivedCarrierStatus(String(row.market_carrier_status), latestCall, latestOffer, activeCommitment?.carrierId === carrier.id),
        latestOffer,
        latestCall,
        rank: latestOffer ? ranks.get(latestOffer.id) || null : null,
      };
    });
    const cheapestOffer = [...validLatest].sort((a, b) => a.price - b.price || b.score - a.score)[0] || null;
    return {
      market,
      progress: {
        carriersSelected: carriers.length,
        callsStarted: calls.length,
        callsActive: calls.filter((call) => isActiveCallStatus(call.status)).length,
        callsCompleted: calls.filter((call) => !isActiveCallStatus(call.status)).length,
        validOffers: validLatest.length,
      },
      carriers,
      offers,
      bestOffer: ranked[0] || null,
      cheapestOffer,
      activeCommitment,
    };
  }

  recordOffer(marketId: string, input: RecordOfferInput): MarketState {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    if (["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(market.status)) throw new Error("Offers cannot be added to this market.");
    const selected = this.db.prepare("SELECT 1 FROM market_carriers WHERE market_id = ? AND carrier_id = ?").get(marketId, input.carrierId);
    if (!selected) throw new Error("That carrier is not selected for this market.");
    if (!Number.isInteger(input.price) || input.price < 0) throw new Error("Offer price must be a non-negative whole amount.");
    const previous = this.db.prepare(`SELECT id FROM offers WHERE market_id = ? AND carrier_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(marketId, input.carrierId) as Row | undefined;
    const now = new Date().toISOString();
    const offerId = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO offers (
        id, market_id, carrier_id, call_id, price, currency, pickup_time, expected_arrival,
        waiting_time_included, extra_fees, conditions, is_final_offer, requires_immediate_decision,
        callback_allowed, supersedes_offer_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offerId, marketId, input.carrierId, input.callId || null, input.price, market.mandate.currency,
        nullableDate(input.pickupTime), nullableDate(input.expectedArrival), input.waitingTimeIncluded?.trim() || null,
        input.extraFees?.trim() || null, input.conditions?.trim() || null, input.isFinalOffer ? 1 : 0,
        input.requiresImmediateDecision ? 1 : 0, input.callbackAllowed === false ? 0 : 1,
        previous ? String(previous.id) : null, now,
      );
      this.db.prepare("UPDATE markets SET status = 'NEGOTIATING', updated_at = ? WHERE id = ?").run(now, marketId);
      this.db.prepare(`UPDATE orders SET lifecycle_status = CASE WHEN lifecycle_status = 'EXCEPTION' THEN lifecycle_status ELSE 'NEGOTIATING' END,
        updated_at = ? WHERE id = ?`).run(now, market.orderId);
      this.db.prepare("UPDATE market_carriers SET status = ?, updated_at = ? WHERE market_id = ? AND carrier_id = ?")
        .run(input.isFinalOffer ? "FINAL" : "NEGOTIATING", now, marketId, input.carrierId);
      this.insertEvent(market.orderId, marketId, input.callId || null, previous ? "OFFER_UPDATED" : "OFFER_RECEIVED", `Offer recorded in ${market.mandate.currency}`, now);
    })();
    return this.getMarketState(marketId)!;
  }

  commitOffer(offerId: string): OrderWorkspace {
    const row = this.db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as Row | undefined;
    if (!row) throw new Error("Offer not found.");
    const market = this.getMarket(String(row.market_id))!;
    const state = this.getMarketState(market.id)!;
    const offer = state.offers.find((candidate) => candidate.id === offerId)!;
    if (!offer.isValid) throw new Error(`Offer is outside mandate: ${offer.invalidReasons.join("; ")}`);
    if (state.progress.validOffers < market.mandate.minimumValidOffers) {
      throw new Error(`At least ${market.mandate.minimumValidOffers} valid offers are required before commitment.`);
    }
    const now = new Date().toISOString();
    const commitmentId = randomUUID();
    this.db.transaction(() => {
      const active = this.db.prepare("SELECT 1 FROM commitments WHERE market_id = ? AND status = 'ACTIVE'").get(market.id);
      if (active) throw new Error("This market already has an active commitment.");
      this.db.prepare(`INSERT INTO commitments
        (id, order_id, market_id, offer_id, carrier_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`).run(commitmentId, market.orderId, market.id, offer.id, offer.carrierId, now);
      this.db.prepare("UPDATE markets SET status = 'COMMITTED', closed_at = ?, updated_at = ? WHERE id = ?").run(now, now, market.id);
      this.db.prepare("UPDATE orders SET lifecycle_status = 'COMMITTED', exception_reason = NULL, updated_at = ? WHERE id = ?")
        .run(now, market.orderId);
      this.db.prepare("UPDATE market_carriers SET status = CASE WHEN carrier_id = ? THEN 'FINAL' ELSE status END, updated_at = ? WHERE market_id = ?")
        .run(offer.carrierId, now, market.id);
      this.insertEvent(market.orderId, market.id, offer.callId, "OFFER_COMMITTED", `Committed offer in ${offer.currency}`, now);
    })();
    return this.getOrder(market.orderId)!;
  }

  invalidateCommitment(commitmentId: string, reason: string): OrderWorkspace {
    const row = this.db.prepare("SELECT * FROM commitments WHERE id = ? AND status = 'ACTIVE'").get(commitmentId) as Row | undefined;
    if (!row) throw new Error("Active commitment not found.");
    const cleanReason = reason.trim();
    if (!cleanReason) throw new Error("An invalidation reason is required.");
    const now = new Date().toISOString();
    const orderId = String(row.order_id);
    const marketId = String(row.market_id);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE commitments SET status = 'INVALIDATED', invalidated_at = ?, invalidation_reason = ? WHERE id = ?`)
        .run(now, cleanReason, commitmentId);
      this.db.prepare("UPDATE markets SET status = 'FAILED', updated_at = ? WHERE id = ?").run(now, marketId);
      this.db.prepare("UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ? WHERE id = ?")
        .run(cleanReason, now, orderId);
      this.insertEvent(orderId, marketId, null, "COMMITMENT_INVALIDATED", cleanReason, now);
      this.insertEvent(orderId, marketId, null, "CARRIER_FAILED", cleanReason, now);
    })();
    return this.getOrder(orderId)!;
  }

  createRecoveryMarket(orderId: string, carrierIds?: string[]): OrderWorkspace {
    const order = this.getOrder(orderId)?.order;
    if (!order) throw new Error("Order not found.");
    const openMarket = this.db.prepare(`SELECT 1 FROM markets WHERE order_id = ?
      AND status IN ('DRAFT', 'OPEN', 'CALLING', 'NEGOTIATING') LIMIT 1`).get(orderId);
    if (openMarket) throw new Error("This order already has an open market.");
    const selectedIds = carrierIds?.length ? [...new Set(carrierIds)] : order.carriers.map((carrier) => carrier.id);
    if (selectedIds.length < 1 || selectedIds.length > 3) throw new Error("Select between one and three carriers for recovery.");
    if (this.calls.getContacts(selectedIds).length !== selectedIds.length) throw new Error("One or more recovery carriers no longer exist.");
    const next = Number((this.db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM markets WHERE order_id = ?").get(orderId) as Row).next);
    const now = new Date().toISOString();
    const marketId = randomUUID();
    const mandate = mandateFromOrder(order);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO markets
        (id, order_id, sequence_number, status, reason, mandate_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, 'DRAFT', 'CARRIER_FAILURE', ?, ?, ?)`).run(marketId, orderId, next, JSON.stringify(mandate), now, now);
      const insert = this.db.prepare(`INSERT INTO market_carriers
        (market_id, carrier_id, status, created_at, updated_at) VALUES (?, ?, 'SELECTED', ?, ?)`);
      const selectForOrder = this.db.prepare(`INSERT OR IGNORE INTO order_carriers
        (order_id, carrier_id, selected_at) VALUES (?, ?, ?)`);
      selectedIds.forEach((carrierId) => {
        insert.run(marketId, carrierId, now, now);
        selectForOrder.run(orderId, carrierId, now);
      });
      this.db.prepare("UPDATE orders SET lifecycle_status = 'EXCEPTION', updated_at = ? WHERE id = ?").run(now, orderId);
      this.insertEvent(orderId, marketId, null, "RECOVERY_MARKET_CREATED", `Recovery market #${next}`, now);
    })();
    return this.getOrder(orderId)!;
  }

  completeOrder(orderId: string): OrderWorkspace {
    const workspace = this.getOrder(orderId);
    if (!workspace) throw new Error("Order not found.");
    if (!["COMMITTED", "IN_PROCESS"].includes(workspace.order.lifecycleStatus)) {
      throw new Error("Only a committed or in-process order can be completed.");
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE orders SET lifecycle_status = 'COMPLETED', exception_reason = NULL, updated_at = ? WHERE id = ?")
        .run(now, orderId);
      this.db.prepare(`UPDATE markets SET status = 'CLOSED', closed_at = COALESCE(closed_at, ?), updated_at = ?
        WHERE order_id = ? AND status = 'COMMITTED'`).run(now, now, orderId);
      this.db.prepare("UPDATE commitments SET status = 'FULFILLED' WHERE order_id = ? AND status = 'ACTIVE'").run(orderId);
      this.insertEvent(orderId, workspace.currentMarket?.market.id || null, null, "ORDER_COMPLETED", "Transport operation completed", now);
    })();
    return this.getOrder(orderId)!;
  }

  beginNautaRiskRecovery(orderId: string): OrderWorkspace {
    const workspace = this.getOrder(orderId);
    if (!workspace) throw new Error("Order not found.");
    const { order, currentMarket } = workspace;
    if (!order.freeTimeEndsAt || order.dailyDemurrageRate <= 0) {
      throw new Error("Add free-time end and a daily demurrage rate before starting Nauta.");
    }
    if (["COMPLETED", "ARCHIVED", "CANCELED"].includes(order.lifecycleStatus)) {
      throw new Error("Nauta cannot start recovery for a closed order.");
    }
    const now = new Date().toISOString();
    const detail = `Nauta recovery started: verify ETA, secure pickup appointment, then request a free-time extension or fee waiver if needed. Potential exposure ${formatMoney(order.dailyDemurrageRate, order.currency)} per day.`;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE orders SET risk_status = 'IN_PROGRESS', lifecycle_status = CASE
        WHEN lifecycle_status IN ('SOURCING', 'NEGOTIATING', 'EXCEPTION') THEN 'NEGOTIATING' ELSE lifecycle_status END,
        updated_at = ? WHERE id = ?`).run(now, orderId);
      this.insertEvent(orderId, currentMarket?.market.id || null, null, "NAUTA_RECOVERY_STARTED", detail, now);
    })();
    return this.getOrder(orderId)!;
  }

  linkVoltaRecovery(orderId: string, operationId: string, marketId: string): OrderWorkspace {
    const order = this.getOrder(orderId)?.order;
    if (!order) throw new Error("Order not found.");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE orders SET volta_operation_id = ?, volta_market_id = ?, updated_at = ? WHERE id = ?`)
        .run(operationId, marketId, now, orderId);
      this.insertEvent(orderId, null, null, "NAUTA_MARKET_STARTED", "Nauta started parallel carrier calls under the order mandate.", now);
    })();
    return this.getOrder(orderId)!;
  }

  private toOrder(row: Row): OrderRecord {
    const orderId = String(row.id);
    const conditions = (this.db.prepare("SELECT condition_text FROM order_conditions WHERE order_id = ? ORDER BY position").all(orderId) as Row[])
      .map((condition) => String(condition.condition_text));
    const carriers = (this.db.prepare(`SELECT contacts.* FROM order_carriers JOIN contacts ON contacts.id = order_carriers.carrier_id
      WHERE order_carriers.order_id = ? ORDER BY contacts.label COLLATE NOCASE`).all(orderId) as Row[]).map(toContact);
    return {
      id: orderId,
      name: String(row.name),
      client: String(row.client),
      origin: String(row.origin),
      destination: String(row.destination),
      reference: nullableString(row.reference),
      currency: String(row.currency),
      targetPrice: Number(row.target_price),
      maximumPrice: Number(row.maximum_price),
      preferredArrival: nullableString(row.preferred_arrival),
      mustArriveBy: nullableString(row.must_arrive_by),
      priceWeight: Number(row.price_weight),
      speedWeight: Number(row.speed_weight),
      minimumValidOffers: Number(row.minimum_valid_offers),
      desiredCarriers: Number(row.desired_carriers),
      conditions,
      carriers,
      lifecycleStatus: String(row.lifecycle_status) as OrderStatus,
      exceptionReason: nullableString(row.exception_reason),
      freeTimeEndsAt: nullableString(row.free_time_ends_at),
      currentEta: nullableString(row.current_eta),
      dailyDemurrageRate: Number(row.daily_demurrage_rate || 0),
      riskStatus: String(row.risk_status || "MONITORED") as DemurrageRiskStatus,
      voltaOperationId: nullableString(row.volta_operation_id),
      voltaMarketId: nullableString(row.volta_market_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private getActiveCommitment(marketId: string): CommitmentRecord | null {
    const row = this.db.prepare(`SELECT commitments.*, contacts.label AS carrier_label FROM commitments
      JOIN contacts ON contacts.id = commitments.carrier_id WHERE commitments.market_id = ? AND commitments.status = 'ACTIVE'`)
      .get(marketId) as Row | undefined;
    return row ? toCommitment(row) : null;
  }

  private listCommitments(orderId: string): CommitmentRecord[] {
    return (this.db.prepare(`SELECT commitments.*, contacts.label AS carrier_label FROM commitments
      JOIN contacts ON contacts.id = commitments.carrier_id WHERE commitments.order_id = ? ORDER BY commitments.created_at DESC`)
      .all(orderId) as Row[]).map(toCommitment);
  }

  private insertEvent(orderId: string, marketId: string | null, callId: string | null, eventType: string, detail: string | null, createdAt: string) {
    this.db.prepare(`INSERT INTO order_events (id, order_id, market_id, call_id, event_type, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), orderId, marketId, callId, eventType, detail, createdAt);
  }
}

let service: OrderMarketService | undefined;
export function getOrderMarketService(): OrderMarketService {
  service ??= new OrderMarketService(getDatabase());
  return service;
}

function validateOrderInput(input: CreateOrderInput) {
  if (!input.name.trim() || !input.client.trim() || !input.origin.trim() || !input.destination.trim()) throw new Error("Order name, client, origin, and destination are required.");
  if (!Number.isInteger(input.targetPrice) || !Number.isInteger(input.maximumPrice) || input.targetPrice < 0 || input.maximumPrice < input.targetPrice) {
    throw new Error("Maximum price must be a whole amount greater than or equal to target price.");
  }
  if (Math.abs(input.priceWeight + input.speedWeight - 1) > 0.001) throw new Error("Price and speed weights must add up to 1.");
  if (input.mustArriveBy && input.preferredArrival && Date.parse(input.mustArriveBy) < Date.parse(input.preferredArrival)) {
    throw new Error("Must arrive by cannot be before preferred arrival.");
  }
  if (input.carrierIds.length < 1 || input.carrierIds.length > 3 || new Set(input.carrierIds).size !== input.carrierIds.length) {
    throw new Error("Select between one and three unique carriers.");
  }
  if (input.dailyDemurrageRate !== undefined && (!Number.isInteger(input.dailyDemurrageRate) || input.dailyDemurrageRate < 0)) {
    throw new Error("Daily demurrage rate must be a non-negative whole amount.");
  }
}

function initialRiskStatus(input: CreateOrderInput, now: string): DemurrageRiskStatus {
  if (!input.freeTimeEndsAt || !input.dailyDemurrageRate) return "MONITORED";
  return Date.parse(input.freeTimeEndsAt) - Date.parse(now) <= 48 * 60 * 60 * 1000 ? "AT_RISK" : "MONITORED";
}

function mandateFromInput(input: CreateOrderInput, conditions: string[]): MandateSnapshot {
  return {
    targetPrice: input.targetPrice,
    maximumPrice: input.maximumPrice,
    preferredArrival: nullableDate(input.preferredArrival),
    mustArriveBy: nullableDate(input.mustArriveBy),
    priceWeight: input.priceWeight,
    speedWeight: input.speedWeight,
    minimumValidOffers: input.minimumValidOffers,
    desiredCarriers: input.desiredCarriers,
    conditions,
    currency: input.currency,
  };
}

function mandateFromOrder(order: OrderRecord): MandateSnapshot {
  const { targetPrice, maximumPrice, preferredArrival, mustArriveBy, priceWeight, speedWeight, minimumValidOffers, desiredCarriers, conditions, currency } = order;
  return { targetPrice, maximumPrice, preferredArrival, mustArriveBy, priceWeight, speedWeight, minimumValidOffers, desiredCarriers, conditions, currency };
}

function toMarket(row: Row): MarketRecord {
  return {
    id: String(row.id), orderId: String(row.order_id), sequenceNumber: Number(row.sequence_number),
    status: String(row.status) as MarketRecord["status"], reason: String(row.reason),
    mandate: JSON.parse(String(row.mandate_snapshot)) as MandateSnapshot,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), closedAt: nullableString(row.closed_at),
  };
}

function toOffer(row: Row): OfferRecord {
  return {
    id: String(row.id), marketId: String(row.market_id), carrierId: String(row.carrier_id), carrierLabel: String(row.carrier_label),
    callId: nullableString(row.call_id), price: Number(row.price), currency: String(row.currency),
    pickupTime: nullableString(row.pickup_time), expectedArrival: nullableString(row.expected_arrival),
    waitingTimeIncluded: nullableString(row.waiting_time_included), extraFees: nullableString(row.extra_fees),
    conditions: nullableString(row.conditions), isFinalOffer: Boolean(row.is_final_offer),
    requiresImmediateDecision: Boolean(row.requires_immediate_decision), callbackAllowed: Boolean(row.callback_allowed),
    supersedesOfferId: nullableString(row.supersedes_offer_id), createdAt: String(row.created_at),
    isValid: true, invalidReasons: [], score: 0,
  };
}

function evaluateOffer(offer: OfferRecord, mandate: MandateSnapshot): OfferRecord {
  const invalidReasons: string[] = [];
  if (offer.price > mandate.maximumPrice) invalidReasons.push(`Price exceeds maximum ${mandate.maximumPrice}`);
  if (offer.expectedArrival && mandate.mustArriveBy && Date.parse(offer.expectedArrival) > Date.parse(mandate.mustArriveBy)) {
    invalidReasons.push("Arrival is after the mandate deadline");
  }
  const priceRange = Math.max(1, mandate.maximumPrice - mandate.targetPrice);
  const priceScore = offer.price <= mandate.targetPrice ? 100 : Math.max(0, 100 * (mandate.maximumPrice - offer.price) / priceRange);
  let speedScore = 50;
  if (offer.expectedArrival && mandate.preferredArrival) {
    const arrival = Date.parse(offer.expectedArrival);
    const preferred = Date.parse(mandate.preferredArrival);
    const latest = mandate.mustArriveBy ? Date.parse(mandate.mustArriveBy) : preferred + 24 * 60 * 60 * 1000;
    speedScore = arrival <= preferred ? 100 : Math.max(0, 100 * (latest - arrival) / Math.max(1, latest - preferred));
  }
  return { ...offer, isValid: invalidReasons.length === 0, invalidReasons, score: Math.round((mandate.priceWeight * priceScore + mandate.speedWeight * speedScore) * 10) / 10 };
}

function derivedCarrierStatus(persisted: string, call: ReturnType<MarketlineRepository["getCall"]>, offer: OfferRecord | null, committed: boolean): MarketCarrierState["status"] {
  if (committed || offer?.isFinalOffer) return "FINAL";
  if (offer) return "NEGOTIATING";
  if (call?.status === "IN_PROGRESS") return "CONNECTED";
  if (call && isActiveCallStatus(call.status)) return "CALLING";
  if (call && ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(call.status)) return "FAILED";
  if (call) return "COMPLETED";
  return persisted as MarketCarrierState["status"];
}

function toCommitment(row: Row): CommitmentRecord {
  return {
    id: String(row.id), orderId: String(row.order_id), marketId: String(row.market_id), offerId: String(row.offer_id),
    carrierId: String(row.carrier_id), carrierLabel: String(row.carrier_label), status: String(row.status) as CommitmentRecord["status"],
    createdAt: String(row.created_at), invalidatedAt: nullableString(row.invalidated_at), invalidationReason: nullableString(row.invalidation_reason),
  };
}

function toEvent(row: Row): OrderEventRecord {
  return {
    id: String(row.id), orderId: String(row.order_id), marketId: nullableString(row.market_id), callId: nullableString(row.call_id),
    eventType: String(row.event_type), detail: nullableString(row.detail), createdAt: String(row.created_at),
  };
}

function toContact(row: Row): Contact {
  return {
    id: String(row.id), label: String(row.label), phoneInput: String(row.phone_input), e164PhoneNumber: String(row.e164_phone_number),
    note: nullableString(row.note), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function summarizeOrder(order: OrderRecord, market: MarketState | null, commitments: CommitmentRecord[]): string {
  if (order.lifecycleStatus === "EXCEPTION" || order.lifecycleStatus === "CANCELED") {
    return `${order.exceptionReason || "Action required"}${market && ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(market.market.status) ? " · Recovery market open" : ""}`;
  }
  const activeCommitment = commitments.find((commitment) => commitment.status === "ACTIVE");
  if (activeCommitment && market?.activeCommitment) {
    const offer = market.offers.find((candidate) => candidate.id === activeCommitment.offerId);
    return `${activeCommitment.carrierLabel}${offer ? ` · ${formatMoney(offer.price, offer.currency)}` : ""}${offer?.pickupTime ? ` · Pickup ${formatShortDate(offer.pickupTime)}` : ""}`;
  }
  if (["COMPLETED", "ARCHIVED"].includes(order.lifecycleStatus)) return `Completed · ${formatShortDate(order.updatedAt)}`;
  if (!market) return "Ready to open market";
  const parts = [`${market.progress.callsActive} calls active`, `${market.progress.validOffers} offers`];
  if (market.bestOffer) parts.push(`Best ${formatMoney(market.bestOffer.price, market.bestOffer.currency)}`);
  return parts.join(" · ");
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}
function formatShortDate(value: string): string { return new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableDate(value: string | null | undefined): string | null { return value?.trim() ? new Date(value).toISOString() : null; }
