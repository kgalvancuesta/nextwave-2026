import type { CallRecord, Contact } from "./types";

export const ORDER_STATUSES = [
  "SOURCING", "NEGOTIATING", "COMMITTED", "IN_PROCESS", "COMPLETED", "ARCHIVED", "EXCEPTION", "CANCELED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MARKET_STATUSES = ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "COMMITTED", "CLOSED", "FAILED", "CANCELED"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export type MarketCarrierStatus = "SELECTED" | "CALLING" | "CONNECTED" | "NEGOTIATING" | "FINAL" | "COMPLETED" | "FAILED";
export type CommitmentStatus = "ACTIVE" | "INVALIDATED" | "FULFILLED";
export type DemurrageRiskStatus = "MONITORED" | "AT_RISK" | "IN_PROGRESS" | "RESOLVED";

export interface MandateSnapshot {
  targetPrice: number;
  maximumPrice: number;
  preferredArrival: string | null;
  mustArriveBy: string | null;
  priceWeight: number;
  speedWeight: number;
  minimumValidOffers: number;
  desiredCarriers: number;
  conditions: string[];
  currency: string;
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
  freeTimeEndsAt: string | null;
  currentEta: string | null;
  dailyDemurrageRate: number;
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
}

export interface OfferRecord {
  id: string;
  marketId: string;
  carrierId: string;
  carrierLabel: string;
  callId: string | null;
  price: number;
  currency: string;
  pickupTime: string | null;
  expectedArrival: string | null;
  waitingTimeIncluded: string | null;
  extraFees: string | null;
  conditions: string | null;
  isFinalOffer: boolean;
  requiresImmediateDecision: boolean;
  callbackAllowed: boolean;
  supersedesOfferId: string | null;
  createdAt: string;
  isValid: boolean;
  invalidReasons: string[];
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

export interface MarketCarrierState {
  carrier: Contact;
  status: MarketCarrierStatus;
  latestOffer: OfferRecord | null;
  latestCall: CallRecord | null;
  rank: number | null;
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
  activeCommitment: CommitmentRecord | null;
}

export interface OrderWorkspace {
  order: OrderRecord;
  currentMarket: MarketState | null;
  markets: MarketState[];
  commitments: CommitmentRecord[];
  events: OrderEventRecord[];
  nautaCalls: CallRecord[];
  collapsedSummary: string;
}
