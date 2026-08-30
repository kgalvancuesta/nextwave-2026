import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema";
import { OrderMarketService } from "../lib/market-service";
import { normalizePhoneNumber } from "../lib/phone";
import { MarketlineRepository } from "../lib/repository";

/**
 * Builds the demo scenario so nobody types a form in front of an audience.
 *
 * Pass the real carrier numbers as arguments -- a live demo needs phones that
 * actually ring:
 *
 *   npm run demo:seed -- "Transportes Pacifico=+525500000002" "Drayage Occidente=+52..."
 *
 * The order is left in DRAFT with its market unstarted, so the first thing that
 * happens on stage is the button press, not data entry.
 */

const path = process.env.DATABASE_PATH || "./data/marketline.db";
const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
applyMigrations(db);

const repository = new MarketlineRepository(db);
const markets = new OrderMarketService(db);

const DEFAULT_CARRIERS = [
  "Transportes Pacifico=+525500000005",
  "Drayage Occidente=+525500000006",
  "Autolineas del Bajio=+525500000007",
];

const requested = process.argv.slice(2).filter((argument) => argument.includes("="));
const entries = requested.length > 0 ? requested : DEFAULT_CARRIERS;
const usingPlaceholders = requested.length === 0;

const carriers = entries.map((entry) => {
  const separator = entry.indexOf("=");
  const label = entry.slice(0, separator).trim();
  const phoneInput = entry.slice(separator + 1).trim();
  if (!label || !phoneInput) throw new Error(`Bad carrier argument: ${entry}. Use "Name=+52...".`);
  const existing = repository.listContacts().find((contact) => contact.label === label);
  if (existing) return existing;
  return repository.createContact({
    label,
    phoneInput,
    e164PhoneNumber: normalizePhoneNumber(phoneInput),
    note: "Demo carrier",
  });
});

const now = Date.now();
const hours = (count: number) => new Date(now + count * 3_600_000).toISOString();

const workspace = markets.createOrder({
  name: "Container MSKU4472100 - free time expiring",
  client: "Grupo Comercial del Norte",
  origin: "Manzanillo Terminal TEC II",
  destination: "Guadalajara DC",
  reference: "DEMO-4472",
  currency: "MXN",
  targetPrice: 18_000,
  maximumPrice: 24_000,
  preferredPickup: hours(14),
  mustPickupBy: hours(26),
  preferredArrival: hours(20),
  mustArriveBy: hours(34),
  priceWeight: 0.6,
  speedWeight: 0.4,
  minimumValidOffers: 2,
  desiredCarriers: carriers.length,
  // These two are what turn the pitch's "ground truth" claim into something the
  // evaluator enforces: a carrier that will not confirm them cannot be awarded.
  conditions: [
    "Truck assigned and driver named",
    "Terminal appointment confirmed",
  ],
  carrierIds: carriers.map((carrier) => carrier.id),
  freeTimeEndsAt: hours(28),
  currentEta: hours(40),
  dailyDemurrageRate: 4_500,
});

db.close();

const lines = [
  `Order      ${workspace.order.reference} - ${workspace.order.name}`,
  `Route      ${workspace.order.origin} -> ${workspace.order.destination}`,
  `Mandate    target ${workspace.order.targetPrice} / max ${workspace.order.maximumPrice} ${workspace.order.currency}`,
  `Free time  ends in 28h, demurrage ${workspace.order.dailyDemurrageRate} ${workspace.order.currency}/day`,
  `Carriers   ${carriers.map((carrier) => `${carrier.label} ${carrier.e164PhoneNumber}`).join(", ")}`,
  `Market     ${workspace.currentMarket?.market.status} - press "Volta: verify and recover by phone" to start`,
];
if (usingPlaceholders) {
  lines.push("", "WARNING: placeholder phone numbers. They will not ring.");
  lines.push('Re-run with real ones: npm run demo:seed -- "Carrier Name=+52..."');
}
process.stdout.write(`${lines.join("\n")}\n`);
