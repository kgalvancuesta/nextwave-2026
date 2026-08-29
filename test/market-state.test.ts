import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers";

function setup(minimumValidOffers = 1) {
  const context = createTestContext();
  const carriers = [
    context.repository.createContact({ label: "Rivera", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
    context.repository.createContact({ label: "GDL", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
    context.repository.createContact({ label: "Pacifico", phoneInput: "+12025550110", e164PhoneNumber: "+12025550110" }),
  ];
  const workspace = context.markets.createOrder({
    name: "Textiles Pacifico", client: "Textiles Pacifico", origin: "Manzanillo", destination: "Guadalajara",
    currency: "MXN", targetPrice: 8_000, maximumPrice: 9_000,
    preferredArrival: "2030-01-10T12:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
    priceWeight: 0.65, speedWeight: 0.35, minimumValidOffers, desiredCarriers: 3,
    conditions: ["Tolls included"], carrierIds: carriers.map((carrier) => carrier.id),
  });
  return { ...context, carriers, workspace, marketId: workspace.currentMarket!.market.id };
}

describe("derived market state", () => {
  it("handles no offers and recalculates the best latest valid offer", () => {
    const { markets, carriers, marketId } = setup();
    expect(markets.getMarketState(marketId)?.bestOffer).toBeNull();

    markets.recordOffer(marketId, { carrierId: carriers[0]!.id, price: 8_700, expectedArrival: "2030-01-10T14:00:00.000Z" });
    markets.recordOffer(marketId, { carrierId: carriers[1]!.id, price: 8_400, expectedArrival: "2030-01-10T16:00:00.000Z" });
    let state = markets.getMarketState(marketId)!;
    expect(state.progress.validOffers).toBe(2);
    expect(state.bestOffer?.carrierId).toBe(carriers[1]!.id);

    markets.recordOffer(marketId, { carrierId: carriers[0]!.id, price: 8_100, expectedArrival: "2030-01-10T13:00:00.000Z" });
    state = markets.getMarketState(marketId)!;
    expect(state.bestOffer?.carrierId).toBe(carriers[0]!.id);
    expect(state.offers).toHaveLength(3);
    const newest = state.offers.find((offer) => offer.carrierId === carriers[0]!.id && offer.price === 8_100)!;
    const prior = state.offers.find((offer) => offer.carrierId === carriers[0]!.id && offer.price === 8_700)!;
    expect(newest.supersedesOfferId).toBe(prior.id);
  });

  it("invalidates offers above maximum or after must-arrive-by", () => {
    const { markets, carriers, marketId } = setup();
    markets.recordOffer(marketId, { carrierId: carriers[0]!.id, price: 9_100, expectedArrival: "2030-01-10T12:00:00.000Z" });
    markets.recordOffer(marketId, { carrierId: carriers[1]!.id, price: 8_200, expectedArrival: "2030-01-10T19:00:00.000Z" });
    const state = markets.getMarketState(marketId)!;
    expect(state.progress.validOffers).toBe(0);
    expect(state.bestOffer).toBeNull();
    expect(state.offers.every((offer) => !offer.isValid)).toBe(true);
  });
});
