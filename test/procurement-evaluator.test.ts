import { describe, expect, it } from "vitest";
import {
  checkOfferFeasibility,
  evaluateMarket,
  evaluateOffers,
  type ProcurementOfferFacts,
} from "@/lib/procurement-evaluator";
import type { MandateSnapshot } from "@/lib/market-types";

const mandate: MandateSnapshot = {
  targetPrice: 700,
  maximumPrice: 900,
  preferredPickup: null,
  mustPickupBy: null,
  preferredArrival: "2030-01-10T15:00:00.000Z",
  mustArriveBy: "2030-01-10T18:00:00.000Z",
  priceWeight: 0.6,
  speedWeight: 0.4,
  minimumValidOffers: 2,
  desiredCarriers: 3,
  conditions: ["Tolls included"],
  currency: "USD",
  freeTimeEndsAt: null,
  dailyDemurrageRate: 0,
  exchangeRates: { USD: 1, MXN: 0.058676 },
  exchangeRateSource: "test",
};

function offer(id: string, carrierId: string, price: number | null, arrival: string | null): ProcurementOfferFacts {
  return {
    id,
    carrierId,
    availability: "AVAILABLE",
    price,
    currency: price === null ? null : "USD",
    rateAllIn: price === null ? null : true,
    pickupTime: null,
    expectedArrival: arrival,
    firm: true,
    confirmedRequirements: ["Tolls included"],
    rejectedRequirements: [],
    humanRequired: false,
  };
}

describe("deterministic procurement evaluator", () => {
  it("surfaces every hard-constraint violation with exact deltas", () => {
    const result = checkOfferFeasibility(mandate, {
      ...offer("bad", "carrier-a", 20_000, "2030-01-10T18:30:00.000Z"),
      currency: "MXN",
      confirmedRequirements: [],
      rejectedRequirements: ["Tolls included"],
    });

    expect(result.feasible).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "MAXIMUM_PRICE", "MANDATORY_ARRIVAL", "REQUIRED_CONDITION",
    ]);
    expect(result.violations.find((violation) => violation.code === "MAXIMUM_PRICE")?.actual).toBe(1173.52);
    expect(result.violations.find((violation) => violation.code === "MAXIMUM_PRICE")?.delta).toBe(273.52);
    expect(result.violations.find((violation) => violation.code === "MANDATORY_ARRIVAL")?.delta).toBe(30 * 60_000);
  });

  it("does not release or rank a complete-looking draft before recap confirmation", () => {
    const draft = { ...offer("draft", "carrier-a", 700, "2030-01-10T18:30:00.000Z"), firm: false };
    const result = evaluateMarket({
      revision: 7,
      status: "NEGOTIATING",
      automaticAward: true,
      deadlineAt: null,
      mandate,
      carriers: [{
        carrierId: "carrier-a", callId: "call-a", callActive: true, callTerminal: false,
        negotiationRounds: 0, humanReason: null, offer: draft,
      }],
    });

    expect(result.offers[0]).toMatchObject({ comparable: false, feasible: false });
    expect(result.actions["carrier-a"]).toMatchObject({ action: "CONFIRM", reason: "confirm_complete_offer" });
    expect(result.rankedOfferIds).toEqual([]);
    expect(result.awardReady).toBe(false);
  });

  it("prunes only strictly dominated comparable offers and never treats unknown as bad", () => {
    const evaluated = evaluateOffers(mandate, [
      offer("a", "a", 700, "2030-01-10T16:00:00.000Z"),
      offer("b", "b", 820, "2030-01-10T17:00:00.000Z"),
      offer("c", "c", 650, null),
      offer("d", "d", 780, "2030-01-10T15:00:00.000Z"),
    ]);

    expect(evaluated.find((candidate) => candidate.id === "b")?.classification).toBe("DOMINATED");
    expect(evaluated.find((candidate) => candidate.id === "a")?.classification).toBe("FRONTIER");
    expect(evaluated.find((candidate) => candidate.id === "d")?.classification).toBe("FRONTIER");
    expect(evaluated.find((candidate) => candidate.id === "c")?.classification).toBe("PARTIAL");
    expect(evaluated.find((candidate) => candidate.id === "c")?.dominated).toBe(false);
  });

  it("changes ranking when the configured price/speed weights change", () => {
    const candidates = [
      offer("cheap", "cheap", 700, "2030-01-10T17:30:00.000Z"),
      offer("fast", "fast", 850, "2030-01-10T14:30:00.000Z"),
    ];
    const priceFirst = evaluateOffers({ ...mandate, priceWeight: 0.9, speedWeight: 0.1 }, candidates)
      .sort((left, right) => right.score - left.score);
    const speedFirst = evaluateOffers({ ...mandate, priceWeight: 0.1, speedWeight: 0.9 }, candidates)
      .sort((left, right) => right.score - left.score);

    expect(priceFirst[0]?.id).toBe("cheap");
    expect(speedFirst[0]?.id).toBe("fast");
  });

  it("holds an early quote, then chooses the best feasible quote without counteroffers", () => {
    const early = evaluateMarket({
      revision: 3,
      status: "NEGOTIATING",
      automaticAward: true,
      deadlineAt: null,
      mandate,
      carriers: [
        { carrierId: "a", callId: "call-a", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: offer("a1", "a", 760, "2030-01-10T15:30:00.000Z") },
        { carrierId: "b", callId: "call-b", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: null },
        { carrierId: "c", callId: "call-c", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: null },
      ],
    });
    expect(early.actions.a?.action).toBe("HOLD");
    expect(early.actions.b?.action).toBe("CONTINUE_DISCOVERY");

    const developed = evaluateMarket({
      revision: 4,
      status: "NEGOTIATING",
      automaticAward: true,
      deadlineAt: null,
      mandate,
      carriers: [
        { carrierId: "a", callId: "call-a", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: offer("a1", "a", 760, "2030-01-10T15:30:00.000Z") },
        { carrierId: "b", callId: "call-b", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: offer("b1", "b", 700, "2030-01-10T16:00:00.000Z") },
        { carrierId: "c", callId: "call-c", callActive: true, callTerminal: false, negotiationRounds: 0, humanReason: null, offer: offer("c1", "c", 850, "2030-01-10T17:00:00.000Z") },
      ],
    });
    expect(developed.awardOfferId).toBe("b1");
    expect(developed.actions.a).toMatchObject({ action: "RELEASE", reason: "market_awarded_to_better_offer" });
    expect(developed.actions.b).toMatchObject({ action: "AWARD", reason: "best_current_feasible_offer" });
    expect(developed.actions.c).toMatchObject({ action: "RELEASE", reason: "pareto_dominated" });
  });

  it("distinguishes an incomplete market from hard-constraint rejection", () => {
    const result = evaluateMarket({
      revision: 5,
      status: "NEGOTIATING",
      automaticAward: true,
      deadlineAt: "2030-01-10T12:00:00.000Z",
      now: "2030-01-10T12:01:00.000Z",
      mandate,
      carriers: [
        { carrierId: "a", callId: "call-a", callActive: false, callTerminal: true, negotiationRounds: 0, humanReason: null, offer: offer("a1", "a", 760, null) },
        { carrierId: "b", callId: "call-b", callActive: false, callTerminal: true, negotiationRounds: 0, humanReason: null, offer: null },
      ],
    });

    expect(result.phase).toBe("HUMAN_REVIEW");
    expect(result.reviewReason).toBe("No complete feasible offer was collected before market close. Missing: committed arrival. Automatic award is prohibited.");
  });

  it("compares a foreign-currency quote using the snapshotted backend rate", () => {
    const evaluated = evaluateOffers({
      ...mandate,
      currency: "MXN",
      targetPrice: 8_000,
      maximumPrice: 10_000,
      exchangeRates: { MXN: 1, USD: 17.0427 },
    }, [{ ...offer("usd", "carrier-usd", 150, "2030-01-10T16:00:00.000Z"), currency: "USD" }])[0]!;

    expect(evaluated.normalizedPrice).toBe(2556.41);
    expect(evaluated.normalizedCurrency).toBe("MXN");
    expect(evaluated.exchangeRate).toBe(17.0427);
    expect(evaluated.feasible).toBe(true);
  });

  it("does not overwrite a real human-authority reason with a close-time summary", () => {
    const result = evaluateMarket({
      revision: 6,
      status: "NEGOTIATING",
      automaticAward: true,
      deadlineAt: "2030-01-10T12:00:00.000Z",
      now: "2030-01-10T12:01:00.000Z",
      mandate,
      carriers: [
        { carrierId: "a", callId: "call-a", callActive: false, callTerminal: true, negotiationRounds: 0, humanReason: "Carrier requested a manager", offer: null },
      ],
    });

    expect(result.reviewReason).toBe("A live carrier interaction requires human authority.");
  });
});
