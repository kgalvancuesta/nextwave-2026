import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrations } from "@/db/schema";

describe("schema migrations", () => {
  it("adds rejected requirements to a database that already applied migration 006", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");

    for (const migration of migrations.filter((candidate) => candidate.id <= "006_procurement_market_workflow")) {
      db.transaction(() => {
        for (const statement of migration.statements) db.prepare(statement).run();
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, "2030-01-01T00:00:00.000Z");
      })();
    }

    const before = db.prepare("PRAGMA table_info(procurement_offer_versions)").all() as Array<{ name: string }>;
    expect(before.some((column) => column.name === "rejected_requirements")).toBe(false);
    expect(applyMigrations(db)).toEqual([
      "007_procurement_rejected_requirements",
      "008_order_exchange_rates",
      "009_self_healing_orders",
      "010_retained_offer_revalidation",
    ]);
    const after = db.prepare("PRAGMA table_info(procurement_offer_versions)").all() as Array<{ name: string }>;
    expect(after.some((column) => column.name === "rejected_requirements")).toBe(true);
    const orderColumns = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
    expect(orderColumns.some((column) => column.name === "exchange_rates")).toBe(true);
    expect(orderColumns.some((column) => column.name === "preferred_pickup")).toBe(true);
    const marketCarrierColumns = db.prepare("PRAGMA table_info(market_carriers)").all() as Array<{ name: string }>;
    expect(marketCarrierColumns.some((column) => column.name === "source_offer_id")).toBe(true);
    const amendmentTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_amendments'").get();
    expect(amendmentTable).toBeTruthy();
  });
});
