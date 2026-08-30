import { describe, expect, it } from "vitest";
import { deadlineWhenEnabled, synchronizeDeadline, validateNewOrder, type NewOrderDraft } from "@/lib/order-form";

const draft: NewOrderDraft = {
  name: "Textiles Pacifico",
  client: "Textiles Pacifico",
  origin: "Manzanillo",
  destination: "Guadalajara",
  reference: "",
  currency: "MXN",
  targetPrice: "8000",
  maximumPrice: "9000",
  preferredArrival: "2030-01-10T12:00",
  mustArriveBy: "2030-01-10T18:00",
  minimumValidOffers: "2",
  desiredCarriers: "3",
  freeTimeEndsAt: "",
  currentEta: "",
  dailyDemurrageRate: "",
};

describe("new order arrival controls", () => {
  it("allows the mandatory deadline to equal or follow preferred arrival", () => {
    expect(validateNewOrder({ ...draft, mustArriveBy: draft.preferredArrival }, true, 1).mustArriveBy).toBeUndefined();
    expect(validateNewOrder(draft, true, 1).mustArriveBy).toBeUndefined();
  });

  it("rejects a mandatory deadline before preferred arrival", () => {
    expect(validateNewOrder({ ...draft, mustArriveBy: "2030-01-10T11:00" }, true, 1).mustArriveBy).toMatch(/cannot be before/);
  });

  it("advances an outdated deadline and preserves a later valid deadline", () => {
    expect(synchronizeDeadline("2030-01-10T20:00", draft.mustArriveBy, true)).toBe("2030-01-10T20:00");
    expect(synchronizeDeadline("2030-01-10T10:00", draft.mustArriveBy, true)).toBe(draft.mustArriveBy);
  });

  it("does not validate or rewrite a disabled deadline", () => {
    const invalid = { ...draft, mustArriveBy: "2030-01-10T11:00" };
    expect(synchronizeDeadline(invalid.preferredArrival, invalid.mustArriveBy, false)).toBe(invalid.mustArriveBy);
    expect(validateNewOrder(invalid, false, 1).mustArriveBy).toBeUndefined();
  });

  it("re-enables a deadline with a valid prior value or preferred-arrival fallback", () => {
    expect(deadlineWhenEnabled(draft.preferredArrival, draft.mustArriveBy, "2030-01-11T12:00")).toBe(draft.mustArriveBy);
    expect(deadlineWhenEnabled("2030-01-10T20:00", draft.mustArriveBy, "2030-01-11T12:00")).toBe("2030-01-10T20:00");
    expect(deadlineWhenEnabled("", "", "2030-01-11T12:00")).toBe("2030-01-11T12:00");
  });
});

describe("new order validation feedback", () => {
  it("returns field-specific errors for the action-area summary", () => {
    const errors = validateNewOrder({ ...draft, destination: "", maximumPrice: "7000" }, true, 0);
    expect(errors.destination).toBe("Destination is required.");
    expect(errors.maximumPrice).toMatch(/greater than or equal/);
    expect(errors.carrierIds).toBeUndefined();
  });
});
