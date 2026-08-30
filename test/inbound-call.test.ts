import { describe, expect, it } from "vitest";
import { handleInboundCall } from "@/lib/call-service";
import { normalizePhoneNumber } from "@/lib/phone";
import { INBOUND_INTERIM_MESSAGE, PlaceholderVoiceSessionAdapter } from "@/lib/voice-session";
import { VoltaStore } from "@/lib/volta/store";
import { createTestContext, createTestRepository } from "./helpers";

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

  it("resolves a known caller from equivalent supported phone formatting", async () => {
    const { db, repository } = createTestContext();
    const contact = repository.createContact({
      label: "Kevin",
      phoneInput: "5500000008",
      e164PhoneNumber: normalizePhoneNumber("5500000008"),
    });

    const result = await handleInboundCall({
      params: {
        CallSid: "CA_known_inbound",
        From: "+525500000008",
        To: "+525500000003",
        CallStatus: "completed",
      },
      repository,
      voiceSession: new PlaceholderVoiceSessionAdapter(),
      recordingEnabled: false,
    });

    expect(result.call).toMatchObject({
      contactId: contact.id,
      contactLabel: "Kevin",
      fromNumber: "+525500000008",
    });
    expect(repository.listCalls()[0]).toMatchObject({
      contactId: contact.id,
      contactLabel: "Kevin",
      fromNumber: "+525500000008",
    });
    expect(new VoltaStore(db).getCall(result.call.id)?.counterparty).toBe("Kevin");
  });

  it("keeps an unknown caller's raw number as the display fallback", async () => {
    const repository = createTestRepository();
    const result = await handleInboundCall({
      params: {
        CallSid: "CA_unknown_inbound",
        From: "+12025550136",
        To: "+525500000003",
        CallStatus: "completed",
      },
      repository,
      voiceSession: new PlaceholderVoiceSessionAdapter(),
      recordingEnabled: false,
    });

    expect(result.call.contactId).toBeNull();
    expect(result.call.contactLabel).toBeNull();
    expect(result.call.fromNumber).toBe("+12025550136");
  });

  it("does not match a similar but different caller number", async () => {
    const repository = createTestRepository();
    repository.createContact({
      label: "Kevin",
      phoneInput: "+525500000008",
      e164PhoneNumber: "+525500000008",
    });

    const result = await handleInboundCall({
      params: {
        CallSid: "CA_near_inbound",
        From: "+525500000009",
        To: "+525500000003",
        CallStatus: "ringing",
      },
      repository,
      voiceSession: new PlaceholderVoiceSessionAdapter(),
      recordingEnabled: false,
    });

    expect(result.call.contactId).toBeNull();
    expect(result.call.contactLabel).toBeNull();
  });

  it("resolves legacy inbound history that was stored without a contact ID", () => {
    const repository = createTestRepository();
    repository.upsertInboundCall({
      twilioCallSid: "CA_legacy_inbound",
      fromNumber: "+525500000008",
      toNumber: "+525500000003",
      contactId: null,
      status: "COMPLETED",
      rawPayload: {},
    });
    const contact = repository.createContact({
      label: "Kevin",
      phoneInput: "+525500000008",
      e164PhoneNumber: "+525500000008",
    });

    expect(repository.listCalls()[0]).toMatchObject({
      contactId: contact.id,
      contactLabel: "Kevin",
      fromNumber: "+525500000008",
    });
  });

});
