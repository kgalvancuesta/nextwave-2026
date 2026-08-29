import { z } from "zod";

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

export const commitmentProposalSchema = z.object({
  counterparty: z.string().min(1),
  summary: z.string().min(1),
  rate: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().length(3).transform((value) => value.toUpperCase()),
  }),
  pickupWindow: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
  accessorials: z.array(z.string().min(1)).default([]),
  terms: z.array(z.string().min(1)).default([]),
  detentionMinutes: z.number().int().nonnegative().optional(),
  recapTarget: z.object({ channel: z.enum(["sms", "email"]), address: z.string().min(1) }),
  audioEvidence: audioEvidenceSchema,
});

export type Mandate = z.infer<typeof mandateSchema>;
export type OperationInput = z.infer<typeof operationInputSchema>;
export type CommitmentProposal = z.infer<typeof commitmentProposalSchema>;

export interface Operation extends OperationInput {
  id: string;
  createdAt: string;
}

export type CallStatus = "dialing" | "active" | "completed" | "failed" | "transferred";

export interface CallRecord {
  id: string;
  operationId: string | null;
  direction: "inbound" | "outbound";
  counterparty: string | null;
  status: CallStatus;
  providerCallId: string | null;
  realtimeCallId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type CommitmentStatus = "proposed" | "effective" | "recap_failed";

export interface MandateDecision {
  allowed: boolean;
  violations: string[];
}

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
