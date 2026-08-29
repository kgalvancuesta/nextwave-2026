import { describe, expect, it } from "vitest";
import { handleInboundCall } from "@/lib/call-service";
import { PlaceholderVoiceSessionAdapter } from "@/lib/voice-session";
import { createTestRepository } from "./helpers";

describe("incoming calls", () => {
  it("persists the call and returns placeholder TwiML", async () => {
    const repository = createTestRepository();
    const result = await handleInboundCall({
      params: {
        CallSid: "CA_inbound_1",
        From: "+525500000004",
        To: "+525500000003",
        CallStatus: "in-progress",
      },
      repository,
      voiceSession: new PlaceholderVoiceSessionAdapter(),
      recordingEnabled: false,
    });

    expect(result.call.direction).toBe("INBOUND");
    expect(repository.getCallByTwilioSid("CA_inbound_1")?.fromNumber).toBe("+525500000004");
    expect(result.response.contentType).toBe("text/xml");
    expect(result.response.body).toContain("<Response>");
    expect(result.response.body).toContain("You have reached Marketline");
    expect(result.response.body).toContain("<Hangup");
  });
});
