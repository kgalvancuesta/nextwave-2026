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
  AmendmentRecord,
  AmendmentTerms,
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
import { buildAwardRecapBody, RECAP_MAX_LENGTH } from "./recap";
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
  exchangeRates?: Record<string, number>;
  exchangeRateSource?: string | null;
  targetPrice: number;
  maximumPrice: number;
  preferredPickup?: string | null;
  mustPickupBy?: string | null;
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
  currency?: string;
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
  /** The Realtime conversation item the fact came from. Never invented by the server. */
  conversationItemId?: string | null;
}

export interface InboundMarketAttachment {
  status: "ATTACHED" | "AMBIGUOUS" | "NOT_FOUND" | "CLOSED";
  marketId: string | null;
  candidates: Array<{ marketId: string; orderReference: string }>;
  attempts?: number;
  suggestedQuestion?: string | null;
  shouldEscalate?: boolean;
}

export interface InboundMatchEvidence {
  reference?: string | null;
  carrierName?: string | null;
  callerName?: string | null;
  origin?: string | null;
  destination?: string | null;
}

export interface AmendmentProposalInput {
  availability?: "AVAILABLE" | "UNAVAILABLE" | null;
  price?: number | null;
  currency?: string | null;
  pickupTime?: string | null;
  expectedArrival?: string | null;
  unsupportedChange?: string | null;
  negotiationComplete?: boolean;
  rawStatement?: string | null;
}

export interface AmendmentDecision {
  amendment: AmendmentRecord;
  action: "ACCEPT" | "NEGOTIATE" | "REVALIDATE" | "RECOVER" | "HUMAN_HANDOFF";
  recoveryMarketId: string | null;
  negotiationTargets: { maximumPrice: number; mustPickupBy: string | null; mustArriveBy: string | null } | null;
}

export interface ProcurementCallContext {
  callId: string;
  order: OrderRecord;
  market: MarketRecord;
  carrier: Contact;
  latestOffer: OfferRecord | null;
  retainedOffer: OfferRecord | null;
  activeCommitment: CommitmentRecord | null;
  isCommittedCarrier: boolean;
  instruction: MarketInstruction;
  marketClosed: boolean;
  /**
   * Set only when this carrier is the one that won. A closed market is not the
   * same situation for the winner as for everyone else, and the winner is owed
   * a spoken read-back of the exact committed terms before the call ends.
   */
  award: { commitmentId: string; offer: OfferRecord; recapAddress: string | null } | null;
}

export interface RevalidationResolution {
  order: OrderRecord;
  amendment: AmendmentRecord;
  originalCarrier: Contact;
  selectedCarrier: Contact;
  originalMarketId: string;
  replaced: boolean;
}

export class OrderMarketService {
  private readonly calls: MarketlineRepository;

  constructor(private readonly db: Database.Database) {
    this.calls = new MarketlineRepository(db);
  }

  createOrder(input: CreateOrderInput): OrderWorkspace {
    validateOrderInput(input);
    const selectedCarrierIds = input.carrierIds.length > 0
      ? [...new Set(input.carrierIds)]
      : this.selectCarrierCandidates(input.origin, input.destination, input.desiredCarriers);
    const contacts = this.calls.getContacts(selectedCarrierIds);
    if (contacts.length !== selectedCarrierIds.length) throw new Error("One or more selected carriers no longer exist.");
    if (contacts.length === 0) throw new Error("Add at least one carrier so Luna can create a market.");
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
        preferred_pickup, must_pickup_by, preferred_arrival, must_arrive_by, price_weight, speed_weight, minimum_valid_offers,
        desired_carriers, lifecycle_status, free_time_ends_at, current_eta, daily_demurrage_rate, risk_status,
        exchange_rates, exchange_rate_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SOURCING', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        orderId, input.name.trim(), input.client.trim(), input.origin.trim(), input.destination.trim(),
        reference, input.currency, input.targetPrice, input.maximumPrice,
        nullableDate(input.preferredPickup), nullableDate(input.mustPickupBy),
        nullableDate(input.preferredArrival), nullableDate(input.mustArriveBy), input.priceWeight,
        input.speedWeight, input.minimumValidOffers, input.desiredCarriers, nullableDate(input.freeTimeEndsAt), nullableDate(input.currentEta),
        input.dailyDemurrageRate || 0, initialRiskStatus(input, now), JSON.stringify(mandate.exchangeRates), mandate.exchangeRateSource, now, now,
      );
      const conditionInsert = this.db.prepare(`INSERT INTO order_conditions
        (id, order_id, condition_text, position, created_at) VALUES (?, ?, ?, ?, ?)`);
      conditions.forEach((condition, index) => conditionInsert.run(randomUUID(), orderId, condition, index, now));
      const orderCarrierInsert = this.db.prepare(`INSERT INTO order_carriers
        (order_id, carrier_id, selected_at) VALUES (?, ?, ?)`);
      selectedCarrierIds.forEach((carrierId) => orderCarrierInsert.run(orderId, carrierId, now));
      this.db.prepare(`INSERT INTO markets
        (id, order_id, sequence_number, status, reason, mandate_snapshot, created_at, updated_at)
        VALUES (?, ?, 1, 'DRAFT', 'INITIAL_PROCUREMENT', ?, ?, ?)`).run(marketId, orderId, JSON.stringify(mandate), now, now);
      const marketCarrierInsert = this.db.prepare(`INSERT INTO market_carriers
        (market_id, carrier_id, status, created_at, updated_at) VALUES (?, ?, 'SELECTED', ?, ?)`);
      selectedCarrierIds.forEach((carrierId) => marketCarrierInsert.run(marketId, carrierId, now, now));
      this.insertEvent(orderId, null, null, "ORDER_CREATED", input.name.trim(), now);
      if (input.carrierIds.length === 0) {
        this.insertEvent(orderId, marketId, null, "CARRIERS_AUTO_SELECTED",
          `Luna selected ${contacts.map((contact) => contact.label).join(", ")} using lane and outcome history.`, now);
      }
      this.insertEvent(orderId, marketId, null, "MARKET_CREATED", "Initial procurement market", now);
    })();

    return this.getOrder(orderId)!;
  }

  listOrders(): OrderWorkspace[] {
    const rows = this.db.prepare("SELECT id FROM orders ORDER BY created_at DESC, id DESC").all() as Row[];
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
    const amendments = this.listAmendments(orderId);
    const events = (this.db.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 100").all(orderId) as Row[])
      .map(toEvent);
    const nautaCalls = order.voltaOperationId ? this.calls.listCallsForVoltaOperation(order.voltaOperationId) : [];
    const activeMarket = markets.find((market) => ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "COMMITTED"].includes(market.market.status));
    const currentMarket = ["COMPLETED", "ARCHIVED"].includes(order.lifecycleStatus)
      ? markets[0] || null
      : activeMarket || markets[0] || null;
    return { order, currentMarket, markets, commitments, events, amendments, nautaCalls, collapsedSummary: summarizeOrder(order, currentMarket, commitments) };
  }

  getMarket(marketId: string): MarketRecord | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE id = ?").get(marketId) as Row | undefined;
    return row ? toMarket(row) : null;
  }

  getMarketCarrierIds(marketId: string): string[] {
    return (this.db.prepare("SELECT carrier_id FROM market_carriers WHERE market_id = ? ORDER BY created_at").all(marketId) as Row[])
      .map((row) => String(row.carrier_id));
  }

  selectCarrierCandidates(origin: string, destination: string, limit: number): string[] {
    const contacts = this.calls.listContacts();
    const laneOrigin = normalizeLocation(origin);
    const laneDestination = normalizeLocation(destination);
    const scored = contacts.map((contact) => {
      const rows = this.db.prepare(`SELECT orders.origin, orders.destination, orders.lifecycle_status,
        commitments.status AS commitment_status
        FROM order_carriers JOIN orders ON orders.id = order_carriers.order_id
        LEFT JOIN commitments ON commitments.order_id = orders.id AND commitments.carrier_id = order_carriers.carrier_id
        WHERE order_carriers.carrier_id = ?`).all(contact.id) as Row[];
      let score = 1;
      for (const row of rows) {
        const exactLane = normalizeLocation(String(row.origin)) === laneOrigin
          && normalizeLocation(String(row.destination)) === laneDestination;
        if (exactLane) score += 40;
        if (String(row.commitment_status || "") === "FULFILLED") score += exactLane ? 35 : 15;
        if (String(row.commitment_status || "") === "ACTIVE") score += exactLane ? 20 : 8;
        if (String(row.commitment_status || "") === "INVALIDATED") score -= exactLane ? 30 : 12;
        if (String(row.lifecycle_status) === "COMPLETED") score += exactLane ? 15 : 5;
      }
      const participation = this.db.prepare(`SELECT COUNT(*) AS count FROM procurement_offer_versions
        WHERE carrier_id = ? AND availability != 'UNKNOWN'`).get(contact.id) as Row;
      score += Math.min(10, Number(participation.count || 0));
      return { id: contact.id, label: contact.label, score };
    });
    return scored
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(3, limit)))
      .map((candidate) => candidate.id);
  }

  startMarket(marketId: string): { market: MarketRecord; carrierIds: string[] } {
    const market = this.getMarket(marketId);
    if (!market) throw new Error("Market not found.");
    if (["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(market.status)) throw new Error("This market cannot start calls in its current state.");
    if (this.calls.listCallsForMarket(marketId).length > 0) throw new Error("Calls have already been started for this market.");
    const carrierIds = this.getMarketCarrierIds(marketId);
    if (carrierIds.length < 1 || carrierIds.length > 3) throw new Error("A market must have between one and three selected carriers to start calls.");
    const now = new Date().toISOString();
    const deadline = new Date(Date.parse(now) + procurementDeadlineMs()).toISOString();
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
      , market_carriers.purpose, market_carriers.source_offer_id, market_carriers.amendment_id
      FROM market_carriers JOIN contacts ON contacts.id = market_carriers.carrier_id
      WHERE market_carriers.market_id = ? ORDER BY contacts.label COLLATE NOCASE`).all(marketId) as Row[];
    const calls = this.calls.listCallsForMarket(marketId);
    const offerRows = this.db.prepare(`SELECT procurement_offer_versions.*, contacts.label AS carrier_label
      FROM procurement_offer_versions JOIN contacts ON contacts.id = procurement_offer_versions.carrier_id
      WHERE procurement_offer_versions.market_id = ?
      ORDER BY procurement_offer_versions.version DESC, procurement_offer_versions.created_at DESC`)
      .all(marketId) as Row[];
    const rawOffers = offerRows.map(toOffer);
    const retainedByCarrier = new Map<string, OfferRecord>();
    for (const row of carrierRows) {
      const sourceOfferId = nullableString(row.source_offer_id);
      if (!sourceOfferId) continue;
      const sourceRow = this.db.prepare(`SELECT procurement_offer_versions.*, contacts.label AS carrier_label
        FROM procurement_offer_versions JOIN contacts ON contacts.id = procurement_offer_versions.carrier_id
        WHERE procurement_offer_versions.id = ?`).get(sourceOfferId) as Row | undefined;
      if (!sourceRow) continue;
      const source = toOffer(sourceRow);
      const evaluated = evaluateOffers(market.mandate, [toOfferFacts(source)])[0]!;
      retainedByCarrier.set(String(row.id), decorateOffer(source, evaluated, market.mandate.exchangeRateSource));
    }
    const latestByCarrier = new Map<string, OfferRecord>();
    for (const offer of rawOffers) if (!latestByCarrier.has(offer.carrierId)) latestByCarrier.set(offer.carrierId, offer);
    const evaluation = this.evaluateSnapshot(market, carrierRows, calls, latestByCarrier);
    const evaluatedLatest = new Map(evaluation.offers.map((offer) => [offer.id, offer]));
    const historicalEvaluation = new Map(evaluateOffers(market.mandate, rawOffers.map(toOfferFacts)).map((offer) => [offer.id, offer]));
    const offers = this.attachEvidence(
      rawOffers.map((offer) => decorateOffer(
        offer,
        evaluatedLatest.get(offer.id) ?? historicalEvaluation.get(offer.id)!,
        market.mandate.exchangeRateSource,
      )),
    );
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
        retainedOffer: retainedByCarrier.get(carrier.id) ?? null,
        latestCall,
        rank: latestOffer ? ranks.get(latestOffer.id) || null : null,
        instruction,
        negotiationRounds: Number(row.negotiation_rounds || 0),
        humanReason: nullableString(row.human_reason),
        purpose: nullableString(row.purpose),
        amendmentId: nullableString(row.amendment_id),
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
      currency: input.currency?.toUpperCase() || market.mandate.currency,
      rateAllIn: true,
      pickupTime: input.pickupTime,
      expectedArrival: input.expectedArrival,
      // A quote entered through the typed HTTP API is already an operator-
      // confirmed record. Voice updates use the progressive path and must earn
      // firm=true through the explicit recap-confirmation state.
      firm: input.isFinalOffer ?? true,
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
    // The server times the evidence from the call clock. A model cannot move
    // a fact to a different moment of the recording by mis-stating an offset.
    const evidenceOffsetMs = this.evidenceOffset(callId || prior?.callId || null, now);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO procurement_offer_versions (
        id, market_id, carrier_id, call_id, version, availability, price, currency, rate_all_in,
        pickup_time, expected_arrival, firm, expires_at, accessorials, carrier_conditions,
        confirmed_requirements, rejected_requirements, raw_statement, confidence, human_required, human_reason,
        supersedes_version_id, created_at, conversation_item_id, evidence_offset_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offerId, marketId, carrierId, callId || prior?.callId || null, version, merged.availability,
        merged.price, merged.currency, nullableBoolean(merged.rateAllIn), merged.pickupTime,
        merged.expectedArrival, nullableBoolean(merged.firm), merged.expiresAt,
        JSON.stringify(merged.accessorials), JSON.stringify(merged.carrierConditions),
        JSON.stringify(merged.confirmedRequirements), JSON.stringify(merged.rejectedRequirements), merged.rawStatement, merged.confidence,
        merged.humanRequired ? 1 : 0, merged.humanReason, prior?.id || null, now,
        merged.conversationItemId, evidenceOffsetMs,
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
        JSON.stringify({
          offerId,
          carrierId,
          availability: merged.availability,
          price: merged.price,
          currency: merged.currency,
          normalizedPrice: evaluated.normalizedPrice,
          normalizedCurrency: evaluated.normalizedCurrency,
          exchangeRate: evaluated.exchangeRate,
          arrival: merged.expectedArrival,
          rateAllIn: merged.rateAllIn,
          classification: evaluated.classification,
          missingFields: evaluated.missingFields,
          violations: evaluated.violations.map((violation) => violation.message),
          version,
          late,
        }), now);
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
    else if (market.reason === "AMENDMENT_REVALIDATION") this.acceptOriginalAmendmentIfRevalidationExhausted(marketId);
    return this.getMarketState(marketId)!;
  }

  getProcurementCallContext(callId: string): ProcurementCallContext | null {
    const call = this.calls.getCall(callId);
    if (!call?.marketId || !call.orderId || !(call.carrierId || call.contactId)) return null;
    const workspace = this.getOrder(call.orderId);
    const state = workspace?.markets.find((candidate) => candidate.market.id === call.marketId);
    const carrierState = state?.carriers.find((candidate) => candidate.carrier.id === (call.carrierId || call.contactId));
    if (!workspace || !state || !carrierState) return null;
    const commitment = state.activeCommitment;
    const awardedOffer = commitment?.carrierId === carrierState.carrier.id
      ? state.offers.find((offer) => offer.id === commitment.offerId) ?? null
      : null;
    return {
      callId,
      award: commitment && awardedOffer
        ? { commitmentId: commitment.id, offer: awardedOffer, recapAddress: commitment.recapAddress }
        : null,
      order: workspace.order,
      market: state.market,
      carrier: carrierState.carrier,
      latestOffer: carrierState.latestOffer,
      retainedOffer: carrierState.retainedOffer,
      activeCommitment: state.activeCommitment,
      isCommittedCarrier: state.activeCommitment?.carrierId === carrierState.carrier.id,
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
    return this.matchInboundCall(callId, { reference });
  }

  matchInboundCall(callId: string, evidence: InboundMatchEvidence): InboundMarketAttachment {
    const call = this.calls.getCall(callId);
    if (!call || call.direction !== "INBOUND") return { status: "NOT_FOUND", marketId: null, candidates: [] };
    if (call.marketId) {
      const market = this.getMarket(call.marketId);
      return { status: market && ["COMMITTED", "CLOSED"].includes(market.status) ? "CLOSED" : "ATTACHED", marketId: call.marketId, candidates: [] };
    }
    const rows = this.db.prepare(`SELECT markets.id AS market_id, markets.order_id, markets.status, markets.sequence_number,
      orders.reference, orders.name, orders.origin, orders.destination, market_carriers.carrier_id, contacts.label AS carrier_label
      FROM market_carriers JOIN markets ON markets.id = market_carriers.market_id
      JOIN orders ON orders.id = markets.order_id
      JOIN contacts ON contacts.id = market_carriers.carrier_id
      ORDER BY CASE WHEN markets.status IN ('CALLING', 'NEGOTIATING', 'OPEN', 'HUMAN_REVIEW') THEN 0 ELSE 1 END,
        markets.updated_at DESC`).all() as Row[];
    const normalizedReference = evidence.reference?.trim() ? normalizeOrderReference(evidence.reference) : null;
    const normalizedCarrier = evidence.carrierName?.trim() ? normalizeLocation(evidence.carrierName) : null;
    const normalizedOrigin = evidence.origin?.trim() ? normalizeLocation(evidence.origin) : null;
    const normalizedDestination = evidence.destination?.trim() ? normalizeLocation(evidence.destination) : null;
    const baseMatches = rows.filter((row) => {
      if (normalizedReference && normalizeOrderReference(String(row.reference || row.name)) !== normalizedReference) return false;
      if (normalizedOrigin && normalizeLocation(String(row.origin)) !== normalizedOrigin) return false;
      if (normalizedDestination && normalizeLocation(String(row.destination)) !== normalizedDestination) return false;
      if (!normalizedReference && !normalizedOrigin && !normalizedDestination) {
        return ["CALLING", "NEGOTIATING", "OPEN", "HUMAN_REVIEW"].includes(String(row.status));
      }
      return true;
    });
    let matching = baseMatches;
    if (normalizedCarrier) {
      matching = matching.filter((row) => normalizeLocation(String(row.carrier_label)) === normalizedCarrier);
    } else if (call.contactId) {
      const callerIdMatches = matching.filter((row) => String(row.carrier_id) === call.contactId);
      if (callerIdMatches.length > 0) matching = callerIdMatches;
    }
    const candidateRows = matching.length > 0 ? matching : baseMatches;
    const candidates = [...new Map(candidateRows.map((row) => [String(row.market_id), {
      marketId: String(row.market_id),
      orderReference: String(row.reference || row.name),
    }])).values()];
    if (matching.length !== 1) {
      const hasEvidence = Boolean(normalizedReference || normalizedCarrier || normalizedOrigin || normalizedDestination);
      const attempts = hasEvidence
        ? Number((this.db.prepare(`UPDATE calls SET identification_attempts = identification_attempts + 1,
            updated_at = ? WHERE id = ? RETURNING identification_attempts`).get(new Date().toISOString(), callId) as Row | undefined)?.identification_attempts || 1)
        : 0;
      const distinctOrders = new Set(baseMatches.map((row) => String(row.order_id)));
      const suggestedQuestion = !normalizedReference ? "Ask for the order/reference number."
        : baseMatches.length === 0 ? "Ask the caller to repeat the order/reference number."
          : distinctOrders.size > 1 && !normalizedOrigin ? "Ask for the pickup city."
            : !normalizedCarrier || matching.length === 0 ? "Ask for the carrier company name."
              : !normalizedDestination ? "Ask for the destination city." : null;
      return {
        status: matching.length > 1 ? "AMBIGUOUS" : "NOT_FOUND",
        marketId: null,
        candidates,
        attempts,
        suggestedQuestion,
        shouldEscalate: attempts >= 3,
      };
    }
    const target = matching[0]!;
    const now = new Date().toISOString();
    const closed = ["COMMITTED", "CLOSED"].includes(String(target.status));
    this.db.transaction(() => {
      this.db.prepare(`UPDATE calls SET order_id = ?, market_id = ?, carrier_id = ?, market_session_state = ?, updated_at = ? WHERE id = ?`)
        .run(String(target.order_id), String(target.market_id), String(target.carrier_id), closed ? "AMENDMENT" : "DISCOVERY", now, callId);
      this.db.prepare("UPDATE markets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, String(target.market_id));
      this.insertEvent(String(target.order_id), String(target.market_id), callId, closed ? "LATE_INBOUND_CALL" : "INBOUND_CALL_ATTACHED",
        closed ? "Carrier called after market close" : "Inbound carrier callback attached", now);
    })();
    if (!closed) this.reevaluateMarket(String(target.market_id));
    return { status: closed ? "CLOSED" : "ATTACHED", marketId: String(target.market_id), candidates, attempts: 0, shouldEscalate: false };
  }

  proposeAmendmentForCall(callId: string, input: AmendmentProposalInput): AmendmentDecision {
    const context = this.getProcurementCallContext(callId);
    if (!context?.marketClosed || !context.activeCommitment || !context.isCommittedCarrier) {
      throw new Error("Only the booked carrier can propose an amendment to the active commitment.");
    }
    const existing = this.getAmendmentByCall(callId);
    if (existing && ["ACCEPTED", "RECOVERY_REQUIRED", "HUMAN_REQUIRED", "REJECTED"].includes(existing.status)) {
      return amendmentDecisionFromRecord(existing, undefined, this.isRevalidationAmendment(existing));
    }
    if (input.price !== undefined && input.price !== null && (!Number.isInteger(input.price) || input.price < 0)) {
      throw new Error("Amended price must be a non-negative whole amount.");
    }
    const committedOffer = this.getMarketState(context.market.id)?.offers
      .find((offer) => offer.id === context.activeCommitment?.offerId);
    if (!committedOffer) throw new Error("The active commitment terms could not be reconstructed.");
    const originalTerms = amendmentTerms(committedOffer);
    const requestedTerms: AmendmentTerms = {
      price: input.price !== undefined ? input.price : originalTerms.price,
      currency: input.currency !== undefined ? input.currency?.toUpperCase() || null : originalTerms.currency,
      pickupTime: input.pickupTime !== undefined ? nullableDate(input.pickupTime) : originalTerms.pickupTime,
      expectedArrival: input.expectedArrival !== undefined ? nullableDate(input.expectedArrival) : originalTerms.expectedArrival,
    };
    const carrierUnavailable = input.availability === "UNAVAILABLE";
    const unsupported = input.unsupportedChange?.trim() || null;
    if (unsupported) {
      const amendment = this.persistAmendment({
        existing, context, status: "HUMAN_REQUIRED", originalTerms, requestedTerms,
        finalTerms: null, violations: [], decisionReason: `Unsupported amendment: ${unsupported}`, recoveryMarketId: null,
      });
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ? WHERE id = ?`)
        .run(`Human review required: ${unsupported}`, now, context.order.id);
      this.insertEvent(context.order.id, context.market.id, callId, "AMENDMENT_HUMAN_REQUIRED", unsupported, now);
      return amendmentDecisionFromRecord(amendment);
    }
    if (!carrierUnavailable && sameAmendmentTerms(originalTerms, requestedTerms)) {
      throw new Error("No price, pickup, or delivery change was provided.");
    }

    const revisedFacts: ProcurementOfferFacts = {
      ...toOfferFacts(committedOffer),
      id: `amendment-${existing?.id ?? callId}`,
      availability: carrierUnavailable ? "UNAVAILABLE" : "AVAILABLE",
      price: requestedTerms.price,
      currency: requestedTerms.currency,
      pickupTime: requestedTerms.pickupTime,
      expectedArrival: requestedTerms.expectedArrival,
    };
    const revised = evaluateOffers(context.market.mandate, [revisedFacts])[0]!;
    if (!carrierUnavailable && (!revised.feasible || !revised.comparable) && !input.negotiationComplete) {
      const amendment = this.persistAmendment({
        existing, context, status: "NEGOTIATING", originalTerms, requestedTerms, finalTerms: null,
        violations: revised.violations, decisionReason: revised.comparable
          ? "Requested terms are outside the mandate; negotiate back into the feasible region."
          : `Requested terms are incomplete: ${revised.missingFields.join(", ")}.`, recoveryMarketId: null,
      });
      this.insertEvent(context.order.id, context.market.id, callId, "AMENDMENT_NEGOTIATION_STARTED",
        JSON.stringify({ amendmentId: amendment.id, violations: revised.violations }), new Date().toISOString());
      return amendmentDecisionFromRecord(amendment, context.market.mandate);
    }

    const betterRetainedOffers = revised.feasible && revised.comparable
      ? this.betterRetainedOffers(context.market.id, committedOffer.carrierId, revisedFacts)
      : [];
    if (revised.feasible && revised.comparable && betterRetainedOffers.length === 0) {
      const amendment = this.acceptAmendment(existing, context, committedOffer, originalTerms, requestedTerms);
      return amendmentDecisionFromRecord(amendment);
    }

    if (revised.feasible && revised.comparable) {
      const reason = "The amendment is feasible, but a better retained offer must be reconfirmed before changing the carrier.";
      let amendment = this.persistAmendment({
        existing, context, status: "RECOVERY_REQUIRED", originalTerms, requestedTerms, finalTerms: null,
        violations: [], decisionReason: reason, recoveryMarketId: null,
      });
      const revalidationMarket = this.createRetainedOfferRevalidationMarket(
        context,
        amendment,
        betterRetainedOffers,
        revised.normalizedPrice,
      );
      this.db.prepare("UPDATE order_amendments SET recovery_market_id = ?, resolved_at = NULL WHERE id = ?")
        .run(revalidationMarket.id, amendment.id);
      amendment = this.getAmendment(amendment.id)!;
      return amendmentDecisionFromRecord(amendment, undefined, true);
    }

    const reason = carrierUnavailable
      ? "The committed carrier is no longer available; recovery is required."
      : "Negotiation did not restore a complete feasible commitment; recovery is required.";
    const recovery = this.getOrder(context.order.id)?.markets.find((state) =>
      ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(state.market.status)
      && state.market.id !== context.market.id);
    const recoveryCarrierIds = recovery ? [] : this.selectRecoveryCandidates(
      context.order.id,
      false,
      context.activeCommitment.carrierId,
    );
    if (!recovery && recoveryCarrierIds.length === 0) {
      const amendment = this.persistAmendment({
        existing, context, status: "HUMAN_REQUIRED", originalTerms, requestedTerms, finalTerms: null,
        violations: revised.violations, decisionReason: `${reason} No alternate carrier is available to contact.`, recoveryMarketId: null,
      });
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ? WHERE id = ?`)
        .run("No alternate carrier is available; human assistance is required.", now, context.order.id);
      this.insertEvent(context.order.id, context.market.id, callId, "AMENDMENT_HUMAN_REQUIRED",
        "No alternate carrier is available to contact.", now);
      return amendmentDecisionFromRecord(amendment);
    }
    let amendment = this.persistAmendment({
      existing, context, status: "RECOVERY_REQUIRED", originalTerms, requestedTerms, finalTerms: null,
      violations: revised.violations, decisionReason: reason, recoveryMarketId: null,
    });
    const workspace = recovery
      ? this.getOrder(context.order.id)!
      : this.createRecoveryMarket(context.order.id, recoveryCarrierIds);
    const recoveryMarket = recovery?.market ?? workspace.currentMarket?.market ?? null;
    if (recoveryMarket) {
      this.db.prepare("UPDATE order_amendments SET recovery_market_id = ? WHERE id = ?").run(recoveryMarket.id, amendment.id);
      amendment = this.getAmendment(amendment.id)!;
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ? WHERE id = ?`)
      .run("Commitment at risk; recovery market open.", now, context.order.id);
    this.insertEvent(context.order.id, recoveryMarket?.id ?? context.market.id, callId, "COMMITMENT_AT_RISK",
      JSON.stringify({ amendmentId: amendment.id, reason, violations: revised.violations }), now);
    return amendmentDecisionFromRecord(amendment);
  }

  private betterRetainedOffers(marketId: string, carrierId: string, revised: ProcurementOfferFacts): OfferRecord[] {
    const state = this.getMarketState(marketId);
    if (!state) return [];
    const alternatives = state.carriers.flatMap((carrier) => {
      if (carrier.carrier.id === carrierId || !carrier.latestOffer) return [];
      return [{ record: carrier.latestOffer, facts: toOfferFacts(carrier.latestOffer) }];
    });
    const evaluated = evaluateOffers(state.market.mandate, [revised, ...alternatives.map((entry) => entry.facts)])
      .filter((offer) => offer.comparable && offer.feasible)
      .sort((left, right) => right.score - left.score
        || (left.normalizedPrice ?? Infinity) - (right.normalizedPrice ?? Infinity)
        || left.id.localeCompare(right.id));
    const revisedIndex = evaluated.findIndex((offer) => offer.id === revised.id);
    if (revisedIndex <= 0) return [];
    const betterIds = new Set(evaluated.slice(0, revisedIndex).map((offer) => offer.id));
    return alternatives
      .filter((entry) => betterIds.has(entry.record.id))
      .map((entry) => entry.record)
      .slice(0, 3);
  }

  private createRetainedOfferRevalidationMarket(
    context: ProcurementCallContext,
    amendment: AmendmentRecord,
    offers: OfferRecord[],
    revisedNormalizedPrice: number | null,
  ): MarketRecord {
    if (offers.length === 0) throw new Error("No retained offer is available to revalidate.");
    const openMarket = this.db.prepare(`SELECT id, reason FROM markets WHERE order_id = ?
      AND status IN ('DRAFT', 'OPEN', 'CALLING', 'NEGOTIATING') LIMIT 1`).get(context.order.id) as Row | undefined;
    if (openMarket) {
      if (String(openMarket.reason) === "AMENDMENT_REVALIDATION") return this.getMarket(String(openMarket.id))!;
      throw new Error("This order already has an open market.");
    }
    const next = Number((this.db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM markets WHERE order_id = ?")
      .get(context.order.id) as Row).next);
    const now = new Date().toISOString();
    const marketId = randomUUID();
    const mandate = mandateFromOrder(context.order);
    if (revisedNormalizedPrice !== null) {
      mandate.maximumPrice = Math.min(mandate.maximumPrice, Math.max(0, Math.ceil(revisedNormalizedPrice) - 1));
      mandate.targetPrice = Math.min(mandate.targetPrice, mandate.maximumPrice);
    }
    mandate.minimumValidOffers = 1;
    mandate.desiredCarriers = offers.length;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO markets
        (id, order_id, sequence_number, status, reason, mandate_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, 'DRAFT', 'AMENDMENT_REVALIDATION', ?, ?, ?)`).run(
        marketId, context.order.id, next, JSON.stringify(mandate), now, now,
      );
      const insert = this.db.prepare(`INSERT INTO market_carriers
        (market_id, carrier_id, status, purpose, source_offer_id, amendment_id, negotiation_rounds, created_at, updated_at)
        VALUES (?, ?, 'SELECTED', 'REVALIDATE_RETAINED_OFFER', ?, ?, 1, ?, ?)`);
      for (const offer of offers) insert.run(marketId, offer.carrierId, offer.id, amendment.id, now, now);
      this.db.prepare(`UPDATE orders SET lifecycle_status = 'EXCEPTION', exception_reason = ?, updated_at = ? WHERE id = ?`)
        .run("Revalidating a better retained offer while the current commitment remains active.", now, context.order.id);
      this.insertEvent(context.order.id, marketId, context.callId, "REVALIDATION_MARKET_CREATED",
        JSON.stringify({ amendmentId: amendment.id, retainedOfferIds: offers.map((offer) => offer.id) }), now);
    })();
    return this.getMarket(marketId)!;
  }

  private isRevalidationAmendment(amendment: AmendmentRecord): boolean {
    return Boolean(amendment.recoveryMarketId
      && this.getMarket(amendment.recoveryMarketId)?.reason === "AMENDMENT_REVALIDATION");
  }

  private acceptAmendment(
    existing: AmendmentRecord | null,
    context: ProcurementCallContext,
    committedOffer: OfferRecord,
    originalTerms: AmendmentTerms,
    requestedTerms: AmendmentTerms,
    recoveryMarketId: string | null = null,
    decisionReason = "Amendment remains within mandate and is still the best retained-market option.",
  ): AmendmentRecord {
    const now = new Date().toISOString();
    const offerId = randomUUID();
    const amendmentId = existing?.id ?? randomUUID();
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT offer_id, status FROM commitments WHERE id = ?").get(context.activeCommitment!.id) as Row | undefined;
      if (!current || String(current.status) !== "ACTIVE") throw new Error("The commitment changed while the amendment was being evaluated.");
      if (existing && String(current.offer_id) !== context.activeCommitment!.offerId) throw new Error("The amendment is stale.");
      const previous = this.db.prepare(`SELECT id, version FROM procurement_offer_versions
        WHERE market_id = ? AND carrier_id = ? ORDER BY version DESC LIMIT 1`).get(context.market.id, context.carrier.id) as Row;
      const version = Number(previous.version) + 1;
      this.db.prepare(`INSERT INTO procurement_offer_versions (
        id, market_id, carrier_id, call_id, version, availability, price, currency, rate_all_in,
        pickup_time, expected_arrival, firm, expires_at, accessorials, carrier_conditions,
        confirmed_requirements, rejected_requirements, raw_statement, confidence, human_required, human_reason,
        supersedes_version_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`).run(
        offerId, context.market.id, context.carrier.id, context.callId, version,
        requestedTerms.price, requestedTerms.currency, requestedTerms.pickupTime, requestedTerms.expectedArrival,
        committedOffer.expiresAt, JSON.stringify(committedOffer.accessorials), JSON.stringify(committedOffer.carrierConditions),
        JSON.stringify(committedOffer.confirmedRequirements), JSON.stringify(committedOffer.rejectedRequirements),
        `Accepted carrier amendment on call ${context.callId}`, committedOffer.confidence, String(previous.id), now,
      );
      this.db.prepare(`INSERT INTO offers (
        id, market_id, carrier_id, call_id, price, currency, pickup_time, expected_arrival,
        waiting_time_included, extra_fees, conditions, is_final_offer, requires_immediate_decision,
        callback_allowed, supersedes_offer_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`).run(
        offerId, context.market.id, context.carrier.id, context.callId, requestedTerms.price, requestedTerms.currency,
        requestedTerms.pickupTime, requestedTerms.expectedArrival, committedOffer.waitingTimeIncluded,
        committedOffer.extraFees, committedOffer.conditions, context.activeCommitment!.offerId, now,
      );
      this.db.prepare("UPDATE commitments SET offer_id = ? WHERE id = ? AND status = 'ACTIVE'")
        .run(offerId, context.activeCommitment!.id);
      this.upsertAmendmentRow({
        id: amendmentId, callId: context.callId, orderId: context.order.id, commitmentId: context.activeCommitment!.id,
        status: "ACCEPTED", originalTerms, requestedTerms, finalTerms: requestedTerms,
        violations: [], decisionReason,
        recoveryMarketId, now, resolvedAt: now,
      });
      this.db.prepare(`UPDATE orders SET lifecycle_status = 'COMMITTED', exception_reason = NULL, updated_at = ? WHERE id = ?`)
        .run(now, context.order.id);
      this.db.prepare("UPDATE markets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, context.market.id);
      this.insertEvent(context.order.id, context.market.id, context.callId, "AMENDMENT_ACCEPTED",
        JSON.stringify({ amendmentId, originalTerms, requestedTerms, outboundCallsCreated: 0 }), now);
    })();
    return this.getAmendment(amendmentId)!;
  }

  private acceptOriginalAmendmentIfRevalidationExhausted(marketId: string): void {
    const market = this.getMarket(marketId);
    if (!market || market.reason !== "AMENDMENT_REVALIDATION"
      || ["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(market.status)) return;
    const state = this.getMarketState(marketId);
    if (!state || state.carriers.length === 0) return;
    const resolvedWithoutBetterOffer = state.carriers.every((carrier) => Boolean(
      carrier.latestOffer
      && (carrier.latestOffer.availability === "UNAVAILABLE"
        || carrier.instruction.action === "RELEASE"
        || carrier.instruction.action === "HUMAN_REQUIRED"),
    ));
    if (!resolvedWithoutBetterOffer) return;
    const amendment = this.listAmendments(market.orderId)
      .find((candidate) => candidate.recoveryMarketId === marketId && candidate.status === "RECOVERY_REQUIRED");
    if (!amendment?.callId) return;
    const context = this.getProcurementCallContext(amendment.callId);
    if (!context?.activeCommitment || !context.isCommittedCarrier) return;
    const committedOffer = this.getMarketState(context.market.id)?.offers
      .find((offer) => offer.id === context.activeCommitment?.offerId);
    if (!committedOffer) return;
    const accepted = this.acceptAmendment(
      amendment,
      context,
      committedOffer,
      amendment.originalTerms,
      amendment.requestedTerms,
      marketId,
      "No retained competitor reconfirmed a better offer; the original carrier's feasible amendment remains best and was confirmed.",
    );
    const now = new Date().toISOString();
    this.db.prepare("UPDATE markets SET status = 'CANCELED', closed_at = ?, review_reason = NULL, updated_at = ? WHERE id = ?")
      .run(now, now, marketId);
    this.insertEvent(market.orderId, marketId, amendment.callId, "REVALIDATION_EXHAUSTED",
      JSON.stringify({ amendmentId: accepted.id, action: "ORIGINAL_AMENDMENT_CONFIRMED" }), now);
  }

  private persistAmendment(input: {
    existing: AmendmentRecord | null;
    context: ProcurementCallContext;
    status: AmendmentRecord["status"];
    originalTerms: AmendmentTerms;
    requestedTerms: AmendmentTerms;
    finalTerms: AmendmentTerms | null;
    violations: AmendmentRecord["violations"];
    decisionReason: string;
    recoveryMarketId: string | null;
  }): AmendmentRecord {
    const now = new Date().toISOString();
    const id = input.existing?.id ?? randomUUID();
    this.upsertAmendmentRow({
      id, callId: input.context.callId, orderId: input.context.order.id, commitmentId: input.context.activeCommitment!.id,
      status: input.status, originalTerms: input.originalTerms, requestedTerms: input.requestedTerms,
      finalTerms: input.finalTerms, violations: input.violations, decisionReason: input.decisionReason,
      recoveryMarketId: input.recoveryMarketId, now,
      resolvedAt: ["NEGOTIATING", "PROPOSED", "RECOVERY_REQUIRED"].includes(input.status) ? null : now,
    });
    return this.getAmendment(id)!;
  }

  private upsertAmendmentRow(input: {
    id: string; callId: string; orderId: string; commitmentId: string; status: AmendmentRecord["status"];
    originalTerms: AmendmentTerms; requestedTerms: AmendmentTerms; finalTerms: AmendmentTerms | null;
    violations: AmendmentRecord["violations"]; decisionReason: string; recoveryMarketId: string | null;
    now: string; resolvedAt: string | null;
  }): void {
    this.db.prepare(`INSERT INTO order_amendments (
      id, order_id, commitment_id, call_id, status, original_terms, requested_terms, final_terms,
      violations, decision_reason, recovery_market_id, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET status = excluded.status, requested_terms = excluded.requested_terms,
      final_terms = excluded.final_terms, violations = excluded.violations, decision_reason = excluded.decision_reason,
      recovery_market_id = excluded.recovery_market_id, resolved_at = excluded.resolved_at`).run(
      input.id, input.orderId, input.commitmentId, input.callId, input.status,
      JSON.stringify(input.originalTerms), JSON.stringify(input.requestedTerms), input.finalTerms ? JSON.stringify(input.finalTerms) : null,
      JSON.stringify(input.violations), input.decisionReason, input.recoveryMarketId, input.now, input.resolvedAt,
    );
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
    const nextRevision = market.revision + 1;
    const awardInstruction = instructionForPersistence("AWARD", "offer_committed_by_operator", nextRevision);
    const releaseInstruction = instructionForPersistence("RELEASE", "market_awarded_to_better_offer", nextRevision);
    this.db.transaction(() => {
      const active = this.db.prepare("SELECT id, market_id FROM commitments WHERE order_id = ? AND status = 'ACTIVE'")
        .get(market.orderId) as Row | undefined;
      if (active && String(active.market_id) === market.id) throw new Error("This market already has an active commitment.");
      if (active) this.invalidatePriorCommitmentForRecovery(active, market, now);
      this.db.prepare(`INSERT INTO commitments
        (id, order_id, market_id, offer_id, carrier_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`).run(commitmentId, market.orderId, market.id, offer.id, offer.carrierId, now);
      this.db.prepare("UPDATE markets SET status = 'COMMITTED', revision = ?, closed_at = ?, updated_at = ? WHERE id = ?")
        .run(nextRevision, now, now, market.id);
      this.db.prepare("UPDATE orders SET lifecycle_status = 'COMMITTED', exception_reason = NULL, updated_at = ? WHERE id = ?")
        .run(now, market.orderId);
      this.db.prepare(`UPDATE market_carriers SET
        status = CASE WHEN carrier_id = ? THEN 'FINAL' ELSE 'RELEASED' END,
        evaluator_action = CASE WHEN carrier_id = ? THEN 'AWARD' ELSE 'RELEASE' END,
        action_reason = CASE WHEN carrier_id = ? THEN 'offer_committed_by_operator' ELSE 'market_awarded_to_better_offer' END,
        action_payload = CASE WHEN carrier_id = ? THEN ? ELSE ? END,
        action_revision = ?, updated_at = ? WHERE market_id = ?`)
        .run(offer.carrierId, offer.carrierId, offer.carrierId, offer.carrierId,
          JSON.stringify(awardInstruction), JSON.stringify(releaseInstruction), nextRevision, now, market.id);
      this.db.prepare(`UPDATE calls SET market_session_state = CASE
        WHEN COALESCE(carrier_id, contact_id) = ? THEN 'AWARDED' ELSE 'RELEASED' END,
        updated_at = ? WHERE market_id = ? AND status IN ('REQUESTED', 'INITIATED', 'RINGING', 'IN_PROGRESS')`)
        .run(offer.carrierId, now, market.id);
      this.insertEvent(market.orderId, market.id, offer.callId, "OFFER_COMMITTED", `Committed offer in ${offer.currency}`, now);
      if (active) this.insertEvent(market.orderId, market.id, offer.callId, "ORDER_RECOVERED",
        `Original carrier replaced by ${offer.carrierLabel}; mandate preserved.`, now);
      const order = this.getOrderRecord(market.orderId);
      const carrier = state.carriers.find((candidate) => candidate.carrier.id === offer.carrierId)?.carrier;
      if (order && carrier) this.queueRecap(commitmentId, order, carrier, offer, now);
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
    const selectedIds = carrierIds?.length ? [...new Set(carrierIds)] : this.selectRecoveryCandidates(orderId);
    if (selectedIds.length < 1 || selectedIds.length > 3) throw new Error("Select between one and three carriers for recovery.");
    const selectedContacts = this.calls.getContacts(selectedIds);
    if (selectedContacts.length !== selectedIds.length) throw new Error("One or more recovery carriers no longer exist.");
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
      this.insertEvent(orderId, marketId, null, "RECOVERY_MARKET_CREATED",
        `Matching with best alternative carriers with similar orders. Calling ${selectedContacts.map((contact) => contact.label).join(", ")}.`, now);
    })();
    return this.getOrder(orderId)!;
  }

  private selectRecoveryCandidates(
    orderId: string,
    includeFailedFallback = true,
    excludedCarrierId?: string,
  ): string[] {
    const workspace = this.getOrder(orderId);
    if (!workspace) return [];
    const atRiskCommitmentId = workspace.amendments.find((amendment) => amendment.status === "RECOVERY_REQUIRED")?.commitmentId;
    const failedCarrierId = excludedCarrierId
      ?? workspace.commitments.find((commitment) => commitment.id === atRiskCommitmentId)?.carrierId
      ?? workspace.commitments.find((commitment) => commitment.status === "INVALIDATED")?.carrierId
      ?? null;
    const latestCarrierStates = new Map<string, MarketCarrierState>();
    for (const state of workspace.markets) {
      for (const carrier of state.carriers) {
        if (!latestCarrierStates.has(carrier.carrier.id)) latestCarrierStates.set(carrier.carrier.id, carrier);
      }
    }
    const bestRetainedCarrierId = [...latestCarrierStates.values()]
      .filter((carrier) => carrier.carrier.id !== failedCarrierId
        && carrier.latestOffer?.availability === "AVAILABLE"
        && carrier.latestOffer.isComparable
        && carrier.latestOffer.isValid)
      .sort((left, right) => (right.latestOffer?.score ?? 0) - (left.latestOffer?.score ?? 0)
        || (left.latestOffer?.normalizedPrice ?? Infinity) - (right.latestOffer?.normalizedPrice ?? Infinity)
        || left.carrier.label.localeCompare(right.carrier.label)
        || left.carrier.id.localeCompare(right.carrier.id))[0]?.carrier.id;
    if (bestRetainedCarrierId) return [bestRetainedCarrierId];

    const dhl = this.calls.listContacts().find((contact) => contact.label.trim().toLowerCase() === "dhl");
    const latestDhlOffer = dhl ? latestCarrierStates.get(dhl.id)?.latestOffer : null;
    if (dhl && dhl.id !== failedCarrierId && latestDhlOffer?.availability !== "UNAVAILABLE") return [dhl.id];
    if (failedCarrierId && includeFailedFallback) return [failedCarrierId];
    // A market that closed with no offers has no retained quote to fall back
    // on and no failed carrier to exclude; recovery then means re-dialing the
    // carriers the order was created with, rather than refusing outright.
    const originalCarrierIds = (this.db.prepare(
      "SELECT carrier_id FROM order_carriers WHERE order_id = ? ORDER BY selected_at, carrier_id",
    ).all(orderId) as Row[])
      .map((row) => String(row.carrier_id))
      .filter((carrierId) => carrierId !== failedCarrierId)
      .slice(0, 3);
    return originalCarrierIds;
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
    const commitmentId = randomUUID();
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT revision, status, automatic_award FROM markets WHERE id = ?").get(marketId) as Row | undefined;
      if (!current || Number(current.revision) !== expectedRevision || !Boolean(current.automatic_award)
        || ["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(String(current.status))) return;
      const latest = this.db.prepare(`SELECT id FROM procurement_offer_versions WHERE market_id = ? AND carrier_id = ?
        ORDER BY version DESC LIMIT 1`).get(marketId, offer.carrierId) as Row | undefined;
      if (String(latest?.id || "") !== expectedOfferId) return;
      const active = this.db.prepare("SELECT id, market_id, carrier_id FROM commitments WHERE order_id = ? AND status = 'ACTIVE'")
        .get(market.orderId) as Row | undefined;
      if (active && String(active.market_id) === marketId) return;
      if (active) this.invalidatePriorCommitmentForRecovery(active, market, now);
      this.db.prepare(`INSERT INTO commitments
        (id, order_id, market_id, offer_id, carrier_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`).run(commitmentId, market.orderId, marketId, offer.id, offer.carrierId, now);
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
      if (active) {
        const replacementMessage = market.reason === "AMENDMENT_REVALIDATION"
          ? `Retained offer reconfirmed; original carrier replaced by ${offer.carrierLabel}.`
          : `Original carrier replaced by ${offer.carrierLabel}; mandate preserved.`;
        this.insertEvent(market.orderId, marketId, offer.callId, "ORDER_RECOVERED", replacementMessage, now);
      }
      if (market.reason === "AMENDMENT_REVALIDATION") {
        const finalTerms = amendmentTerms(offer);
        this.db.prepare(`UPDATE order_amendments SET status = 'ACCEPTED', final_terms = ?, violations = '[]',
          decision_reason = ?, resolved_at = ? WHERE recovery_market_id = ?`).run(
          JSON.stringify(finalTerms),
          `A better retained offer was reconfirmed by ${offer.carrierLabel}; the commitment was switched atomically.`,
          now,
          market.id,
        );
        this.insertEvent(market.orderId, market.id, offer.callId, "RETAINED_OFFER_RECONFIRMED",
          JSON.stringify({ carrierId: offer.carrierId, offerId: offer.id, finalTerms }), now);
      }
      const order = this.getOrderRecord(market.orderId);
      const carrier = state.carriers.find((candidate) => candidate.carrier.id === offer.carrierId)?.carrier;
      if (order && carrier) this.queueRecap(commitmentId, order, carrier, offer, now);
    })();
  }

  private invalidatePriorCommitmentForRecovery(active: Row, targetMarket: MarketRecord, now: string): void {
    const order = this.db.prepare("SELECT lifecycle_status FROM orders WHERE id = ?").get(targetMarket.orderId) as Row | undefined;
    if (!["CARRIER_FAILURE", "AMENDMENT_REVALIDATION"].includes(targetMarket.reason)
      || String(order?.lifecycle_status) !== "EXCEPTION") {
      throw new Error("An active order commitment can only be replaced by an authorized recovery market.");
    }
    const reason = targetMarket.reason === "AMENDMENT_REVALIDATION"
      ? `Replaced after retained offer reconfirmation in market #${targetMarket.sequenceNumber}`
      : `Replaced atomically by recovery market #${targetMarket.sequenceNumber}`;
    this.db.prepare(`UPDATE commitments SET status = 'INVALIDATED', invalidated_at = ?, invalidation_reason = ?
      WHERE id = ? AND status = 'ACTIVE'`).run(now, reason, String(active.id));
    if (targetMarket.reason === "CARRIER_FAILURE") {
      this.db.prepare("UPDATE markets SET status = 'FAILED', updated_at = ? WHERE id = ?")
        .run(now, String(active.market_id));
    }
    this.insertEvent(targetMarket.orderId, String(active.market_id), null, "COMMITMENT_REPLACED", reason, now);
  }

  getRevalidationResolution(marketId: string): RevalidationResolution | null {
    const market = this.getMarket(marketId);
    if (!market || market.reason !== "AMENDMENT_REVALIDATION"
      || !["COMMITTED", "CANCELED"].includes(market.status)) return null;
    const workspace = this.getOrder(market.orderId);
    const amendment = workspace?.amendments.find((candidate) => candidate.recoveryMarketId === marketId);
    const active = workspace?.commitments.find((commitment) => commitment.status === "ACTIVE");
    const original = amendment
      ? workspace?.commitments.find((commitment) => commitment.id === amendment.commitmentId)
      : null;
    const originalCarrier = original
      ? workspace?.order.carriers.find((carrier) => carrier.id === original.carrierId)
      : null;
    const selectedCarrier = active
      ? workspace?.order.carriers.find((carrier) => carrier.id === active.carrierId)
      : null;
    if (!workspace || amendment?.status !== "ACCEPTED" || !active || !original || !originalCarrier || !selectedCarrier) return null;
    return {
      order: workspace.order,
      amendment,
      originalCarrier,
      selectedCarrier,
      originalMarketId: original.marketId,
      replaced: active.id !== original.id,
    };
  }

  private getOrderRecord(orderId: string): OrderRecord | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Row | undefined;
    return row ? this.toOrder(row) : null;
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
      exchangeRates: normalizeExchangeRates(String(row.currency), jsonNumberRecord(row.exchange_rates)),
      exchangeRateSource: nullableString(row.exchange_rate_source) || defaultExchangeRateSource(String(row.currency)),
      targetPrice: Number(row.target_price),
      maximumPrice: Number(row.maximum_price),
      preferredPickup: nullableString(row.preferred_pickup),
      mustPickupBy: nullableString(row.must_pickup_by),
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

  /**
   * Milliseconds from the start of the audio to the moment the fact was
   * recorded. Measured against the answered leg when Twilio has reported it,
   * because recording begins when the carrier picks up, not when we dial.
   */
  private evidenceOffset(callId: string | null, capturedAt: string): number | null {
    if (!callId) return null;
    const call = this.calls.getCall(callId);
    const anchor = call?.answeredAt || call?.startedAt;
    if (!anchor) return null;
    const offset = Date.parse(capturedAt) - Date.parse(anchor);
    return Number.isFinite(offset) && offset >= 0 ? offset : null;
  }

  /**
   * Resolves each recorded fact to a playable position in the call audio. The
   * recording's own start time wins when Twilio has reported it, since the
   * media begins there rather than at the answered event.
   */
  private attachEvidence(offers: OfferRecord[]): OfferRecord[] {
    const cache = new Map<string, { audioUrl: string | null; recordingStartTime: string | null }>();
    const lookup = (callId: string) => {
      const cached = cache.get(callId);
      if (cached) return cached;
      const row = this.db.prepare(`SELECT recordings.recording_url, recordings.recording_start_time
        FROM calls LEFT JOIN recordings ON recordings.twilio_call_sid = calls.twilio_call_sid
        WHERE calls.id = ? ORDER BY recordings.created_at DESC LIMIT 1`).get(callId) as Row | undefined;
      const resolved = {
        audioUrl: nullableString(row?.recording_url) ? `/api/offers/AUDIO_ID/audio` : null,
        recordingStartTime: nullableString(row?.recording_start_time),
      };
      cache.set(callId, resolved);
      return resolved;
    };

    return offers.map((offer) => {
      if (!offer.callId) return offer;
      const { audioUrl, recordingStartTime } = lookup(offer.callId);
      const fromRecording = recordingStartTime
        ? Date.parse(offer.createdAt) - Date.parse(recordingStartTime)
        : Number.NaN;
      const offsetMs = Number.isFinite(fromRecording) && fromRecording >= 0 ? fromRecording : offer.evidenceOffsetMs;
      return {
        ...offer,
        evidence: {
          callId: offer.callId,
          audioUrl: audioUrl ? audioUrl.replace("AUDIO_ID", offer.id) : null,
          offsetMs,
          conversationItemId: offer.conversationItemId,
          rawStatement: offer.rawStatement,
          capturedAt: offer.createdAt,
        },
      };
    });
  }

  /**
   * The award is only half of a commitment; the carrier must hold the same
   * terms in writing. The body is frozen here, inside the award transaction,
   * and delivery is a separate retryable step so a Twilio outage can never
   * roll back a booking the carrier already accepted verbally.
   */
  private queueRecap(commitmentId: string, order: OrderRecord, carrier: Contact, offer: OfferRecord, now: string): void {
    const body = buildAwardRecapBody({
      commitmentId,
      order,
      carrierLabel: carrier.label,
      offer,
    });
    const deliverable = body.length <= RECAP_MAX_LENGTH && Boolean(carrier.e164PhoneNumber);
    this.db.prepare(`UPDATE commitments SET recap_status = ?, recap_channel = ?, recap_address = ?, recap_body = ?,
      recap_error = ? WHERE id = ?`).run(
      deliverable ? "PENDING" : "FAILED",
      "sms",
      carrier.e164PhoneNumber || null,
      body,
      deliverable ? null : "Recap could not be queued: the carrier has no phone number or the body exceeds the SMS limit.",
      commitmentId,
    );
    this.insertEvent(order.id, offer.marketId, offer.callId, deliverable ? "RECAP_QUEUED" : "RECAP_FAILED",
      deliverable ? `Written recap queued for ${carrier.e164PhoneNumber}` : "Recap could not be queued", now);
  }

  /**
   * The Twilio media behind one recorded fact, with the position in the audio
   * where it was said. The raw provider URL never leaves the server; callers
   * stream it through this app so recordings stay behind the dashboard's auth.
   */
  getOfferRecording(offerId: string): { recordingUrl: string; offsetMs: number | null } | null {
    const row = this.db.prepare(`SELECT procurement_offer_versions.created_at, procurement_offer_versions.evidence_offset_ms,
      recordings.recording_url, recordings.recording_start_time
      FROM procurement_offer_versions
      JOIN calls ON calls.id = procurement_offer_versions.call_id
      JOIN recordings ON recordings.twilio_call_sid = calls.twilio_call_sid
      WHERE procurement_offer_versions.id = ? AND recordings.recording_url IS NOT NULL
      ORDER BY recordings.created_at DESC LIMIT 1`).get(offerId) as Row | undefined;
    if (!row) return null;
    const start = nullableString(row.recording_start_time);
    const fromRecording = start ? Date.parse(String(row.created_at)) - Date.parse(start) : Number.NaN;
    return {
      recordingUrl: String(row.recording_url),
      offsetMs: Number.isFinite(fromRecording) && fromRecording >= 0 ? fromRecording : nullableNumber(row.evidence_offset_ms),
    };
  }

  /** Commitments whose written recap still owes the carrier a delivery attempt. */
  listPendingRecaps(): Array<{ commitmentId: string; orderId: string; marketId: string; address: string; body: string; attempts: number }> {
    return (this.db.prepare(`SELECT id, order_id, market_id, recap_address, recap_body, recap_attempts
      FROM commitments WHERE recap_status = 'PENDING' AND recap_address IS NOT NULL AND recap_body IS NOT NULL
      ORDER BY created_at`).all() as Row[]).map((row) => ({
        commitmentId: String(row.id),
        orderId: String(row.order_id),
        marketId: String(row.market_id),
        address: String(row.recap_address),
        body: String(row.recap_body),
        attempts: Number(row.recap_attempts || 0),
      }));
  }

  markRecapSent(commitmentId: string, deliveryId: string): void {
    const now = new Date().toISOString();
    const row = this.db.prepare("SELECT order_id, market_id, recap_address FROM commitments WHERE id = ?")
      .get(commitmentId) as Row | undefined;
    if (!row) return;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE commitments SET recap_status = 'SENT', recap_delivery_id = ?, recap_sent_at = ?,
        recap_error = NULL, recap_attempts = recap_attempts + 1 WHERE id = ?`).run(deliveryId, now, commitmentId);
      this.insertEvent(String(row.order_id), String(row.market_id), null, "RECAP_SENT",
        `Written recap delivered to ${row.recap_address} (${deliveryId})`, now);
    })();
  }

  markRecapFailed(commitmentId: string, error: string): void {
    const now = new Date().toISOString();
    const row = this.db.prepare("SELECT order_id, market_id, recap_attempts FROM commitments WHERE id = ?")
      .get(commitmentId) as Row | undefined;
    if (!row) return;
    // A recap that cannot be delivered is an operational exception, not a
    // silent failure: after three attempts it stops retrying and says so.
    const attempts = Number(row.recap_attempts || 0) + 1;
    const exhausted = attempts >= 3;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE commitments SET recap_status = ?, recap_error = ?, recap_attempts = ? WHERE id = ?`)
        .run(exhausted ? "FAILED" : "PENDING", error, attempts, commitmentId);
      this.insertEvent(String(row.order_id), String(row.market_id), null, "RECAP_FAILED",
        `${error} (attempt ${attempts}${exhausted ? ", giving up" : ""})`, now);
    })();
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

  private listAmendments(orderId: string): AmendmentRecord[] {
    return (this.db.prepare(`SELECT order_amendments.*, contacts.label AS carrier_label FROM order_amendments
      JOIN commitments ON commitments.id = order_amendments.commitment_id
      JOIN contacts ON contacts.id = commitments.carrier_id
      WHERE order_amendments.order_id = ? ORDER BY order_amendments.created_at DESC`)
      .all(orderId) as Row[]).map(toAmendment);
  }

  getAmendment(amendmentId: string): AmendmentRecord | null {
    const row = this.db.prepare(`SELECT order_amendments.*, contacts.label AS carrier_label FROM order_amendments
      JOIN commitments ON commitments.id = order_amendments.commitment_id
      JOIN contacts ON contacts.id = commitments.carrier_id
      WHERE order_amendments.id = ?`).get(amendmentId) as Row | undefined;
    return row ? toAmendment(row) : null;
  }

  private getAmendmentByCall(callId: string): AmendmentRecord | null {
    const row = this.db.prepare(`SELECT order_amendments.*, contacts.label AS carrier_label FROM order_amendments
      JOIN commitments ON commitments.id = order_amendments.commitment_id
      JOIN contacts ON contacts.id = commitments.carrier_id
      WHERE order_amendments.call_id = ?`).get(callId) as Row | undefined;
    return row ? toAmendment(row) : null;
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
  if (input.mustPickupBy && input.preferredPickup && Date.parse(input.mustPickupBy) < Date.parse(input.preferredPickup)) {
    throw new Error("Must pick up by cannot be before preferred pickup.");
  }
  if (input.carrierIds.length > 3 || new Set(input.carrierIds).size !== input.carrierIds.length) {
    throw new Error("Select up to three unique carriers, or leave the list empty for automatic selection.");
  }
  if (input.dailyDemurrageRate !== undefined && (!Number.isInteger(input.dailyDemurrageRate) || input.dailyDemurrageRate < 0)) {
    throw new Error("Daily demurrage rate must be a non-negative whole amount.");
  }
  for (const [currency, rate] of Object.entries(input.exchangeRates ?? {})) {
    if (!/^[A-Za-z]{3}$/.test(currency) || !Number.isFinite(rate) || rate <= 0) {
      throw new Error("Exchange rates require a three-letter currency and a positive numeric rate.");
    }
  }
}

function initialRiskStatus(input: CreateOrderInput, now: string): DemurrageRiskStatus {
  if (!input.freeTimeEndsAt || !input.dailyDemurrageRate) return "MONITORED";
  return Date.parse(input.freeTimeEndsAt) - Date.parse(now) <= 48 * 60 * 60 * 1000 ? "AT_RISK" : "MONITORED";
}

function mandateFromInput(input: CreateOrderInput, conditions: string[]): MandateSnapshot {
  const currency = input.currency.toUpperCase();
  return {
    targetPrice: input.targetPrice,
    maximumPrice: input.maximumPrice,
    preferredPickup: nullableDate(input.preferredPickup),
    mustPickupBy: nullableDate(input.mustPickupBy),
    preferredArrival: nullableDate(input.preferredArrival),
    mustArriveBy: nullableDate(input.mustArriveBy),
    priceWeight: input.priceWeight,
    speedWeight: input.speedWeight,
    minimumValidOffers: input.minimumValidOffers,
    desiredCarriers: input.desiredCarriers,
    conditions,
    currency,
    freeTimeEndsAt: nullableDate(input.freeTimeEndsAt),
    dailyDemurrageRate: input.dailyDemurrageRate || 0,
    exchangeRates: normalizeExchangeRates(currency, input.exchangeRates),
    exchangeRateSource: input.exchangeRateSource?.trim()
      || (input.exchangeRates ? "Operator-configured order rate" : defaultExchangeRateSource(currency)),
  };
}

function mandateFromOrder(order: OrderRecord): MandateSnapshot {
  const { targetPrice, maximumPrice, preferredPickup, mustPickupBy, preferredArrival, mustArriveBy, priceWeight, speedWeight, minimumValidOffers, desiredCarriers, conditions, currency, freeTimeEndsAt, dailyDemurrageRate, exchangeRates, exchangeRateSource } = order;
  return { targetPrice, maximumPrice, preferredPickup, mustPickupBy, preferredArrival, mustArriveBy, priceWeight, speedWeight, minimumValidOffers, desiredCarriers, conditions, currency, freeTimeEndsAt, dailyDemurrageRate, exchangeRates, exchangeRateSource };
}

function toMarket(row: Row): MarketRecord {
  const mandate = normalizeMandate(JSON.parse(String(row.mandate_snapshot)) as Partial<MandateSnapshot> & Pick<MandateSnapshot, "currency">);
  return {
    id: String(row.id), orderId: String(row.order_id), sequenceNumber: Number(row.sequence_number),
    status: String(row.status) as MarketRecord["status"], reason: String(row.reason),
    mandate,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), closedAt: nullableString(row.closed_at),
    revision: Number(row.revision || 0), startedAt: nullableString(row.started_at),
    procurementDeadlineAt: nullableString(row.procurement_deadline_at), automaticAward: Boolean(row.automatic_award),
    reviewReason: nullableString(row.review_reason),
  };
}

/**
 * How long discovery may run before an unanswered lane stops holding the
 * market. Five minutes is right for production and short for a live demo where
 * the market is being explained while the calls are open, so it is
 * configurable rather than hardcoded.
 */
function procurementDeadlineMs(): number {
  const configured = Number(process.env.PROCUREMENT_DEADLINE_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 120) : 5;
  return minutes * 60_000;
}

function toOffer(row: Row): OfferRecord {
  return {
    id: String(row.id), marketId: String(row.market_id || ""), carrierId: String(row.carrier_id || ""),
    carrierLabel: nullableString(row.carrier_label) || "", callId: nullableString(row.call_id),
    version: Number(row.version || 0), availability: String(row.availability || "UNKNOWN") as OfferAvailability,
    price: nullableNumber(row.price), currency: nullableString(row.currency), rateAllIn: nullableBooleanFromRow(row.rate_all_in),
    normalizedPrice: null, normalizedCurrency: "", exchangeRate: null, exchangeRateSource: null,
    pickupTime: nullableString(row.pickup_time), expectedArrival: nullableString(row.expected_arrival),
    firm: nullableBooleanFromRow(row.firm), expiresAt: nullableString(row.expires_at),
    accessorials: jsonStringArray(row.accessorials), carrierConditions: jsonStringArray(row.carrier_conditions),
    confirmedRequirements: jsonStringArray(row.confirmed_requirements), rawStatement: nullableString(row.raw_statement),
    rejectedRequirements: jsonStringArray(row.rejected_requirements),
    confidence: nullableNumber(row.confidence), humanRequired: Boolean(row.human_required), humanReason: nullableString(row.human_reason),
    conversationItemId: nullableString(row.conversation_item_id), evidenceOffsetMs: nullableNumber(row.evidence_offset_ms),
    evidence: null,
    waitingTimeIncluded: null, extraFees: null, conditions: null, isFinalOffer: Boolean(row.firm),
    requiresImmediateDecision: false, callbackAllowed: true,
    supersedesOfferId: nullableString(row.supersedes_version_id), createdAt: String(row.created_at),
    isComparable: false, isValid: true, invalidReasons: [], feasibilityViolations: [], missingFields: ["availability"],
    classification: "PARTIAL", isDominated: false, isFrontier: false, score: 0,
  };
}

function toOfferFacts(offer: Pick<OfferRecord,
  "id" | "carrierId" | "availability" | "price" | "currency" | "rateAllIn" | "pickupTime" | "expectedArrival"
  | "firm" | "confirmedRequirements" | "rejectedRequirements" | "humanRequired"
>): ProcurementOfferFacts {
  return {
    id: offer.id,
    carrierId: offer.carrierId,
    availability: offer.availability,
    price: offer.price,
    currency: offer.currency,
    rateAllIn: offer.rateAllIn,
    pickupTime: offer.pickupTime,
    expectedArrival: offer.expectedArrival,
    firm: offer.firm,
    confirmedRequirements: offer.confirmedRequirements,
    rejectedRequirements: offer.rejectedRequirements,
    humanRequired: offer.humanRequired,
  };
}

function decorateOffer(offer: OfferRecord, evaluated: EvaluatedProcurementOffer, exchangeRateSource: string | null): OfferRecord {
  return {
    ...offer,
    normalizedPrice: evaluated.normalizedPrice,
    normalizedCurrency: evaluated.normalizedCurrency,
    exchangeRate: evaluated.exchangeRate,
    exchangeRateSource: evaluated.exchangeRate === null ? null : exchangeRateSource,
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
      normalizedPrice: null, normalizedCurrency: defaultCurrency, exchangeRate: null, exchangeRateSource: null,
      pickupTime: null, expectedArrival: null, firm: null, expiresAt: null, accessorials: [], carrierConditions: [],
      confirmedRequirements: [], rawStatement: null, confidence: null, humanRequired: false, humanReason: null,
      rejectedRequirements: [], conversationItemId: null, evidenceOffsetMs: null, evidence: null,
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
    // Evidence belongs to the version that captured it, so it is never
    // inherited from the previous version the way commercial facts are.
    conversationItemId: update.conversationItemId?.trim() || null,
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
  if (action === "AWARD") return "AWARDED";
  if (action === "RELEASE") return "RELEASED";
  if (action === "NEGOTIATE") return "NEGOTIATING";
  if (action === "HOLD" || action === "CONFIRM") return "WAITING_FOR_MARKET";
  return "DISCOVERY";
}

function instructionForPersistence(
  action: MarketInstruction["action"],
  reason: string,
  marketRevision: number,
): MarketInstruction {
  return { action, reason, field: null, targetPrice: null, targetArrival: null, marketRevision };
}

function violationDistance(offer: OfferRecord): number {
  return offer.feasibilityViolations.reduce((total, violation) => {
    if (violation.delta === null) return total + 1_000;
    if (violation.code === "MAXIMUM_PRICE" && typeof violation.limit === "number" && violation.limit > 0) {
      return total + Math.abs(violation.delta) / violation.limit;
    }
    if (["MANDATORY_PICKUP", "MANDATORY_ARRIVAL"].includes(violation.code)) {
      return total + Math.abs(violation.delta) / 3_600_000;
    }
    return total + Math.abs(violation.delta);
  }, 0);
}

const BANXICO_USD_MXN_FIX_2026_08_28 = 17.0427;

function defaultExchangeRates(standardCurrency: string): Record<string, number> {
  const standard = standardCurrency.toUpperCase();
  if (standard === "MXN") return { MXN: 1, USD: BANXICO_USD_MXN_FIX_2026_08_28 };
  if (standard === "USD") return { USD: 1, MXN: 1 / BANXICO_USD_MXN_FIX_2026_08_28 };
  return { [standard]: 1 };
}

function defaultExchangeRateSource(standardCurrency: string): string | null {
  return ["MXN", "USD"].includes(standardCurrency.toUpperCase())
    ? "Banco de México FIX 2026-08-28 default; configurable per order"
    : null;
}

function normalizeExchangeRates(standardCurrency: string, configured?: Record<string, number>): Record<string, number> {
  const standard = standardCurrency.toUpperCase();
  const rates = { ...defaultExchangeRates(standard) };
  for (const [currency, rate] of Object.entries(configured ?? {})) {
    if (/^[A-Za-z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0) rates[currency.toUpperCase()] = rate;
  }
  rates[standard] = 1;
  return rates;
}

function normalizeMandate(raw: Partial<MandateSnapshot> & Pick<MandateSnapshot, "currency">): MandateSnapshot {
  const currency = String(raw.currency || "MXN").toUpperCase();
  return {
    ...raw,
    currency,
    preferredPickup: raw.preferredPickup ?? null,
    mustPickupBy: raw.mustPickupBy ?? null,
    // Mandates persisted before demurrage entered ranking have neither field.
    freeTimeEndsAt: raw.freeTimeEndsAt ?? null,
    dailyDemurrageRate: raw.dailyDemurrageRate ?? 0,
    exchangeRates: normalizeExchangeRates(currency, raw.exchangeRates),
    exchangeRateSource: raw.exchangeRateSource ?? defaultExchangeRateSource(currency),
  } as MandateSnapshot;
}

function jsonNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return undefined;
  }
}

function toCommitment(row: Row): CommitmentRecord {
  return {
    id: String(row.id), orderId: String(row.order_id), marketId: String(row.market_id), offerId: String(row.offer_id),
    carrierId: String(row.carrier_id), carrierLabel: String(row.carrier_label), status: String(row.status) as CommitmentRecord["status"],
    createdAt: String(row.created_at), invalidatedAt: nullableString(row.invalidated_at), invalidationReason: nullableString(row.invalidation_reason),
    recapStatus: String(row.recap_status || "NOT_REQUIRED") as CommitmentRecord["recapStatus"],
    recapChannel: nullableString(row.recap_channel) as CommitmentRecord["recapChannel"],
    recapAddress: nullableString(row.recap_address), recapBody: nullableString(row.recap_body),
    recapDeliveryId: nullableString(row.recap_delivery_id), recapError: nullableString(row.recap_error),
    recapSentAt: nullableString(row.recap_sent_at), recapAttempts: Number(row.recap_attempts || 0),
  };
}

function toAmendment(row: Row): AmendmentRecord {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    commitmentId: String(row.commitment_id),
    callId: nullableString(row.call_id),
    carrierLabel: String(row.carrier_label),
    status: String(row.status) as AmendmentRecord["status"],
    originalTerms: jsonAmendmentTerms(row.original_terms),
    requestedTerms: jsonAmendmentTerms(row.requested_terms),
    finalTerms: row.final_terms ? jsonAmendmentTerms(row.final_terms) : null,
    violations: jsonArray(row.violations) as AmendmentRecord["violations"],
    decisionReason: nullableString(row.decision_reason),
    recoveryMarketId: nullableString(row.recovery_market_id),
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

function amendmentTerms(offer: OfferRecord): AmendmentTerms {
  return {
    price: offer.price,
    currency: offer.currency,
    pickupTime: offer.pickupTime,
    expectedArrival: offer.expectedArrival,
  };
}

function sameAmendmentTerms(left: AmendmentTerms, right: AmendmentTerms): boolean {
  return left.price === right.price
    && left.currency === right.currency
    && left.pickupTime === right.pickupTime
    && left.expectedArrival === right.expectedArrival;
}

function amendmentDecisionFromRecord(
  amendment: AmendmentRecord,
  mandate?: MandateSnapshot,
  revalidation = false,
): AmendmentDecision {
  const action: AmendmentDecision["action"] = amendment.status === "ACCEPTED"
    ? "ACCEPT"
    : ["PROPOSED", "NEGOTIATING"].includes(amendment.status)
      ? "NEGOTIATE"
      : amendment.status === "RECOVERY_REQUIRED"
        ? revalidation ? "REVALIDATE" : "RECOVER"
        : "HUMAN_HANDOFF";
  return {
    amendment,
    action,
    recoveryMarketId: amendment.recoveryMarketId,
    negotiationTargets: action === "NEGOTIATE" && mandate
      ? { maximumPrice: mandate.maximumPrice, mustPickupBy: mandate.mustPickupBy, mustArriveBy: mandate.mustArriveBy }
      : null,
  };
}

function jsonAmendmentTerms(value: unknown): AmendmentTerms {
  const parsed = jsonObject(value);
  return {
    price: nullableNumber(parsed.price),
    currency: nullableString(parsed.currency),
    pickupTime: nullableString(parsed.pickupTime),
    expectedArrival: nullableString(parsed.expectedArrival),
  };
}

function jsonObject(value: unknown): Row {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch { return {}; }
}

function jsonArray(value: unknown): unknown[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
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
function normalizeLocation(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]+/g, " ").trim();
}
function nullableDate(value: string | null | undefined): string | null { return value?.trim() ? new Date(value).toISOString() : null; }
