import { z } from "zod";

export const rateSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
});

export const proposedPickupWindowSchema = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
}).superRefine((value, context) => {
  if (Date.parse(value.start) > Date.parse(value.end)) {
    context.addIssue({ code: "custom", path: ["end"], message: "pickupWindow.end must not precede pickupWindow.start" });
  }
});

export const mandateSchema = z.object({
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  rate: z.object({ min: z.number().nonnegative(), max: z.number().positive() }),
  pickupWindow: z.object({ earliest: z.iso.datetime(), latest: z.iso.datetime() }),
  allowedAccessorials: z.array(z.string().min(1)).default([]),
  prohibitedTerms: z.array(z.string().min(1)).default([]),
  maxDetentionMinutes: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
  if (value.rate.min > value.rate.max) {
    context.addIssue({ code: "custom", path: ["rate"], message: "rate.min must not exceed rate.max" });
  }
  if (Date.parse(value.pickupWindow.earliest) > Date.parse(value.pickupWindow.latest)) {
    context.addIssue({ code: "custom", path: ["pickupWindow"], message: "earliest must not follow latest" });
  }
});

export const operationInputSchema = z.object({
  externalReference: z.string().min(1),
  objective: z.string().min(1),
  mandate: mandateSchema,
  minimumCarrierCalls: z.number().int().min(3).default(3),
});

export const audioEvidenceSchema = z.object({
  conversationItemId: z.string().min(1),
  recordingId: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).refine((value) => value.endMs > value.startMs, {
  message: "audio evidence endMs must exceed startMs",
});

/** A carrier the market can call. Reliability is a caller-provided 0-100 score. */
export const carrierCandidateSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  reliabilityScore: z.number().min(0).max(100),
});

/** The commercial terms heard on a carrier call, before any commitment is made. */
export const carrierQuoteTermsSchema = z.object({
  summary: z.string().min(1),
  rate: rateSchema,
  pickupWindow: proposedPickupWindowSchema,
  accessorials: z.array(z.string().min(1)).default([]),
  terms: z.array(z.string().min(1)).default([]),
  detentionMinutes: z.number().int().nonnegative().optional(),
  audioEvidence: audioEvidenceSchema,
});

export const mandateDecisionSchema = z.object({
  allowed: z.boolean(),
  violations: z.array(z.string()),
});

export const carrierMarketStatusSchema = z.enum([
  "open",
  "collecting_quotes",
  "ready_for_selection",
  "selected",
  "exhausted",
  "cancelled",
]);

export const carrierMarketInputSchema = z.object({
  operationId: z.string().min(1),
  candidates: z.array(carrierCandidateSchema).min(1),
});

export const carrierMarketPatchSchema = z.object({
  status: carrierMarketStatusSchema.optional(),
  closedAt: z.iso.datetime().nullable().optional(),
});

export const carrierMarketSelectionSchema = z.object({
  marketId: z.string().min(1),
  quoteId: z.string().min(1),
});

export const carrierQuoteInputSchema = z.object({
  marketId: z.string().min(1),
  carrier: carrierCandidateSchema,
  callId: z.string().min(1),
  terms: carrierQuoteTermsSchema,
  mandateDecision: mandateDecisionSchema,
});

export const commitmentProposalSchema = z.object({
  counterparty: z.string().min(1),
  summary: z.string().min(1),
  rate: rateSchema,
  pickupWindow: proposedPickupWindowSchema,
  accessorials: z.array(z.string().min(1)).default([]),
  terms: z.array(z.string().min(1)).default([]),
  detentionMinutes: z.number().int().nonnegative().optional(),
  recapTarget: z.object({ channel: z.enum(["sms", "email"]), address: z.string().min(1) }),
  audioEvidence: audioEvidenceSchema,
});

export type Mandate = z.infer<typeof mandateSchema>;
export type OperationInput = z.infer<typeof operationInputSchema>;
export type CarrierCandidate = z.infer<typeof carrierCandidateSchema>;
export type CarrierQuoteTerms = z.infer<typeof carrierQuoteTermsSchema>;
export type CarrierMarketStatus = z.infer<typeof carrierMarketStatusSchema>;
export type CarrierMarketInput = z.infer<typeof carrierMarketInputSchema>;
export type CarrierMarketPatch = z.infer<typeof carrierMarketPatchSchema>;
export type CarrierMarketSelection = z.infer<typeof carrierMarketSelectionSchema>;
export type CarrierQuoteInput = z.infer<typeof carrierQuoteInputSchema>;
export type CommitmentProposal = z.infer<typeof commitmentProposalSchema>;
export type MandateDecision = z.infer<typeof mandateDecisionSchema>;

export interface Operation extends OperationInput {
  id: string;
  createdAt: string;
}

export interface CarrierMarket extends CarrierMarketInput {
  id: string;
  status: CarrierMarketStatus;
  selectedQuoteId: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CarrierQuote extends CarrierQuoteInput {
  id: string;
  createdAt: string;
}

export type CallStatus = "dialing" | "active" | "completed" | "failed" | "transferred";

export interface CallRecord {
  id: string;
  operationId: string | null;
  marketId: string | null;
  direction: "inbound" | "outbound";
  counterparty: string | null;
  /** The Twilio sender and the dialed number, shared with the telephony ledger. */
  fromNumber: string;
  toNumber: string;
  status: CallStatus;
  providerCallId: string | null;
  realtimeCallId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type CreateCallInput = Omit<CallRecord, "id" | "marketId" | "startedAt" | "endedAt"> & {
  marketId?: string | null;
};

export type CallPatch = Partial<Pick<CallRecord, "marketId" | "status" | "providerCallId" | "realtimeCallId" | "endedAt">>;

export type CommitmentStatus = "proposed" | "effective" | "recap_failed";

export interface CommitmentRecord extends CommitmentProposal {
  id: string;
  operationId: string;
  callId: string;
  status: CommitmentStatus;
  mandateDecision: MandateDecision;
  recapDeliveryId: string | null;
  createdAt: string;
}

export interface CallEvent {
  id: string;
  callId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
}
