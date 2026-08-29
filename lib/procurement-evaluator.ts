import type {
  EvaluatorAction,
  FeasibilityViolation,
  MandateSnapshot,
  MarketInstruction,
  MarketPhase,
  OfferAvailability,
  OfferClassification,
} from "./market-types";

export interface ProcurementOfferFacts {
  id: string;
  carrierId: string;
  availability: OfferAvailability;
  price: number | null;
  currency: string | null;
  rateAllIn: boolean | null;
  expectedArrival: string | null;
  confirmedRequirements: string[];
  rejectedRequirements: string[];
  humanRequired: boolean;
}

export interface EvaluatedProcurementOffer extends ProcurementOfferFacts {
  comparable: boolean;
  feasible: boolean;
  violations: FeasibilityViolation[];
  missingFields: Array<"availability" | "price" | "arrival" | "all_in" | "requirements">;
  classification: OfferClassification;
  dominated: boolean;
  frontier: boolean;
  score: number;
}

export interface MarketEvaluationCarrier {
  carrierId: string;
  callId: string | null;
  callActive: boolean;
  callTerminal: boolean;
  negotiationRounds: number;
  humanReason: string | null;
  offer: ProcurementOfferFacts | null;
}

export interface MarketEvaluationInput {
  revision: number;
  status: string;
  automaticAward: boolean;
  deadlineAt: string | null;
  mandate: MandateSnapshot;
  carriers: MarketEvaluationCarrier[];
  now?: string;
}

export interface MarketEvaluation {
  revision: number;
  phase: MarketPhase;
  offers: EvaluatedProcurementOffer[];
  actions: Record<string, MarketInstruction>;
  rankedOfferIds: string[];
  bestOfferId: string | null;
  cheapestOfferId: string | null;
  awardOfferId: string | null;
  awardReady: boolean;
  reviewReason: string | null;
}

export function checkOfferFeasibility(
  mandate: MandateSnapshot,
  offer: ProcurementOfferFacts,
): { feasible: boolean; violations: FeasibilityViolation[] } {
  const violations: FeasibilityViolation[] = [];
  if (offer.availability === "UNAVAILABLE") {
    violations.push({ code: "UNAVAILABLE", message: "Carrier is unavailable", actual: "UNAVAILABLE", limit: "AVAILABLE", delta: null });
  }
  if (offer.currency && offer.currency.toUpperCase() !== mandate.currency.toUpperCase()) {
    violations.push({
      code: "CURRENCY",
      message: `Currency ${offer.currency.toUpperCase()} does not match ${mandate.currency.toUpperCase()}`,
      actual: offer.currency.toUpperCase(),
      limit: mandate.currency.toUpperCase(),
      delta: null,
    });
  }
  if (offer.price !== null && offer.price > mandate.maximumPrice) {
    violations.push({
      code: "MAXIMUM_PRICE",
      message: `Price exceeds maximum by ${offer.price - mandate.maximumPrice}`,
      actual: offer.price,
      limit: mandate.maximumPrice,
      delta: offer.price - mandate.maximumPrice,
    });
  }
  if (offer.expectedArrival && mandate.mustArriveBy) {
    const arrival = Date.parse(offer.expectedArrival);
    const deadline = Date.parse(mandate.mustArriveBy);
    if (Number.isFinite(arrival) && Number.isFinite(deadline) && arrival > deadline) {
      violations.push({
        code: "MANDATORY_ARRIVAL",
        message: `Arrival misses the mandatory deadline by ${Math.ceil((arrival - deadline) / 60_000)} minutes`,
        actual: offer.expectedArrival,
        limit: mandate.mustArriveBy,
        delta: arrival - deadline,
      });
    }
  }
  const rejected = new Set(offer.rejectedRequirements.map(normalize));
  for (const requirement of mandate.conditions) {
    if (rejected.has(normalize(requirement))) {
      violations.push({
        code: "REQUIRED_CONDITION",
        message: `Carrier rejected required condition: ${requirement}`,
        actual: "REJECTED",
        limit: requirement,
        delta: null,
      });
    }
  }
  return { feasible: violations.length === 0, violations };
}

export function missingComparableFields(
  mandate: MandateSnapshot,
  offer: ProcurementOfferFacts,
): EvaluatedProcurementOffer["missingFields"] {
  const missing: EvaluatedProcurementOffer["missingFields"] = [];
  if (offer.availability === "UNKNOWN") missing.push("availability");
  if (offer.availability === "AVAILABLE") {
    if (offer.price === null || !offer.currency) missing.push("price");
    if (!offer.expectedArrival && (mandate.preferredArrival !== null || mandate.mustArriveBy !== null)) missing.push("arrival");
    if (offer.rateAllIn !== true) missing.push("all_in");
    const confirmed = new Set(offer.confirmedRequirements.map(normalize));
    if (mandate.conditions.some((requirement) => !confirmed.has(normalize(requirement)))) missing.push("requirements");
  }
  return missing;
}

export function evaluateOffers(
  mandate: MandateSnapshot,
  offers: ProcurementOfferFacts[],
): EvaluatedProcurementOffer[] {
  const evaluated = offers.map((offer): EvaluatedProcurementOffer => {
    const missingFields = missingComparableFields(mandate, offer);
    const result = checkOfferFeasibility(mandate, offer);
    const comparable = offer.availability === "AVAILABLE" && missingFields.length === 0;
    return {
      ...offer,
      comparable,
      feasible: result.feasible,
      violations: result.violations,
      missingFields,
      classification: result.feasible ? (comparable ? "COMPARABLE" : "PARTIAL") : "INFEASIBLE",
      dominated: false,
      frontier: false,
      score: 0,
    };
  });

  const candidates = evaluated.filter((offer) => offer.comparable && offer.feasible);
  const arrivals = candidates.map((offer) => Date.parse(offer.expectedArrival!)).filter(Number.isFinite);
  const arrivalBounds = arrivals.length > 0 ? { earliest: Math.min(...arrivals), latest: Math.max(...arrivals) } : null;
  for (const offer of candidates) {
    offer.score = scoreOffer(mandate, offer, arrivalBounds);
    offer.dominated = candidates.some((other) => other.id !== offer.id && dominates(other, offer));
    offer.frontier = !offer.dominated;
    offer.classification = offer.dominated ? "DOMINATED" : "FRONTIER";
  }
  return evaluated;
}

export function evaluateMarket(input: MarketEvaluationInput): MarketEvaluation {
  const terminalMarket = ["COMMITTED", "CLOSED", "FAILED", "CANCELED"].includes(input.status);
  const offers = evaluateOffers(input.mandate, input.carriers.flatMap((carrier) => carrier.offer ? [carrier.offer] : []));
  const byCarrier = new Map(offers.map((offer) => [offer.carrierId, offer]));
  const feasibleComparable = offers.filter((offer) => offer.comparable && offer.feasible);
  const ranked = feasibleComparable
    .filter((offer) => offer.frontier)
    .sort((left, right) => right.score - left.score || (left.price ?? Infinity) - (right.price ?? Infinity) || left.id.localeCompare(right.id));
  const cheapest = [...feasibleComparable].sort((left, right) => (left.price ?? Infinity) - (right.price ?? Infinity) || right.score - left.score)[0] ?? null;
  const timedOut = Boolean(input.deadlineAt && Date.parse(input.now ?? new Date().toISOString()) >= Date.parse(input.deadlineAt));
  const discoveryComplete = timedOut || input.carriers.every((carrier) => isDiscoveryResolved(carrier, byCarrier.get(carrier.carrierId) ?? null));
  const actions: Record<string, MarketInstruction> = {};

  if (terminalMarket) {
    for (const carrier of input.carriers) actions[carrier.carrierId] = instruction("RELEASE", "market_closed", input.revision);
    return result("CLOSED", false, null, null);
  }

  let negotiationPending = false;
  for (const carrier of input.carriers) {
    const offer = byCarrier.get(carrier.carrierId) ?? null;
    if (carrier.humanReason || offer?.humanRequired) {
      actions[carrier.carrierId] = instruction("HUMAN_REQUIRED", carrier.humanReason || "offer_requires_human", input.revision);
      continue;
    }
    if (!offer) {
      actions[carrier.carrierId] = carrier.callTerminal
        ? instruction("RELEASE", "call_ended_without_offer", input.revision)
        : instruction("CONTINUE_DISCOVERY", "awaiting_first_offer", input.revision);
      continue;
    }
    if (offer.availability === "UNAVAILABLE") {
      actions[carrier.carrierId] = instruction("RELEASE", "carrier_unavailable", input.revision);
      continue;
    }
    if (!offer.comparable && offer.feasible) {
      const field = offer.missingFields[0] ?? "availability";
      actions[carrier.carrierId] = carrier.callTerminal
        ? instruction("RELEASE", "partial_offer_call_ended", input.revision)
        : { ...instruction("ASK_MISSING_FIELD", `missing_${field}`, input.revision), field };
      continue;
    }
    if (!offer.feasible) {
      actions[carrier.carrierId] = instruction("RELEASE", "hard_constraint_violation", input.revision);
      continue;
    }
    if (offer.dominated) {
      actions[carrier.carrierId] = instruction("RELEASE", "pareto_dominated", input.revision);
      continue;
    }
    if (!discoveryComplete) {
      actions[carrier.carrierId] = instruction("HOLD", "nondominated_offer_waiting_for_market", input.revision);
      continue;
    }
    if (carrier.callActive && carrier.negotiationRounds < 1 && !timedOut) {
      actions[carrier.carrierId] = negotiationInstruction(input.mandate, offer, ranked, input.revision);
      negotiationPending = true;
      continue;
    }
    actions[carrier.carrierId] = instruction("HOLD", "frontier_negotiation_complete", input.revision);
  }

  const humanActive = input.carriers.some((carrier) => carrier.humanReason || byCarrier.get(carrier.carrierId)?.humanRequired);
  const enoughOffers = feasibleComparable.length >= input.mandate.minimumValidOffers || (discoveryComplete && feasibleComparable.length > 0);
  const awardReady = input.automaticAward && discoveryComplete && enoughOffers && !negotiationPending && !humanActive;
  const awardOfferId = awardReady ? ranked[0]?.id ?? null : null;

  if (awardOfferId) {
    const winner = ranked[0]!;
    actions[winner.carrierId] = instruction("AWARD", "best_current_feasible_offer", input.revision);
    for (const carrier of input.carriers) {
      if (carrier.carrierId !== winner.carrierId && actions[carrier.carrierId]?.action === "HOLD") {
        actions[carrier.carrierId] = instruction("RELEASE", "market_awarded_to_better_offer", input.revision);
      }
    }
  }

  const noFeasibleAtClose = discoveryComplete && feasibleComparable.length === 0;
  const hasPartialOffer = offers.some((offer) => offer.feasible && !offer.comparable);
  const reviewReason = humanActive
    ? "A live carrier interaction requires human authority."
    : noFeasibleAtClose ? noFeasibleReviewReason(offers.length, hasPartialOffer) : null;
  const phase: MarketPhase = awardOfferId ? "READY_TO_AWARD"
    : noFeasibleAtClose || humanActive ? "HUMAN_REVIEW"
      : discoveryComplete ? "FRONTIER_NEGOTIATION" : "DISCOVERY";
  return result(phase, awardReady, awardOfferId, reviewReason);

  function result(phase: MarketPhase, awardReady: boolean, awardOfferId: string | null, reviewReason: string | null): MarketEvaluation {
    return {
      revision: input.revision,
      phase,
      offers,
      actions,
      rankedOfferIds: ranked.map((offer) => offer.id),
      bestOfferId: ranked[0]?.id ?? null,
      cheapestOfferId: cheapest?.id ?? null,
      awardOfferId,
      awardReady,
      reviewReason,
    };
  }
}

function noFeasibleReviewReason(offerCount: number, hasPartialOffer: boolean): string {
  if (offerCount === 0) {
    return "No carrier produced an offer before market close. Automatic award is prohibited.";
  }
  if (hasPartialOffer) {
    return "No complete feasible offer was collected before market close. Automatic award is prohibited.";
  }
  return "Every collected carrier response was unavailable or violated at least one hard constraint. Automatic award is prohibited.";
}

function scoreOffer(
  mandate: MandateSnapshot,
  offer: ProcurementOfferFacts,
  arrivalBounds: { earliest: number; latest: number } | null,
): number {
  const price = offer.price!;
  const priceRange = Math.max(1, mandate.maximumPrice - mandate.targetPrice);
  const priceScore = price <= mandate.targetPrice ? 100 : Math.max(0, 100 * (mandate.maximumPrice - price) / priceRange);
  let speedScore = 50;
  if (offer.expectedArrival && mandate.preferredArrival) {
    const arrival = Date.parse(offer.expectedArrival);
    const preferred = Date.parse(mandate.preferredArrival);
    const latest = mandate.mustArriveBy ? Date.parse(mandate.mustArriveBy) : preferred + 86_400_000;
    speedScore = arrival <= preferred ? 100 : Math.max(0, 100 * (latest - arrival) / Math.max(1, latest - preferred));
  } else if (offer.expectedArrival && arrivalBounds) {
    const arrival = Date.parse(offer.expectedArrival);
    speedScore = arrivalBounds.latest === arrivalBounds.earliest
      ? 100
      : Math.max(0, 100 * (arrivalBounds.latest - arrival) / (arrivalBounds.latest - arrivalBounds.earliest));
  }
  return Math.round((mandate.priceWeight * priceScore + mandate.speedWeight * speedScore) * 10) / 10;
}

function dominates(left: EvaluatedProcurementOffer, right: EvaluatedProcurementOffer): boolean {
  if (left.price === null || right.price === null || !left.expectedArrival || !right.expectedArrival) return false;
  const leftArrival = Date.parse(left.expectedArrival);
  const rightArrival = Date.parse(right.expectedArrival);
  if (!Number.isFinite(leftArrival) || !Number.isFinite(rightArrival)) return false;
  const noWorse = left.price <= right.price && leftArrival <= rightArrival;
  return noWorse && (left.price < right.price || leftArrival < rightArrival);
}

function isDiscoveryResolved(carrier: MarketEvaluationCarrier, offer: EvaluatedProcurementOffer | null): boolean {
  if (carrier.humanReason || carrier.callTerminal) return true;
  if (!offer) return false;
  return offer.availability === "UNAVAILABLE" || offer.comparable || !offer.feasible;
}

function negotiationInstruction(
  mandate: MandateSnapshot,
  offer: EvaluatedProcurementOffer,
  ranked: EvaluatedProcurementOffer[],
  revision: number,
): MarketInstruction {
  const lowestPrice = Math.min(...ranked.map((candidate) => candidate.price ?? Infinity));
  const earliestArrival = Math.min(...ranked.map((candidate) => Date.parse(candidate.expectedArrival!)));
  const priceGap = Math.max(0, (offer.price ?? lowestPrice) - Math.min(mandate.targetPrice, lowestPrice));
  const arrivalGap = Math.max(0, Date.parse(offer.expectedArrival!) - Math.min(Date.parse(mandate.preferredArrival ?? offer.expectedArrival!), earliestArrival));
  if (arrivalGap > 0 && (offer.price === lowestPrice || mandate.speedWeight > mandate.priceWeight)) {
    return {
      ...instruction("NEGOTIATE", "improve_arrival_on_frontier", revision),
      field: "arrival",
      targetArrival: mandate.preferredArrival && Date.parse(mandate.preferredArrival) < Date.parse(offer.expectedArrival!)
        ? mandate.preferredArrival
        : new Date(earliestArrival).toISOString(),
    };
  }
  return {
    ...instruction("NEGOTIATE", "improve_price_on_frontier", revision),
    field: "price",
    targetPrice: Math.max(0, Math.round((offer.price ?? mandate.targetPrice) - Math.max(1, priceGap || (offer.price ?? 0) * 0.05))),
  };
}

function instruction(action: EvaluatorAction, reason: string, marketRevision: number): MarketInstruction {
  return { action, reason, field: null, targetPrice: null, targetArrival: null, marketRevision };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
