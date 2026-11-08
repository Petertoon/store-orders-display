
// Store Orders Display — receives Wix Stores orders, splits them per store (by SKU prefix),
// pushes them live to each store's screen and to the support master, and queues print jobs
// for each store's Raspberry Pi print agent.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { splitOrder, UNASSIGNED } = require('./orders');
const email = require('./email');

const PORT = process.env.PORT || 3000;
const MASTER_KEY = process.env.MASTER_KEY;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
if (!MASTER_KEY || !WEBHOOK_TOKEN) {
  console.error('MASTER_KEY and WEBHOOK_TOKEN environment variables are required.');
  process.exit(1);
}

// ---------- store config ----------
const STORES_FILE = process.env.STORES_FILE || path.join(__dirname, 'stores.json');
function loadStores() {
  const raw = process.env.STORES_JSON || fs.readFileSync(STORES_FILE, 'utf8');
  return JSON.parse(raw).stores;
}
let stores = loadStores();
const storeById = (id) => stores.find((s) => s.id === id);

// ---------- keys (derived from MASTER_KEY, so nothing secret lives in the repo) ----------
const keyFor = (scope) => crypto.createHmac('sha256', MASTER_KEY).update(scope).digest('hex').slice(0, 24);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const getKey = (req) => req.query.key || req.get('x-key') || (req.body && req.body.key);
const isMaster = (req) => safeEq(getKey(req), MASTER_KEY);
const canSeeStore = (req, storeId) => isMaster(req) || safeEq(getKey(req), keyFor('store:' + storeId));

// ---------- live feed (SSE) ----------
const clients = new Set(); // { res, storeId | 'all' }
function broadcast(event, data, storeId) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.storeId === 'all' || (storeId && c.storeId === storeId)) c.res.write(msg);
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

// ---------- print agent health (in memory; agents report every few seconds) ----------
const agents = new Map(); // agentId -> { lastSeen, printers: [{storeId, ok, error}] }
function agentSummary() {
  const now = Date.now();
  const ids = new Set([...stores.filter((s) => s.printer).map((s) => s.agentId), ...agents.keys()]);
  return [...ids].filter(Boolean).map((id) => {
    const a = agents.get(id);
    return {
      agentId: id,
      online: !!a && now - a.lastSeen < 30000,
      lastSeen: a ? new Date(a.lastSeen).toISOString() : null,
      printers: a ? a.printers : [],
      stores: stores.filter((s) => s.agentId === id).map((s) => s.id),
    };
  });
}

// ---------- order intake ----------
async function queuePrint(ticket) {
  const store = storeById(ticket.storeId);
  if (!store || !store.printer || !store.agentId) return null;
  const job = await db.createPrintJob(ticket, store.agentId);
  broadcast('job', job, null);
  return job;
}

// Last email result per store, shown on the master screen.
const emailStatus = new Map(); // storeId -> { ok, error, at, orderNumber }
function emailTicket(ticket) {
  const store = storeById(ticket.storeId);
  if (!store || !email.recipients(store).length) return;
  email.sendTicketEmail(store, ticket).then((r) => {
    if (r.skipped) return;
    const st = { ok: r.ok, error: r.error || null, at: new Date().toISOString(), orderNumber: ticket.orderNumber };
    emailStatus.set(store.id, st);
    console.log(`[email] ${store.id} #${ticket.orderNumber} ${r.ok ? 'sent' : 'FAILED: ' + r.error}`);
    broadcast('email', { storeId: store.id, ...st }, null);
  });
}

async function handleNewOrder(rawOrder) {
  const tickets = splitOrder(rawOrder, stores);
  const created = [];
  for (const t of tickets) {
    if (!(await db.insertTicket(t))) continue; // duplicate delivery
    const ticket = await db.getTicket(t.id);
    created.push(ticket);
    broadcast('ticket', ticket, ticket.storeId);
    await queuePrint(ticket);
    emailTicket(ticket); // runs in the background; never delays the order
  }
  return { tickets: tickets.length, created: created.length,
    unassigned: tickets.some((t) => t.storeId === UNASSIGNED) };
}

async function handleCancel(rawOrder) {
  const order = rawOrder.entity || rawOrder.order || rawOrder;
  const id = String(order._id || order.id || '');
  const list = await db.ticketsForOrder(id);
  for (const t of list) {
    const u = await db.setStatus(t.id, 'cancelled');
    broadcast('ticket', u, u.storeId);
  }
  return { cancelled: list.length };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Wix (Velo backend events.js) posts here.
app.post('/webhook/wix-order', async (req, res) => {
  if (!safeEq(req.query.token, WEBHOOK_TOKEN)) return res.status(401).json({ error: 'bad token' });
  try {
    const { type = 'created', order } = req.body || {};
    const result = type === 'canceled' || type === 'cancelled'
      ? await handleCancel(order || req.body)
      : await handleNewOrder(order || req.body);
    console.log('[webhook]', type, JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[webhook] error', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/stream', (req, res) => {
  const storeId = req.query.store;
  if (storeId === 'all' ? !isMaster(req) : !canSeeStore(req, storeId)) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = { res, storeId };
  clients.add(client);
  req.on('close', () => clients.delete(client));
});

app.get('/api/store-info', (req, res) => {
  const s = storeById(req.query.store);
  if (!s || !canSeeStore(req, s.id)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: s.id, name: s.name, color: s.color, display: s.display, printer: s.printer });
});

app.get('/api/tickets', async (req, res) => {
  const storeId = req.query.store;
  if (storeId === 'all' ? !isMaster(req) : !canSeeStore(req, storeId)) return res.status(401).json({ error: 'unauthorized' });
  res.json(await db.listTickets(storeId === 'all' ? null : storeId));
});

const STATUSES = ['new', 'picking', 'ready', 'done', 'cancelled'];
app.post('/api/tickets/:id/status', async (req, res) => {
  const t = await db.getTicket(req.params.id);
  if (!t || !canSeeStore(req, t.storeId)) return res.status(404).json({ error: 'not found' });
  const status = req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
  const u = await db.setStatus(t.id, status);
  broadcast('ticket', u, u.storeId);
  res.json(u);
});

app.post('/api/tickets/:id/reprint', async (req, res) => {
  const t = await db.getTicket(req.params.id);
  if (!t || !canSeeStore(req, t.storeId)) return res.status(404).json({ error: 'not found' });
  const job = await queuePrint(t);
  if (!job) return res.status(400).json({ error: 'printing is off for this store' });
  res.json(job);
});

// ----- print agent -----
function agentAuth(req, res) {
  const agentId = req.get('x-agent-id') || req.body.agentId;
  if (!agentId || !safeEq(req.get('x-agent-key'), keyFor('agent:' + agentId))) {
    res.status(401).json({ error: 'bad agent key' });
    return null;
  }
  return agentId;
}

// Agent calls this every few seconds: reports printer health, receives jobs.
app.post('/api/agent/poll', async (req, res) => {
  const agentId = agentAuth(req, res);
  if (!agentId) return;
  const prev = agents.get(agentId);
  agents.set(agentId, { lastSeen: Date.now(), printers: Array.isArray(req.body.printers) ? req.body.printers : [] });
  if (!prev || Date.now() - prev.lastSeen > 30000) broadcast('agents', agentSummary(), null);

  const jobs = await db.claimJobs(agentId);
  const out = [];
  for (const j of jobs) {
    const t = await db.getTicket(j.ticketId);
    const s = storeById(j.storeId);
    if (t && s) out.push({ jobId: j.id, attempt: j.attempts, store: { id: s.id, name: s.name }, ticket: t });
  }
  res.json({ jobs: out, serverTime: new Date().toISOString() });
});

app.post('/api/agent/jobs/:id/done', async (req, res) => {
  const agentId = agentAuth(req, res);
  if (!agentId) return;
  const j = await db.finishJob(req.params.id, agentId, !!req.body.ok, req.body.error);
  if (!j) return res.status(404).json({ error: 'not found' });
  broadcast('job', j, null);
  if (!j.error) {
    // let the store screen show a "printed" mark
    broadcast('printed', { ticketId: j.ticketId, at: j.doneAt }, j.storeId);
  }
  res.json({ ok: true });
});

// ----- master (support) -----
app.get('/master', (req, res) => {
  if (!isMaster(req)) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(__dirname, 'private', 'master.html'));
});

app.get('/api/master/overview', async (req, res) => {
  if (!isMaster(req)) return res.status(401).json({ error: 'unauthorized' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    stores: stores.map((s) => ({
      ...s,
      displayUrl: `${base}/store.html?store=${encodeURIComponent(s.id)}&key=${keyFor('store:' + s.id)}`,
      emails: email.recipients(s),
      emailStatus: emailStatus.get(s.id) || null,
    })),
    emailConfigured: email.enabled,
    agents: agentSummary().map((a) => ({ ...a, agentKey: keyFor('agent:' + a.agentId) })),
    jobs: await db.recentJobs(50),
  });
});

// Sends a fake order through the full pipeline (screens + printers). Master key only.
app.post('/api/test-order', async (req, res) => {
  if (!isMaster(req)) return res.status(401).json({ error: 'unauthorized' });
  const n = Math.floor(1000 + Math.random() * 9000);
  const lineItems = stores.flatMap((s, i) => [
    { productName: { original: `Test Item ${i + 1}a` }, physicalProperties: { sku: `${s.skuPrefix}10${i}1` }, quantity: 2,
      descriptionLines: [{ name: { original: 'Size' }, plainText: { original: 'Large' } }] },
    { productName: { original: `Test Item ${i + 1}b` }, physicalProperties: { sku: `${s.skuPrefix}10${i}2` }, quantity: 1 },
  ]);
  const order = { _id: 'test-' + crypto.randomUUID(), number: 'T' + n, lineItems,
    billingInfo: { contactDetails: { firstName: 'Test', lastName: 'Customer', phone: '(555) 010-' + n } },
    buyerNote: 'This is a test order' };
  res.json(await handleNewOrder({ order }));
});

// Reload stores.json / STORES_JSON without a redeploy (master only).
app.post('/api/master/reload-stores', (req, res) => {
  if (!isMaster(req)) return res.status(401).json({ error: 'unauthorized' });
  stores = loadStores();
  broadcast('agents', agentSummary(), null);
  res.json({ ok: true, stores: stores.length });
});

db.init().then(() => {
  app.listen(PORT, () => console.log(`Store Orders Display listening on ${PORT}`));
}).catch((e) => { console.error('DB init failed', e); process.exit(1); });
