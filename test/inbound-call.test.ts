import { describe, expect, it } from "vitest";
import { handleInboundCall } from "@/lib/call-service";
import { INBOUND_INTERIM_MESSAGE, PlaceholderVoiceSessionAdapter } from "@/lib/voice-session";
import { createTestRepository } from "./helpers";

describe("incoming calls", () => {
  it("persists the call and returns Nextwave interim TwiML", async () => {
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
    // Verify the Nextwave-branded interim message is spoken
    expect(result.response.body).toContain(INBOUND_INTERIM_MESSAGE);
    // Verify the call ends cleanly
    expect(result.response.body).toContain("<Hangup");
  });

});
