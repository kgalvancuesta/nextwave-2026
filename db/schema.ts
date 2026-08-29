import type Database from "better-sqlite3";

export const migrations = [
  {
    id: "001_initial",
    statements: [
      `CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        phone_input TEXT NOT NULL,
        e164_phone_number TEXT NOT NULL UNIQUE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS call_batches (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        twilio_call_sid TEXT UNIQUE,
        batch_id TEXT REFERENCES call_batches(id) ON DELETE SET NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        direction TEXT NOT NULL CHECK(direction IN ('INBOUND', 'OUTBOUND')),
        from_number TEXT NOT NULL,
        to_number TEXT NOT NULL,
        status TEXT NOT NULL,
        status_rank INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        answered_at TEXT,
        completed_at TEXT,
        duration_seconds INTEGER,
        error_code TEXT,
        error_message TEXT,
        raw_status_payload TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        twilio_recording_sid TEXT NOT NULL UNIQUE,
        twilio_call_sid TEXT NOT NULL,
        status TEXT NOT NULL,
        recording_url TEXT,
        duration_seconds INTEGER,
        recording_start_time TEXT,
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_calls_batch_id ON calls(batch_id)",
      "CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_calls_active_status ON calls(status) WHERE status IN ('REQUESTED', 'INITIATED', 'RINGING', 'IN_PROGRESS')",
      "CREATE INDEX IF NOT EXISTS idx_recordings_call_sid ON recordings(twilio_call_sid)",
    ],
  },
] as const;

export function applyMigrations(db: Database.Database): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied: string[] = [];

  for (const migration of migrations) {
    const exists = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id);
    if (exists) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.prepare(statement).run();
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
    })();
    applied.push(migration.id);
  }
  db.exec("PRAGMA optimize");
  return applied;
}
