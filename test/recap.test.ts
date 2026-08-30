import { describe, expect, it } from "vitest";
import { buildAwardReadback, buildAwardRecapBody } from "@/lib/recap";
import { flushAwardRecaps, type RecapSender } from "@/lib/recap-service";
import { createTestContext } from "./helpers";

const OFFER = {
  price: 640,
  currency: "USD",
  rateAllIn: true,
  pickupTime: "2030-01-10T09:00:00.000Z",
  expectedArrival: "2030-01-10T15:00:00.000Z",
  accessorials: [],
  confirmedRequirements: ["Genset required"],
};

const ORDER = {
  id: "8f1d2c3b-0000-4000-8000-000000000000",
  reference: "ORD-778",
  origin: "Manzanillo",
  destination: "Guadalajara",
  conditions: ["Genset required"],
};

function setup() {
  const context = createTestContext();
  const carriers = [
    context.repository.createContact({ label: "FedEx", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
    context.repository.createContact({ label: "UPS", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
    context.repository.createContact({ label: "DHL", phoneInput: "+12025550110", e164PhoneNumber: "+12025550110" }),
  ];
  const workspace = context.markets.createOrder({
    name: "Recap load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
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

function completeOffer(price: number, arrival: string) {
  return {
    availability: "AVAILABLE" as const,
    price, currency: "USD", rateAllIn: true, expectedArrival: arrival,
    firm: true,
    confirmedRequirements: [], confidence: 0.98,
  };
}

/** Drives the market to the automatic award recorded in the workflow tests. */
function awardMarket(context: ReturnType<typeof setup>) {
  const { markets, calls } = context;
  // Each locked quote is asked once for a lower price; the second update per
  // carrier is that answer and spends the round, so the market can then award.
  markets.recordProgressiveOfferForCall(calls[0]!.id, completeOffer(760, "2030-01-10T15:30:00.000Z"));
  markets.recordProgressiveOfferForCall(calls[0]!.id, completeOffer(760, "2030-01-10T15:30:00.000Z"));
  markets.recordProgressiveOfferForCall(calls[1]!.id, completeOffer(700, "2030-01-10T16:00:00.000Z"));
  markets.recordProgressiveOfferForCall(calls[1]!.id, completeOffer(700, "2030-01-10T16:00:00.000Z"));
  markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(650, "2030-01-10T15:00:00.000Z"));
  return markets.recordProgressiveOfferForCall(calls[2]!.id, completeOffer(640, "2030-01-10T15:00:00.000Z"));
}

function fakeSender(deliveryId = "SM_1"): RecapSender & { sent: Array<{ to: string; body: string }> } {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
      return { deliveryId };
    },
  };
}

describe("award recap body", () => {
  it("states every committed term the carrier could later dispute", () => {
    const body = buildAwardRecapBody({ commitmentId: "c-1", order: ORDER, carrierLabel: "DHL", offer: OFFER, timeZone: "UTC" });

    expect(body).toContain("ORD-778");
    expect(body).toContain("DHL");
    expect(body).toContain("Manzanillo -> Guadalajara");
    expect(body).toContain("640 USD all-in");
    expect(body).toContain("Genset required");
    expect(body).toContain("Booking ID: c-1");
    expect(body).toMatch(/DISPUTE within 30 minutes/);
  });

  it("names the time zone so a disputed timestamp is never ambiguous", () => {
    const body = buildAwardRecapBody({ commitmentId: "c-1", order: ORDER, carrierLabel: "DHL", offer: OFFER, timeZone: "UTC" });

    expect(body).toMatch(/Arrival: .*\(UTC\)/);
  });

  it("says the rate is unconfirmed rather than inventing one", () => {
    const body = buildAwardRecapBody({
      commitmentId: "c-1", order: ORDER, carrierLabel: "DHL", timeZone: "UTC",
      offer: { ...OFFER, price: null, rateAllIn: null },
    });

    expect(body).toContain("rate to be confirmed");
  });

  it("gives the agent a spoken read-back carrying the same terms as the SMS", () => {
    const readback = buildAwardReadback({ commitmentId: "c-1", order: ORDER, carrierLabel: "DHL", offer: OFFER, timeZone: "UTC" });

    expect(readback).toContain("640 USD all-in");
    expect(readback).toContain("Genset required");
  });
});

describe("commitment recap lifecycle", () => {
  it("queues a written recap inside the award transaction", () => {
    const context = setup();
    const state = awardMarket(context);

    const commitment = state.activeCommitment!;
    expect(commitment.recapStatus).toBe("PENDING");
    expect(commitment.recapChannel).toBe("sms");
    expect(commitment.recapAddress).toBe(context.carriers[2]!.e164PhoneNumber);
    expect(commitment.recapBody).toContain("640 USD all-in");
    expect(context.markets.getOrder(context.workspace.order.id)!.events.some((event) => event.eventType === "RECAP_QUEUED")).toBe(true);
  });

  it("delivers the queued recap verbatim and records the provider receipt", async () => {
    const context = setup();
    const state = awardMarket(context);
    const sender = fakeSender("SM_delivered");

    expect(await flushAwardRecaps(context.markets, sender)).toEqual({ sent: 1, failed: 0 });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(context.carriers[2]!.e164PhoneNumber);
    expect(sender.sent[0]!.body).toBe(state.activeCommitment!.recapBody);

    const commitment = context.markets.getMarketState(context.marketId)!.activeCommitment!;
    expect(commitment.recapStatus).toBe("SENT");
    expect(commitment.recapDeliveryId).toBe("SM_delivered");
    expect(commitment.recapSentAt).not.toBeNull();
    expect(context.markets.getOrder(context.workspace.order.id)!.events.some((event) => event.eventType === "RECAP_SENT")).toBe(true);
  });

  it("does not resend a recap that already reached the carrier", async () => {
    const context = setup();
    awardMarket(context);
    const sender = fakeSender();

    await flushAwardRecaps(context.markets, sender);
    expect(await flushAwardRecaps(context.markets, sender)).toEqual({ sent: 0, failed: 0 });
    expect(sender.sent).toHaveLength(1);
  });

  it("keeps a failed recap pending, then escalates it after three attempts", async () => {
    const context = setup();
    awardMarket(context);
    const failing: RecapSender = { async send() { throw new Error("Twilio 21610: unsubscribed recipient"); } };

    await flushAwardRecaps(context.markets, failing);
    let commitment = context.markets.getMarketState(context.marketId)!.activeCommitment!;
    expect(commitment.recapStatus).toBe("PENDING");
    expect(commitment.recapAttempts).toBe(1);
    expect(commitment.recapError).toMatch(/unsubscribed recipient/);

    await flushAwardRecaps(context.markets, failing);
    await flushAwardRecaps(context.markets, failing);

    commitment = context.markets.getMarketState(context.marketId)!.activeCommitment!;
    expect(commitment.recapStatus).toBe("FAILED");
    expect(commitment.recapAttempts).toBe(3);
    expect(await flushAwardRecaps(context.markets, failing)).toEqual({ sent: 0, failed: 0 });
  });

  it("never loses the award when the recap cannot be delivered", async () => {
    const context = setup();
    const awarded = awardMarket(context);
    const failing: RecapSender = { async send() { throw new Error("network down"); } };

    await flushAwardRecaps(context.markets, failing);

    const state = context.markets.getMarketState(context.marketId)!;
    expect(state.market.status).toBe("COMMITTED");
    expect(state.activeCommitment!.id).toBe(awarded.activeCommitment!.id);
  });

  it("also queues a recap for an offer a human commits from the dashboard", () => {
    const context = setup();
    context.markets.recordProgressiveOfferForCall(context.calls[0]!.id, completeOffer(760, "2030-01-10T15:30:00.000Z"));
    const state = context.markets.recordProgressiveOfferForCall(context.calls[1]!.id, completeOffer(700, "2030-01-10T16:00:00.000Z"));
    const offer = state.carriers.find((carrier) => carrier.carrier.id === context.carriers[1]!.id)!.latestOffer!;

    const workspace = context.markets.commitOffer(offer.id);

    const commitment = workspace.commitments.find((candidate) => candidate.status === "ACTIVE")!;
    expect(commitment.recapStatus).toBe("PENDING");
    expect(commitment.recapBody).toContain("700 USD all-in");
  });
});
