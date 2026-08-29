import { describe, expect, it } from "vitest";
import { evaluateMandate } from "@/lib/volta/mandate";
import { commitmentProposalSchema, mandateSchema } from "@/lib/volta/models";

const mandate = mandateSchema.parse({
  currency: "USD",
  rate: { min: 900, max: 1200 },
  pickupWindow: {
    earliest: "2026-09-01T14:00:00.000Z",
    latest: "2026-09-01T18:00:00.000Z",
  },
  allowedAccessorials: ["liftgate"],
  prohibitedTerms: ["cash on pickup"],
  maxDetentionMinutes: 60,
});

const proposal = commitmentProposalSchema.parse({
  counterparty: "Carrier A",
  summary: "USD 1,050, pickup at 15:00Z with liftgate",
  rate: { amount: 1050, currency: "USD" },
  pickupWindow: { start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T16:00:00.000Z" },
  accessorials: ["liftgate"],
  terms: ["net 30"],
  detentionMinutes: 45,
  recapTarget: { channel: "sms", address: "+12025550131" },
  audioEvidence: { conversationItemId: "item_1", recordingId: "recording_1", startMs: 42_000, endMs: 47_000 },
});

describe("mandate evaluation", () => {
  it("approves a proposal fully inside the mandate", () => {
    expect(evaluateMandate(mandate, proposal)).toEqual({ allowed: true, violations: [] });
  });

  it("rejects rate, window, accessorial, detention, and prohibited-term violations", () => {
    const decision = evaluateMandate(mandate, {
      ...proposal,
      rate: { amount: 1400, currency: "USD" },
      pickupWindow: { start: "2026-09-01T17:00:00.000Z", end: "2026-09-01T19:00:00.000Z" },
      accessorials: ["hazmat"],
      terms: ["cash on pickup required"],
      detentionMinutes: 90,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations).toHaveLength(5);
  });

  it("requires a non-empty audio evidence range", () => {
    expect(() => commitmentProposalSchema.parse({
      ...proposal,
      audioEvidence: { ...proposal.audioEvidence, startMs: 47_000, endMs: 47_000 },
    })).toThrow();
  });
});
