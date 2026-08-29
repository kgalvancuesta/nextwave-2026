import type { CarrierCandidate } from "./models";

/**
 * Carrier identity is compared by normalized name across the market, the call
 * record, and the selected quote. Keeping it in one place means the commitment
 * gate and the agent instructions can never disagree on who is on the line.
 */
export function normalizeCarrier(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function sameCarrier(value: string | null, carrier: CarrierCandidate): boolean {
  return normalizeCarrier(value ?? "") === normalizeCarrier(carrier.name);
}
