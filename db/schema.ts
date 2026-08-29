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
  {
    id: "002_order_market_state",
    statements: [
      `CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client TEXT NOT NULL,
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        reference TEXT,
        currency TEXT NOT NULL DEFAULT 'MXN',
        target_price INTEGER NOT NULL CHECK(target_price >= 0),
        maximum_price INTEGER NOT NULL CHECK(maximum_price >= target_price),
        preferred_arrival TEXT,
        must_arrive_by TEXT,
        price_weight REAL NOT NULL CHECK(price_weight >= 0 AND price_weight <= 1),
        speed_weight REAL NOT NULL CHECK(speed_weight >= 0 AND speed_weight <= 1),
        minimum_valid_offers INTEGER NOT NULL DEFAULT 2 CHECK(minimum_valid_offers > 0),
        desired_carriers INTEGER NOT NULL DEFAULT 3 CHECK(desired_carriers > 0),
        lifecycle_status TEXT NOT NULL DEFAULT 'SOURCING',
        exception_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE order_conditions (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        condition_text TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE order_carriers (
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        carrier_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        selected_at TEXT NOT NULL,
        PRIMARY KEY(order_id, carrier_id)
      )`,
      `CREATE TABLE markets (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        reason TEXT NOT NULL,
        mandate_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE(order_id, sequence_number)
      )`,
      `CREATE TABLE market_carriers (
        market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        carrier_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'SELECTED',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(market_id, carrier_id)
      )`,
      `CREATE TABLE offers (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        carrier_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        price INTEGER NOT NULL CHECK(price >= 0),
        currency TEXT NOT NULL,
        pickup_time TEXT,
        expected_arrival TEXT,
        waiting_time_included TEXT,
        extra_fees TEXT,
        conditions TEXT,
        is_final_offer INTEGER NOT NULL DEFAULT 0,
        requires_immediate_decision INTEGER NOT NULL DEFAULT 0,
        callback_allowed INTEGER NOT NULL DEFAULT 1,
        supersedes_offer_id TEXT REFERENCES offers(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE commitments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
        carrier_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT
      )`,
      `CREATE TABLE order_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        market_id TEXT REFERENCES markets(id) ON DELETE SET NULL,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      )`,
      "ALTER TABLE calls ADD COLUMN order_id TEXT REFERENCES orders(id) ON DELETE SET NULL",
      "ALTER TABLE calls ADD COLUMN market_id TEXT REFERENCES markets(id) ON DELETE SET NULL",
      "ALTER TABLE calls ADD COLUMN carrier_id TEXT REFERENCES contacts(id) ON DELETE SET NULL",
      "CREATE INDEX idx_orders_status_updated ON orders(lifecycle_status, updated_at DESC)",
      "CREATE INDEX idx_order_conditions_order ON order_conditions(order_id, position)",
      "CREATE INDEX idx_order_carriers_carrier ON order_carriers(carrier_id)",
      "CREATE INDEX idx_markets_order_sequence ON markets(order_id, sequence_number DESC)",
      "CREATE INDEX idx_market_carriers_carrier ON market_carriers(carrier_id)",
      "CREATE INDEX idx_offers_market_carrier_created ON offers(market_id, carrier_id, created_at DESC)",
      "CREATE INDEX idx_commitments_order_status ON commitments(order_id, status)",
      "CREATE UNIQUE INDEX idx_commitments_one_active_market ON commitments(market_id) WHERE status = 'ACTIVE'",
      "CREATE INDEX idx_order_events_order_created ON order_events(order_id, created_at DESC)",
      "CREATE INDEX idx_calls_market_created ON calls(market_id, created_at DESC)",
    ],
  },
  {
    // The Volta voice agent keeps its negotiation state in its own tables and
    // its own columns on `calls`. The order/market tables above are owned by
    // the dashboard; nothing here writes to them.
    id: "003_volta_agent_state",
    statements: [
      `CREATE TABLE IF NOT EXISTS volta_operations (
        id TEXT PRIMARY KEY,
        external_reference TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS volta_markets (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES volta_operations(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN (
          'open', 'collecting_quotes', 'ready_for_selection', 'selected', 'exhausted', 'cancelled'
        )),
        candidates TEXT NOT NULL,
        selected_quote_id TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS volta_quotes (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES volta_markets(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        carrier TEXT NOT NULL,
        terms TEXT NOT NULL,
        mandate_decision TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS volta_commitments (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES volta_operations(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'effective', 'recap_failed')),
        proposal TEXT NOT NULL,
        mandate_decision TEXT NOT NULL,
        recap_delivery_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS volta_call_events (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )`,
      "ALTER TABLE calls ADD COLUMN volta_operation_id TEXT",
      "ALTER TABLE calls ADD COLUMN volta_market_id TEXT",
      "ALTER TABLE calls ADD COLUMN volta_status TEXT",
      "ALTER TABLE calls ADD COLUMN volta_counterparty TEXT",
      "ALTER TABLE calls ADD COLUMN realtime_call_id TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_realtime_call_id ON calls(realtime_call_id) WHERE realtime_call_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_calls_volta_operation_id ON calls(volta_operation_id)",
      "CREATE INDEX IF NOT EXISTS idx_calls_volta_market_id ON calls(volta_market_id)",
      "CREATE INDEX IF NOT EXISTS idx_volta_markets_operation_id ON volta_markets(operation_id)",
      "CREATE INDEX IF NOT EXISTS idx_volta_quotes_market_id ON volta_quotes(market_id)",
      "CREATE INDEX IF NOT EXISTS idx_volta_commitments_call_id ON volta_commitments(call_id)",
      "CREATE INDEX IF NOT EXISTS idx_volta_call_events_call_id ON volta_call_events(call_id, occurred_at)",
    ],
  },
  {
    id: "004_demurrage_risk",
    statements: [
      "ALTER TABLE orders ADD COLUMN free_time_ends_at TEXT",
      "ALTER TABLE orders ADD COLUMN current_eta TEXT",
      "ALTER TABLE orders ADD COLUMN daily_demurrage_rate INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE orders ADD COLUMN risk_status TEXT NOT NULL DEFAULT 'MONITORED' CHECK(risk_status IN ('MONITORED', 'AT_RISK', 'IN_PROGRESS', 'RESOLVED'))",
      "CREATE INDEX idx_orders_risk_status ON orders(risk_status, updated_at DESC)",
    ],
  },
  {
    id: "005_order_volta_link",
    statements: [
      "ALTER TABLE orders ADD COLUMN volta_operation_id TEXT",
      "ALTER TABLE orders ADD COLUMN volta_market_id TEXT",
      "CREATE INDEX idx_orders_volta_operation_id ON orders(volta_operation_id)",
    ],
  },
  {
    id: "006_procurement_market_workflow",
    statements: [
      "ALTER TABLE markets ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE markets ADD COLUMN started_at TEXT",
      "ALTER TABLE markets ADD COLUMN procurement_deadline_at TEXT",
      "ALTER TABLE markets ADD COLUMN automatic_award INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE markets ADD COLUMN review_reason TEXT",
      "ALTER TABLE market_carriers ADD COLUMN availability TEXT NOT NULL DEFAULT 'UNKNOWN'",
      "ALTER TABLE market_carriers ADD COLUMN evaluator_action TEXT NOT NULL DEFAULT 'CONTINUE_DISCOVERY'",
      "ALTER TABLE market_carriers ADD COLUMN action_reason TEXT",
      "ALTER TABLE market_carriers ADD COLUMN action_payload TEXT",
      "ALTER TABLE market_carriers ADD COLUMN action_revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE market_carriers ADD COLUMN negotiation_rounds INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE market_carriers ADD COLUMN human_reason TEXT",
      "ALTER TABLE market_carriers ADD COLUMN released_at TEXT",
      "ALTER TABLE calls ADD COLUMN market_session_state TEXT",
      "ALTER TABLE calls ADD COLUMN human_takeover INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE calls ADD COLUMN human_reason TEXT",
      `CREATE TABLE procurement_offer_versions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        carrier_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        version INTEGER NOT NULL,
        availability TEXT NOT NULL CHECK(availability IN ('UNKNOWN', 'AVAILABLE', 'UNAVAILABLE')),
        price INTEGER CHECK(price IS NULL OR price >= 0),
        currency TEXT,
        rate_all_in INTEGER,
        pickup_time TEXT,
        expected_arrival TEXT,
        firm INTEGER,
        expires_at TEXT,
        accessorials TEXT NOT NULL DEFAULT '[]',
        carrier_conditions TEXT NOT NULL DEFAULT '[]',
        confirmed_requirements TEXT NOT NULL DEFAULT '[]',
        raw_statement TEXT,
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        human_required INTEGER NOT NULL DEFAULT 0,
        human_reason TEXT,
        supersedes_version_id TEXT REFERENCES procurement_offer_versions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(market_id, carrier_id, version)
      )`,
      `INSERT INTO procurement_offer_versions (
        id, market_id, carrier_id, call_id, version, availability, price, currency,
        rate_all_in, pickup_time, expected_arrival, firm, expires_at, accessorials,
        carrier_conditions, confirmed_requirements, raw_statement, confidence,
        human_required, human_reason, supersedes_version_id, created_at
      ) SELECT id, market_id, carrier_id, call_id,
        ROW_NUMBER() OVER (PARTITION BY market_id, carrier_id ORDER BY created_at, id),
        'AVAILABLE', price, currency, 1, pickup_time, expected_arrival, is_final_offer,
        NULL, '[]', CASE WHEN conditions IS NULL THEN '[]' ELSE json_array(conditions) END,
        '[]', NULL, NULL, 0, NULL, supersedes_offer_id, created_at
        FROM offers`,
      "CREATE INDEX idx_procurement_offers_market_carrier_version ON procurement_offer_versions(market_id, carrier_id, version DESC)",
      "CREATE INDEX idx_procurement_offers_call ON procurement_offer_versions(call_id, created_at DESC)",
      "CREATE INDEX idx_market_carriers_action ON market_carriers(market_id, evaluator_action)",
    ],
  },
  {
    id: "007_procurement_rejected_requirements",
    statements: [
      "ALTER TABLE procurement_offer_versions ADD COLUMN rejected_requirements TEXT NOT NULL DEFAULT '[]'",
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
