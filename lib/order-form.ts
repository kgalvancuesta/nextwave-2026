export interface NewOrderDraft {
  name: string;
  client: string;
  origin: string;
  destination: string;
  reference: string;
  currency: string;
  targetPrice: string;
  maximumPrice: string;
  preferredArrival: string;
  mustArriveBy: string;
  minimumValidOffers: string;
  desiredCarriers: string;
}

export type NewOrderField = keyof NewOrderDraft | "carrierIds";
export type NewOrderErrors = Partial<Record<NewOrderField, string>>;

export function synchronizeDeadline(preferredArrival: string, mustArriveBy: string, enabled: boolean): string {
  if (!enabled || !preferredArrival) return mustArriveBy;
  if (!mustArriveBy || Date.parse(mustArriveBy) < Date.parse(preferredArrival)) return preferredArrival;
  return mustArriveBy;
}

export function deadlineWhenEnabled(preferredArrival: string, previousDeadline: string, fallback: string): string {
  if (previousDeadline && (!preferredArrival || Date.parse(previousDeadline) >= Date.parse(preferredArrival))) return previousDeadline;
  return preferredArrival || fallback;
}

export function validateNewOrder(draft: NewOrderDraft, deadlineEnabled: boolean, selectedCarrierCount: number): NewOrderErrors {
  const errors: NewOrderErrors = {};
  if (!draft.name.trim()) errors.name = "Order name is required.";
  if (!draft.client.trim()) errors.client = "Client is required.";
  if (!draft.origin.trim()) errors.origin = "Origin is required.";
  if (!draft.destination.trim()) errors.destination = "Destination is required.";

  const target = Number(draft.targetPrice);
  const maximum = Number(draft.maximumPrice);
  if (!draft.targetPrice || !Number.isInteger(target) || target < 0) errors.targetPrice = "Enter a non-negative whole target price.";
  if (!draft.maximumPrice || !Number.isInteger(maximum) || maximum < 0) errors.maximumPrice = "Enter a non-negative whole maximum price.";
  else if (!errors.targetPrice && maximum < target) errors.maximumPrice = "Maximum price must be greater than or equal to target price.";

  if (deadlineEnabled) {
    if (!draft.mustArriveBy) errors.mustArriveBy = "Choose a latest arrival or turn the deadline off.";
    else if (draft.preferredArrival && Date.parse(draft.mustArriveBy) < Date.parse(draft.preferredArrival)) {
      errors.mustArriveBy = "Latest arrival cannot be before preferred arrival.";
    }
  }

  const minimumOffers = Number(draft.minimumValidOffers);
  if (!Number.isInteger(minimumOffers) || minimumOffers < 1 || minimumOffers > 10) errors.minimumValidOffers = "Enter between 1 and 10 offers.";
  const desiredCarriers = Number(draft.desiredCarriers);
  if (!Number.isInteger(desiredCarriers) || desiredCarriers < 1 || desiredCarriers > 3) errors.desiredCarriers = "Enter between 1 and 3 carriers.";
  if (selectedCarrierCount < 1) errors.carrierIds = "Select at least one carrier.";
  return errors;
}
