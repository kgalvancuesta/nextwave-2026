import type { CallRecord, Contact } from "./types";

export const ORDER_STATUSES = [
  "SOURCING", "NEGOTIATING", "COMMITTED", "IN_PROCESS", "COMPLETED", "ARCHIVED", "EXCEPTION", "CANCELED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MARKET_STATUSES = ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "HUMAN_REVIEW", "COMMITTED", "CLOSED", "FAILED", "CANCELED"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export type MarketCarrierStatus =
  | "SELECTED" | "CALLING" | "DISCOVERY" | "PARTIAL" | "OFFER" | "WAITING"
  | "NEGOTIATING" | "HUMAN" | "RELEASED" | "FAILED" | "UNAVAILABLE" | "AWARDED" | "COMPLETED";
export type OfferAvailability = "UNKNOWN" | "AVAILABLE" | "UNAVAILABLE";
export type OfferClassification = "PARTIAL" | "COMPARABLE" | "FRONTIER" | "DOMINATED" | "INFEASIBLE";
export type OfferMissingField = "availability" | "price" | "exchange_rate" | "pickup" | "arrival" | "all_in" | "requirements";
export type MarketPhase = "DISCOVERY" | "FRONTIER_NEGOTIATION" | "READY_TO_AWARD" | "HUMAN_REVIEW" | "CLOSED";
export type EvaluatorAction =
  | "ASK_MISSING_FIELD" | "CONTINUE_DISCOVERY" | "HOLD" | "NEGOTIATE"
  | "CONFIRM" | "RELEASE" | "HUMAN_REQUIRED" | "REQUEST_HUMAN_REVIEW" | "AWARD";
export type CommitmentStatus = "ACTIVE" | "INVALIDATED" | "FULFILLED";
export type RecapStatus = "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED";
export type DemurrageRiskStatus = "MONITORED" | "AT_RISK" | "IN_PROGRESS" | "RESOLVED";

export interface FeasibilityViolation {
  code: "UNAVAILABLE" | "CURRENCY" | "MAXIMUM_PRICE" | "MANDATORY_PICKUP" | "MANDATORY_ARRIVAL" | "REQUIRED_CONDITION";
  message: string;
  actual: string | number | null;
  limit: string | number | null;
  delta: number | null;
}

export interface MarketInstruction {
  action: EvaluatorAction;
  reason: string;
  field: OfferMissingField | null;
  targetPrice: number | null;
  targetArrival: string | null;
  marketRevision: number;
}

export interface MandateSnapshot {
  targetPrice: number;
  maximumPrice: number;
  preferredPickup: string | null;
  mustPickupBy: string | null;
  preferredArrival: string | null;
  mustArriveBy: string | null;
  priceWeight: number;
  speedWeight: number;
  minimumValidOffers: number;
  desiredCarriers: number;
  conditions: string[];
  currency: string;
  /**
   * Demurrage exposure, carried on the mandate so ranking can price a late
   * arrival in money instead of treating hours as a pure preference. An
   * arrival inside the free time costs nothing no matter how much later it is.
   */
  freeTimeEndsAt: string | null;
  dailyDemurrageRate: number;
  /** Units of the mandate currency for one unit of each quoted currency. */
  exchangeRates: Record<string, number>;
  exchangeRateSource: string | null;
}

export interface OrderRecord extends MandateSnapshot {
  id: string;
  name: string;
  client: string;
  origin: string;
  destination: string;
  reference: string | null;
  lifecycleStatus: OrderStatus;
  exceptionReason: string | null;
  // freeTimeEndsAt and dailyDemurrageRate are inherited from MandateSnapshot.
  currentEta: string | null;
  riskStatus: DemurrageRiskStatus;
  voltaOperationId: string | null;
  voltaMarketId: string | null;
  carriers: Contact[];
  createdAt: string;
  updatedAt: string;
}

export interface MarketRecord {
  id: string;
  orderId: string;
  sequenceNumber: number;
  status: MarketStatus;
  reason: string;
  mandate: MandateSnapshot;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  revision: number;
  startedAt: string | null;
  procurementDeadlineAt: string | null;
  automaticAward: boolean;
  reviewReason: string | null;
}

export interface OfferRecord {
  id: string;
  marketId: string;
  carrierId: string;
  carrierLabel: string;
  callId: string | null;
  version: number;
  availability: OfferAvailability;
  price: number | null;
  currency: string | null;
  normalizedPrice: number | null;
  normalizedCurrency: string;
  exchangeRate: number | null;
  exchangeRateSource: string | null;
  rateAllIn: boolean | null;
  pickupTime: string | null;
  expectedArrival: string | null;
  firm: boolean | null;
  expiresAt: string | null;
  accessorials: string[];
  carrierConditions: string[];
  confirmedRequirements: string[];
  rejectedRequirements: string[];
  rawStatement: string | null;
  confidence: number | null;
  humanRequired: boolean;
  humanReason: string | null;
  conversationItemId: string | null;
  evidenceOffsetMs: number | null;
  evidence: OfferEvidence | null;
  waitingTimeIncluded: string | null;
  extraFees: string | null;
  conditions: string | null;
  isFinalOffer: boolean;
  requiresImmediateDecision: boolean;
  callbackAllowed: boolean;
  supersedesOfferId: string | null;
  createdAt: string;
  isComparable: boolean;
  isValid: boolean;
  invalidReasons: string[];
  feasibilityViolations: FeasibilityViolation[];
  missingFields: OfferMissingField[];
  classification: OfferClassification;
  isDominated: boolean;
  isFrontier: boolean;
  score: number;
}

export interface CommitmentRecord {
  id: string;
  orderId: string;
  marketId: string;
  offerId: string;
  carrierId: string;
  carrierLabel: string;
  status: CommitmentStatus;
  createdAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  /** The written record of the agreed terms, frozen when the award committed. */
  recapStatus: RecapStatus;
  recapChannel: "sms" | null;
  recapAddress: string | null;
  recapBody: string | null;
  recapDeliveryId: string | null;
  recapError: string | null;
  recapSentAt: string | null;
  recapAttempts: number;
}

/**
 * Where in the call a recorded fact was actually said. `audioUrl` points at
 * this app's authenticated proxy, never at the raw Twilio media URL.
 */
export interface OfferEvidence {
  callId: string;
  audioUrl: string | null;
  offsetMs: number | null;
  conversationItemId: string | null;
  rawStatement: string | null;
  capturedAt: string;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  marketId: string | null;
  callId: string | null;
  eventType: string;
  detail: string | null;
  createdAt: string;
}

export type AmendmentStatus =
  | "PROPOSED" | "NEGOTIATING" | "ACCEPTED" | "RECOVERY_REQUIRED"
  | "HUMAN_REQUIRED" | "REJECTED" | "SUPERSEDED";

export interface AmendmentTerms {
  price: number | null;
  currency: string | null;
  pickupTime: string | null;
  expectedArrival: string | null;
}

export interface AmendmentRecord {
  id: string;
  orderId: string;
  commitmentId: string;
  callId: string | null;
  carrierLabel: string;
  status: AmendmentStatus;
  originalTerms: AmendmentTerms;
  requestedTerms: AmendmentTerms;
  finalTerms: AmendmentTerms | null;
  violations: FeasibilityViolation[];
  decisionReason: string | null;
  recoveryMarketId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MarketCarrierState {
  carrier: Contact;
  status: MarketCarrierStatus;
  latestOffer: OfferRecord | null;
  /** A prior offer that must be reconfirmed before it can become authoritative again. */
  retainedOffer: OfferRecord | null;
  latestCall: CallRecord | null;
  rank: number | null;
  instruction: MarketInstruction;
  negotiationRounds: number;
  humanReason: string | null;
  purpose: string | null;
  amendmentId: string | null;
}

export interface MarketState {
  market: MarketRecord;
  progress: {
    carriersSelected: number;
    callsStarted: number;
    callsActive: number;
    callsCompleted: number;
    validOffers: number;
  };
  carriers: MarketCarrierState[];
  offers: OfferRecord[];
  bestOffer: OfferRecord | null;
  cheapestOffer: OfferRecord | null;
  nearFeasibleOffers: OfferRecord[];
  phase: MarketPhase;
  awardReady: boolean;
  reviewReason: string | null;
  activeCommitment: CommitmentRecord | null;
}

export interface OrderWorkspace {
  order: OrderRecord;
  currentMarket: MarketState | null;
  markets: MarketState[];
  commitments: CommitmentRecord[];
  events: OrderEventRecord[];
  amendments: AmendmentRecord[];
  nautaCalls: CallRecord[];
  collapsedSummary: string;
}

export function publicOrderReference(order: Pick<OrderRecord, "id" | "reference">): string {
  return order.reference?.trim() || generatedOrderReference(order.id);
}

export function generatedOrderReference(orderId: string): string {
  return `ORD-${orderId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function normalizeOrderReference(reference: string): string {
  const withoutLabel = reference.trim()
    .replace(/^(?:(?:the|my|our)\s+)?(?:(?:order|reference|ref)(?:\s+(?:number|no))?|(?:order\s+)?number)(?:\s+is)?[\s:#-]*/i, "")
    .replace(/^(?:(?:el|mi|nuestro)\s+)?(?:(?:n[uú]mero\s+de\s+)?(?:orden|referencia)|n[uú]mero\s+de\s+orden)(?:\s+es)?[\s:#-]*/i, "");
  const tokens = withoutLabel.match(/[\p{L}\p{N}]+/gu) ?? [];
  const digitWords: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    cero: "0", uno: "1", un: "1", una: "1", dos: "2", tres: "3",
    cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9",
  };
  const spokenDigits = tokens.map((token) => /^\d+$/.test(token)
    ? token
    : digitWords[token.toLocaleLowerCase("en-US")]);
  if (spokenDigits.length > 0 && spokenDigits.every((digit) => digit !== undefined)) {
    return spokenDigits.join("");
  }
  return reference.trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}
