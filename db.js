// Database connection and schema. Tables are created automatically on startup.
// Keep schema changes additive (ADD COLUMN IF NOT EXISTS): the whole schema runs as one transaction,
// so one bad statement stops the server from starting (Render keeps the last good version running).
const { Pool, types } = require('pg');
// Keep plain dates (like a due date) as "2026-11-26" instead of a time-zone-shifted timestamp.
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in Render > Environment.');
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) && process.env.PGSSLMODE !== 'disable';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

const schema = `
-- A house (household). Everything else belongs to one house.
CREATE TABLE IF NOT EXISTS households (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The login for a house (one shared email + password).
CREATE TABLE IF NOT EXISTS logins (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  login_id INT NOT NULL REFERENCES logins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Family members: pick "who are you" on each screen; to-dos can be for one of them.
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  position INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Board columns. Colors left empty use the standard dark look.
-- buttons: [{label, enabled, action: mark/next, color, place: top/middle/bottom}]
CREATE TABLE IF NOT EXISTS board_columns (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563c9',
  text_color TEXT,
  bg_color TEXT,
  card_color TEXT,
  card_text_color TEXT,
  position INT NOT NULL DEFAULT 0,
  buttons JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  column_id INT REFERENCES board_columns(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  member_id INT REFERENCES members(id) ON DELETE SET NULL,
  due_date DATE,
  priority TEXT NOT NULL DEFAULT 'normal',
  status_label TEXT,
  column_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ,
  created_by INT REFERENCES members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todos_household ON todos (household_id, column_id);

-- Checklist steps on a to-do.
CREATE TABLE IF NOT EXISTS todo_steps (
  id SERIAL PRIMARY KEY,
  todo_id INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todo_steps_todo ON todo_steps (todo_id);

-- Everything that happens to a to-do, with who and when.
CREATE TABLE IF NOT EXISTS todo_history (
  id SERIAL PRIMARY KEY,
  todo_id INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  member_id INT REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todo_history_todo ON todo_history (todo_id);

-- v2: one program, several kinds of screens. An account (household row) uses one screen:
-- 'todo' (Mama's To-Do), 'shop' (Papa's Shop job board) or 'store' (Store Orders), and can be switched off.
ALTER TABLE households ADD COLUMN IF NOT EXISTS screen TEXT NOT NULL DEFAULT 'todo';
ALTER TABLE households ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE households DROP CONSTRAINT IF EXISTS households_screen_check;
ALTER TABLE households ADD CONSTRAINT households_screen_check CHECK (screen IN ('todo', 'shop', 'store'));
-- The admin (platform owner) has a login with no account of its own and can open any account's screen.
ALTER TABLE logins ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE logins ALTER COLUMN household_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS acting_household_id INT REFERENCES households(id) ON DELETE SET NULL;
-- Shop jobs: a job number per account and the customer.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS job_number INT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS job_address TEXT;

-- v2.1: Store Orders (moved in from store-orders-display).
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- A Store Orders account's store: code (used as storeId by the print agent), SKU prefix, color, printer, Pi, emails.
CREATE TABLE IF NOT EXISTS store_settings (
  household_id INT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  sku_prefix TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f59e0b',
  printer BOOLEAN NOT NULL DEFAULT FALSE,
  agent_id TEXT,
  emails TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS store_settings_prefix ON store_settings (upper(sku_prefix));
-- One ticket per store per order (same as store-orders-display).
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_number TEXT,
  store_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  customer JSONB NOT NULL DEFAULT '{}',
  items JSONB NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_store_status ON tickets(store_id, status);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS print_jobs_agent ON print_jobs(agent_id, status);

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_priority_check;
ALTER TABLE todos ADD CONSTRAINT todos_priority_check CHECK (priority IN ('normal', 'high'));
`;

async function init() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(777001)');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
