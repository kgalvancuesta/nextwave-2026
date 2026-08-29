import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema";

const path = process.env.DATABASE_PATH || "./data/marketline.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const applied = applyMigrations(db);
db.close();

process.stdout.write(applied.length > 0 ? `Applied migrations: ${applied.join(", ")}\n` : "Database is up to date.\n");
