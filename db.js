// Storage: Postgres when DATABASE_URL is set, otherwise in-memory (local testing only —
// in-memory data is lost on every restart/deploy).
const ACTIVE = ['new', 'picking', 'ready'];
const RESEND_AFTER_MS = 60 * 1000; // a job the agent took but never confirmed is retried

let pool = null;
const mem = { tickets: new Map(), jobs: [], nextJobId: 1 };

async function init() {
  if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set — using in-memory storage (testing only)');
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  });
  await pool.query(`
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
  `);
  console.log('[db] Postgres ready');
}

const rowToTicket = (r) => ({
  id: r.id, orderId: r.order_id, orderNumber: r.order_number, storeId: r.store_id,
  status: r.status, customer: r.customer, items: r.items, note: r.note,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});
const rowToJob = (r) => ({
  id: r.id, ticketId: r.ticket_id, storeId: r.store_id, agentId: r.agent_id, status: r.status,
  attempts: r.attempts, error: r.error,
  createdAt: r.created_at && new Date(r.created_at).toISOString(),
  doneAt: r.done_at && new Date(r.done_at).toISOString(),
});

// Returns true if inserted, false if it already existed (duplicate webhook).
async function insertTicket(t) {
  if (!pool) {
    if (mem.tickets.has(t.id)) return false;
    const now = new Date().toISOString();
    mem.tickets.set(t.id, { ...t, status: 'new', createdAt: now, updatedAt: now });
    return true;
  }
  const r = await pool.query(
    `INSERT INTO tickets (id, order_id, order_number, store_id, customer, items, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [t.id, t.orderId, t.orderNumber, t.storeId, JSON.stringify(t.customer), JSON.stringify(t.items), t.note || null]
  );
  return r.rowCount === 1;
}

async function getTicket(id) {
  if (!pool) return mem.tickets.get(id) || null;
  const r = await pool.query('SELECT * FROM tickets WHERE id=$1', [id]);
  return r.rows[0] ? rowToTicket(r.rows[0]) : null;
}

// Active tickets plus anything finished in the last 12 hours.
async function listTickets(storeId) {
  const since = Date.now() - 12 * 3600 * 1000;
  if (!pool) {
    return [...mem.tickets.values()]
      .filter((t) => (!storeId || t.storeId === storeId) &&
        (ACTIVE.includes(t.status) || Date.parse(t.updatedAt) > since))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const r = await pool.query(
    `SELECT * FROM tickets WHERE ($1::text IS NULL OR store_id=$1)
       AND (status = ANY($2) OR updated_at > to_timestamp($3/1000.0))
     ORDER BY created_at`,
    [storeId || null, ACTIVE, since]
  );
  return r.rows.map(rowToTicket);
}

async function setStatus(id, status) {
  if (!pool) {
    const t = mem.tickets.get(id);
    if (!t) return null;
    t.status = status; t.updatedAt = new Date().toISOString();
    return t;
  }
  const r = await pool.query(
    'UPDATE tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, status]);
  return r.rows[0] ? rowToTicket(r.rows[0]) : null;
}

async function ticketsForOrder(orderId) {
  if (!pool) return [...mem.tickets.values()].filter((t) => t.orderId === orderId);
  const r = await pool.query('SELECT * FROM tickets WHERE order_id=$1', [orderId]);
  return r.rows.map(rowToTicket);
}

async function createPrintJob(ticket, agentId) {
  if (!pool) {
    const job = { id: mem.nextJobId++, ticketId: ticket.id, storeId: ticket.storeId, agentId,
      status: 'pending', attempts: 0, error: null, createdAt: new Date().toISOString(), doneAt: null };
    mem.jobs.push(job);
    return job;
  }
  const r = await pool.query(
    'INSERT INTO print_jobs (ticket_id, store_id, agent_id) VALUES ($1,$2,$3) RETURNING *',
    [ticket.id, ticket.storeId, agentId]);
  return rowToJob(r.rows[0]);
}

// Hands the agent its pending jobs (and re-sends ones it took but never confirmed).
async function claimJobs(agentId) {
  if (!pool) {
    const now = Date.now();
    const jobs = mem.jobs.filter((j) => j.agentId === agentId &&
      (j.status === 'pending' || (j.status === 'sent' && now - j.sentAt > RESEND_AFTER_MS)));
    jobs.forEach((j) => { j.status = 'sent'; j.sentAt = now; j.attempts++; });
    return jobs.map((j) => ({ ...j }));
  }
  const r = await pool.query(
    `UPDATE print_jobs SET status='sent', sent_at=now(), attempts=attempts+1
     WHERE id IN (SELECT id FROM print_jobs WHERE agent_id=$1 AND
       (status='pending' OR (status='sent' AND sent_at < now() - ($2 || ' milliseconds')::interval))
       ORDER BY id LIMIT 20)
     RETURNING *`,
    [agentId, String(RESEND_AFTER_MS)]);
  return r.rows.map(rowToJob);
}

async function finishJob(id, agentId, ok, error) {
  const status = ok ? 'done' : 'failed';
  if (!pool) {
    const j = mem.jobs.find((x) => x.id === Number(id) && x.agentId === agentId);
    if (!j) return null;
    j.status = status; j.error = ok ? null : String(error || 'unknown error'); j.doneAt = new Date().toISOString();
    return { ...j };
  }
  const r = await pool.query(
    `UPDATE print_jobs SET status=$3, error=$4, done_at=now() WHERE id=$1 AND agent_id=$2 RETURNING *`,
    [Number(id), agentId, status, ok ? null : String(error || 'unknown error')]);
  return r.rows[0] ? rowToJob(r.rows[0]) : null;
}

async function recentJobs(limit = 50) {
  if (!pool) return mem.jobs.slice(-limit).reverse().map((j) => ({ ...j }));
  const r = await pool.query('SELECT * FROM print_jobs ORDER BY id DESC LIMIT $1', [limit]);
  return r.rows.map(rowToJob);
}

module.exports = { init, insertTicket, getTicket, listTickets, setStatus, ticketsForOrder,
  createPrintJob, claimJobs, finishJob, recentJobs, ACTIVE };
