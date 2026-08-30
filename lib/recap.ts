import type { MandateSnapshot, OfferRecord, OrderRecord } from "./market-types";
import { publicOrderReference } from "./market-types";

/**
 * Carriers read the recap on a phone, in local time. The award terms are
 * stored as ISO instants; only the rendering is localized, and the zone is
 * always named so a disputed timestamp is never ambiguous.
 */
export const RECAP_TIME_ZONE = process.env.RECAP_TIME_ZONE?.trim() || "America/Mexico_City";

/** Twilio rejects a body above this length; the caller must not exceed it. */
export const RECAP_MAX_LENGTH = 1_600;

export interface AwardRecapInput {
  commitmentId: string;
  order: Pick<OrderRecord, "id" | "reference" | "origin" | "destination"> & Pick<MandateSnapshot, "conditions">;
  carrierLabel: string;
  offer: Pick<OfferRecord, "price" | "currency" | "rateAllIn" | "pickupTime" | "expectedArrival" | "accessorials" | "confirmedRequirements">;
  timeZone?: string;
}

/**
 * The written record of what the carrier agreed to. It is built only from
 * persisted server state — never from model output — so the message the
 * carrier receives is exactly the commitment the dashboard holds.
 */
export function buildAwardRecapBody(input: AwardRecapInput): string {
  const zone = input.timeZone || RECAP_TIME_ZONE;
  const reference = publicOrderReference(input.order);
  const conditions = input.offer.confirmedRequirements.length > 0
    ? input.offer.confirmedRequirements
    : input.order.conditions;

  const lines = [
    `SEMANTIKS - CONFIRMED BOOKING ${reference}`,
    `Carrier: ${input.carrierLabel}`,
    `Route: ${input.order.origin} -> ${input.order.destination}`,
    `Rate: ${formatMoney(input.offer.price, input.offer.currency)}${input.offer.rateAllIn ? " all-in" : ""}`,
    input.offer.pickupTime ? `Pickup: ${formatMoment(input.offer.pickupTime, zone)}` : null,
    input.offer.expectedArrival ? `Arrival: ${formatMoment(input.offer.expectedArrival, zone)}` : null,
    conditions.length > 0 ? `Agreed conditions: ${conditions.join("; ")}` : null,
    input.offer.accessorials.length > 0 ? `Accessorials: ${input.offer.accessorials.join("; ")}` : null,
    `Booking ID: ${input.commitmentId}`,
    "This message is the written record of the terms agreed by phone. Reply DISPUTE within 30 minutes if anything above is wrong.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

/**
 * The spoken read-back the agent must deliver before hanging up on a win. It
 * mirrors the SMS line for line so the carrier hears and reads the same terms.
 */
export function buildAwardReadback(input: AwardRecapInput): string {
  const zone = input.timeZone || RECAP_TIME_ZONE;
  const parts = [
    `${formatMoney(input.offer.price, input.offer.currency)}${input.offer.rateAllIn ? " all-in" : ""}`,
    input.offer.pickupTime ? `pickup ${formatMoment(input.offer.pickupTime, zone)}` : null,
    input.offer.expectedArrival ? `arrival ${formatMoment(input.offer.expectedArrival, zone)}` : null,
  ].filter((part): part is string => part !== null);
  const conditions = input.offer.confirmedRequirements.length > 0
    ? `, including ${input.offer.confirmedRequirements.join(" and ")}`
    : "";
  return `${parts.join(", ")}${conditions}`;
}

function formatMoney(price: number | null, currency: string | null): string {
  if (price === null) return "rate to be confirmed";
  const code = (currency || "MXN").toUpperCase();
  return `${new Intl.NumberFormat("en-US").format(price)} ${code}`;
}

function formatMoment(iso: string, timeZone: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(parsed);
    return `${formatted} (${timeZone})`;
  } catch {
    return new Date(parsed).toISOString();
  }
}
