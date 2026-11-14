// QuickBooks Online for Papa's Shop. Each shop account connects its own QuickBooks company (OAuth, same Intuit app as
// ContractorPOS). Customers become QuickBooks Customers, each job becomes an Invoice (its parts and charges, up-charges
// labeled with their phase, taxable / not taxable), and each payment becomes a Payment applied to that invoice
// (into Undeposited Funds or a chosen bank account, so it matches the bank deposit in QuickBooks Banking).
//
// Nothing waits on QuickBooks: the shop keeps working when QuickBooks isn't connected, the sign-in expired, or Intuit is
// down. What still has to go is worked out from the jobs themselves (and a list of removals), so it all goes through on
// the next sync after reconnecting. Syncs run a few seconds after a change, every 5 minutes, and with "Sync now".
//
// A job goes to QuickBooks once it has parts/charges AND (its invoice was sent or printed, OR it has a payment, OR it
// reached the last column). After that, changes update the invoice.
//
// Server settings (Render > Environment): QBO_CLIENT_ID, QBO_CLIENT_SECRET (developer.intuit.com > your app > Keys),
// QBO_ENVIRONMENT "sandbox" (default) or "production", QBO_REDIRECT_URI (optional; default <this site>/api/qbo/callback).
const crypto = require('crypto');

const ENV = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const URLS = {
  auth: process.env.QBO_AUTH_URL || 'https://appcenter.intuit.com/connect/oauth2',
  token: process.env.QBO_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revoke: process.env.QBO_REVOKE_URL || 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
  api: process.env.QBO_API_BASE || (ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com'),
};
const MINOR = '75';
const ITEM_NAMES = { parts: 'Shop Parts', labor: 'Shop Labor & Charges' };
const configured = () => !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);

module.exports = function setupQbo(app, { pool, wrap, fail, text, requireLogin, notify, hooks, shop }) {
  const L = [requireLogin];
  const shopOnly = (req) => { if (req.account.screen !== 'shop') fail(400, "QuickBooks is for Papa's Shop accounts"); };
  const publicOrigin = (req) => (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`);
  const redirectUri = (req) => process.env.QBO_REDIRECT_URI || `${publicOrigin(req)}/api/qbo/callback`;
  const dollars = (c) => Math.round(c) / 100;
  const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: process.env.TIME_ZONE || 'America/Chicago' });
  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // ---------- tokens are stored encrypted ----------
  const key = () => crypto.createHash('sha256').update('homeboard-qbo:' + (process.env.QBO_TOKEN_KEY || process.env.QBO_CLIENT_SECRET || '')).digest();
  function enc(s) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }
  function dec(s) {
    const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  const sign = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');

  // ---------- talking to Intuit (from ContractorPOS) ----------
  class QboError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
  async function tokenRequest(params) {
    const r = await fetch(URLS.token, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new QboError(`QuickBooks sign-in failed: ${data.error_description || data.error || r.status}`, r.status, data.error);
    return data;
  }
  async function saveTokens(hid, t) {
    await pool.query(`UPDATE qbo_connections SET access_token_enc=$1, refresh_token_enc=$2,
        access_expires_at = now() + ($3 || ' seconds')::interval, refresh_expires_at = now() + ($4 || ' seconds')::interval, needs_reconnect=false
      WHERE household_id=$5`, [enc(t.access_token), enc(t.refresh_token), String(t.expires_in || 3600), String(t.x_refresh_token_expires_in || 8640000), hid]);
  }
  const getConn = async (hid) => (await pool.query('SELECT * FROM qbo_connections WHERE household_id=$1', [hid])).rows[0] || null;
  const refreshing = new Map();
  async function accessToken(conn, force) {
    if (!force && new Date(conn.access_expires_at) - Date.now() > 5 * 60 * 1000) return dec(conn.access_token_enc);
    if (refreshing.has(conn.household_id)) return refreshing.get(conn.household_id);
    const p = (async () => {
      const fresh = await getConn(conn.household_id);
      if (!fresh) throw new QboError('QuickBooks is not connected', 401, 'reconnect');
      if (!force && new Date(fresh.access_expires_at) - Date.now() > 5 * 60 * 1000) return dec(fresh.access_token_enc);
      let t;
      try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(fresh.refresh_token_enc) }); }
      catch (e) {
        if (e.code === 'invalid_grant') throw new QboError('The QuickBooks connection expired. Connect to QuickBooks again; nothing is lost.', 401, 'reconnect');
        throw e;
      }
      await saveTokens(conn.household_id, t);
      Object.assign(conn, await getConn(conn.household_id));
      return t.access_token;
    })().finally(() => refreshing.delete(conn.household_id));
    refreshing.set(conn.household_id, p);
    return p;
  }
  async function qbo(conn, method, path, body, retried) {
    const sep = path.includes('?') ? '&' : '?';
    let r;
    try {
      r = await fetch(`${URLS.api}/v3/company/${conn.realm_id}/${path}${sep}minorversion=${MINOR}`, {
        method,
        headers: { Authorization: 'Bearer ' + await accessToken(conn, retried === 'force'), Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e instanceof QboError) throw e;
      throw new QboError('QuickBooks could not be reached. It will try again.', 503, 'offline');
    }
    if (r.status === 401 && !retried) return qbo(conn, method, path, body, 'force');
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.Fault) {
      const e = (data.Fault && data.Fault.Error && data.Fault.Error[0]) || {};
      throw new QboError(`QuickBooks: ${e.Message || 'request failed (' + r.status + ')'}${e.Detail ? ' (' + e.Detail + ')' : ''}`, r.status, e.code);
    }
    return data;
  }
  const query = async (conn, s) => (await qbo(conn, 'GET', 'query?query=' + encodeURIComponent(s))).QueryResponse || {};
  const notFound = (e) => /610|not found|object not found/i.test(String(e.code) + e.message);
  const stale = (e) => /5010|stale/i.test(String(e.code) + e.message);

  // ---------- what goes to QuickBooks ----------
  // Jobs that belong in QuickBooks: with lines, and sent/printed, paid something, or finished.
  async function eligibleJobs(hid) {
    return (await pool.query(`SELECT t.* FROM todos t WHERE t.household_id=$1 AND t.job_number IS NOT NULL
      AND EXISTS (SELECT 1 FROM job_lines l WHERE l.todo_id=t.id)
      AND (t.invoice_sent_at IS NOT NULL OR t.done_at IS NOT NULL OR EXISTS (SELECT 1 FROM job_payments p WHERE p.todo_id=t.id))
      ORDER BY t.id`, [hid])).rows;
  }
  // Everything on the invoice; when this changes, the invoice is sent again.
  async function jobContent(job) {
    const m = await shop.money(pool, job.id, job.household_id);
    const cust = job.customer_id ? (await pool.query('SELECT name, phone, email, address FROM customers WHERE id=$1', [job.customer_id])).rows[0] : null;
    const content = { doc: String(job.job_number), date: ymd(job.created_at), title: job.title, tax: m.totals.tax_cents,
      customer: cust || { name: job.customer_name, phone: job.customer_phone, email: job.customer_email, address: job.job_address },
      lines: m.lines.map((l) => [l.kind, l.name, Number(l.qty), l.unit_cents, l.taxable, l.upcharge, l.phase]) };
    return { m, hash: crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex') };
  }
  async function pending(hid, realm) {
    const out = { jobs: [], payments: 0, removals: 0 };
    for (const j of await eligibleJobs(hid)) {
      const { hash } = await jobContent(j);
      // Not connected: what isn't in QuickBooks yet, or changed since it was sent.
      if ((realm && j.qbo_realm !== realm) || !j.qbo_invoice_id || j.qbo_hash !== hash) out.jobs.push(j);
    }
    out.payments = (await pool.query(`SELECT count(*)::int AS n FROM job_payments p JOIN todos t ON t.id=p.todo_id
      WHERE t.household_id=$1 AND t.job_number IS NOT NULL AND (p.qbo_id IS NULL OR ($2 <> '' AND p.qbo_realm IS DISTINCT FROM $2))`, [hid, realm || ''])).rows[0].n;
    out.removals = realm ? (await pool.query('SELECT count(*)::int AS n FROM qbo_removals WHERE household_id=$1 AND realm_id=$2', [hid, realm])).rows[0].n : 0;
    return out;
  }

  // ---------- QuickBooks objects ----------
  async function ensureItems(conn) {
    const s = conn.settings || {};
    if (s.items && s.items.realm === conn.realm_id && s.items.account === s.income_account_id && s.items.parts && s.items.labor) return s.items;
    const items = { realm: conn.realm_id, account: s.income_account_id };
    for (const [k, name] of Object.entries(ITEM_NAMES)) {
      const found = (await query(conn, `select * from Item where Name = '${q(name)}'`)).Item || [];
      let it = found[0];
      if (!it) it = (await qbo(conn, 'POST', 'item', { Name: name, Type: 'Service', Taxable: true, IncomeAccountRef: { value: s.income_account_id } })).Item;
      else if (!it.IncomeAccountRef || it.IncomeAccountRef.value !== s.income_account_id) {
        it = (await qbo(conn, 'POST', 'item', { Id: it.Id, SyncToken: it.SyncToken, sparse: true, IncomeAccountRef: { value: s.income_account_id } })).Item;
      }
      items[k] = it.Id;
    }
    s.items = items;
    await pool.query('UPDATE qbo_connections SET settings=$1 WHERE household_id=$2', [JSON.stringify(s), conn.household_id]);
    conn.settings = s;
    return items;
  }
  function customerBody(c) {
    const b = { DisplayName: c.name.trim().slice(0, 100), PrintOnCheckName: c.name.trim().slice(0, 100) };
    if (c.phone) b.PrimaryPhone = { FreeFormNumber: c.phone };
    if (c.email) b.PrimaryEmailAddr = { Address: c.email };
    if (c.address) b.BillAddr = { Line1: c.address.slice(0, 500) };
    return b;
  }
  async function syncCustomer(conn, c) {
    const body = customerBody(c);
    const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
    if (c.qbo_realm === conn.realm_id && c.qbo_id && c.qbo_hash === hash) return c.qbo_id;
    let saved;
    if (c.qbo_realm === conn.realm_id && c.qbo_id) {
      const up = (tok) => qbo(conn, 'POST', 'customer', { ...body, Id: c.qbo_id, SyncToken: tok, sparse: true });
      try { saved = (await up(c.qbo_sync_token)).Customer; }
      catch (e) {
        if (!stale(e)) throw e;
        saved = (await up((await qbo(conn, 'GET', `customer/${c.qbo_id}`)).Customer.SyncToken)).Customer;
      }
    } else {
      try { saved = (await qbo(conn, 'POST', 'customer', body)).Customer; }
      catch (e) {
        if (!/6240|duplicate/i.test(String(e.code) + e.message)) throw e;
        // A customer with this name is already in QuickBooks: use that one.
        const ex = ((await query(conn, `select * from Customer where DisplayName = '${q(body.DisplayName)}'`)).Customer || [])[0];
        if (ex) saved = (await qbo(conn, 'POST', 'customer', { ...body, Id: ex.Id, SyncToken: ex.SyncToken, sparse: true })).Customer;
        else saved = (await qbo(conn, 'POST', 'customer', { ...body, DisplayName: `${body.DisplayName} (${c.id})` })).Customer; // the name is taken by a vendor
      }
    }
    await pool.query('UPDATE customers SET qbo_realm=$1, qbo_id=$2, qbo_sync_token=$3, qbo_hash=$4, qbo_error=NULL WHERE id=$5',
      [conn.realm_id, saved.Id, saved.SyncToken, hash, c.id]);
    return saved.Id;
  }
  async function syncJob(conn, job, items) {
    const fresh = (await pool.query('SELECT * FROM todos WHERE id=$1', [job.id])).rows[0];
    const cust = await shop.ensureCustomer(pool, fresh);
    if (!cust) throw new QboError('Add the customer to the job first (QuickBooks invoices need a customer).', 400, 'nocustomer');
    const custId = await syncCustomer(conn, cust);
    const { m, hash } = await jobContent((await pool.query('SELECT * FROM todos WHERE id=$1', [job.id])).rows[0]);
    if (fresh.qbo_realm === conn.realm_id && fresh.qbo_invoice_id && fresh.qbo_hash === hash) return;
    const body = {
      CustomerRef: { value: custId }, DocNumber: String(fresh.job_number).slice(0, 21), TxnDate: ymd(fresh.created_at),
      PrivateNote: `HomeBoard job #${fresh.job_number}: ${fresh.title || ''}`.slice(0, 4000),
      Line: m.lines.map((l) => ({
        DetailType: 'SalesItemLineDetail', Amount: dollars(l.total_cents),
        Description: (l.name + (l.upcharge ? ` (up-charge${l.phase ? ' · ' + l.phase : ''})` : '')).slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: l.kind === 'part' ? items.parts : items.labor }, Qty: Number(l.qty), UnitPrice: dollars(l.unit_cents),
          TaxCodeRef: { value: l.taxable ? 'TAX' : 'NON' } },
      })),
      ...(m.totals.tax_cents ? { TxnTaxDetail: { TotalTax: dollars(m.totals.tax_cents) } } : {}),
      ...(cust.email ? { BillEmail: { Address: cust.email } } : {}),
    };
    let inv;
    if (fresh.qbo_realm === conn.realm_id && fresh.qbo_invoice_id) {
      const up = (tok) => qbo(conn, 'POST', 'invoice', { ...body, Id: fresh.qbo_invoice_id, SyncToken: tok });
      try { inv = (await up(fresh.qbo_sync_token)).Invoice; }
      catch (e) {
        if (notFound(e)) inv = (await qbo(conn, 'POST', 'invoice', body)).Invoice; // deleted in QuickBooks: make it again
        else if (stale(e)) inv = (await up((await qbo(conn, 'GET', `invoice/${fresh.qbo_invoice_id}`)).Invoice.SyncToken)).Invoice;
        else throw e;
      }
    } else inv = (await qbo(conn, 'POST', 'invoice', body)).Invoice;
    await pool.query(`UPDATE todos SET qbo_realm=$1, qbo_invoice_id=$2, qbo_sync_token=$3, qbo_hash=$4, qbo_synced_at=now(), qbo_error=NULL,
      qbo_total_cents=$5 WHERE id=$6`, [conn.realm_id, inv.Id, inv.SyncToken, hash, Math.round(Number(inv.TotalAmt || 0) * 100), job.id]);
  }
  async function syncPayment(conn, p) {
    const body = {
      CustomerRef: { value: p.cust_qbo_id }, TotalAmt: dollars(p.amount_cents), TxnDate: ymd(p.created_at),
      PrivateNote: `${p.method}${p.note ? ' · ' + p.note : ''} · HomeBoard job #${p.job_number}`.slice(0, 4000),
      ...(p.note && p.method === 'check' ? { PaymentRefNum: String(p.note).replace(/^#/, '').slice(0, 21) } : {}),
      Line: [{ Amount: dollars(p.amount_cents), LinkedTxn: [{ TxnId: p.qbo_invoice_id, TxnType: 'Invoice' }] }],
      ...(conn.settings.deposit_account_id ? { DepositToAccountRef: { value: conn.settings.deposit_account_id } } : {}),
    };
    const saved = (await qbo(conn, 'POST', 'payment', body)).Payment;
    await pool.query('UPDATE job_payments SET qbo_realm=$1, qbo_id=$2, qbo_error=NULL WHERE id=$3', [conn.realm_id, saved.Id, p.id]);
  }
  async function removeOne(conn, r) {
    const ent = r.entity === 'Payment' ? 'payment' : 'invoice';
    try {
      const cur = (await qbo(conn, 'GET', `${ent}/${r.qbo_id}`))[r.entity];
      if (r.entity === 'Payment') await qbo(conn, 'POST', 'payment?operation=delete', { Id: r.qbo_id, SyncToken: cur.SyncToken });
      else await qbo(conn, 'POST', 'invoice?operation=void', { Id: r.qbo_id, SyncToken: cur.SyncToken });
    } catch (e) { if (!notFound(e)) throw e; } // already gone
    await pool.query('DELETE FROM qbo_removals WHERE id=$1', [r.id]);
  }

  // ---------- the sync ----------
  const running = new Map(), again = new Set();
  async function sync(hid) {
    if (!configured()) return;
    if (running.has(hid)) { again.add(hid); return running.get(hid); }
    const p = (async () => {
      const conn = await getConn(hid);
      if (!conn || conn.needs_reconnect) return;
      if (!conn.settings || !conn.settings.income_account_id) {
        await pool.query('UPDATE qbo_connections SET last_sync_error=$1 WHERE household_id=$2', ['Choose the income account in the QuickBooks settings to start sending.', hid]);
        return;
      }
      let firstError = null;
      try {
        const items = await ensureItems(conn);
        for (const r of (await pool.query('SELECT * FROM qbo_removals WHERE household_id=$1 AND realm_id=$2 ORDER BY id', [hid, conn.realm_id])).rows) {
          try { await removeOne(conn, r); }
          catch (e) { if (e.code === 'reconnect' || e.code === 'offline') throw e; firstError = firstError || e.message; await pool.query('UPDATE qbo_removals SET error=$1 WHERE id=$2', [e.message.slice(0, 500), r.id]); }
        }
        const todo = (await pending(hid, conn.realm_id)).jobs.slice(0, 40);
        for (const j of todo) {
          try { await syncJob(conn, j, items); }
          catch (e) { if (e.code === 'reconnect' || e.code === 'offline') throw e; firstError = firstError || `Job #${j.job_number}: ${e.message}`; await pool.query('UPDATE todos SET qbo_error=$1 WHERE id=$2', [e.message.slice(0, 500), j.id]); }
        }
        const pays = (await pool.query(`SELECT p.*, t.job_number, t.qbo_invoice_id, c.qbo_id AS cust_qbo_id FROM job_payments p
            JOIN todos t ON t.id=p.todo_id LEFT JOIN customers c ON c.id=t.customer_id
          WHERE t.household_id=$1 AND t.qbo_realm=$2 AND t.qbo_invoice_id IS NOT NULL AND c.qbo_realm=$2
            AND (p.qbo_id IS NULL OR p.qbo_realm IS DISTINCT FROM $2) ORDER BY p.id LIMIT 60`, [hid, conn.realm_id])).rows;
        for (const pay of pays) {
          try { await syncPayment(conn, pay); }
          catch (e) { if (e.code === 'reconnect' || e.code === 'offline') throw e; firstError = firstError || `Payment on job #${pay.job_number}: ${e.message}`; await pool.query('UPDATE job_payments SET qbo_error=$1 WHERE id=$2', [e.message.slice(0, 500), pay.id]); }
        }
        await pool.query('UPDATE qbo_connections SET last_sync_at=now(), last_sync_error=$1 WHERE household_id=$2', [firstError, hid]);
      } catch (e) {
        await pool.query('UPDATE qbo_connections SET last_sync_error=$1, needs_reconnect=needs_reconnect OR $2 WHERE household_id=$3',
          [e.message.slice(0, 500), e.code === 'reconnect', hid]);
      }
    })().finally(() => {
      running.delete(hid);
      notify(hid, { type: 'qbo' });
      if (again.delete(hid)) kick(hid);
    });
    running.set(hid, p);
    return p;
  }
  // A few seconds after a change (so a burst of typing is one sync).
  const timers = new Map();
  function kick(hid) {
    clearTimeout(timers.get(hid));
    timers.set(hid, setTimeout(() => { timers.delete(hid); getConn(hid).then((c) => c && sync(hid)).catch(() => {}); }, Number(process.env.QBO_KICK_MS || 4000)));
  }
  hooks.changed.push(kick);
  // Deleted here: remove from QuickBooks too (payments deleted, the invoice voided). Kept in a list until it's done.
  hooks.beforeDelete.push(async (db, todoId, hid) => {
    const t = (await db.query('SELECT qbo_realm, qbo_invoice_id, job_number FROM todos WHERE id=$1 AND household_id=$2', [todoId, hid])).rows[0];
    if (!t || !t.qbo_invoice_id) return;
    const pays = (await db.query('SELECT qbo_id, qbo_realm, amount_cents FROM job_payments WHERE todo_id=$1 AND qbo_id IS NOT NULL', [todoId])).rows;
    for (const p of pays) await db.query('INSERT INTO qbo_removals (household_id, realm_id, entity, qbo_id, label) VALUES ($1,$2,$3,$4,$5)',
      [hid, p.qbo_realm, 'Payment', p.qbo_id, `Payment on job #${t.job_number}`]);
    await db.query('INSERT INTO qbo_removals (household_id, realm_id, entity, qbo_id, label) VALUES ($1,$2,$3,$4,$5)',
      [hid, t.qbo_realm, 'Invoice', t.qbo_invoice_id, `Invoice #${t.job_number}`]);
  });
  hooks.paymentRemoved.push(async (db, p, hid) => {
    if (p.qbo_id) await db.query('INSERT INTO qbo_removals (household_id, realm_id, entity, qbo_id, label) VALUES ($1,$2,$3,$4,$5)',
      [hid, p.qbo_realm, 'Payment', p.qbo_id, 'Removed payment']);
  });
  // Every 5 minutes: anything still waiting (QuickBooks was down, or just reconnected).
  setInterval(async () => {
    if (!configured()) return;
    const r = await pool.query("SELECT household_id FROM qbo_connections c JOIN households h ON h.id=c.household_id WHERE NOT c.needs_reconnect AND h.active AND h.screen='shop'").catch(() => ({ rows: [] }));
    for (const x of r.rows) await sync(x.household_id).catch(() => {});
  }, 5 * 60 * 1000).unref();

  // ---------- routes (on the shop's screen) ----------
  async function status(hid) {
    const conn = await getConn(hid);
    const realm = conn && conn.realm_id;
    const w = await pending(hid, realm);
    const errors = (await pool.query(`SELECT id, job_number, title, qbo_error FROM todos WHERE household_id=$1 AND qbo_error IS NOT NULL ORDER BY id DESC LIMIT 20`, [hid])).rows;
    const out = { configured: configured(), environment: ENV, connected: !!conn,
      waiting: { jobs: w.jobs.length, payments: w.payments, removals: w.removals, total: w.jobs.length + w.payments + w.removals },
      errors };
    if (conn) Object.assign(out, { company_name: conn.company_name, connected_env: conn.environment, needs_reconnect: conn.needs_reconnect,
      settings: { income_account_id: conn.settings.income_account_id || '', deposit_account_id: conn.settings.deposit_account_id || '' },
      last_sync_at: conn.last_sync_at, last_sync_error: conn.last_sync_error, syncing: running.has(hid) });
    return out;
  }
  app.get('/api/qbo/status', ...L, wrap(async (req, res) => { shopOnly(req); res.json(await status(req.household_id)); }));
  // For the job ticket: is this job in QuickBooks?
  app.get('/api/qbo/job/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const conn = await getConn(req.household_id);
    const job = await shop.loadJob(pool, req.params.id, req.household_id);
    const eligible = (await eligibleJobs(req.household_id)).some((j) => j.id === job.id);
    if (!eligible) return res.json({ state: job.qbo_invoice_id ? 'synced' : 'not_yet', connected: !!conn });
    const { hash, m } = await jobContent(job);
    const synced = conn && job.qbo_realm === conn.realm_id && job.qbo_invoice_id && job.qbo_hash === hash;
    res.json({ connected: !!conn, state: job.qbo_error ? 'error' : synced ? 'synced' : 'waiting', error: job.qbo_error, synced_at: job.qbo_synced_at,
      qbo_total_cents: synced ? job.qbo_total_cents : null, total_cents: m.totals.total_cents });
  }));
  app.get('/api/qbo/connect', ...L, wrap(async (req, res) => {
    shopOnly(req);
    if (!configured()) fail(400, 'QuickBooks is not set up on this server yet (QBO_CLIENT_ID and QBO_CLIENT_SECRET in Render).');
    const st = Buffer.from(JSON.stringify({ h: req.household_id, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    const url = `${URLS.auth}?` + new URLSearchParams({ client_id: process.env.QBO_CLIENT_ID, response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri(req), state: st + '.' + sign(st) }).toString();
    res.json({ url });
  }));
  // Intuit sends the shop back here after signing in and picking the QuickBooks company.
  app.get('/api/qbo/callback', (req, res, next) => requireLogin(req, res, (err) => (err ? res.redirect('/login') : next())), wrap(async (req, res) => {
    const back = (msg) => res.redirect('/#qbo=' + encodeURIComponent(msg || 'connected'));
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'You canceled the QuickBooks connection.' : 'QuickBooks said: ' + req.query.error);
    const [st, sig] = String(req.query.state || '').split('.');
    if (!st || !sig || sign(st) !== sig) return back('That QuickBooks link was not valid. Try again.');
    const s = JSON.parse(Buffer.from(st, 'base64url').toString());
    if (Date.now() - s.t > 30 * 60 * 1000) return back('That QuickBooks link expired. Try again.');
    if (s.h !== req.household_id) return back('Please connect from the shop you are signed in to.');
    const realm = String(req.query.realmId || '');
    if (!/^\d+$/.test(realm) || !req.query.code) return back('QuickBooks did not send back a company.');
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req) });
      let prev = await getConn(s.h);
      if (!prev) { // disconnected earlier: its last settings
        const last = (await pool.query('SELECT value FROM app_settings WHERE key=$1', ['qbo_last:' + s.h])).rows[0];
        if (last) { const v = JSON.parse(last.value); prev = { realm_id: v.realm, settings: v.settings }; }
      }
      // Same QuickBooks company as before: keep the settings. A different company: start fresh (everything is sent to it).
      const settingsKeep = prev && prev.realm_id === realm ? prev.settings : {};
      await pool.query(`INSERT INTO qbo_connections (household_id, realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, settings)
        VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, now() + ($7 || ' seconds')::interval, $8)
        ON CONFLICT (household_id) DO UPDATE SET realm_id=EXCLUDED.realm_id, environment=EXCLUDED.environment, access_token_enc=EXCLUDED.access_token_enc,
          refresh_token_enc=EXCLUDED.refresh_token_enc, access_expires_at=EXCLUDED.access_expires_at, refresh_expires_at=EXCLUDED.refresh_expires_at,
          settings=EXCLUDED.settings, needs_reconnect=false, connected_at=now(), last_sync_error=NULL`,
        [s.h, realm, ENV, enc(t.access_token), enc(t.refresh_token), String(t.expires_in || 3600), String(t.x_refresh_token_expires_in || 8640000), JSON.stringify(settingsKeep)]);
      const conn = await getConn(s.h);
      try {
        const info = await qbo(conn, 'GET', `companyinfo/${realm}`);
        await pool.query('UPDATE qbo_connections SET company_name=$1 WHERE household_id=$2', [info.CompanyInfo && info.CompanyInfo.CompanyName, s.h]);
      } catch (e) { /* the name is optional */ }
      kick(s.h);
      back('');
    } catch (e) { back(e.message); }
  }));
  app.post('/api/qbo/disconnect', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const conn = await getConn(req.household_id);
    if (conn && configured()) {
      try {
        await fetch(URLS.revoke, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: dec(conn.refresh_token_enc) }) });
      } catch (e) { /* disconnect anyway */ }
    }
    // What was sent is remembered, so reconnecting the same company won't send it twice; its settings are kept too.
    if (conn) await pool.query('INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      ['qbo_last:' + req.household_id, JSON.stringify({ realm: conn.realm_id, settings: conn.settings })]);
    await pool.query('DELETE FROM qbo_connections WHERE household_id=$1', [req.household_id]);
    notify(req.household_id, { type: 'qbo' });
    res.json({ ok: true });
  }));
  // Accounts to choose from: income (for parts & labor) and where payments go.
  app.get('/api/qbo/accounts', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const conn = (await getConn(req.household_id)) || fail(400, 'Connect to QuickBooks first');
    try {
      const r = await query(conn, 'select Id, Name, FullyQualifiedName, AccountType from Account where Active = true maxresults 1000');
      const acc = (r.Account || []).map((a) => ({ id: a.Id, name: a.FullyQualifiedName || a.Name, type: a.AccountType }));
      res.json({ income: acc.filter((a) => a.type === 'Income'), bank: acc.filter((a) => a.type === 'Bank') });
    } catch (e) {
      if (e.code === 'reconnect') await pool.query('UPDATE qbo_connections SET needs_reconnect=true, last_sync_error=$1 WHERE household_id=$2', [e.message, req.household_id]);
      fail(400, e.message);
    }
  }));
  app.put('/api/qbo/settings', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const conn = (await getConn(req.household_id)) || fail(400, 'Connect to QuickBooks first');
    const s = { ...conn.settings };
    s.income_account_id = text(req.body.income_account_id, 'Income account', { max: 30 });
    s.deposit_account_id = text(req.body.deposit_account_id, 'Deposit account', { required: false, max: 30 }) || '';
    await pool.query('UPDATE qbo_connections SET settings=$1, last_sync_error=NULL WHERE household_id=$2', [JSON.stringify(s), req.household_id]);
    kick(req.household_id);
    res.json(await status(req.household_id));
  }));
  app.post('/api/qbo/sync', ...L, wrap(async (req, res) => {
    shopOnly(req);
    if (!configured()) fail(400, 'QuickBooks is not set up on this server yet');
    await sync(req.household_id);
    res.json(await status(req.household_id));
  }));
  // Errors on a job are tried again: clear them so the next sync retries.
  app.post('/api/qbo/retry', ...L, wrap(async (req, res) => {
    shopOnly(req);
    await pool.query('UPDATE todos SET qbo_error=NULL WHERE household_id=$1', [req.household_id]);
    await sync(req.household_id);
    res.json(await status(req.household_id));
  }));

  return { sync, status, configured };
};
