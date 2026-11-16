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
-- QuickBooks is an add-on the admin switches on per Papa's Shop account (off = no QuickBooks button, nothing is sent).
ALTER TABLE households ADD COLUMN IF NOT EXISTS qbo_on BOOLEAN NOT NULL DEFAULT FALSE;
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

-- v2.2: Papa's Shop money: parts list, parts/charges on a job (with the phase they were added in), payments, invoices.
CREATE TABLE IF NOT EXISTS shop_settings (
  household_id INT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,        -- percent, e.g. 8.25
  invoice_header TEXT NOT NULL DEFAULT '',          -- address / phone lines under the shop name
  invoice_footer TEXT NOT NULL DEFAULT ''           -- e.g. "Thank you! Payment due on pickup."
);
CREATE TABLE IF NOT EXISTS parts (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  part_number TEXT,
  barcode TEXT,
  price_cents INT NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parts_household ON parts (household_id, active);
CREATE INDEX IF NOT EXISTS parts_barcode ON parts (household_id, barcode);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS customer_email TEXT;
-- kind: part (from the parts list) or charge (typed: labor, fees). upcharge: added after the first phase.
CREATE TABLE IF NOT EXISTS job_lines (
  id SERIAL PRIMARY KEY,
  todo_id INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'part',
  part_id INT REFERENCES parts(id) ON DELETE SET NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  qty NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_cents INT NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  phase TEXT,
  upcharge BOOLEAN NOT NULL DEFAULT FALSE,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_lines_todo ON job_lines (todo_id);
CREATE TABLE IF NOT EXISTS job_payments (
  id SERIAL PRIMARY KEY,
  todo_id INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  note TEXT,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_payments_todo ON job_payments (todo_id);
-- Phone scanner paired to a shop screen (by QR code, no sign-in on the phone). target = the job open on that screen.
CREATE TABLE IF NOT EXISTS scan_pairs (
  token TEXT PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  target_todo_id INT REFERENCES todos(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used TIMESTAMPTZ
);

-- v2.3: Papa's Shop customer list, invoice links (WhatsApp / text / email), QuickBooks (invoices + payments).
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  qbo_realm TEXT,
  qbo_id TEXT,
  qbo_sync_token TEXT,
  qbo_hash TEXT,
  qbo_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_household ON customers (household_id, active);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS customer_id INT REFERENCES customers(id) ON DELETE SET NULL;
-- Private code for the customer's invoice link (/i/<code>); when the invoice was first sent.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS invoice_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS todos_invoice_code ON todos (invoice_code);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS invoice_sent_at TIMESTAMPTZ;
-- QuickBooks: one connected company per shop account. Tokens are stored encrypted.
CREATE TABLE IF NOT EXISTS qbo_connections (
  household_id INT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  environment TEXT,
  company_name TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  access_expires_at TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}',
  needs_reconnect BOOLEAN NOT NULL DEFAULT FALSE,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ,
  last_sync_error TEXT
);
-- What's in QuickBooks for each job (invoice) and payment. qbo_realm = which QuickBooks company the id belongs to.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_realm TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_invoice_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_sync_token TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_hash TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_synced_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_error TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS qbo_total_cents INT;
ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS qbo_realm TEXT;
ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS qbo_id TEXT;
ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS qbo_error TEXT;
-- Things removed here that still have to be removed in QuickBooks (payments deleted, invoices voided).
CREATE TABLE IF NOT EXISTS qbo_removals (
  id SERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  qbo_id TEXT NOT NULL,
  label TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
