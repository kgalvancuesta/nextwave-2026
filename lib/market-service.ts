import "server-only";

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isActiveCallStatus } from "./call-status";
import { getDatabase } from "./db";
import {
  checkOfferFeasibility,
  evaluateMarket,
  evaluateOffers,
  type MarketEvaluation,
  type ProcurementOfferFacts,
  type EvaluatedProcurementOffer,
} from "./procurement-evaluator";
import type {
  CommitmentRecord,
  DemurrageRiskStatus,
  MandateSnapshot,
  MarketCarrierState,
  MarketRecord,
  MarketState,
  MarketInstruction,
  OfferAvailability,
  OfferRecord,
  OrderEventRecord,
  OrderRecord,
  OrderStatus,
  OrderWorkspace,
} from "./market-types";
import { generatedOrderReference, normalizeOrderReference } from "./market-types";
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
  confirmedRequirements?: string[];
  rejectedRequirements?: string[];
}

export interface ProgressiveOfferUpdateInput {
  availability?: OfferAvailability;
  price?: number | null;
  currency?: string | null;
  rateAllIn?: boolean | null;
  pickupTime?: string | null;
  expectedArrival?: string | null;
  firm?: boolean | null;
  expiresAt?: string | null;
  accessorials?: string[];
  carrierConditions?: string[];
  confirmedRequirements?: string[];
  rejectedRequirements?: string[];
  rawStatement?: string | null;
  confidence?: number | null;
  humanRequired?: boolean;
  humanReason?: string | null;
}

export interface InboundMarketAttachment {
  status: "ATTACHED" | "AMBIGUOUS" | "NOT_FOUND" | "CLOSED";
  marketId: string | null;
  candidates: Array<{ marketId: string; orderReference: string }>;
}

export interface ProcurementCallContext {
  callId: string;
  order: OrderRecord;
  market: MarketRecord;
  carrier: Contact;
  latestOffer: OfferRecord | null;
  instruction: MarketInstruction;
  marketClosed: boolean;
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
    const reference = input.reference?.trim() || generatedOrderReference(orderId);
    const normalizedReference = normalizeOrderReference(reference);
    const existingReference = (this.db.prepare("SELECT reference FROM orders WHERE reference IS NOT NULL").all() as Row[])
      .some((row) => normalizeOrderReference(String(row.reference)) === normalizedReference);
    if (existingReference) throw new Error(`Order/reference number already exists: ${reference}`);
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
        reference, input.currency, input.targetPrice, input.maximumPrice,
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

  reevaluateExpiredMarkets(now = new Date().toISOString()): void {
    const rows = this.db.prepare(`SELECT id FROM markets WHERE procurement_deadline_at IS NOT NULL
      AND procurement_deadline_at <= ? AND status IN ('CALLING', 'NEGOTIATING', 'OPEN', 'HUMAN_REVIEW')`).all(now) as Row[];
    for (const row of rows) this.reevaluateMarket(String(row.id));
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
    const deadline = new Date(Date.parse(now) + 5 * 60_000).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE markets SET status = 'CALLING', started_at = ?, procurement_deadline_at = ?,
        revision = revision + 1, review_reason = NULL, updated_at = ? WHERE id = ?`).run(now, deadline, now, marketId);
      this.db.prepare(`UPDATE market_carriers SET status = 'CALLING', evaluator_action = 'CONTINUE_DISCOVERY',
        action_reason = 'calls_requested', action_revision = (SELECT revision FROM markets WHERE id = ?), updated_at = ?
        WHERE market_id = ?`).run(marketId, now, marketId);
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
      , market_carriers.evaluator_action, market_carriers.action_reason, market_carriers.action_payload
      , market_carriers.action_revision, market_carriers.negotiation_rounds, market_carriers.human_reason
      FROM market_carriers JOIN contacts ON contacts.id = market_carriers.carrier_id
      WHERE market_carriers.market_id = ? ORDER BY contacts.label COLLATE NOCASE`).all(marketId) as Row[];
    const calls = this.calls.listCallsForMarket(marketId);
    const offerRows = this.db.prepare(`SELECT procurement_offer_versions.*, contacts.label AS carrier_label
      FROM procurement_offer_versions JOIN contacts ON contacts.id = procurement_offer_versions.carrier_id
      WHERE procurement_offer_versions.market_id = ?
      ORDER BY procurement_offer_versions.version DESC, procurement_offer_versions.created_at DESC`)
      .all(marketId) as Row[];
    const rawOffers = offerRows.map(toOffer);
    const latestByCarrier = new Map<string, OfferRecord>();
    for (const offer of rawOffers) if (!latestByCarrier.has(offer.carrierId)) latestByCarrier.set(offer.carrierId, offer);
    const evaluation = this.evaluateSnapshot(market, carrierRows, calls, latestByCarrier);
    const evaluatedLatest = new Map(evaluation.offers.map((offer) => [offer.id, offer]));
    const historicalEvaluation = new Map(evaluateOffers(market.mandate, rawOffers.map(toOfferFacts)).map((offer) => [offer.id, offer]));
    const offers = rawOffers.map((offer) => decorateOffer(offer, evaluatedLatest.get(offer.id) ?? historicalEvaluation.get(offer.id)!));
    for (const [carrierId, offer] of latestByCarrier) {
      const decorated = offers.find((candidate) => candidate.id === offer.id);
      if (decorated) latestByCarrier.set(carrierId, decorated);
    }
    const ranked = evaluation.rankedOfferIds.map((id) => offers.find((offer) => offer.id === id)!).filter(Boolean);
    const ranks = new Map(ranked.map((offer, index) => [offer.id, index + 1]));
    const activeCommitment = this.getActiveCommitment(marketId);
    const carriers: MarketCarrierState[] = carrierRows.map((row) => {
      const carrier = toContact(row);
      const latestOffer = latestByCarrier.get(carrier.id) || null;
      const latestCall = calls.find((call) => (call.carrierId || call.contactId) === carrier.id) || null;
      const instruction = activeCommitment?.carrierId === carrier.id
        ? { action: "AWARD" as const, reason: "active_commitment", field: null, targetPrice: null, targetArrival: null, marketRevision: market.revision }
        : evaluation.actions[carrier.id] ?? instructionFromRow(row, market.revision);
      return {
        carrier,
        status: derivedCarrierStatus(String(row.market_carrier_status), latestCall, latestOffer, instruction, activeCommitment?.carrierId === carrier.id),
        latestOffer,
        latestCall,
        rank: latestOffer ? ranks.get(latestOffer.id) || null : null,
        instruction,
        negotiationRounds: Number(row.negotiation_rounds || 0),
        humanReason: nullableString(row.human_reason),
      };
    });
    const validLatest = [...latestByCarrier.values()].filter((offer) => offer.isComparable && offer.isValid);
    const cheapestOffer = evaluation.cheapestOfferId
      ? offers.find((offer) => offer.id === evaluation.cheapestOfferId) ?? null
      : null;
    const nearFeasibleOffers = [...latestByCarrier.values()]
      .filter((offer) => offer.isComparable && !offer.isValid)
      .sort((left, right) => violationDistance(left) - violationDistance(right) || (left.price ?? Infinity) - (right.price ?? Infinity));
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
      bestOffer: evaluation.bestOfferId ? offers.find((offer) => offer.id === evaluation.bestOfferId) ?? null : null,
      cheapestOffer,
      nearFeasibleOffers,
      phase: evaluation.phase,
      awardReady: evaluation.awardReady,
      reviewReason: evaluation.reviewReason,
      activeCommitment,
    };
  }

  recordOffer(marketId: string, input: RecordOfferInput): MarketState {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    return this.recordProgressiveOffer(marketId, input.carrierId, {
      availability: "AVAILABLE",
      price: input.price,
      currency: market.mandate.currency,
      rateAllIn: true,
      pickupTime: input.pickupTime,
      expectedArrival: input.expectedArrival,
      firm: input.isFinalOffer ?? false,
      carrierConditions: input.conditions?.trim() ? [input.conditions.trim()] : [],
      accessorials: input.extraFees?.trim() ? [input.extraFees.trim()] : [],
      confirmedRequirements: input.confirmedRequirements ?? market.mandate.conditions,
      rejectedRequirements: input.rejectedRequirements ?? [],
    }, input.callId ?? null, {
      waitingTimeIncluded: input.waitingTimeIncluded,
      requiresImmediateDecision: input.requiresImmediateDecision,
      callbackAllowed: input.callbackAllowed,
    });
  }

  recordProgressiveOffer(
    marketId: string,
    carrierId: string,
    update: ProgressiveOfferUpdateInput,
    callId: string | null = null,
    legacy: Pick<RecordOfferInput, "waitingTimeIncluded" | "requiresImmediateDecision" | "callbackAllowed"> = {},
  ): MarketState {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    if (["FAILED", "CANCELED"].includes(market.status)) throw new Error("Offers cannot be added to this market.");
    const selected = this.db.prepare("SELECT * FROM market_carriers WHERE market_id = ? AND carrier_id = ?")
      .get(marketId, carrierId) as Row | undefined;
    if (!selected) throw new Error("That carrier is not selected for this market.");
    if (update.price !== undefined && update.price !== null && (!Number.isInteger(update.price) || update.price < 0)) {
      throw new Error("Offer price must be a non-negative whole amount.");
    }
    if (update.confidence !== undefined && update.confidence !== null && (update.confidence < 0 || update.confidence > 1)) {
      throw new Error("Offer confidence must be between 0 and 1.");
    }
    if (callId) {
      const call = this.calls.getCall(callId);
      if (!call || call.marketId !== marketId || (call.carrierId || call.contactId) !== carrierId) {
        throw new Error("The call is not attached to that carrier in this market.");
      }
    }
    const previous = this.db.prepare(`SELECT * FROM procurement_offer_versions WHERE market_id = ? AND carrier_id = ?
      ORDER BY version DESC LIMIT 1`).get(marketId, carrierId) as Row | undefined;
    const prior = previous ? toOffer(previous) : null;
    const merged = mergeOfferUpdate(prior, update, market.mandate.currency);
    const now = new Date().toISOString();
    const offerId = randomUUID();
    const version = Number(previous?.version || 0) + 1;
    const late = ["COMMITTED", "CLOSED"].includes(market.status);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO procurement_offer_versions (
        id, market_id, carrier_id, call_id, version, availability, price, currency, rate_all_in,
        pickup_time, expected_arrival, firm, expires_at, accessorials, carrier_conditions,
        confirmed_requirements, rejected_requirements, raw_statement, confidence, human_required, human_reason,
        supersedes_version_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offerId, marketId, carrierId, callId || prior?.callId || null, version, merged.availability,
        merged.price, merged.currency, nullableBoolean(merged.rateAllIn), merged.pickupTime,
        merged.expectedArrival, nullableBoolean(merged.firm), merged.expiresAt,
        JSON.stringify(merged.accessorials), JSON.stringify(merged.carrierConditions),
        JSON.stringify(merged.confirmedRequirements), JSON.stringify(merged.rejectedRequirements), merged.rawStatement, merged.confidence,
        merged.humanRequired ? 1 : 0, merged.humanReason, prior?.id || null, now,
      );

      const evaluated = evaluateOffers(market.mandate, [{ ...toOfferFacts(merged), id: offerId, carrierId }])[0]!;
      if (evaluated.comparable && merged.price !== null && merged.currency) {
        const previousComparable = this.db.prepare(`SELECT id FROM offers WHERE market_id = ? AND carrier_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`).get(marketId, carrierId) as Row | undefined;
        this.db.prepare(`INSERT INTO offers (
          id, market_id, carrier_id, call_id, price, currency, pickup_time, expected_arrival,
          waiting_time_included, extra_fees, conditions, is_final_offer, requires_immediate_decision,
          callback_allowed, supersedes_offer_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          offerId, marketId, carrierId, callId || prior?.callId || null, merged.price, merged.currency,
          merged.pickupTime, merged.expectedArrival, legacy.waitingTimeIncluded?.trim() || null,
          merged.accessorials.join("; ") || null, merged.carrierConditions.join("; ") || null,
          merged.firm ? 1 : 0, legacy.requiresImmediateDecision ? 1 : 0,
          legacy.callbackAllowed === false ? 0 : 1, nullableString(previousComparable?.id), now,
        );
      }

      this.db.prepare(`UPDATE markets SET status = CASE WHEN status IN ('COMMITTED', 'CLOSED') THEN status ELSE 'NEGOTIATING' END,
        revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, marketId);
      this.db.prepare(`UPDATE orders SET lifecycle_status = CASE
        WHEN lifecycle_status IN ('EXCEPTION', 'COMMITTED', 'IN_PROCESS', 'COMPLETED', 'ARCHIVED') THEN lifecycle_status
        ELSE 'NEGOTIATING' END, updated_at = ? WHERE id = ?`).run(now, market.orderId);
      const status = merged.humanRequired ? "HUMAN"
        : merged.availability === "UNAVAILABLE" ? "UNAVAILABLE"
          : evaluated.comparable ? "OFFER" : "PARTIAL";
      this.db.prepare(`UPDATE market_carriers SET status = ?, availability = ?,
        negotiation_rounds = negotiation_rounds + CASE WHEN evaluator_action = 'NEGOTIATE' THEN 1 ELSE 0 END,
        human_reason = ?, updated_at = ? WHERE market_id = ? AND carrier_id = ?`)
        .run(status, merged.availability, merged.humanRequired ? merged.humanReason || "Carrier interaction requires human review" : null,
          now, marketId, carrierId);
      this.insertEvent(market.orderId, marketId, callId || null, late ? "LATE_OFFER_RECEIVED" : previous ? "OFFER_UPDATED" : "OFFER_RECEIVED",
        JSON.stringify({ availability: merged.availability, price: merged.price, arrival: merged.expectedArrival, version, late }), now);
    })();
    return this.reevaluateMarket(marketId);
  }

  reevaluateMarket(marketId: string): MarketState {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    const carrierRows = this.db.prepare(`SELECT contacts.*, market_carriers.status AS market_carrier_status,
      market_carriers.negotiation_rounds, market_carriers.human_reason
      FROM market_carriers JOIN contacts ON contacts.id = market_carriers.carrier_id
      WHERE market_carriers.market_id = ?`).all(marketId) as Row[];
    const calls = this.calls.listCallsForMarket(marketId);
    const latestRows = this.db.prepare(`SELECT procurement_offer_versions.* FROM procurement_offer_versions
      JOIN (SELECT carrier_id, MAX(version) AS version FROM procurement_offer_versions WHERE market_id = ? GROUP BY carrier_id) latest
      ON latest.carrier_id = procurement_offer_versions.carrier_id AND latest.version = procurement_offer_versions.version
      WHERE procurement_offer_versions.market_id = ?`).all(marketId, marketId) as Row[];
    const latest = new Map(latestRows.map((row) => {
      const offer = toOffer(row);
      return [offer.carrierId, offer] as const;
    }));
    const evaluation = this.evaluateSnapshot(market, carrierRows, calls, latest);
    const now = new Date().toISOString();

    this.db.transaction(() => {
      const current = this.getMarket(marketId);
      if (!current || current.revision !== evaluation.revision) return;
      const updateCarrier = this.db.prepare(`UPDATE market_carriers SET evaluator_action = ?, action_reason = ?,
        action_payload = ?, action_revision = ?, status = ?, released_at = CASE WHEN ? = 'RELEASE' THEN COALESCE(released_at, ?) ELSE released_at END,
        updated_at = ? WHERE market_id = ? AND carrier_id = ?`);
      for (const row of carrierRows) {
        const carrierId = String(row.id);
        const action = evaluation.actions[carrierId];
        if (!action) continue;
        const call = calls.find((candidate) => (candidate.carrierId || candidate.contactId) === carrierId) || null;
        const offer = latest.get(carrierId) || null;
        updateCarrier.run(action.action, action.reason, JSON.stringify(action), action.marketRevision,
          workflowStatus(action, call, offer), action.action, now, now, marketId, carrierId);
        if (call) {
          this.db.prepare("UPDATE calls SET market_session_state = ?, updated_at = ? WHERE id = ?")
            .run(sessionState(action.action), now, call.id);
        }
      }
      const nextStatus = evaluation.phase === "HUMAN_REVIEW" ? "HUMAN_REVIEW"
        : evaluation.phase === "FRONTIER_NEGOTIATION" ? "NEGOTIATING" : current.status;
      this.db.prepare(`UPDATE markets SET status = CASE WHEN status IN ('COMMITTED', 'CLOSED', 'FAILED', 'CANCELED') THEN status ELSE ? END,
        review_reason = ?, updated_at = ? WHERE id = ?`).run(nextStatus, evaluation.reviewReason, now, marketId);
      if (evaluation.reviewReason) {
        this.db.prepare(`UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ?
          WHERE id = ? AND lifecycle_status NOT IN ('COMMITTED', 'IN_PROCESS', 'COMPLETED', 'ARCHIVED')`)
          .run(evaluation.reviewReason, now, market.orderId);
      }
    })();

    if (evaluation.awardOfferId) this.awardAutomatically(marketId, evaluation.awardOfferId, evaluation.revision);
    return this.getMarketState(marketId)!;
  }

  getProcurementCallContext(callId: string): ProcurementCallContext | null {
    const call = this.calls.getCall(callId);
    if (!call?.marketId || !call.orderId || !(call.carrierId || call.contactId)) return null;
    const workspace = this.getOrder(call.orderId);
    const state = workspace?.markets.find((candidate) => candidate.market.id === call.marketId);
    const carrierState = state?.carriers.find((candidate) => candidate.carrier.id === (call.carrierId || call.contactId));
    if (!workspace || !state || !carrierState) return null;
    return {
      callId,
      order: workspace.order,
      market: state.market,
      carrier: carrierState.carrier,
      latestOffer: carrierState.latestOffer,
      instruction: carrierState.instruction,
      marketClosed: ["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(state.market.status),
    };
  }

  recordProgressiveOfferForCall(callId: string, update: ProgressiveOfferUpdateInput): MarketState {
    const context = this.getProcurementCallContext(callId);
    if (!context) throw new Error("Call is not attached to a procurement market.");
    return this.recordProgressiveOffer(context.market.id, context.carrier.id, update, callId);
  }

  getInstructionForCall(callId: string): MarketInstruction | null {
    return this.getProcurementCallContext(callId)?.instruction ?? null;
  }

  listMarketCallInstructions(marketId: string): Array<{ callId: string; instruction: MarketInstruction }> {
    const state = this.getMarketState(marketId);
    if (!state) return [];
    return state.carriers.flatMap((carrier) => carrier.latestCall && isActiveCallStatus(carrier.latestCall.status)
      ? [{ callId: carrier.latestCall.id, instruction: carrier.instruction }]
      : []);
  }

  validateCallInstruction(callId: string, marketRevision: number, allowed: MarketInstruction["action"][]): MarketInstruction {
    const instruction = this.getInstructionForCall(callId);
    if (!instruction) throw new Error("Call is not attached to a procurement market.");
    if (instruction.marketRevision !== marketRevision) throw new Error("stale_market_instruction");
    if (!allowed.includes(instruction.action)) throw new Error(`action_not_allowed:${instruction.action}`);
    return instruction;
  }

  markCallHumanRequired(callId: string, reason: string): MarketState | null {
    const context = this.getProcurementCallContext(callId);
    if (!context) return null;
    const cleanReason = reason.trim();
    if (!cleanReason) throw new Error("A human escalation reason is required.");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE market_carriers SET status = 'HUMAN', evaluator_action = 'HUMAN_REQUIRED',
        action_reason = 'human_authority_required', human_reason = ?, updated_at = ?
        WHERE market_id = ? AND carrier_id = ?`).run(cleanReason, now, context.market.id, context.carrier.id);
      this.db.prepare("UPDATE calls SET market_session_state = 'HUMAN', human_takeover = 1, human_reason = ?, updated_at = ? WHERE id = ?")
        .run(cleanReason, now, callId);
      this.db.prepare("UPDATE markets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, context.market.id);
      this.insertEvent(context.order.id, context.market.id, callId, "HUMAN_REQUIRED", cleanReason, now);
    })();
    return this.reevaluateMarket(context.market.id);
  }

  attachInboundCallToMarket(callId: string, reference?: string): InboundMarketAttachment {
    const call = this.calls.getCall(callId);
    if (!call || call.direction !== "INBOUND" || !call.contactId) return { status: "NOT_FOUND", marketId: null, candidates: [] };
    if (call.marketId) {
      const market = this.getMarket(call.marketId);
      return { status: market && ["COMMITTED", "CLOSED"].includes(market.status) ? "CLOSED" : "ATTACHED", marketId: call.marketId, candidates: [] };
    }
    const rows = this.db.prepare(`SELECT markets.id AS market_id, markets.order_id, markets.status, orders.reference, orders.name
      FROM market_carriers JOIN markets ON markets.id = market_carriers.market_id
      JOIN orders ON orders.id = markets.order_id
      WHERE market_carriers.carrier_id = ?
      ORDER BY CASE WHEN markets.status IN ('CALLING', 'NEGOTIATING', 'OPEN', 'HUMAN_REVIEW') THEN 0 ELSE 1 END,
        markets.updated_at DESC`).all(call.contactId) as Row[];
    const normalized = reference ? normalizeOrderReference(reference) : null;
    const matching = normalized
      ? rows.filter((row) => normalizeOrderReference(String(row.reference || row.name)) === normalized)
      : rows.filter((row) => ["CALLING", "NEGOTIATING", "OPEN", "HUMAN_REVIEW"].includes(String(row.status)));
    const candidates = matching.map((row) => ({ marketId: String(row.market_id), orderReference: String(row.reference || row.name) }));
    if (matching.length !== 1) return { status: matching.length > 1 ? "AMBIGUOUS" : "NOT_FOUND", marketId: null, candidates };
    const target = matching[0]!;
    const now = new Date().toISOString();
    const closed = ["COMMITTED", "CLOSED"].includes(String(target.status));
    this.db.transaction(() => {
      this.db.prepare(`UPDATE calls SET order_id = ?, market_id = ?, carrier_id = ?, market_session_state = ?, updated_at = ? WHERE id = ?`)
        .run(String(target.order_id), String(target.market_id), call.contactId, closed ? "COMPLETED" : "DISCOVERY", now, callId);
      this.db.prepare("UPDATE markets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, String(target.market_id));
      this.insertEvent(String(target.order_id), String(target.market_id), callId, closed ? "LATE_INBOUND_CALL" : "INBOUND_CALL_ATTACHED",
        closed ? "Carrier called after market close" : "Inbound carrier callback attached", now);
    })();
    if (!closed) this.reevaluateMarket(String(target.market_id));
    return { status: closed ? "CLOSED" : "ATTACHED", marketId: String(target.market_id), candidates };
  }

  commitOffer(offerId: string): OrderWorkspace {
    const row = this.db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as Row | undefined;
    if (!row) throw new Error("Offer not found.");
    const market = this.getMarket(String(row.market_id))!;
    const state = this.getMarketState(market.id)!;
    const offer = state.offers.find((candidate) => candidate.id === offerId)!;
    if (!offer || !offer.isComparable) throw new Error("Offer is incomplete and cannot be committed.");
    if (!offer.isValid) throw new Error(`Offer is outside mandate: ${offer.invalidReasons.join("; ")}`);
    const latest = state.carriers.find((carrier) => carrier.carrier.id === offer.carrierId)?.latestOffer;
    if (latest?.id !== offer.id) throw new Error("A newer carrier offer exists; reload the market before committing.");
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

  private evaluateSnapshot(
    market: MarketRecord,
    carrierRows: Row[],
    calls: ReturnType<MarketlineRepository["listCallsForMarket"]>,
    latest: Map<string, OfferRecord>,
  ): MarketEvaluation {
    return evaluateMarket({
      revision: market.revision,
      status: market.status,
      automaticAward: market.automaticAward && market.startedAt !== null,
      deadlineAt: market.procurementDeadlineAt,
      mandate: market.mandate,
      carriers: carrierRows.map((row) => {
        const carrierId = String(row.id);
        const call = calls.find((candidate) => (candidate.carrierId || candidate.contactId) === carrierId) || null;
        const offer = latest.get(carrierId) || null;
        return {
          carrierId,
          callId: call?.id ?? null,
          callActive: Boolean(call && isActiveCallStatus(call.status)),
          callTerminal: Boolean(call && !isActiveCallStatus(call.status)),
          negotiationRounds: Number(row.negotiation_rounds || 0),
          humanReason: nullableString(row.human_reason),
          offer: offer ? toOfferFacts(offer) : null,
        };
      }),
    });
  }

  private awardAutomatically(marketId: string, expectedOfferId: string, expectedRevision: number): void {
    const market = this.getMarket(marketId);
    if (!market || market.revision !== expectedRevision || !market.automaticAward) return;
    const state = this.getMarketState(marketId);
    const offer = state?.offers.find((candidate) => candidate.id === expectedOfferId);
    if (!state?.awardReady || state.bestOffer?.id !== expectedOfferId || !offer?.isComparable || !offer.isValid) return;
    const feasibility = checkOfferFeasibility(market.mandate, toOfferFacts(offer));
    if (!feasibility.feasible) return;
    const persistedComparable = this.db.prepare("SELECT 1 FROM offers WHERE id = ?").get(expectedOfferId);
    if (!persistedComparable) return;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT revision, status, automatic_award FROM markets WHERE id = ?").get(marketId) as Row | undefined;
      if (!current || Number(current.revision) !== expectedRevision || !Boolean(current.automatic_award)
        || ["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(String(current.status))) return;
      const latest = this.db.prepare(`SELECT id FROM procurement_offer_versions WHERE market_id = ? AND carrier_id = ?
        ORDER BY version DESC LIMIT 1`).get(marketId, offer.carrierId) as Row | undefined;
      if (String(latest?.id || "") !== expectedOfferId) return;
      const active = this.db.prepare("SELECT 1 FROM commitments WHERE market_id = ? AND status = 'ACTIVE'").get(marketId);
      if (active) return;
      this.db.prepare(`INSERT INTO commitments
        (id, order_id, market_id, offer_id, carrier_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`).run(randomUUID(), market.orderId, marketId, offer.id, offer.carrierId, now);
      this.db.prepare("UPDATE markets SET status = 'COMMITTED', closed_at = ?, review_reason = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, marketId);
      this.db.prepare("UPDATE orders SET lifecycle_status = 'COMMITTED', exception_reason = NULL, updated_at = ? WHERE id = ?")
        .run(now, market.orderId);
      this.db.prepare(`UPDATE market_carriers SET status = CASE WHEN carrier_id = ? THEN 'AWARDED' ELSE 'RELEASED' END,
        evaluator_action = CASE WHEN carrier_id = ? THEN 'AWARD' ELSE 'RELEASE' END,
        action_reason = CASE WHEN carrier_id = ? THEN 'best_current_feasible_offer' ELSE 'market_awarded_to_better_offer' END,
        action_revision = ?, updated_at = ? WHERE market_id = ?`)
        .run(offer.carrierId, offer.carrierId, offer.carrierId, expectedRevision, now, marketId);
      this.insertEvent(market.orderId, marketId, offer.callId, "OFFER_AUTO_AWARDED",
        JSON.stringify({ offerId: offer.id, carrierId: offer.carrierId, marketRevision: expectedRevision }), now);
    })();
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
    revision: Number(row.revision || 0), startedAt: nullableString(row.started_at),
    procurementDeadlineAt: nullableString(row.procurement_deadline_at), automaticAward: Boolean(row.automatic_award),
    reviewReason: nullableString(row.review_reason),
  };
}

function toOffer(row: Row): OfferRecord {
  return {
    id: String(row.id), marketId: String(row.market_id || ""), carrierId: String(row.carrier_id || ""),
    carrierLabel: nullableString(row.carrier_label) || "", callId: nullableString(row.call_id),
    version: Number(row.version || 0), availability: String(row.availability || "UNKNOWN") as OfferAvailability,
    price: nullableNumber(row.price), currency: nullableString(row.currency), rateAllIn: nullableBooleanFromRow(row.rate_all_in),
    pickupTime: nullableString(row.pickup_time), expectedArrival: nullableString(row.expected_arrival),
    firm: nullableBooleanFromRow(row.firm), expiresAt: nullableString(row.expires_at),
    accessorials: jsonStringArray(row.accessorials), carrierConditions: jsonStringArray(row.carrier_conditions),
    confirmedRequirements: jsonStringArray(row.confirmed_requirements), rawStatement: nullableString(row.raw_statement),
    rejectedRequirements: jsonStringArray(row.rejected_requirements),
    confidence: nullableNumber(row.confidence), humanRequired: Boolean(row.human_required), humanReason: nullableString(row.human_reason),
    waitingTimeIncluded: null, extraFees: null, conditions: null, isFinalOffer: Boolean(row.firm),
    requiresImmediateDecision: false, callbackAllowed: true,
    supersedesOfferId: nullableString(row.supersedes_version_id), createdAt: String(row.created_at),
    isComparable: false, isValid: true, invalidReasons: [], feasibilityViolations: [], missingFields: ["availability"],
    classification: "PARTIAL", isDominated: false, isFrontier: false, score: 0,
  };
}

function toOfferFacts(offer: Pick<OfferRecord,
  "id" | "carrierId" | "availability" | "price" | "currency" | "rateAllIn" | "expectedArrival"
  | "confirmedRequirements" | "rejectedRequirements" | "humanRequired"
>): ProcurementOfferFacts {
  return {
    id: offer.id,
    carrierId: offer.carrierId,
    availability: offer.availability,
    price: offer.price,
    currency: offer.currency,
    rateAllIn: offer.rateAllIn,
    expectedArrival: offer.expectedArrival,
    confirmedRequirements: offer.confirmedRequirements,
    rejectedRequirements: offer.rejectedRequirements,
    humanRequired: offer.humanRequired,
  };
}

function decorateOffer(offer: OfferRecord, evaluated: EvaluatedProcurementOffer): OfferRecord {
  return {
    ...offer,
    isComparable: evaluated.comparable,
    isValid: evaluated.feasible,
    invalidReasons: evaluated.violations.map((violation) => violation.message),
    feasibilityViolations: evaluated.violations,
    missingFields: evaluated.missingFields,
    classification: evaluated.classification,
    isDominated: evaluated.dominated,
    isFrontier: evaluated.frontier,
    score: evaluated.score,
  };
}

function mergeOfferUpdate(prior: OfferRecord | null, update: ProgressiveOfferUpdateInput, defaultCurrency: string): OfferRecord {
  return {
    ...(prior ?? {
      id: "", marketId: "", carrierId: "", carrierLabel: "", callId: null, version: 0,
      availability: "UNKNOWN" as const, price: null, currency: defaultCurrency, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: null, expiresAt: null, accessorials: [], carrierConditions: [],
      confirmedRequirements: [], rawStatement: null, confidence: null, humanRequired: false, humanReason: null,
      rejectedRequirements: [],
      waitingTimeIncluded: null, extraFees: null, conditions: null, isFinalOffer: false,
      requiresImmediateDecision: false, callbackAllowed: true, supersedesOfferId: null, createdAt: "",
      isComparable: false, isValid: true, invalidReasons: [], feasibilityViolations: [], missingFields: ["availability" as const],
      classification: "PARTIAL" as const, isDominated: false, isFrontier: false, score: 0,
    }),
    availability: update.availability ?? prior?.availability ?? "UNKNOWN",
    price: update.price !== undefined ? update.price : prior?.price ?? null,
    currency: update.currency !== undefined ? update.currency?.toUpperCase() || null : prior?.currency ?? defaultCurrency,
    rateAllIn: update.rateAllIn !== undefined ? update.rateAllIn : prior?.rateAllIn ?? null,
    pickupTime: update.pickupTime !== undefined ? nullableDate(update.pickupTime) : prior?.pickupTime ?? null,
    expectedArrival: update.expectedArrival !== undefined ? nullableDate(update.expectedArrival) : prior?.expectedArrival ?? null,
    firm: update.firm !== undefined ? update.firm : prior?.firm ?? null,
    expiresAt: update.expiresAt !== undefined ? nullableDate(update.expiresAt) : prior?.expiresAt ?? null,
    accessorials: update.accessorials ?? prior?.accessorials ?? [],
    carrierConditions: update.carrierConditions ?? prior?.carrierConditions ?? [],
    confirmedRequirements: update.confirmedRequirements ?? prior?.confirmedRequirements ?? [],
    rejectedRequirements: update.rejectedRequirements ?? prior?.rejectedRequirements ?? [],
    rawStatement: update.rawStatement !== undefined ? update.rawStatement?.trim() || null : prior?.rawStatement ?? null,
    confidence: update.confidence !== undefined ? update.confidence : prior?.confidence ?? null,
    humanRequired: update.humanRequired ?? prior?.humanRequired ?? false,
    humanReason: update.humanReason !== undefined ? update.humanReason?.trim() || null : prior?.humanReason ?? null,
  };
}

function derivedCarrierStatus(
  persisted: string,
  call: ReturnType<MarketlineRepository["getCall"]>,
  offer: OfferRecord | null,
  instruction: MarketInstruction,
  committed: boolean,
): MarketCarrierState["status"] {
  if (committed || instruction.action === "AWARD") return "AWARDED";
  if (instruction.action === "HUMAN_REQUIRED") return "HUMAN";
  if (!offer && call && ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(call.status)) return "FAILED";
  if (instruction.action === "RELEASE") return offer?.availability === "UNAVAILABLE" ? "UNAVAILABLE" : "RELEASED";
  if (instruction.action === "NEGOTIATE") return "NEGOTIATING";
  if (instruction.action === "HOLD" || instruction.action === "CONFIRM") return "WAITING";
  if (instruction.action === "ASK_MISSING_FIELD") return "PARTIAL";
  if (offer?.isComparable) return "OFFER";
  if (offer) return "PARTIAL";
  if (call?.status === "IN_PROGRESS") return "DISCOVERY";
  if (call && isActiveCallStatus(call.status)) return "CALLING";
  if (call && ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(call.status)) return "FAILED";
  if (call) return "COMPLETED";
  return persisted as MarketCarrierState["status"];
}

function instructionFromRow(row: Row, revision: number): MarketInstruction {
  if (row.action_payload) {
    try { return JSON.parse(String(row.action_payload)) as MarketInstruction; } catch { /* fall through */ }
  }
  return {
    action: String(row.evaluator_action || "CONTINUE_DISCOVERY") as MarketInstruction["action"],
    reason: String(row.action_reason || "awaiting_market"), field: null, targetPrice: null,
    targetArrival: null, marketRevision: Number(row.action_revision || revision),
  };
}

function workflowStatus(action: MarketInstruction, call: ReturnType<MarketlineRepository["getCall"]>, offer: OfferRecord | null): MarketCarrierState["status"] {
  return derivedCarrierStatus("SELECTED", call, offer, action, false);
}

function sessionState(action: MarketInstruction["action"]): string {
  if (action === "HUMAN_REQUIRED") return "HUMAN";
  if (action === "RELEASE") return "RELEASED";
  if (action === "NEGOTIATE") return "NEGOTIATING";
  if (action === "HOLD" || action === "CONFIRM") return "WAITING_FOR_MARKET";
  return "DISCOVERY";
}

function violationDistance(offer: OfferRecord): number {
  return offer.feasibilityViolations.reduce((total, violation) => total + (violation.delta === null ? 1_000_000_000 : Math.abs(violation.delta)), 0);
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

function formatMoney(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "—";
  return new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}
function formatShortDate(value: string): string { return new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
function nullableBoolean(value: boolean | null): number | null { return value === null ? null : value ? 1 : 0; }
function nullableBooleanFromRow(value: unknown): boolean | null { return value === null || value === undefined ? null : Boolean(value); }
function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
function nullableDate(value: string | null | undefined): string | null { return value?.trim() ? new Date(value).toISOString() : null; }
