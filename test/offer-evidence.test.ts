import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers";

function setup() {
  const context = createTestContext();
  const carriers = [
    context.repository.createContact({ label: "FedEx", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
    context.repository.createContact({ label: "UPS", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
    context.repository.createContact({ label: "DHL", phoneInput: "+12025550110", e164PhoneNumber: "+12025550110" }),
  ];
  const workspace = context.markets.createOrder({
    name: "Evidence load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
    currency: "USD", targetPrice: 700, maximumPrice: 900,
    preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
    priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 2, desiredCarriers: 3,
    conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
  });
  const marketId = workspace.currentMarket!.market.id;
  context.markets.startMarket(marketId);
  const batch = context.repository.createOutboundBatch(carriers, "+12025550101", { orderId: workspace.order.id, marketId });
  return { ...context, workspace, marketId, carriers, calls: batch.calls };
}

/** Puts a call on the wire with a provider SID so recordings can join to it. */
function answerCall(context: ReturnType<typeof setup>, index: number, sid: string) {
  context.repository.setOutboundCallInitiated(context.calls[index]!.id, sid);
  return context.repository.updateCallStatus(sid, "IN_PROGRESS", {});
}

function offerFor(context: ReturnType<typeof setup>, carrierIndex: number) {
  return context.markets.getMarketState(context.marketId)!
    .carriers.find((carrier) => carrier.carrier.id === context.carriers[carrierIndex]!.id)!.latestOffer!;
}

describe("offer audio evidence", () => {
  it("keeps the carrier's own words and the conversation item the fact came from", () => {
    const context = setup();
    answerCall(context, 0, "CA_evidence");

    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", rateAllIn: true,
      rawStatement: "We can do it for 760 all-in", conversationItemId: "item_42",
    });

    const offer = offerFor(context, 0);
    expect(offer.conversationItemId).toBe("item_42");
    expect(offer.evidence).toMatchObject({
      callId: context.calls[0]!.id,
      conversationItemId: "item_42",
      rawStatement: "We can do it for 760 all-in",
    });
  });

  it("times the fact from the call clock rather than from anything the model says", () => {
    const context = setup();
    answerCall(context, 0, "CA_offset");

    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", rateAllIn: true, conversationItemId: "item_1",
    });

    const offer = offerFor(context, 0);
    expect(offer.evidenceOffsetMs).not.toBeNull();
    expect(offer.evidenceOffsetMs!).toBeGreaterThanOrEqual(0);
    expect(offer.evidenceOffsetMs!).toBeLessThan(60_000);
  });

  it("binds evidence to the version that captured it instead of inheriting it", () => {
    const context = setup();
    answerCall(context, 0, "CA_versions");
    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", conversationItemId: "item_first",
    });

    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      expectedArrival: "2030-01-10T15:30:00.000Z", rateAllIn: true,
    });

    const offer = offerFor(context, 0);
    expect(offer.version).toBe(2);
    expect(offer.price).toBe(760);
    expect(offer.conversationItemId).toBeNull();
  });

  it("offers no audio link until the recording actually exists", () => {
    const context = setup();
    answerCall(context, 0, "CA_norecording");
    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", conversationItemId: "item_1",
    });

    expect(offerFor(context, 0).evidence?.audioUrl).toBeNull();
    expect(context.markets.getOfferRecording(offerFor(context, 0).id)).toBeNull();
  });

  it("exposes a proxied audio link once Twilio publishes the recording", () => {
    const context = setup();
    answerCall(context, 0, "CA_withrecording");
    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", conversationItemId: "item_1",
    });
    context.repository.upsertRecording({
      twilioRecordingSid: "RE_1",
      twilioCallSid: "CA_withrecording",
      status: "completed",
      recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE_1",
      rawPayload: {},
    });

    const offer = offerFor(context, 0);
    expect(offer.evidence?.audioUrl).toBe(`/api/offers/${offer.id}/audio`);
    expect(context.markets.getOfferRecording(offer.id)?.recordingUrl)
      .toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE_1");
  });

  it("measures the offset from the recording's own start once Twilio reports it", () => {
    const context = setup();
    answerCall(context, 0, "CA_recstart");
    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", conversationItemId: "item_1",
    });
    const captured = Date.parse(offerFor(context, 0).createdAt);
    context.repository.upsertRecording({
      twilioRecordingSid: "RE_2",
      twilioCallSid: "CA_recstart",
      status: "completed",
      recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE_2",
      recordingStartTime: new Date(captured - 12_000).toISOString(),
      rawPayload: {},
    });

    expect(offerFor(context, 0).evidence?.offsetMs).toBe(12_000);
    expect(context.markets.getOfferRecording(offerFor(context, 0).id)?.offsetMs).toBe(12_000);
  });
});
