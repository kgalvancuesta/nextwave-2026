import Database from "better-sqlite3";
import { applyMigrations } from "@/db/schema";
import { MarketlineRepository } from "@/lib/repository";
import { OrderMarketService } from "@/lib/market-service";
import { VoltaStore } from "@/lib/volta/store";

export function createTestRepository(): MarketlineRepository {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return new MarketlineRepository(db);
}

export function createTestContext() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return { db, repository: new MarketlineRepository(db), markets: new OrderMarketService(db) };
}

export function createTestVoltaStore(): VoltaStore {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return new VoltaStore(db);
}
