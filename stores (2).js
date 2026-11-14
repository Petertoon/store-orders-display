// Store Orders (moved in from store-orders-display): receives Wix Stores orders, splits them per store by SKU
// prefix, shows each store only its own items (store screen, live), queues print jobs for the store's Raspberry Pi
// print agent, and emails the store. Each store is a "Store Orders" account; its settings are in store_settings.
// The webhook and print-agent addresses are the same as before, so switching over only changes the web address.
const crypto = require('crypto');
const { splitOrder, UNASSIGNED } = require('./orders');
const email = require('./email');

const ACTIVE = ['new', 'picking', 'ready'];
const STATUSES = ['new', 'picking', 'ready', 'done', 'cancelled'];
const RESEND_AFTER_MS = 60 * 1000; // a job the agent took but never confirmed is sent again

module.exports = function setupStores(app, deps) {
  const { pool, wrap, fail, text, cleanColor, requireLogin, requireSignIn, requireAdmin, notify } = deps;
  const A = [requireSignIn, requireAdmin];

  // ---------- secrets: from the environment if set (same names as before), otherwise made once and kept ----------
  let secrets = null;
  async function getSecrets() {
    if (secrets) return secrets;
    const get = async (key, env) => {
      if (process.env[env]) return process.env[env];
      await pool.query('INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, crypto.randomBytes(24).toString('hex')]);
      return (await pool.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0].value;
    };
    // MASTER_KEY: agent keys are made from it, as before. WEBHOOK_TOKEN: the secret in the webhook address.
    secrets = { agent: await get('agent_secret', 'MASTER_KEY'), webhook: await get('webhook_token', 'WEBHOOK_TOKEN') };
    return secrets;
  }
  const keyFor = async (scope) => crypto.createHmac('sha256', (await getSecrets()).agent).update(scope).digest('hex').slice(0, 24);
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const publicOrigin = (req) => (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`);

  // ---------- stores (from Store Orders accounts) ----------
  const splitEmails = (s) => String(s || '').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  async function loadStores(db = pool) {
    const { rows } = await db.query(`SELECT s.*, h.name, h.active FROM store_settings s JOIN households h ON h.id = s.household_id
      WHERE h.screen = 'store' ORDER BY lower(h.name)`);
    return rows.map((r) => ({ id: r.code, household_id: r.household_id, name: r.name, active: r.active, skuPrefix: r.sku_prefix,
      color: r.color, printer: r.printer, agentId: r.agent_id || null, email: splitEmails(r.emails) }));
  }
  const settingsFor = async (hid, db = pool) => (await db.query('SELECT * FROM store_settings WHERE household_id=$1', [hid])).rows[0] || null;

  // Saves a store's settings when the admin makes or edits a Store Orders account.
  async function saveSettings(db, hid, name, b) {
    const cur = await settingsFor(hid, db);
    const prefix = ('sku_prefix' in b ? text(b.sku_prefix, 'SKU prefix', { required: false, max: 20 }).toUpperCase() : cur && cur.sku_prefix) || '';
    if (!prefix) fail(400, "Enter the store's SKU prefix (for example A-). Every product SKU for this store must start with it.");
    if (/\s/.test(prefix)) fail(400, 'The SKU prefix cannot have spaces');
    const dup = await db.query(`SELECT h.name FROM store_settings s JOIN households h ON h.id = s.household_id
      WHERE upper(s.sku_prefix) = $1 AND s.household_id <> $2`, [prefix, hid]);
    if (dup.rows[0]) fail(400, `SKU prefix ${prefix} is already used by ${dup.rows[0].name}`);
    let code = cur && cur.code;
    if (!code) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'store';
      code = base;
      for (let n = 2; (await db.query('SELECT 1 FROM store_settings WHERE code=$1', [code])).rows.length; n++) code = `${base}-${n}`;
    }
    const printer = 'printer' in b ? !!b.printer : !!(cur && cur.printer);
    let agent = 'agent_id' in b ? text(b.agent_id, 'Pi name', { required: false, max: 40 }).replace(/\s+/g, '-') : (cur && cur.agent_id) || '';
    if (printer && !agent) agent = 'pi-' + code;
    const emails = 'emails' in b ? splitEmails(b.emails) : splitEmails(cur && cur.emails);
    for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, `"${e}" is not a valid email`);
    if (emails.length > 10) fail(400, '10 emails is the most a store can have');
    const color = cleanColor('color' in b ? b.color : cur && cur.color, '#f59e0b');
    await db.query(`INSERT INTO store_settings (household_id, code, sku_prefix, color, printer, agent_id, emails) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (household_id) DO UPDATE SET sku_prefix=$3, color=$4, printer=$5, agent_id=$6, emails=$7`,
      [hid, code, prefix, color, printer, agent || null, emails.join(', ')]);
  }

  // ---------- tickets & print jobs ----------
  const rowToTicket = (r) => ({
    id: r.id, orderId: r.order_id, orderNumber: r.order_number, storeId: r.store_id, status: r.status, customer: r.customer,
    items: r.items, note: r.note, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  });
  const rowToJob = (r) => ({
    id: r.id, ticketId: r.ticket_id, storeId: r.store_id, agentId: r.agent_id, status: r.status, attempts: r.attempts, error: r.error,
    createdAt: r.created_at && new Date(r.created_at).toISOString(), doneAt: r.done_at && new Date(r.done_at).toISOString(),
  });
  const getTicket = async (id) => { const r = await pool.query('SELECT * FROM tickets WHERE id=$1', [id]); return r.rows[0] ? rowToTicket(r.rows[0]) : null; };
  // Active tickets plus anything finished in the last 12 hours.
  async function listTickets(storeId) {
    const r = await pool.query(`SELECT * FROM tickets WHERE ($1::text IS NULL OR store_id=$1)
      AND (status = ANY($2) OR updated_at > now() - interval '12 hours') ORDER BY created_at`, [storeId || null, ACTIVE]);
    return r.rows.map(rowToTicket);
  }
  async function setStatus(id, status) {
    const r = await pool.query('UPDATE tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, status]);
    return r.rows[0] ? rowToTicket(r.rows[0]) : null;
  }

  // ---------- live updates ----------
  // Store screens use the board's live feed (/api/events) for their account; the admin's Store Orders tab has its own.
  const adminClients = new Set();
  function toAdmin(event, data) { const m = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const r of adminClients) r.write(m); }
  async function toStore(storeId, payload) {
    const s = (await pool.query('SELECT household_id FROM store_settings WHERE code=$1', [storeId])).rows[0];
    if (s) notify(s.household_id, payload);
  }
  async function publish(ticket) { toAdmin('ticket', ticket); await toStore(ticket.storeId, { type: 'ticket', ticket }); }
  app.get('/api/admin/store/stream', ...A, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); res.write('retry: 3000\n\n');
    adminClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); adminClients.delete(res); });
  });

  // ---------- print agent health (in memory; agents report every few seconds) ----------
  const agents = new Map(); // agentId -> { lastSeen, printers: [{storeId, ok, error}] }
  async function agentSummary(stores) {
    const now = Date.now();
    const ids = new Set([...stores.filter((s) => s.printer && s.agentId).map((s) => s.agentId), ...agents.keys()]);
    return Promise.all([...ids].map(async (id) => {
      const a = agents.get(id);
      return { agentId: id, online: !!a && now - a.lastSeen < 30000, lastSeen: a ? new Date(a.lastSeen).toISOString() : null,
        printers: a ? a.printers : [], stores: stores.filter((s) => s.agentId === id).map((s) => s.id), agentKey: await keyFor('agent:' + id) };
    }));
  }

  // ---------- order intake ----------
  async function queuePrint(ticket, stores) {
    const store = (stores || await loadStores()).find((s) => s.id === ticket.storeId);
    if (!store || !store.printer || !store.agentId) return null;
    const r = await pool.query('INSERT INTO print_jobs (ticket_id, store_id, agent_id) VALUES ($1,$2,$3) RETURNING *', [ticket.id, ticket.storeId, store.agentId]);
    const job = rowToJob(r.rows[0]);
    toAdmin('job', job);
    return job;
  }
  // Last email result per store, shown on the admin tab.
  const emailStatus = new Map();
  function emailTicket(ticket, stores) {
    const store = stores.find((s) => s.id === ticket.storeId);
    if (!store || !email.recipients(store).length) return;
    email.sendTicketEmail(store, ticket).then((r) => {
      if (r.skipped) return;
      const st = { ok: r.ok, error: r.error || null, at: new Date().toISOString(), orderNumber: ticket.orderNumber };
      emailStatus.set(store.id, st);
      console.log(`[email] ${store.id} #${ticket.orderNumber} ${r.ok ? 'sent' : 'FAILED: ' + r.error}`);
      toAdmin('email', { storeId: store.id, ...st });
    });
  }
  async function handleNewOrder(rawOrder) {
    const stores = await loadStores();
    const tickets = splitOrder(rawOrder, stores);
    let created = 0;
    for (const t of tickets) {
      const r = await pool.query(`INSERT INTO tickets (id, order_id, order_number, store_id, customer, items, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [t.id, t.orderId, t.orderNumber, t.storeId, JSON.stringify(t.customer), JSON.stringify(t.items), t.note || null]);
      if (!r.rows[0]) continue; // duplicate delivery
      created++;
      const ticket = rowToTicket(r.rows[0]);
      await publish(ticket);
      await queuePrint(ticket, stores);
      emailTicket(ticket, stores); // in the background; never delays the order
    }
    return { tickets: tickets.length, created, unassigned: tickets.some((t) => t.storeId === UNASSIGNED) };
  }
  async function handleCancel(rawOrder) {
    const order = rawOrder.entity || rawOrder.order || rawOrder;
    const id = String(order._id || order.id || '');
    const r = await pool.query('SELECT id FROM tickets WHERE order_id=$1', [id]);
    for (const row of r.rows) await publish(await setStatus(row.id, 'cancelled'));
    return { cancelled: r.rows.length };
  }

  // Wix (Velo backend events.js) posts here: same address as store-orders-display.
  app.post('/webhook/wix-order', wrap(async (req, res) => {
    if (!safeEq(req.query.token, (await getSecrets()).webhook)) return res.status(401).json({ error: 'bad token' });
    try {
      const { type = 'created', order } = req.body || {};
      const result = type === 'canceled' || type === 'cancelled' ? await handleCancel(order || req.body) : await handleNewOrder(order || req.body);
      console.log('[webhook]', type, JSON.stringify(result));
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[webhook] error', e);
      res.status(400).json({ error: e.message });
    }
  }));

  // ---------- the store screen (signed in as the store's account, or the admin viewing it) ----------
  async function myStore(req) {
    if (req.account.screen !== 'store') fail(400, 'This is not a Store Orders account');
    const s = await settingsFor(req.household_id);
    if (!s) fail(400, "This store isn't set up yet. The administrator sets its SKU prefix on the admin page.");
    return s;
  }
  async function myTicket(req) {
    const s = await myStore(req);
    const t = await getTicket(req.params.id);
    if (!t || t.storeId !== s.code) fail(404, 'Order not found');
    return { s, t };
  }
  app.get('/api/store/info', requireLogin, wrap(async (req, res) => {
    const s = await myStore(req);
    res.json({ id: s.code, name: req.account.name, color: s.color, printer: s.printer, skuPrefix: s.sku_prefix });
  }));
  app.get('/api/store/tickets', requireLogin, wrap(async (req, res) => res.json(await listTickets((await myStore(req)).code))));
  app.post('/api/store/tickets/:id/status', requireLogin, wrap(async (req, res) => {
    const { t } = await myTicket(req);
    if (!STATUSES.includes(req.body.status)) fail(400, 'bad status');
    const u = await setStatus(t.id, req.body.status);
    await publish(u);
    res.json(u);
  }));
  app.post('/api/store/tickets/:id/reprint', requireLogin, wrap(async (req, res) => {
    const { t } = await myTicket(req);
    const job = await queuePrint(t);
    if (!job) fail(400, 'Printing is off for this store');
    res.json(job);
  }));

  // ---------- print agent (Raspberry Pi): same addresses and keys as before ----------
  async function agentAuth(req) {
    const agentId = req.get('x-agent-id') || (req.body && req.body.agentId);
    if (!agentId || !safeEq(req.get('x-agent-key'), await keyFor('agent:' + agentId))) fail(401, 'bad agent key');
    return agentId;
  }
  app.post('/api/agent/poll', wrap(async (req, res) => {
    const agentId = await agentAuth(req);
    const prev = agents.get(agentId);
    agents.set(agentId, { lastSeen: Date.now(), printers: Array.isArray(req.body.printers) ? req.body.printers : [] });
    if (!prev || Date.now() - prev.lastSeen > 30000) toAdmin('agents', { agentId });
    const r = await pool.query(`UPDATE print_jobs SET status='sent', sent_at=now(), attempts=attempts+1
      WHERE id IN (SELECT id FROM print_jobs WHERE agent_id=$1 AND
        (status='pending' OR (status='sent' AND sent_at < now() - ($2 || ' milliseconds')::interval)) ORDER BY id LIMIT 20)
      RETURNING *`, [agentId, String(RESEND_AFTER_MS)]);
    const stores = await loadStores();
    const out = [];
    for (const j of r.rows.map(rowToJob)) {
      const t = await getTicket(j.ticketId);
      const s = stores.find((x) => x.id === j.storeId);
      if (t && s) out.push({ jobId: j.id, attempt: j.attempts, store: { id: s.id, name: s.name }, ticket: t });
    }
    res.json({ jobs: out, serverTime: new Date().toISOString() });
  }));
  app.post('/api/agent/jobs/:id/done', wrap(async (req, res) => {
    const agentId = await agentAuth(req);
    const ok = !!req.body.ok;
    const r = await pool.query('UPDATE print_jobs SET status=$3, error=$4, done_at=now() WHERE id=$1 AND agent_id=$2 RETURNING *',
      [Number(req.params.id) || 0, agentId, ok ? 'done' : 'failed', ok ? null : String(req.body.error || 'unknown error')]);
    if (!r.rows[0]) fail(404, 'not found');
    const j = rowToJob(r.rows[0]);
    toAdmin('job', j);
    if (!j.error) await toStore(j.storeId, { type: 'printed', ticketId: j.ticketId, at: j.doneAt }); // "✓ printed" on the store screen
    res.json({ ok: true });
  }));

  // ---------- admin: the Store Orders tab (was the master screen) ----------
  app.get('/api/admin/store/overview', ...A, wrap(async (req, res) => {
    const stores = await loadStores();
    const jobs = await pool.query('SELECT * FROM print_jobs ORDER BY id DESC LIMIT 50');
    const s = await getSecrets();
    res.json({
      stores: stores.map((x) => ({ ...x, emails: email.recipients(x), emailStatus: emailStatus.get(x.id) || null })),
      emailConfigured: email.enabled,
      agents: await agentSummary(stores),
      jobs: jobs.rows.map(rowToJob),
      webhookUrl: `${publicOrigin(req)}/webhook/wix-order?token=${s.webhook}`,
      server: publicOrigin(req),
    });
  }));
  app.get('/api/admin/store/tickets', ...A, wrap(async (req, res) => res.json(await listTickets(null))));
  app.post('/api/admin/store/tickets/:id/status', ...A, wrap(async (req, res) => {
    if (!STATUSES.includes(req.body.status)) fail(400, 'bad status');
    const u = await setStatus(req.params.id, req.body.status);
    if (!u) fail(404, 'Order not found');
    await publish(u);
    res.json(u);
  }));
  app.post('/api/admin/store/tickets/:id/reprint', ...A, wrap(async (req, res) => {
    const t = await getTicket(req.params.id);
    if (!t) fail(404, 'Order not found');
    const job = await queuePrint(t);
    if (!job) fail(400, 'Printing is off for this store');
    res.json(job);
  }));
  // Sends a made-up order through everything (screens, printers, emails).
  app.post('/api/admin/store/test-order', ...A, wrap(async (req, res) => {
    const stores = (await loadStores()).filter((s) => s.active);
    if (!stores.length) fail(400, 'Make a Store Orders account (switched on) first');
    const n = Math.floor(1000 + Math.random() * 9000);
    const lineItems = stores.flatMap((s, i) => [
      { productName: { original: `Test Item ${i + 1}a` }, physicalProperties: { sku: `${s.skuPrefix}10${i}1` }, quantity: 2,
        descriptionLines: [{ name: { original: 'Size' }, plainText: { original: 'Large' } }] },
      { productName: { original: `Test Item ${i + 1}b` }, physicalProperties: { sku: `${s.skuPrefix}10${i}2` }, quantity: 1 },
    ]);
    const order = { _id: 'test-' + crypto.randomUUID(), number: 'T' + n, lineItems,
      billingInfo: { contactDetails: { firstName: 'Test', lastName: 'Customer', phone: '(555) 010-' + n } }, buyerNote: 'This is a test order' };
    res.json(await handleNewOrder({ order }));
  }));

  return { saveSettings, settingsFor };
};
