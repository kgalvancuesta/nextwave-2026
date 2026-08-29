import Database from "better-sqlite3";
import { applyMigrations } from "@/db/schema";
import { MarketlineRepository } from "@/lib/repository";

export function createTestRepository(): MarketlineRepository {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return new MarketlineRepository(db);
}
