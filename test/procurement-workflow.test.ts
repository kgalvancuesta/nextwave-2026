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
    name: "Live procurement", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
    currency: "USD", targetPrice: 700, maximumPrice: 900,
    preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
    priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 2, desiredCarriers: 3,
    conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
  });
  const marketId = workspace.currentMarket!.market.id;
  context.markets.startMarket(marketId);
  const batch = context.repository.createOutboundBatch(carriers, "+12025550101", {
    orderId: workspace.order.id,
    marketId,
  });
  return { ...context, workspace, marketId, carriers, calls: batch.calls };
}

function completeOffer(price: number, arrival: string) {
  return {
    availability: "AVAILABLE" as const,
    price,
    currency: "USD",
    rateAllIn: true,
    expectedArrival: arrival,
    confirmedRequirements: [],
    confidence: 0.98,
  };
}

describe("shared procurement workflow", () => {
  it("keeps a no-offer Twilio failure visible instead of presenting it as a normal release", () => {
    const { markets, repository, marketId, carriers, calls } = setup();
    repository.setOutboundCallFailed(calls[0]!.id, "21216", "Twilio account is not allowed to call this destination");

    const state = markets.reevaluateMarket(marketId);
    const carrier = state.carriers.find((candidate) => candidate.carrier.id === carriers[0]!.id)!;
    expect(carrier.status).toBe("FAILED");
    expect(carrier.latestCall?.errorCode).toBe("21216");
    expect(carrier.latestCall?.errorMessage).toMatch(/not allowed/);
  });

  it("streams partial facts, holds an early offer, prunes, detects staleness, and awards only after a negotiation round", () => {
    const { markets, carriers, calls } = setup();

    let state = markets.recordProgressiveOfferForCall(calls[0]!.id, {
      availability: "AVAILABLE", price: 760, currency: "USD", rateAllIn: true,
      rawStatement: "We can do it for 760 all-in", confidence: 0.97,
    });
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer?.price).toBe(760);
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer?.classification).toBe("PARTIAL");
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.instruction)
      .toMatchObject({ action: "ASK_MISSING_FIELD", field: "arrival" });

    state = markets.recordProgressiveOfferForCall(calls[0]!.id, completeOffer(760, "2030-01-10T15:30:00.000Z"));
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.status).toBe("WAITING");

    markets.recordProgressiveOfferForCall(calls[1]!.id, completeOffer(700, "2030-01-10T16:00:00.000Z"));
    state = markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(850, "2030-01-10T17:00:00.000Z"));
    const fedex = state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)!;
    const ups = state.carriers.find((carrier) => carrier.carrier.id === carriers[1]!.id)!;
    const dhl = state.carriers.find((carrier) => carrier.carrier.id === carriers[2]!.id)!;
    expect(fedex.instruction.action).toBe("NEGOTIATE");
    expect(ups.instruction.action).toBe("NEGOTIATE");
    expect(dhl.instruction).toMatchObject({ action: "RELEASE", reason: "pareto_dominated" });
    const staleRevision = fedex.instruction.marketRevision;

    state = markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(650, "2030-01-10T15:00:00.000Z"));
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.instruction.action).toBe("RELEASE");
    expect(() => markets.validateCallInstruction(calls[0]!.id, staleRevision, ["NEGOTIATE"]))
      .toThrow(/stale_market_instruction/);

    state = markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(640, "2030-01-10T15:00:00.000Z"));
    expect(state.market.status).toBe("COMMITTED");
    expect(state.activeCommitment?.carrierId).toBe(carriers[2]!.id);
    expect(state.bestOffer).toMatchObject({ carrierId: carriers[2]!.id, price: 640, isValid: true });
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[2]!.id)?.instruction.action).toBe("AWARD");
  });

  it("never chooses a least-bad offer when every carrier violates a hard constraint", () => {
    const { markets, calls } = setup();
    markets.recordProgressiveOfferForCall(calls[0]!.id, completeOffer(950, "2030-01-10T16:00:00.000Z"));
    markets.recordProgressiveOfferForCall(calls[1]!.id, completeOffer(850, "2030-01-10T19:00:00.000Z"));
    const state = markets.recordProgressiveOfferForCall(calls[2]!.id, {
      availability: "UNAVAILABLE", rawStatement: "No capacity", confidence: 1,
    });

    expect(state.market.status).toBe("HUMAN_REVIEW");
    expect(state.activeCommitment).toBeNull();
    expect(state.bestOffer).toBeNull();
    expect(state.nearFeasibleOffers).toHaveLength(2);
    expect(state.reviewReason).toMatch(/Automatic award is prohibited/);
  });

  it("attaches an unambiguous known-carrier callback to the open market", () => {
    const { markets, repository, marketId, carriers } = setup();
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_callback",
      fromNumber: carriers[0]!.e164PhoneNumber,
      toNumber: "+12025550101",
      contactId: carriers[0]!.id,
      status: "IN_PROGRESS",
      rawPayload: {},
    });

    expect(markets.attachInboundCallToMarket(inbound.id)).toMatchObject({ status: "ATTACHED", marketId });
    const state = markets.recordProgressiveOfferForCall(inbound.id, completeOffer(680, "2030-01-10T15:00:00.000Z"));
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer)
      .toMatchObject({ price: 680, callId: inbound.id });
  });

  it("does not guess when a known carrier has multiple active markets", () => {
    const { markets, repository, carriers } = setup();
    const second = markets.createOrder({
      name: "Second load", client: "Nextwave", origin: "Veracruz", destination: "Monterrey",
      currency: "USD", targetPrice: 600, maximumPrice: 800, priceWeight: 0.5, speedWeight: 0.5,
      minimumValidOffers: 2, desiredCarriers: 3, conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
    });
    markets.startMarket(second.currentMarket!.market.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_ambiguous", fromNumber: carriers[0]!.e164PhoneNumber, toNumber: "+12025550101",
      contactId: carriers[0]!.id, status: "IN_PROGRESS", rawPayload: {},
    });

    const attachment = markets.attachInboundCallToMarket(inbound.id);
    expect(attachment.status).toBe("AMBIGUOUS");
    expect(attachment.marketId).toBeNull();
    expect(attachment.candidates).toHaveLength(2);
  });

  it("records a better late callback without revoking an existing award", () => {
    const { markets, repository, workspace, carriers, calls } = setup();
    markets.recordProgressiveOfferForCall(calls[0]!.id, completeOffer(760, "2030-01-10T15:30:00.000Z"));
    markets.recordProgressiveOfferForCall(calls[1]!.id, completeOffer(700, "2030-01-10T16:00:00.000Z"));
    markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(850, "2030-01-10T17:00:00.000Z"));
    markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(650, "2030-01-10T15:00:00.000Z"));
    let state = markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(640, "2030-01-10T15:00:00.000Z"));
    const originalCommitment = state.activeCommitment!;

    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_late_better", fromNumber: carriers[0]!.e164PhoneNumber, toNumber: "+12025550101",
      contactId: carriers[0]!.id, status: "IN_PROGRESS", rawPayload: {},
    });
    expect(markets.attachInboundCallToMarket(inbound.id, workspace.order.reference!)).toMatchObject({ status: "CLOSED" });
    state = markets.recordProgressiveOfferForCall(inbound.id, completeOffer(500, "2030-01-10T14:30:00.000Z"));

    expect(state.market.status).toBe("COMMITTED");
    expect(state.activeCommitment?.id).toBe(originalCommitment.id);
    expect(state.offers.some((offer) => offer.callId === inbound.id && offer.price === 500)).toBe(true);
  });
});
