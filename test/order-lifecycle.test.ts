import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers";

describe("order lifecycle and commitment concurrency", () => {
  it("preserves failure history and restores committed state through a recovery market", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({ label: "Rivera", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" });
    const created = markets.createOrder({
      name: "Order 17", client: "Textiles", origin: "Manzanillo", destination: "Guadalajara", currency: "MXN",
      targetPrice: 8_000, maximumPrice: 9_000, priceWeight: 0.7, speedWeight: 0.3,
      minimumValidOffers: 1, desiredCarriers: 1, conditions: [], carrierIds: [carrier.id],
    });
    expect(created.order.lifecycleStatus).toBe("SOURCING");
    const marketOne = created.currentMarket!.market.id;
    const firstState = markets.recordOffer(marketOne, { carrierId: carrier.id, price: 8_300, isFinalOffer: true });
    const firstOffer = firstState.bestOffer!;
    let workspace = markets.commitOffer(firstOffer.id);
    expect(workspace.order.lifecycleStatus).toBe("COMMITTED");
    const firstCommitment = workspace.commitments.find((commitment) => commitment.status === "ACTIVE")!;

    expect(() => markets.commitOffer(firstOffer.id)).toThrow(/active commitment/);

    workspace = markets.invalidateCommitment(firstCommitment.id, "Truck breakdown");
    expect(workspace.order.lifecycleStatus).toBe("EXCEPTION");
    expect(workspace.commitments[0]?.status).toBe("INVALIDATED");
    workspace = markets.createRecoveryMarket(workspace.order.id);
    expect(workspace.markets).toHaveLength(2);
    expect(workspace.currentMarket?.market.sequenceNumber).toBe(2);
    expect(workspace.order.lifecycleStatus).toBe("EXCEPTION");

    const recoveryId = workspace.currentMarket!.market.id;
    const replacement = markets.recordOffer(recoveryId, { carrierId: carrier.id, price: 8_500, isFinalOffer: true }).bestOffer!;
    workspace = markets.commitOffer(replacement.id);
    expect(workspace.order.lifecycleStatus).toBe("COMMITTED");
    expect(workspace.order.exceptionReason).toBeNull();
    expect(workspace.commitments.filter((commitment) => commitment.status === "ACTIVE")).toHaveLength(1);
    expect(workspace.markets.find((market) => market.market.id === marketOne)?.market.status).toBe("FAILED");

    workspace = markets.completeOrder(workspace.order.id);
    expect(workspace.order.lifecycleStatus).toBe("COMPLETED");
    expect(workspace.commitments.some((commitment) => commitment.status === "FULFILLED")).toBe(true);
    expect(workspace.currentMarket?.market.status).toBe("CLOSED");
  });
});
