import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers";

const pickup1430 = "2030-01-10T14:30:00.000Z";
const pickup1440 = "2030-01-10T14:40:00.000Z";
const pickup1450 = "2030-01-10T14:50:00.000Z";
const pickup1700 = "2030-01-10T17:00:00.000Z";
const pickup1730 = "2030-01-10T17:30:00.000Z";

function bookedMarket() {
  const context = createTestContext();
  const carriers = [
    context.repository.createContact({ label: "Carrier A", phoneInput: "+12025550102", e164PhoneNumber: "+12025550102" }),
    context.repository.createContact({ label: "Carrier B", phoneInput: "+12025550103", e164PhoneNumber: "+12025550103" }),
    context.repository.createContact({ label: "Carrier C", phoneInput: "+12025550104", e164PhoneNumber: "+12025550104" }),
  ];
  let workspace = context.markets.createOrder({
    name: "Dallas Phoenix", client: "Demo", origin: "Dallas", destination: "Phoenix", reference: "1842",
    currency: "USD", targetPrice: 1_400, maximumPrice: 1_500,
    preferredPickup: pickup1430, mustPickupBy: "2030-01-10T15:00:00.000Z",
    priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 3,
    conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
  });
  const marketId = workspace.currentMarket!.market.id;
  const stateA = context.markets.recordOffer(marketId, {
    carrierId: carriers[0]!.id, price: 1_450, pickupTime: pickup1430, isFinalOffer: true,
  });
  context.markets.recordOffer(marketId, {
    carrierId: carriers[1]!.id, price: 1_475, pickupTime: pickup1450, isFinalOffer: true,
  });
  workspace = context.markets.commitOffer(stateA.offers.find((offer) => offer.carrierId === carriers[0]!.id)!.id);
  const inbound = context.repository.upsertInboundCall({
    twilioCallSid: `CA_${crypto.randomUUID()}`,
    fromNumber: carriers[0]!.e164PhoneNumber,
    toNumber: "+12025550101",
    contactId: carriers[0]!.id,
    status: "IN_PROGRESS",
    rawPayload: {},
  });
  expect(context.markets.attachInboundCallToMarket(inbound.id, "one eight four two").status).toBe("CLOSED");
  return { ...context, carriers, workspace, marketId, inbound };
}

describe("self-healing orders", () => {
  it("accepts a feasible amendment that remains best without creating outbound calls", () => {
    const { markets, repository, inbound, workspace } = bookedMarket();
    const before = markets.getOrder(workspace.order.id)!;
    const originalOfferId = before.commitments.find((commitment) => commitment.status === "ACTIVE")!.offerId;

    const decision = markets.proposeAmendmentForCall(inbound.id, {
      price: 1_470,
      currency: "USD",
      pickupTime: pickup1440,
      negotiationComplete: false,
    });

    expect(decision.action).toBe("ACCEPT");
    expect(decision.amendment).toMatchObject({ status: "ACCEPTED", requestedTerms: { price: 1_470, pickupTime: pickup1440 } });
    const after = markets.getOrder(workspace.order.id)!;
    expect(after.commitments.find((commitment) => commitment.status === "ACTIVE")!.offerId).not.toBe(originalOfferId);
    expect(after.amendments).toHaveLength(1);
    expect(repository.listCalls().filter((call) => call.direction === "OUTBOUND")).toHaveLength(0);

    const duplicate = markets.proposeAmendmentForCall(inbound.id, { price: 1_470, negotiationComplete: false });
    expect(duplicate.amendment.id).toBe(decision.amendment.id);
    expect(markets.getOrder(workspace.order.id)!.amendments).toHaveLength(1);
  });

  it("negotiates an infeasible amendment, then opens recovery without mutating the active commitment", () => {
    const { markets, carriers, inbound, marketId, workspace: created } = bookedMarket();
    const original = markets.getOrder(created.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")!;

    const negotiation = markets.proposeAmendmentForCall(inbound.id, {
      price: 1_650,
      pickupTime: pickup1730,
      negotiationComplete: false,
    });
    expect(negotiation).toMatchObject({ action: "NEGOTIATE", negotiationTargets: { maximumPrice: 1_500 } });
    expect(negotiation.amendment.violations.map((violation) => violation.code)).toEqual(["MAXIMUM_PRICE", "MANDATORY_PICKUP"]);
    expect(markets.getOrder(created.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")?.offerId)
      .toBe(original.offerId);

    const recovery = markets.proposeAmendmentForCall(inbound.id, {
      price: 1_575,
      pickupTime: pickup1700,
      negotiationComplete: true,
    });
    expect(recovery.action).toBe("RECOVER");
    expect(recovery.recoveryMarketId).not.toBeNull();
    let workspace = markets.getOrder(created.order.id)!;
    expect(workspace.order.lifecycleStatus).toBe("EXCEPTION");
    expect(workspace.commitments.find((commitment) => commitment.status === "ACTIVE")?.id).toBe(original.id);
    expect(workspace.currentMarket?.market.id).toBe(recovery.recoveryMarketId);
    expect(workspace.currentMarket?.carriers.some((carrier) => carrier.carrier.id === carriers[1]!.id)).toBe(true);
    expect(workspace.currentMarket?.carriers.some((carrier) => carrier.carrier.id === carriers[0]!.id)).toBe(false);

    const recoveredOffer = markets.recordOffer(recovery.recoveryMarketId!, {
      carrierId: carriers[1]!.id, price: 1_490, pickupTime: pickup1450, isFinalOffer: true,
    }).bestOffer!;
    workspace = markets.commitOffer(recoveredOffer.id);
    expect(workspace.commitments.filter((commitment) => commitment.status === "ACTIVE")).toHaveLength(1);
    expect(workspace.commitments.find((commitment) => commitment.status === "ACTIVE")?.carrierId).toBe(carriers[1]!.id);
    expect(workspace.commitments.find((commitment) => commitment.id === original.id)?.status).toBe("INVALIDATED");
    expect(workspace.markets.find((market) => market.market.id === marketId)?.market.status).toBe("FAILED");
    expect(workspace.order.lifecycleStatus).toBe("COMMITTED");
  });

  it("starts recovery when the committed carrier becomes unavailable", () => {
    const { markets, carriers, inbound, workspace: created } = bookedMarket();
    const original = markets.getOrder(created.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")!;

    const recovery = markets.proposeAmendmentForCall(inbound.id, {
      availability: "UNAVAILABLE",
      negotiationComplete: false,
      rawStatement: "We can no longer make the commitment.",
    });

    expect(recovery).toMatchObject({
      action: "RECOVER",
      amendment: { status: "RECOVERY_REQUIRED" },
    });
    expect(recovery.amendment.violations.map((violation) => violation.code)).toContain("UNAVAILABLE");
    const workspace = markets.getOrder(created.order.id)!;
    expect(workspace.commitments.find((commitment) => commitment.status === "ACTIVE")?.id).toBe(original.id);
    expect(workspace.currentMarket?.carriers.map((carrier) => carrier.carrier.id)).not.toContain(carriers[0]!.id);
  });

  it("requires human assistance when an unavailable commitment has no alternate carrier", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "Only carrier", phoneInput: "+12025550105", e164PhoneNumber: "+12025550105",
    });
    const created = markets.createOrder({
      name: "Single carrier", client: "Demo", origin: "Dallas", destination: "Phoenix", reference: "1900",
      currency: "USD", targetPrice: 1_400, maximumPrice: 1_500,
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    const offer = markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: carrier.id, price: 1_450, isFinalOffer: true,
    }).bestOffer!;
    markets.commitOffer(offer.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_no_recovery_candidate", fromNumber: carrier.e164PhoneNumber,
      toNumber: "+12025550101", contactId: carrier.id, status: "IN_PROGRESS", rawPayload: {},
    });
    expect(markets.attachInboundCallToMarket(inbound.id, "1900").status).toBe("CLOSED");

    const decision = markets.proposeAmendmentForCall(inbound.id, {
      availability: "UNAVAILABLE", negotiationComplete: false,
    });

    expect(decision).toMatchObject({ action: "HUMAN_HANDOFF", amendment: { status: "HUMAN_REQUIRED" } });
    expect(markets.getOrder(created.order.id)?.order).toMatchObject({
      lifecycleStatus: "EXCEPTION",
      exceptionReason: "No alternate carrier is available; human assistance is required.",
    });
  });

  it("revalidates only better retained offers and switches atomically when one is reconfirmed", () => {
    const { markets, carriers, inbound, workspace: created, marketId } = bookedMarket();
    const originalCommitment = markets.getOrder(created.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")!;
    const decision = markets.proposeAmendmentForCall(inbound.id, {
      price: 1_495,
      pickupTime: pickup1440,
      negotiationComplete: false,
    });
    expect(decision).toMatchObject({ action: "REVALIDATE", amendment: { status: "RECOVERY_REQUIRED", violations: [] } });
    const revalidation = markets.getOrder(created.order.id)!.currentMarket!;
    expect(revalidation.market).toMatchObject({ reason: "AMENDMENT_REVALIDATION", status: "DRAFT" });
    expect(revalidation.carriers.map((carrier) => carrier.carrier.id)).toEqual([carriers[1]!.id]);
    expect(revalidation.carriers[0]?.retainedOffer).toMatchObject({ price: 1_475, pickupTime: pickup1450 });
    expect(revalidation.market.mandate).toMatchObject({ minimumValidOffers: 1, maximumPrice: 1_494 });

    markets.startMarket(revalidation.market.id);
    markets.recordProgressiveOffer(revalidation.market.id, carriers[1]!.id, {
      availability: "AVAILABLE", price: 1_475, currency: "USD", rateAllIn: true,
      pickupTime: pickup1450, firm: true, confirmedRequirements: [], rawStatement: "Yes, still confirmed",
    });
    const resolved = markets.getOrder(created.order.id)!;
    expect(resolved.commitments.find((commitment) => commitment.status === "ACTIVE")?.carrierId).toBe(carriers[1]!.id);
    expect(resolved.commitments.find((commitment) => commitment.id === originalCommitment.id)?.status).toBe("INVALIDATED");
    expect(resolved.markets.find((market) => market.market.id === marketId)?.market.status).toBe("COMMITTED");
    expect(resolved.amendments[0]).toMatchObject({ status: "ACCEPTED", finalTerms: { price: 1_475 } });
  });

  it("confirms the original feasible amendment when retained competitors decline", () => {
    const { markets, carriers, inbound, workspace: created } = bookedMarket();
    const decision = markets.proposeAmendmentForCall(inbound.id, {
      price: 1_495,
      pickupTime: pickup1440,
      negotiationComplete: false,
    });
    expect(decision.action).toBe("REVALIDATE");
    markets.startMarket(decision.recoveryMarketId!);
    markets.recordProgressiveOffer(decision.recoveryMarketId!, carriers[1]!.id, {
      availability: "UNAVAILABLE",
      rawStatement: "We can no longer honor the retained offer",
    });

    const resolved = markets.getOrder(created.order.id)!;
    const active = resolved.commitments.find((commitment) => commitment.status === "ACTIVE")!;
    expect(active.carrierId).toBe(carriers[0]!.id);
    expect(resolved.markets.find((market) => market.market.id === decision.recoveryMarketId)?.market.status).toBe("CANCELED");
    expect(resolved.amendments[0]).toMatchObject({
      status: "ACCEPTED",
      finalTerms: { price: 1_495, pickupTime: pickup1440 },
    });
  });

  it("hands unsupported changes to a human and preserves the commitment", () => {
    const { markets, inbound, workspace } = bookedMarket();
    const before = markets.getOrder(workspace.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")!;
    const decision = markets.proposeAmendmentForCall(inbound.id, {
      unsupportedChange: "Change equipment from dry van to reefer",
      negotiationComplete: false,
    });
    expect(decision.action).toBe("HUMAN_HANDOFF");
    expect(decision.amendment.status).toBe("HUMAN_REQUIRED");
    expect(markets.getOrder(workspace.order.id)!.commitments.find((commitment) => commitment.status === "ACTIVE")?.id).toBe(before.id);
  });

  it("uses reference plus carrier identity when caller ID is unavailable, and never guesses a bad reference", () => {
    const { markets, repository, carriers } = bookedMarket();
    const unknown = repository.upsertInboundCall({
      twilioCallSid: "CA_unknown_identity",
      fromNumber: "+12025550121",
      toNumber: "+12025550101",
      contactId: null,
      status: "IN_PROGRESS",
      rawPayload: {},
    });
    const miss = markets.matchInboundCall(unknown.id, { reference: "wrong", carrierName: carriers[0]!.label });
    expect(miss).toMatchObject({ status: "NOT_FOUND", suggestedQuestion: "Ask the caller to repeat the order/reference number.", shouldEscalate: false });
    const matched = markets.matchInboundCall(unknown.id, { reference: "1842", carrierName: carriers[0]!.label });
    expect(matched.status).toBe("CLOSED");
    expect(repository.getCall(unknown.id)).toMatchObject({ carrierId: carriers[0]!.id });
  });

  it("uses caller ID only as a hint and matches the stated order after asking for carrier", () => {
    const { markets, repository, carriers } = bookedMarket();
    const unrelated = repository.createContact({
      label: "Unrelated caller ID",
      phoneInput: "+12025550108",
      e164PhoneNumber: "+12025550108",
    });
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_unrelated_caller_id",
      fromNumber: unrelated.e164PhoneNumber,
      toNumber: "+12025550101",
      contactId: unrelated.id,
      status: "IN_PROGRESS",
      rawPayload: {},
    });

    const needsCarrier = markets.matchInboundCall(inbound.id, { reference: "1842" });
    expect(needsCarrier).toMatchObject({
      status: "AMBIGUOUS",
      suggestedQuestion: "Ask for the carrier company name.",
      shouldEscalate: false,
    });

    const matched = markets.matchInboundCall(inbound.id, {
      reference: "1842",
      carrierName: carriers[1]!.label,
    });
    expect(matched.status).toBe("CLOSED");
    expect(repository.getCall(inbound.id)).toMatchObject({
      carrierId: carriers[1]!.id,
      marketId: matched.marketId,
    });
  });

  it("automatically selects a historically successful exact-lane carrier", () => {
    const { repository, markets } = createTestContext();
    const fallback = repository.createContact({ label: "A Fallback", phoneInput: "+12025550106", e164PhoneNumber: "+12025550106" });
    const proven = repository.createContact({ label: "Z Proven", phoneInput: "+12025550107", e164PhoneNumber: "+12025550107" });
    const historical = markets.createOrder({
      name: "Historical", client: "Demo", origin: "Dallas", destination: "Phoenix", currency: "USD",
      targetPrice: 1_300, maximumPrice: 1_500, priceWeight: 1, speedWeight: 0,
      minimumValidOffers: 1, desiredCarriers: 1, conditions: [], carrierIds: [proven.id],
    });
    const offer = markets.recordOffer(historical.currentMarket!.market.id, { carrierId: proven.id, price: 1_400, isFinalOffer: true }).bestOffer!;
    markets.completeOrder(markets.commitOffer(offer.id).order.id);

    const created = markets.createOrder({
      name: "Automatic", client: "Demo", origin: "Dallas", destination: "Phoenix", currency: "USD",
      targetPrice: 1_300, maximumPrice: 1_500, priceWeight: 1, speedWeight: 0,
      minimumValidOffers: 1, desiredCarriers: 1, conditions: [], carrierIds: [],
    });
    expect(created.order.carriers.map((carrier) => carrier.id)).toEqual([proven.id]);
    expect(created.order.carriers.map((carrier) => carrier.id)).not.toContain(fallback.id);
    expect(created.events.some((event) => event.eventType === "CARRIERS_AUTO_SELECTED")).toBe(true);
  });
});
