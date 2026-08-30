import { describe, expect, it } from "vitest";
import type { OutboundTelephonyGateway, RecapGateway } from "@/lib/volta/ports";
import { VoiceControlService } from "@/lib/volta/voice-control-service";
import { FakeAgentRuntime } from "./fake-agent-runtime";
import { createTestVoltaStore } from "./helpers";

class RecordingTelephony implements OutboundTelephonyGateway {
  readonly requests: Array<{ to: string; internalCallId: string; operationId: string }> = [];

  async dial(input: { to: string; internalCallId: string; operationId: string }) {
    this.requests.push(input);
    return { providerCallId: `CA_${this.requests.length}` };
  }

  async playMessageAndHangup() {}
}

const recap: RecapGateway = {
  async deliver() { return { deliveryId: "SM_1" }; },
};

const carriers = [
  { name: "Transportes Pacifico", phone: "+12025550128", reliabilityScore: 87 },
  { name: "Drayage Occidente", phone: "+12025550129", reliabilityScore: 92 },
  { name: "Manzanillo Express", phone: "+12025550130", reliabilityScore: 81 },
];

function createHarness() {
  const telephony = new RecordingTelephony();
  const service = new VoiceControlService(
    createTestVoltaStore(),
    new FakeAgentRuntime(),
    telephony,
    recap,
    {
      fromNumber: "+12025550127",
      sipUri: "sip:project@sip.api.openai.com;transport=tls",
      humanEscalationUri: "tel:+12025550133",
    },
  );
  const operation = service.createOperation({
    externalReference: "CONT-42",
    objective: "Recover delayed Manzanillo pickup before free time expires",
    minimumCarrierCalls: 3,
    mandate: {
      currency: "MXN",
      rate: { min: 0, max: 9000 },
      pickupWindow: {
        earliest: "2026-09-03T10:00:00.000Z",
        latest: "2026-09-03T16:00:00.000Z",
      },
      allowedAccessorials: [],
      prohibitedTerms: [],
    },
  });
  return { service, telephony, operation };
}

function terms(rate: number, start: string, end: string) {
  return {
    summary: `MXN ${rate}, pickup ${start}`,
    rate: { amount: rate, currency: "MXN" },
    pickupWindow: { start, end },
    accessorials: [],
    terms: [],
    audioEvidence: {
      conversationItemId: `item_${rate}`,
      recordingId: `recording_${rate}`,
      startMs: 10_000,
      endMs: 15_000,
    },
  };
}

describe("carrier market", () => {
  it("opens three distinct carrier calls, preserves all quotes, and selects the best eligible one", async () => {
    const { service, telephony, operation } = createHarness();
    const result = await service.startCarrierMarket(operation.id, carriers);

    expect(telephony.requests).toHaveLength(3);
    expect(telephony.requests.map((request) => request.to)).toEqual(carriers.map((carrier) => carrier.phone));
    expect(telephony.requests.every((request) => request.operationId === operation.id)).toBe(true);
    expect(result.market.status).toBe("collecting_quotes");

    const tooLate = service.recordCarrierQuote(
      result.calls[0]!.id,
      terms(7500, "2026-09-03T16:00:00.000Z", "2026-09-03T17:00:00.000Z"),
    );
    const overCap = service.recordCarrierQuote(
      result.calls[1]!.id,
      terms(9400, "2026-09-03T10:00:00.000Z", "2026-09-03T12:00:00.000Z"),
    );
    const winning = service.recordCarrierQuote(
      result.calls[2]!.id,
      terms(8700, "2026-09-03T12:00:00.000Z", "2026-09-03T14:00:00.000Z"),
    );

    expect(tooLate.mandateDecision.allowed).toBe(false);
    expect(overCap.mandateDecision.allowed).toBe(false);
    expect(winning.mandateDecision.allowed).toBe(true);

    const selected = service.selectBestCarrierQuote(result.market.id);
    expect(selected.market.status).toBe("selected");
    expect(selected.market.selectedQuoteId).toBe(winning.id);
    expect(selected.quote.id).toBe(winning.id);

    const snapshot = service.getOperationSnapshot(operation.id)!;
    expect(snapshot.quotes).toHaveLength(3);
    // Selecting a quote must never fabricate a commitment.
    expect(snapshot.commitments).toHaveLength(0);
    expect(snapshot.quotes.map((quote) => quote.mandateDecision.allowed)).toEqual([false, false, true]);

    const confirmation = await service.startSelectedCarrierConfirmation(result.market.id);
    expect(confirmation.marketId).toBe(result.market.id);
    expect(confirmation.counterparty).toBe("Manzanillo Express");
    expect(telephony.requests).toHaveLength(4);
  });

  it("rejects duplicate carriers before dialing and exhausts a market with no valid quote", async () => {
    const { service, telephony, operation } = createHarness();
    await expect(service.startCarrierMarket(operation.id, [carriers[0], carriers[0], carriers[2]]))
      .rejects.toThrow(/duplicate carrier candidate/);
    expect(telephony.requests).toHaveLength(0);

    const result = await service.startCarrierMarket(operation.id, carriers);
    for (const call of result.calls) {
      service.recordCarrierQuote(call.id, terms(9500, "2026-09-03T11:00:00.000Z", "2026-09-03T13:00:00.000Z"));
    }

    expect(() => service.selectBestCarrierQuote(result.market.id)).toThrow(/no_eligible_quotes/);
    const snapshot = service.getOperationSnapshot(operation.id)!;
    expect(snapshot.markets[0]?.status).toBe("exhausted");
    expect(snapshot.markets[0]?.selectedQuoteId).toBeNull();
  });

  it("shares the telephony ledger so market calls appear as ordinary calls", async () => {
    const { service, operation } = createHarness();
    const result = await service.startCarrierMarket(operation.id, carriers);

    const snapshot = service.getOperationSnapshot(operation.id)!;
    expect(snapshot.calls).toHaveLength(3);
    expect(snapshot.calls.map((call) => call.toNumber).sort()).toEqual(carriers.map((carrier) => carrier.phone).sort());
    expect(snapshot.calls.every((call) => call.fromNumber === "+12025550127")).toBe(true);
    expect(snapshot.calls.every((call) => call.providerCallId?.startsWith("CA_"))).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
