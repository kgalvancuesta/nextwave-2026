import { describe, expect, it } from "vitest";
import { handleStatusCallback } from "@/lib/call-service";
import { isActiveCallStatus, mapTwilioCallStatus } from "@/lib/call-status";
import { createTestRepository } from "./helpers";

describe("Twilio status callbacks", () => {
  it("updates by Call SID, tolerates repeats, and rejects stale regression", () => {
    const repository = createTestRepository();
    const contact = repository.createContact({ label: "A", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" });
    const batch = repository.createOutboundBatch([contact], "+12025550101");
    repository.setOutboundCallInitiated(batch.calls[0]!.id, "CA_status_1");

    handleStatusCallback({ params: { CallSid: "CA_status_1", CallStatus: "ringing" }, repository });
    expect(repository.getCallByTwilioSid("CA_status_1")?.status).toBe("RINGING");

    handleStatusCallback({ params: { CallSid: "CA_status_1", CallStatus: "completed", CallDuration: "12" }, repository });
    const completedAt = repository.getCallByTwilioSid("CA_status_1")?.completedAt;
    handleStatusCallback({ params: { CallSid: "CA_status_1", CallStatus: "completed", CallDuration: "12" }, repository });
    handleStatusCallback({ params: { CallSid: "CA_status_1", CallStatus: "ringing" }, repository });

    const call = repository.getCallByTwilioSid("CA_status_1");
    expect(call?.status).toBe("COMPLETED");
    expect(call?.durationSeconds).toBe(12);
    expect(call?.completedAt).toBe(completedAt);
  });

  it("maps every terminal Twilio status", () => {
    expect(mapTwilioCallStatus("busy")).toBe("BUSY");
    expect(mapTwilioCallStatus("no-answer")).toBe("NO_ANSWER");
    expect(mapTwilioCallStatus("failed")).toBe("FAILED");
    expect(mapTwilioCallStatus("canceled")).toBe("CANCELED");
    expect(isActiveCallStatus("IN_PROGRESS")).toBe(true);
    expect(isActiveCallStatus("COMPLETED")).toBe(false);
    expect(isActiveCallStatus("FAILED")).toBe(false);
  });
});
