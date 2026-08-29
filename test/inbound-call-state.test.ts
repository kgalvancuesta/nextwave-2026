import { describe, expect, it } from "vitest";
import { deriveInboundCallState, isActiveCallStatus } from "@/lib/call-status";
import { handleInboundCall, handleStatusCallback } from "@/lib/call-service";
import { PlaceholderVoiceSessionAdapter } from "@/lib/voice-session";
import type { CallRecord } from "@/lib/types";
import { createTestRepository } from "./helpers";

// ---------------------------------------------------------------------------
// Helper: build a minimal CallRecord stub for unit tests of deriveInboundCallState
// ---------------------------------------------------------------------------
function makeCall(overrides: Partial<CallRecord>): CallRecord {
  return {
    id: "test-id",
    twilioCallSid: null,
    batchId: null,
    contactId: null,
    contactLabel: null,
    orderId: null,
    marketId: null,
    carrierId: null,
    direction: "INBOUND",
    fromNumber: "+12025550126",
    toNumber: "+12025550137",
    status: "RINGING",
    startedAt: new Date().toISOString(),
    answeredAt: null,
    completedAt: null,
    durationSeconds: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("deriveInboundCallState — pure unit tests", () => {
  it("returns idle when the call list is empty", () => {
    expect(deriveInboundCallState([])).toBe("idle");
  });

  it("returns incoming when an inbound call is RINGING", () => {
    expect(deriveInboundCallState([makeCall({ status: "RINGING" })])).toBe("incoming");
  });

  it("returns in_progress when an inbound call is IN_PROGRESS", () => {
    expect(deriveInboundCallState([makeCall({ status: "IN_PROGRESS" })])).toBe("in_progress");
  });

  it("returns idle for a completed inbound call", () => {
    expect(deriveInboundCallState([makeCall({ status: "COMPLETED" })])).toBe("idle");
  });

  it("returns idle for failed, busy, no-answer, canceled", () => {
    for (const status of ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"] as const) {
      expect(deriveInboundCallState([makeCall({ status })])).toBe("idle");
    }
  });

  it("ignores outbound calls — only inbound calls drive the state", () => {
    const outboundRinging = makeCall({ direction: "OUTBOUND", status: "RINGING" });
    expect(deriveInboundCallState([outboundRinging])).toBe("idle");
  });

  it("prioritises in_progress over incoming when both are present", () => {
    const calls = [
      makeCall({ id: "a", status: "RINGING" }),
      makeCall({ id: "b", status: "IN_PROGRESS" }),
    ];
    expect(deriveInboundCallState(calls)).toBe("in_progress");
  });

  it("duplicate calls with the same status do not break state", () => {
    const calls = [
      makeCall({ id: "a", status: "RINGING" }),
      makeCall({ id: "b", status: "RINGING" }),
    ];
    expect(deriveInboundCallState(calls)).toBe("incoming");
  });
});

describe("inbound call state — integration path through repository", () => {
  it("transitions: idle → incoming → in_progress → idle on completion", async () => {
    const repository = createTestRepository();
    const voiceSession = new PlaceholderVoiceSessionAdapter();

    // No calls yet → idle
    expect(deriveInboundCallState(repository.listCalls())).toBe("idle");

    // Twilio sends the inbound webhook with ringing status
    await handleInboundCall({
      params: { CallSid: "CA_state_test", From: "+12025550122", To: "+12025550137", CallStatus: "ringing" },
      repository,
      voiceSession,
      recordingEnabled: false,
    });
    expect(deriveInboundCallState(repository.listCalls())).toBe("incoming");

    // Twilio status callback: call answered
    handleStatusCallback({
      params: { CallSid: "CA_state_test", CallStatus: "in-progress" },
      repository,
    });
    expect(deriveInboundCallState(repository.listCalls())).toBe("in_progress");

    // Twilio status callback: call completed
    handleStatusCallback({
      params: { CallSid: "CA_state_test", CallStatus: "completed", CallDuration: "42" },
      repository,
    });
    expect(deriveInboundCallState(repository.listCalls())).toBe("idle");
  });

  it("transitions: idle → in_progress → idle when call arrives already answered", async () => {
    const repository = createTestRepository();

    // Some Twilio configurations send in-progress as the first status
    await handleInboundCall({
      params: { CallSid: "CA_direct_answer", From: "+12025550123", To: "+12025550137", CallStatus: "in-progress" },
      repository,
      voiceSession: new PlaceholderVoiceSessionAdapter(),
      recordingEnabled: false,
    });
    expect(deriveInboundCallState(repository.listCalls())).toBe("in_progress");

    handleStatusCallback({
      params: { CallSid: "CA_direct_answer", CallStatus: "completed", CallDuration: "10" },
      repository,
    });
    expect(deriveInboundCallState(repository.listCalls())).toBe("idle");
  });

  it("returns idle on any terminal status (failed, busy, no-answer, canceled)", () => {
    const repository = createTestRepository();

    for (const [sid, status] of [
      ["CA_fail", "failed"],
      ["CA_busy", "busy"],
      ["CA_noanswer", "no-answer"],
      ["CA_cancel", "canceled"],
    ] as [string, string][]) {
      repository.upsertInboundCall({
        twilioCallSid: sid,
        fromNumber: "+12025550124",
        toNumber: "+12025550137",
        contactId: null,
        status: "IN_PROGRESS",
        rawPayload: {},
      });
      handleStatusCallback({ params: { CallSid: sid, CallStatus: status }, repository });
    }

    expect(deriveInboundCallState(repository.listCalls())).toBe("idle");
  });

  it("duplicate status callbacks do not corrupt state", () => {
    const repository = createTestRepository();
    repository.upsertInboundCall({
      twilioCallSid: "CA_dup",
      fromNumber: "+12025550125",
      toNumber: "+12025550137",
      contactId: null,
      status: "RINGING",
      rawPayload: {},
    });

    // Send completed twice
    handleStatusCallback({ params: { CallSid: "CA_dup", CallStatus: "completed" }, repository });
    handleStatusCallback({ params: { CallSid: "CA_dup", CallStatus: "completed" }, repository });
    // Send ringing after completed (stale/out-of-order — ignored by status-rank guard)
    handleStatusCallback({ params: { CallSid: "CA_dup", CallStatus: "ringing" }, repository });

    expect(deriveInboundCallState(repository.listCalls())).toBe("idle");
    expect(repository.getCallByTwilioSid("CA_dup")?.status).toBe("COMPLETED");
  });

  it("isActiveCallStatus correctly classifies active vs terminal statuses", () => {
    expect(isActiveCallStatus("REQUESTED")).toBe(true);
    expect(isActiveCallStatus("RINGING")).toBe(true);
    expect(isActiveCallStatus("IN_PROGRESS")).toBe(true);
    expect(isActiveCallStatus("COMPLETED")).toBe(false);
    expect(isActiveCallStatus("FAILED")).toBe(false);
    expect(isActiveCallStatus("BUSY")).toBe(false);
    expect(isActiveCallStatus("NO_ANSWER")).toBe(false);
    expect(isActiveCallStatus("CANCELED")).toBe(false);
  });
});
