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
    expect(applyMigrations(db)).toEqual(["007_procurement_rejected_requirements"]);
    const after = db.prepare("PRAGMA table_info(procurement_offer_versions)").all() as Array<{ name: string }>;
    expect(after.some((column) => column.name === "rejected_requirements")).toBe(true);
  });
});
