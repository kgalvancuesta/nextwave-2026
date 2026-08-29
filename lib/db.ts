import "server-only";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { getDatabasePath } from "./config";

let database: Database.Database | undefined;

export function getDatabase(): Database.Database {
  if (database) return database;
  const path = getDatabasePath();
  mkdirSync(dirname(path), { recursive: true });
  database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}
