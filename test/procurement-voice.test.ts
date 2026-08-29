import { describe, expect, it } from "vitest";
import { DashboardProcurementVoiceAdapter } from "@/lib/procurement-voice";
import type { OutboundTelephonyGateway, RecapGateway } from "@/lib/volta/ports";
import { VoltaStore } from "@/lib/volta/store";
import { VoiceControlService } from "@/lib/volta/voice-control-service";
import { FakeAgentRuntime } from "./fake-agent-runtime";
import { createTestContext } from "./helpers";

const telephony: OutboundTelephonyGateway = {
  async dial() { return { providerCallId: "CA_unused" }; },
};
const recap: RecapGateway = {
  async deliver() { return { deliveryId: "SM_unused" }; },
};

describe("dashboard procurement voice bridge", () => {
  it("briefs a dashboard market call as procurement and streams tool facts into the shared market", async () => {
    const { db, repository, markets } = createTestContext();
    const carriers = [
      repository.createContact({ label: "FedEx", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
      repository.createContact({ label: "UPS", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
    ];
    const workspace = markets.createOrder({
      name: "Voice load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
      currency: "USD", targetPrice: 700, maximumPrice: 900,
      preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
      priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 2, desiredCarriers: 2,
      conditions: ["Tolls included"], carrierIds: carriers.map((carrier) => carrier.id),
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const call = repository.createOutboundBatch(carriers, "+12025550101", { orderId: workspace.order.id, marketId }).calls[0]!;
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, telephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: "tel:+12025550121" },
      new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T03:30:00.000Z")),
    );

    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_procurement", sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
    });
    expect(runtime.profile?.kind).toBe("procurement");
    expect(runtime.profile?.instructions).toContain("what's your all-in rate and the arrival time you can commit to");
    expect(runtime.profile?.instructions).toContain("If this is clearly voicemail");
    expect(runtime.profile?.instructions).toContain("A tool payload failure is not a reason for human escalation");

    const partial = await runtime.invokeTool!("record_procurement_update", {
      availability: "AVAILABLE",
      price: 760,
      currency: "USD",
      rateAllIn: true,
      pickupTime: null,
      expectedArrival: null,
      firm: false,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: ["Tolls included"],
      rejectedRequirements: [],
      rawStatement: "760 all-in and arrival by 3:30 PM",
      confidence: 0.98,
      humanRequired: false,
      humanReason: null,
    }) as { ok: boolean; instruction: { action: string } };
    expect(partial).toMatchObject({ ok: true, comparable: false, instruction: { action: "ASK_MISSING_FIELD" } });

    const result = await runtime.invokeTool!("record_procurement_update", {
      availability: "UNKNOWN",
      price: null,
      currency: null,
      rateAllIn: null,
      pickupTime: null,
      expectedArrival: "in 12 hours",
      firm: null,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: [],
      rejectedRequirements: [],
      rawStatement: "Arrival in 12 hours",
      confidence: 0.98,
      humanRequired: false,
      humanReason: null,
    }) as { ok: boolean; instruction: { action: string } };

    expect(result).toMatchObject({ ok: true, comparable: true, instruction: { action: "HOLD" } });
    expect(markets.getMarketState(marketId)?.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer)
      .toMatchObject({
        availability: "AVAILABLE",
        price: 760,
        currency: "USD",
        rateAllIn: true,
        expectedArrival: "2030-01-10T15:30:00.000Z",
        confirmedRequirements: ["Tolls included"],
      });
  });
});
