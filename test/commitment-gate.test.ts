import { describe, expect, it } from "vitest";
import type { OutboundTelephonyGateway, RecapGateway } from "@/lib/volta/ports";
import { VoiceControlService } from "@/lib/volta/voice-control-service";
import { FakeAgentRuntime } from "./fake-agent-runtime";
import { createTestVoltaStore } from "./helpers";

const telephony: OutboundTelephonyGateway = {
  async dial() { return { providerCallId: "CA_1" }; },
  async playMessageAndHangup() {},
};

const recap: RecapGateway = {
  async deliver() { return { deliveryId: "SM_1" }; },
};

const mandate = {
  currency: "USD",
  rate: { min: 900, max: 1200 },
  pickupWindow: { earliest: "2026-09-01T14:00:00.000Z", latest: "2026-09-01T18:00:00.000Z" },
  allowedAccessorials: [],
  prohibitedTerms: [],
};

function createHarness() {
  const runtime = new FakeAgentRuntime();
  const service = new VoiceControlService(createTestVoltaStore(), runtime, telephony, recap, {
    fromNumber: "+12025550127",
    sipUri: "sip:project@sip.api.openai.com;transport=tls",
    humanEscalationUri: "tel:+12025550133",
  });
  return { runtime, service };
}

const proposal = {
  counterparty: "Carrier A",
  summary: "USD 1,050 pickup at 15:00Z",
  rate: { amount: 1050, currency: "USD" },
  pickupWindow: { start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T16:00:00.000Z" },
  accessorials: [],
  terms: [],
  recapTarget: { channel: "sms", address: "+12025550131" },
  audioEvidence: { conversationItemId: "item_1", recordingId: "recording_1", startMs: 10_000, endMs: 15_000 },
};

describe("commitment gate", () => {
  it("keeps an approved verbal agreement provisional until recap delivery", async () => {
    const { runtime, service } = createHarness();
    const operation = service.createOperation({
      externalReference: "SHIP-42",
      objective: "Book ground transport",
      mandate,
      minimumCarrierCalls: 3,
    });

    const webhookResult = await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: {
        call_id: "rtc_1",
        sip_headers: [{ name: "X-Operation-ID", value: operation.id }],
      },
    });
    expect(webhookResult.callId).toBeTruthy();
    // Correlated to an operation but not to a market: briefed as a direct
    // negotiation, so propose_commitment is on the tool surface.
    expect(runtime.profile?.kind).toBe("direct");
    expect(runtime.responsesRequested).toBe(1);

    await runtime.invokeTool!("propose_commitment", proposal);

    let snapshot = service.getOperationSnapshot(operation.id)!;
    expect(snapshot.commitments[0]?.status).toBe("proposed");

    await service.completeCall(webhookResult.callId!);
    snapshot = service.getOperationSnapshot(operation.id)!;
    expect(snapshot.commitments[0]?.status).toBe("effective");
    expect(snapshot.commitments[0]?.recapDeliveryId).toBe("SM_1");
  });

  it("rejects a proposal outside the mandate without recording a commitment", async () => {
    const { runtime, service } = createHarness();
    const operation = service.createOperation({
      externalReference: "SHIP-43",
      objective: "Book ground transport",
      mandate,
      minimumCarrierCalls: 3,
    });

    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_2", sip_headers: [{ name: "X-Operation-ID", value: operation.id }] },
    });

    const result = await runtime.invokeTool!("propose_commitment", {
      ...proposal,
      rate: { amount: 1400, currency: "USD" },
    }) as { ok: boolean; approved: boolean; escalate: boolean };

    expect(result.ok).toBe(false);
    expect(result.escalate).toBe(true);
    expect(service.getOperationSnapshot(operation.id)!.commitments).toHaveLength(0);
  });

  it("re-briefs an unidentified inbound call once it names its operation", async () => {
    const { runtime, service } = createHarness();
    service.createOperation({
      externalReference: "SHIP-77",
      objective: "Book ground transport",
      mandate,
      minimumCarrierCalls: 3,
    });

    // No correlation headers: the agent starts in restricted intake mode.
    const webhookResult = await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_3", sip_headers: [{ name: "From", value: "+12025550135" }] },
    });
    expect(runtime.profile?.kind).toBe("intake");

    const identified = await runtime.invokeTool!("identify_operation", { external_reference: "SHIP-77" }) as {
      ok: boolean;
      operation_id: string;
    };
    expect(identified.ok).toBe(true);
    expect(runtime.rebriefs).toEqual(["direct"]);

    const snapshot = service.getOperationSnapshot(identified.operation_id)!;
    expect(snapshot.calls[0]?.id).toBe(webhookResult.callId);
    expect(snapshot.events.some((event) => event.type === "agent.rebriefed")).toBe(true);
  });
});
