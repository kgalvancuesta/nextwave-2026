import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrations } from "@/db/schema";

const BASELINE = "006_procurement_market_workflow";

function migrateTo(id: string): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const migration of migrations.filter((candidate) => candidate.id <= id)) {
    db.transaction(() => {
      for (const statement of migration.statements) db.prepare(statement).run();
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, "2030-01-01T00:00:00.000Z");
    })();
  }
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

describe("schema migrations", () => {
  it("applies every pending migration to a database still at the 006 baseline", () => {
    const db = migrateTo(BASELINE);
    const pending = migrations.filter((candidate) => candidate.id > BASELINE).map((candidate) => candidate.id);

    expect(columns(db, "procurement_offer_versions")).not.toContain("rejected_requirements");
    expect(applyMigrations(db)).toEqual(pending);
    expect(columns(db, "procurement_offer_versions")).toContain("rejected_requirements");
  });

  it("adds the exchange-rate, self-healing, and retained-offer columns", () => {
    const db = migrateTo(BASELINE);
    applyMigrations(db);

    expect(columns(db, "orders")).toEqual(expect.arrayContaining([
      "exchange_rates", "exchange_rate_source", "preferred_pickup", "must_pickup_by",
    ]));
    expect(columns(db, "market_carriers")).toEqual(expect.arrayContaining([
      "purpose", "source_offer_id", "amendment_id",
    ]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_amendments'").get()).toBeTruthy();
  });

  it("adds the commitment recap columns", () => {
    const db = migrateTo(BASELINE);
    expect(columns(db, "commitments")).not.toContain("recap_status");

    applyMigrations(db);

    expect(columns(db, "commitments")).toEqual(expect.arrayContaining([
      "recap_status", "recap_channel", "recap_address", "recap_body",
      "recap_delivery_id", "recap_error", "recap_sent_at", "recap_attempts",
    ]));
  });

  it("adds the offer audio evidence columns", () => {
    const db = migrateTo(BASELINE);
    expect(columns(db, "procurement_offer_versions")).not.toContain("evidence_offset_ms");

    applyMigrations(db);

    expect(columns(db, "procurement_offer_versions")).toEqual(expect.arrayContaining([
      "conversation_item_id", "evidence_offset_ms",
    ]));
  });

  it("is idempotent once every migration has been applied", () => {
    const db = migrateTo(BASELINE);
    applyMigrations(db);

    expect(applyMigrations(db)).toEqual([]);
  });
});
