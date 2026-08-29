import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStateStore } from "../src/adapters/sqlite-store.js";
import { VoiceControlService } from "../src/application/voice-control-service.js";
import type { OutboundTelephonyGateway, RealtimeGateway, RealtimeSession, RecapGateway } from "../src/ports.js";

class FakeRealtime implements RealtimeGateway {
  onEvent?: (event: unknown) => Promise<void>;
  outputs: unknown[] = [];

  async verifyWebhook(): Promise<unknown> { throw new Error("unused"); }
  async acceptCall(): Promise<void> {}
  connectSideband(_callId: string, onEvent: (event: unknown) => Promise<void>): RealtimeSession {
    this.onEvent = onEvent;
    return { send: (event) => this.outputs.push(event), close() {} };
  }
  async transfer(): Promise<void> {}
  async hangup(): Promise<void> {}
}

const telephony: OutboundTelephonyGateway = {
  async dial() { return { providerCallId: "provider_1" }; },
};

const recap: RecapGateway = {
  async deliver() { return { deliveryId: "delivery_1" }; },
};

test("keeps an approved verbal agreement provisional until recap delivery", async () => {
  const store = new SqliteStateStore(":memory:");
  const realtime = new FakeRealtime();
  const service = new VoiceControlService(store, realtime, telephony, recap, {
    sipUri: "sip:project@sip.api.openai.com;transport=tls",
    humanEscalationUri: "tel:+12025550127",
  });
  const operation = service.createOperation({
    externalReference: "SHIP-42",
    objective: "Book ground transport",
    mandate: {
      currency: "USD",
      rate: { min: 900, max: 1200 },
      pickupWindow: {
        earliest: "2026-09-01T14:00:00.000Z",
        latest: "2026-09-01T18:00:00.000Z",
      },
      allowedAccessorials: [],
      prohibitedTerms: [],
    },
    minimumCarrierCalls: 3,
  });

  const webhookResult = await service.handleOpenAiWebhook({
    type: "realtime.call.incoming",
    data: {
      call_id: "rtc_1",
      sip_headers: [{ name: "X-Operation-ID", value: operation.id }],
    },
  });
  assert.ok(webhookResult.callId);

  await realtime.onEvent!({
    type: "response.function_call_arguments.done",
    name: "propose_commitment",
    call_id: "tool_1",
    arguments: JSON.stringify({
      counterparty: "Carrier A",
      summary: "USD 1,050 pickup at 15:00Z",
      rate: { amount: 1050, currency: "USD" },
      pickupWindow: { start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T16:00:00.000Z" },
      accessorials: [],
      terms: [],
      recapTarget: { channel: "sms", address: "+12025550131" },
      audioEvidence: { conversationItemId: "item_1", recordingId: "recording_1", startMs: 10_000, endMs: 15_000 },
    }),
  });

  let snapshot = service.getOperationSnapshot(operation.id)!;
  assert.equal(snapshot.commitments[0]?.status, "proposed");

  await service.completeCall(webhookResult.callId);
  snapshot = service.getOperationSnapshot(operation.id)!;
  assert.equal(snapshot.commitments[0]?.status, "effective");
  assert.equal(snapshot.commitments[0]?.recapDeliveryId, "delivery_1");
});
