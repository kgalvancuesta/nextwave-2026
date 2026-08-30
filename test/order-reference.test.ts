import { describe, expect, it } from "vitest";
import { normalizeOrderReference, publicOrderReference } from "@/lib/market-types";
import { VoltaStore } from "@/lib/volta/store";
import { createTestContext } from "./helpers";

const baseOrder = {
  name: "Order reference test",
  client: "Textiles",
  origin: "Manzanillo",
  destination: "Guadalajara",
  currency: "MXN",
  targetPrice: 8_000,
  maximumPrice: 9_000,
  priceWeight: 0.7,
  speedWeight: 0.3,
  minimumValidOffers: 1,
  desiredCarriers: 1,
  conditions: [],
};

describe("order/reference numbers", () => {
  it("persists a generated public reference when the form leaves it blank", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "Rivera",
      phoneInput: "+12025550100",
      e164PhoneNumber: "+12025550100",
    });

    const workspace = markets.createOrder({ ...baseOrder, carrierIds: [carrier.id] });

    expect(workspace.order.reference).toMatch(/^ORD-[A-F0-9]{8}$/);
    expect(publicOrderReference(workspace.order)).toBe(workspace.order.reference);
  });

  it("rejects duplicate user-provided references without case sensitivity", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "Rivera",
      phoneInput: "+12025550100",
      e164PhoneNumber: "+12025550100",
    });
    markets.createOrder({ ...baseOrder, reference: "SHIP-77", carrierIds: [carrier.id] });

    expect(() => markets.createOrder({
      ...baseOrder,
      name: "Duplicate",
      reference: "ship 77",
      carrierIds: [carrier.id],
    })).toThrow(/already exists/);
  });

  it("finds a linked voice operation using the order reference shown in the dashboard", () => {
    const { db, repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "Rivera",
      phoneInput: "+12025550100",
      e164PhoneNumber: "+12025550100",
    });
    const workspace = markets.createOrder({ ...baseOrder, reference: "SHIP-77", carrierIds: [carrier.id] });
    const store = new VoltaStore(db);
    const operation = store.createOperation({
      externalReference: `order:${workspace.order.id}`,
      objective: "Book ground transport",
      mandate: {
        currency: "MXN",
        rate: { min: 8_000, max: 9_000 },
        pickupWindow: { earliest: "2030-01-10T14:00:00.000Z", latest: "2030-01-10T18:00:00.000Z" },
        allowedAccessorials: [],
        prohibitedTerms: [],
      },
      minimumCarrierCalls: 3,
    });
    markets.linkVoltaRecovery(workspace.order.id, operation.id, "legacy-market-id");

    expect(store.findOperationByReference("ship 77")?.id).toBe(operation.id);
  });

  it("matches spoken digit sequences to stored numeric references", () => {
    expect(normalizeOrderReference("one one one seven")).toBe("1117");
    expect(normalizeOrderReference("Order number is one one one seven")).toBe("1117");
    expect(normalizeOrderReference("uno uno uno siete")).toBe("1117");
  });

  it("preserves existing alphanumeric reference behavior", () => {
    expect(normalizeOrderReference("ORD-1845-AD19")).toBe("ORD1845AD19");
  });
});
