// Papa's Shop money: a parts list with prices, parts and charges on a job (each stamped with the phase it was added in;
// anything added after the first phase is an up-charge), sales tax per shop, payments, the invoice (print / email),
// and a phone barcode scanner paired to a shop screen by QR code (same camera scanner as ContractorPOS).
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const email = require('./email');

module.exports = function setupShop(app, deps) {
  const { pool, wrap, fail, text, requireLogin, notify, hooks } = deps;
  // Tell the rest of the program (QuickBooks) that something about this account's jobs changed.
  const changed = (hid) => { for (const h of hooks.changed) h(hid); };
  const L = [requireLogin];

  // ---------- helpers ----------
  const shopOnly = (req) => { if (req.account.screen !== 'shop') fail(400, "This is only for Papa's Shop accounts"); };
  const who = (req) => (req.member && req.member.name) || 'Someone';
  const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function cents(v, label) {
    const s = String(v ?? '').replace(/[$,\s]/g, '');
    if (!/^-?\d+(\.\d{1,2})?$|^-?\.\d{1,2}$/.test(s)) fail(400, `${label} must be an amount like 12.50`);
    const c = Math.round(parseFloat(s) * 100);
    if (Math.abs(c) > 100000000) fail(400, `${label} is too large`);
    return c;
  }
  function qtyOf(v) {
    const n = Number(v ?? 1);
    if (!Number.isFinite(n) || n <= 0 || n > 99999) fail(400, 'Quantity must be more than 0');
    return Math.round(n * 100) / 100;
  }
  // Scanners report UPC-A as 12 digits or as 13 digits with a leading 0; match either.
  function barcodeVariants(code) {
    const c = String(code || '').trim();
    const out = new Set([c]);
    if (/^\d{12}$/.test(c)) out.add('0' + c);
    if (/^0\d{12}$/.test(c)) out.add(c.slice(1));
    return [...out];
  }
  const publicOrigin = (req) => (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`);
  const token = () => crypto.randomBytes(18).toString('hex');
  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  // The camera barcode reader for phones without a built-in one (same packages as ContractorPOS).
  const vendorDir = (pkg) => path.join(__dirname, 'node_modules', pkg);
  app.get('/vendor/barcode-detector.js', (req, res) => res.sendFile(path.join(vendorDir('barcode-detector'), 'dist/iife/pure.js'), { maxAge: '7d' }));
  app.get('/vendor/zxing_reader.wasm', (req, res) => res.type('application/wasm').sendFile(path.join(vendorDir('zxing-wasm'), 'dist/reader/zxing_reader.wasm'), { maxAge: '7d' }));

  // ---------- shop settings (tax rate, invoice header and footer) ----------
  async function settings(hid, db = pool) {
    const r = await db.query('SELECT * FROM shop_settings WHERE household_id=$1', [hid]);
    const s = r.rows[0] || { tax_rate: 0, invoice_header: '', invoice_footer: '' };
    return { tax_rate: Number(s.tax_rate), invoice_header: s.invoice_header, invoice_footer: s.invoice_footer };
  }
  app.get('/api/shop/settings', ...L, wrap(async (req, res) => { shopOnly(req); res.json(await settings(req.household_id)); }));
  app.put('/api/shop/settings', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const rate = Number(String(req.body.tax_rate ?? 0).replace('%', '').trim() || 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 30) fail(400, 'Tax rate must be a percent between 0 and 30, like 8.25');
    const header = text(req.body.invoice_header, 'Invoice header', { required: false, max: 500 });
    const footer = text(req.body.invoice_footer, 'Invoice note', { required: false, max: 1000 });
    await pool.query(`INSERT INTO shop_settings (household_id, tax_rate, invoice_header, invoice_footer) VALUES ($1,$2,$3,$4)
      ON CONFLICT (household_id) DO UPDATE SET tax_rate=$2, invoice_header=$3, invoice_footer=$4`, [req.household_id, rate, header, footer]);
    notify(req.household_id, { type: 'money' });
    res.json({ ok: true });
  }));

  // ---------- parts list ----------
  const partRow = (p) => ({ id: p.id, name: p.name, part_number: p.part_number, barcode: p.barcode, price_cents: p.price_cents, taxable: p.taxable });
  function readPart(b) {
    const barcode = text(b.barcode, 'Barcode', { required: false, max: 64 }).replace(/\s+/g, '') || null;
    return { name: text(b.name, 'Part name', { max: 120 }), part_number: text(b.part_number, 'Part number', { required: false, max: 60 }) || null,
      barcode, price_cents: cents(b.price, 'Price'), taxable: b.taxable !== false };
  }
  async function barcodeTaken(db, hid, barcode, exceptId) {
    if (!barcode) return null;
    const r = await db.query('SELECT name FROM parts WHERE household_id=$1 AND active AND barcode = ANY($2) AND id <> $3 LIMIT 1',
      [hid, barcodeVariants(barcode), exceptId || 0]);
    return r.rows[0] ? r.rows[0].name : null;
  }
  async function createPart(db, hid, p) {
    const taken = await barcodeTaken(db, hid, p.barcode);
    if (taken) fail(400, `That barcode is already on "${taken}"`);
    const r = await db.query('INSERT INTO parts (household_id, name, part_number, barcode, price_cents, taxable) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [hid, p.name, p.part_number, p.barcode, p.price_cents, p.taxable]);
    return r.rows[0];
  }
  app.get('/api/shop/parts', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const r = await pool.query('SELECT * FROM parts WHERE household_id=$1 AND active ORDER BY lower(name), id', [req.household_id]);
    res.json(r.rows.map(partRow));
  }));
  app.post('/api/shop/parts', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const n = await pool.query('SELECT count(*)::int AS n FROM parts WHERE household_id=$1 AND active', [req.household_id]);
    if (n.rows[0].n >= 5000) fail(400, '5,000 parts is the most a shop can have');
    const p = await createPart(pool, req.household_id, readPart(req.body));
    notify(req.household_id, { type: 'parts' });
    res.json(partRow(p));
  }));
  app.put('/api/shop/parts/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const p = readPart(req.body);
    const taken = await barcodeTaken(pool, req.household_id, p.barcode, Number(req.params.id));
    if (taken) fail(400, `That barcode is already on "${taken}"`);
    const r = await pool.query(`UPDATE parts SET name=$1, part_number=$2, barcode=$3, price_cents=$4, taxable=$5
      WHERE id=$6 AND household_id=$7 AND active RETURNING *`, [p.name, p.part_number, p.barcode, p.price_cents, p.taxable, Number(req.params.id) || 0, req.household_id]);
    if (!r.rows[0]) fail(404, 'Part not found');
    notify(req.household_id, { type: 'parts' });
    res.json(partRow(r.rows[0]));
  }));
  // Removing a part keeps it on jobs that already used it (with the price it had then).
  app.delete('/api/shop/parts/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const r = await pool.query('UPDATE parts SET active=false, barcode=NULL WHERE id=$1 AND household_id=$2 AND active RETURNING id', [Number(req.params.id) || 0, req.household_id]);
    if (!r.rows[0]) fail(404, 'Part not found');
    notify(req.household_id, { type: 'parts' });
    res.json({ ok: true });
  }));

  // ---------- money on a job ----------
  async function loadJob(db, id, hid, lock = false) {
    const r = await db.query(`SELECT * FROM todos WHERE id=$1 AND household_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [Number(id) || 0, hid]);
    if (!r.rows[0]) fail(404, 'That job was not found (it may have been deleted)');
    const cols = (await db.query('SELECT id, name FROM board_columns WHERE household_id=$1 ORDER BY position, id', [hid])).rows;
    const job = r.rows[0];
    let idx = cols.findIndex((c) => c.id === job.column_id);
    if (idx < 0) idx = 0;
    job.phase = cols[idx] ? cols[idx].name : '';
    job.first_phase = idx === 0;
    return job;
  }
  const lineTotal = (l) => Math.round(Number(l.qty) * l.unit_cents);
  function computeTotals(lines, payments, rate) {
    let original = 0, up = 0, taxable = 0;
    for (const l of lines) { const t = lineTotal(l); if (l.upcharge) up += t; else original += t; if (l.taxable) taxable += t; }
    const subtotal = original + up;
    const tax = Math.round((taxable * rate) / 100 + 1e-9);
    const paid = payments.reduce((n, p) => n + p.amount_cents, 0);
    return { original_cents: original, upcharge_cents: up, subtotal_cents: subtotal, taxable_cents: taxable, tax_rate: rate,
      tax_cents: tax, total_cents: subtotal + tax, paid_cents: paid, balance_cents: subtotal + tax - paid };
  }
  async function money(db, todoId, hid) {
    const lines = (await db.query('SELECT * FROM job_lines WHERE todo_id=$1 ORDER BY id', [todoId])).rows.map((l) => ({ ...l, qty: Number(l.qty), total_cents: lineTotal(l) }));
    const payments = (await db.query('SELECT * FROM job_payments WHERE todo_id=$1 ORDER BY id', [todoId])).rows;
    const s = await settings(hid, db);
    return { lines, payments, totals: computeTotals(lines, payments, s.tax_rate) };
  }
  const log = (db, todoId, actor, action) => db.query(
    'INSERT INTO todo_history (todo_id, member_id, member_name, action) VALUES ($1,$2,$3,$4)', [todoId, actor.id || null, actor.name, action]);
  const touch = (db, todoId) => db.query('UPDATE todos SET updated_at=now() WHERE id=$1', [todoId]);
  const qtyText = (q) => (Number(q) === 1 ? '' : ` × ${Number(q)}`);

  // Adds a part (by id or scanned/typed code) or a typed charge to a job. Returns { found: false } for an unknown code.
  async function addLine(db, hid, job, b, actor) {
    const qty = qtyOf(b.qty);
    const upcharge = 'upcharge' in b ? !!b.upcharge : !job.first_phase;
    let part = null;
    if (b.code) {
      const r = await db.query(`SELECT * FROM parts WHERE household_id=$1 AND active AND (barcode = ANY($2) OR lower(part_number) = lower($3))
        ORDER BY (barcode = ANY($2)) DESC LIMIT 1`, [hid, barcodeVariants(b.code), String(b.code).trim()]);
      if (!r.rows[0]) return { found: false, code: String(b.code).trim() };
      part = r.rows[0];
    } else if (b.part_id) {
      const r = await db.query('SELECT * FROM parts WHERE id=$1 AND household_id=$2 AND active', [Number(b.part_id) || 0, hid]);
      part = r.rows[0] || fail(404, 'Part not found');
    }
    let line;
    if (part) {
      // Same part again in the same phase: add to the quantity.
      const ex = await db.query(`SELECT * FROM job_lines WHERE todo_id=$1 AND part_id=$2 AND unit_cents=$3 AND upcharge=$4 AND phase IS NOT DISTINCT FROM $5 LIMIT 1`,
        [job.id, part.id, part.price_cents, upcharge, job.phase]);
      if (ex.rows[0]) line = (await db.query('UPDATE job_lines SET qty = qty + $1 WHERE id=$2 RETURNING *', [qty, ex.rows[0].id])).rows[0];
      else line = (await db.query(`INSERT INTO job_lines (todo_id, kind, part_id, barcode, name, qty, unit_cents, taxable, phase, upcharge, added_by)
        VALUES ($1,'part',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [job.id, part.id, part.barcode, part.name, qty, part.price_cents, part.taxable, job.phase, upcharge, actor.name])).rows[0];
      await log(db, job.id, actor, `${upcharge ? 'Up-charge' : 'Added'}: ${part.name}${qtyText(qty)} ${usd(Math.round(qty * part.price_cents))} (${job.phase})`);
    } else {
      const name = text(b.name, 'Description', { max: 160 });
      const unit = cents(b.price, 'Price');
      line = (await db.query(`INSERT INTO job_lines (todo_id, kind, name, qty, unit_cents, taxable, phase, upcharge, added_by)
        VALUES ($1,'charge',$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [job.id, name, qty, unit, b.taxable !== false, job.phase, upcharge, actor.name])).rows[0];
      await log(db, job.id, actor, `${upcharge ? 'Up-charge' : 'Added charge'}: ${name}${qtyText(qty)} ${usd(Math.round(qty * unit))} (${job.phase})`);
    }
    await touch(db, job.id);
    return { found: true, line: { ...line, qty: Number(line.qty), total_cents: lineTotal(line) } };
  }
  const actorOf = (req) => ({ id: req.member && req.member.id, name: who(req) });

  app.get('/api/shop/jobs/:id/money', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const job = await loadJob(pool, req.params.id, req.household_id);
    res.json({ ...(await money(pool, job.id, req.household_id)), phase: job.phase, first_phase: job.first_phase });
  }));
  app.post('/api/shop/jobs/:id/lines', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const out = await withTx(async (db) => {
      const job = await loadJob(db, req.params.id, req.household_id, true);
      return addLine(db, req.household_id, job, req.body, actorOf(req));
    });
    if (out.found) { notify(req.household_id, { type: 'todo', id: Number(req.params.id) }); changed(req.household_id); }
    res.json(out);
  }));
  // Change quantity, price, description, taxable, or whether a line counts as an up-charge.
  app.patch('/api/shop/jobs/:id/lines/:lid', ...L, wrap(async (req, res) => {
    shopOnly(req);
    await withTx(async (db) => {
      const job = await loadJob(db, req.params.id, req.household_id, true);
      const l = (await db.query('SELECT * FROM job_lines WHERE id=$1 AND todo_id=$2', [Number(req.params.lid) || 0, job.id])).rows[0];
      if (!l) fail(404, 'Line not found');
      const qty = 'qty' in req.body ? qtyOf(req.body.qty) : Number(l.qty);
      const unit = 'price' in req.body ? cents(req.body.price, 'Price') : l.unit_cents;
      const name = 'name' in req.body ? text(req.body.name, 'Description', { max: 160 }) : l.name;
      const taxable = 'taxable' in req.body ? !!req.body.taxable : l.taxable;
      const up = 'upcharge' in req.body ? !!req.body.upcharge : l.upcharge;
      await db.query('UPDATE job_lines SET qty=$1, unit_cents=$2, name=$3, taxable=$4, upcharge=$5 WHERE id=$6', [qty, unit, name, taxable, up, l.id]);
      const changes = [];
      if (qty !== Number(l.qty)) changes.push(`qty ${Number(l.qty)} → ${qty}`);
      if (unit !== l.unit_cents) changes.push(`price ${usd(l.unit_cents)} → ${usd(unit)}`);
      if (up !== l.upcharge) changes.push(up ? 'now an up-charge' : 'now part of the original');
      if (name !== l.name) changes.push('renamed');
      if (taxable !== l.taxable) changes.push(taxable ? 'taxable' : 'not taxable');
      if (changes.length) await log(db, job.id, actorOf(req), `Changed ${name}: ${changes.join(', ')}`);
      await touch(db, job.id);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    changed(req.household_id);
    res.json({ ok: true });
  }));
  app.delete('/api/shop/jobs/:id/lines/:lid', ...L, wrap(async (req, res) => {
    shopOnly(req);
    await withTx(async (db) => {
      const job = await loadJob(db, req.params.id, req.household_id, true);
      const l = (await db.query('DELETE FROM job_lines WHERE id=$1 AND todo_id=$2 RETURNING *', [Number(req.params.lid) || 0, job.id])).rows[0];
      if (!l) fail(404, 'Line not found');
      await log(db, job.id, actorOf(req), `Removed: ${l.name}${qtyText(l.qty)} ${usd(lineTotal(l))}`);
      await touch(db, job.id);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    changed(req.household_id);
    res.json({ ok: true });
  }));

  // ---------- payments ----------
  const METHODS = { cash: 'Cash', check: 'Check', card: 'Card', other: 'Other' };
  app.post('/api/shop/jobs/:id/payments', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const out = await withTx(async (db) => {
      const job = await loadJob(db, req.params.id, req.household_id, true);
      const amount = cents(req.body.amount, 'Amount');
      if (amount <= 0) fail(400, 'Enter an amount more than 0');
      const method = METHODS[req.body.method] ? req.body.method : 'cash';
      const note = text(req.body.note, 'Note', { required: false, max: 120 }) || null;
      const p = (await db.query('INSERT INTO job_payments (todo_id, amount_cents, method, note, added_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [job.id, amount, method, note, who(req)])).rows[0];
      await log(db, job.id, actorOf(req), `Payment ${usd(amount)} ${METHODS[method]}${note ? ' · ' + note : ''}`);
      await touch(db, job.id);
      return p;
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    changed(req.household_id);
    res.json(out);
  }));
  app.delete('/api/shop/jobs/:id/payments/:pid', ...L, wrap(async (req, res) => {
    shopOnly(req);
    await withTx(async (db) => {
      const job = await loadJob(db, req.params.id, req.household_id, true);
      const p = (await db.query('DELETE FROM job_payments WHERE id=$1 AND todo_id=$2 RETURNING *', [Number(req.params.pid) || 0, job.id])).rows[0];
      if (!p) fail(404, 'Payment not found');
      for (const h of hooks.paymentRemoved) await h(db, p, req.household_id); // QuickBooks removes it too
      await log(db, job.id, actorOf(req), `Payment removed: ${usd(p.amount_cents)} ${METHODS[p.method] || p.method}`);
      await touch(db, job.id);
    });
    notify(req.household_id, { type: 'todo', id: Number(req.params.id) });
    changed(req.household_id);
    res.json({ ok: true });
  }));

  // Totals for every job on the board (for the cards).
  app.get('/api/shop/summary', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const s = await settings(req.household_id);
    const lines = await pool.query(`SELECT l.todo_id, l.qty, l.unit_cents, l.taxable, l.upcharge FROM job_lines l JOIN todos t ON t.id = l.todo_id WHERE t.household_id=$1`, [req.household_id]);
    const pays = await pool.query(`SELECT p.todo_id, p.amount_cents FROM job_payments p JOIN todos t ON t.id = p.todo_id WHERE t.household_id=$1`, [req.household_id]);
    const by = {};
    for (const l of lines.rows) (by[l.todo_id] = by[l.todo_id] || { l: [], p: [] }).l.push(l);
    for (const p of pays.rows) (by[p.todo_id] = by[p.todo_id] || { l: [], p: [] }).p.push(p);
    const out = {};
    for (const [id, v] of Object.entries(by)) { const t = computeTotals(v.l, v.p, s.tax_rate); out[id] = { total_cents: t.total_cents, paid_cents: t.paid_cents, balance_cents: t.balance_cents, lines: v.l.length }; }
    res.json(out);
  }));

  // ---------- invoice ----------
  async function invoiceData(hid, id) {
    const job = await loadJob(pool, id, hid);
    const acct = (await pool.query('SELECT name FROM households WHERE id=$1', [hid])).rows[0];
    const s = await settings(hid);
    return { job, acct, s, ...(await money(pool, job.id, hid)) };
  }
  function invoiceHtml({ job, acct, s, lines, payments, totals }, { forEmail = false } = {}) {
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: process.env.TIME_ZONE || 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric' });
    const row = (l) => `<tr><td style="padding:7px 8px;border-bottom:1px solid #e5e7eb">${esc(l.name)}${l.kind === 'part' && l.barcode ? `<div style="color:#6b7280;font-size:12px">#${esc(l.barcode)}</div>` : ''}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.qty)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${usd(l.unit_cents)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700">${usd(l.total_cents)}${l.taxable ? '' : '<div style="color:#6b7280;font-size:11px;font-weight:400">no tax</div>'}</td></tr>`;
    const head = (t) => `<tr><td colspan="4" style="padding:12px 8px 4px;font-weight:800;color:#111827;font-size:13px;text-transform:uppercase;letter-spacing:.05em">${esc(t)}</td></tr>`;
    const orig = lines.filter((l) => !l.upcharge), ups = lines.filter((l) => l.upcharge);
    const phases = [...new Set(ups.map((l) => l.phase || ''))];
    const body = (orig.length ? (ups.length ? head('Original') : '') + orig.map(row).join('') : '')
      + phases.map((p) => head(`Up-charges${p ? ' · ' + p : ''}`) + ups.filter((l) => (l.phase || '') === p).map(row).join('')).join('');
    const tot = (label, c, strong) => `<tr><td style="padding:4px 8px;text-align:right;${strong ? 'font-size:18px;font-weight:800' : 'color:#374151'}">${label}</td><td style="padding:4px 8px;text-align:right;width:130px;${strong ? 'font-size:18px;font-weight:800' : ''}">${usd(c)}</td></tr>`;
    const paidOff = totals.total_cents > 0 && totals.balance_cents <= 0;
    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:760px;margin:0 auto;background:#fff;padding:28px">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top"><div style="font-size:24px;font-weight:800">${esc(acct.name)}</div>
      <div style="color:#4b5563;white-space:pre-line;margin-top:4px">${esc(s.invoice_header)}</div></td>
    <td style="vertical-align:top;text-align:right"><div style="font-size:28px;font-weight:800;letter-spacing:.04em">INVOICE</div>
      <div style="margin-top:4px">Invoice # <b>${esc(job.job_number || job.id)}</b></div><div style="color:#4b5563">${fmtDate(new Date())}</div>
      ${paidOff ? '<div style="display:inline-block;margin-top:6px;padding:3px 10px;border:2px solid #16a34a;color:#16a34a;font-weight:800;border-radius:6px">PAID</div>' : ''}</td></tr></table>
  <table style="width:100%;border-collapse:collapse;margin-top:22px"><tr>
    <td style="vertical-align:top;width:50%"><div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Bill to</div>
      <div style="font-weight:700;margin-top:2px">${esc(job.customer_name || '')}</div>
      ${job.customer_phone ? `<div>${esc(job.customer_phone)}</div>` : ''}${job.customer_email ? `<div>${esc(job.customer_email)}</div>` : ''}
      ${job.job_address ? `<div style="white-space:pre-line">${esc(job.job_address)}</div>` : ''}</td>
    <td style="vertical-align:top"><div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.06em">Job</div>
      <div style="font-weight:700;margin-top:2px">${esc(job.title || '')}</div><div style="color:#4b5563">Started ${fmtDate(job.created_at)}</div></td></tr></table>
  <table style="width:100%;border-collapse:collapse;margin-top:22px;font-size:14px">
    <tr style="background:#f3f4f6"><th style="text-align:left;padding:8px">Description</th><th style="text-align:right;padding:8px;width:60px">Qty</th>
      <th style="text-align:right;padding:8px;width:100px">Price</th><th style="text-align:right;padding:8px;width:110px">Amount</th></tr>
    ${body || '<tr><td colspan="4" style="padding:14px 8px;color:#6b7280">No parts or charges yet.</td></tr>'}
  </table>
  <table style="margin:16px 0 0 auto;border-collapse:collapse;font-size:15px">
    ${ups.length ? tot('Original', totals.original_cents) + tot('Up-charges', totals.upcharge_cents) : ''}
    ${tot('Subtotal', totals.subtotal_cents)}
    ${totals.tax_rate ? tot(`Tax (${totals.tax_rate}%)`, totals.tax_cents) : ''}
    ${tot('Total', totals.total_cents, true)}
    ${payments.map((p) => tot(`Paid ${fmtDate(p.created_at)} · ${METHODS[p.method] || p.method}`, -p.amount_cents)).join('')}
    ${payments.length ? tot('Balance due', totals.balance_cents, true) : ''}
  </table>
  ${s.invoice_footer ? `<div style="margin-top:26px;padding-top:14px;border-top:1px solid #e5e7eb;color:#374151;white-space:pre-line">${esc(s.invoice_footer)}</div>` : ''}
  ${forEmail ? '' : ''}
</div>`;
  }
  // The invoice page: print it or save it as a PDF from the browser.
  app.get('/invoice/:id', (req, res, next) => requireLogin(req, res, (err) => (err ? res.redirect('/login') : next())), wrap(async (req, res) => {
    shopOnly(req);
    const d = await invoiceData(req.household_id, req.params.id);
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(d.job.job_number || d.job.id)} · ${esc(d.acct.name)}</title>
<style>body{margin:0;background:#e5e7eb}.bar{display:flex;gap:8px;justify-content:center;padding:12px;font-family:Arial,sans-serif}
.bar button{font-size:16px;padding:10px 18px;border:0;border-radius:8px;cursor:pointer;background:#2563eb;color:#fff;font-weight:700}.bar button.g{background:#4b5563}
@media print{.bar{display:none}body{background:#fff}}</style></head><body>
<div class="bar"><span data-brand></span><button onclick="print()">🖨 Print / Save as PDF</button><button class="g" onclick="history.length > 1 ? history.back() : close()">Close</button></div>
${invoiceHtml(d)}<script src="/brand.js"></script></body></html>`);
  }));
  app.post('/api/shop/jobs/:id/email-invoice', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const to = text(req.body.to, 'Email', { max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) fail(400, 'Enter a valid email');
    const d = await invoiceData(req.household_id, req.params.id);
    if (!d.lines.length) fail(400, 'Add parts or charges before sending the invoice');
    const link = await invoiceLink(req, d.job);
    const r = await email.sendMail({ to, subject: `Invoice #${d.job.job_number || d.job.id} from ${d.acct.name} · ${usd(d.totals.balance_cents)} due`,
      html: `<div style="background:#f3f4f6;padding:16px"><p style="text-align:center;font-family:Arial,sans-serif;margin:0 0 12px"><a href="${esc(link)}">View this invoice online</a></p>${invoiceHtml(d, { forEmail: true })}</div>`,
      text: `Invoice #${d.job.job_number || d.job.id} from ${d.acct.name}\nTotal ${usd(d.totals.total_cents)} · Balance due ${usd(d.totals.balance_cents)}\n${link}` });
    if (!r.ok) fail(400, 'The email was not sent: ' + r.error);
    await pool.query('UPDATE todos SET customer_email=$1, invoice_sent_at=COALESCE(invoice_sent_at, now()) WHERE id=$2', [to, d.job.id]);
    changed(req.household_id);
    await log(pool, d.job.id, actorOf(req), `Invoice emailed to ${to} (${usd(d.totals.balance_cents)} due)`);
    notify(req.household_id, { type: 'todo', id: d.job.id });
    res.json({ ok: true });
  }));

  // ---------- customer list ----------
  const digits = (s) => String(s || '').replace(/\D/g, '');
  function readCustomer(b) {
    const email = text(b.email, 'Email', { required: false, max: 200 }).toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email');
    return { name: text(b.name, 'Customer name', { max: 120 }), phone: text(b.phone, 'Phone', { required: false, max: 40 }) || null, email,
      address: text(b.address, 'Address', { required: false, max: 300 }) || null, notes: text(b.notes, 'Notes', { required: false, max: 2000 }) || null };
  }
  // Each customer's jobs, total and what they still owe.
  async function customerTotals(hid) {
    const s = await settings(hid);
    const jobs = (await pool.query('SELECT id, customer_id FROM todos WHERE household_id=$1 AND customer_id IS NOT NULL', [hid])).rows;
    const lines = (await pool.query('SELECT l.todo_id, l.qty, l.unit_cents, l.taxable, l.upcharge FROM job_lines l JOIN todos t ON t.id=l.todo_id WHERE t.household_id=$1 AND t.customer_id IS NOT NULL', [hid])).rows;
    const pays = (await pool.query('SELECT p.todo_id, p.amount_cents FROM job_payments p JOIN todos t ON t.id=p.todo_id WHERE t.household_id=$1 AND t.customer_id IS NOT NULL', [hid])).rows;
    const out = {};
    for (const j of jobs) {
      const t = computeTotals(lines.filter((l) => l.todo_id === j.id), pays.filter((p) => p.todo_id === j.id), s.tax_rate);
      const o = out[j.customer_id] = out[j.customer_id] || { jobs: 0, total_cents: 0, balance_cents: 0 };
      o.jobs++; o.total_cents += t.total_cents; o.balance_cents += Math.max(0, t.balance_cents);
    }
    return out;
  }
  app.get('/api/shop/customers', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const r = await pool.query('SELECT id, name, phone, email, address, notes, qbo_id IS NOT NULL AS in_qbo FROM customers WHERE household_id=$1 AND active ORDER BY lower(name), id', [req.household_id]);
    const tot = await customerTotals(req.household_id);
    res.json(r.rows.map((c) => ({ ...c, ...(tot[c.id] || { jobs: 0, total_cents: 0, balance_cents: 0 }) })));
  }));
  app.get('/api/shop/customers/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const c = (await pool.query('SELECT * FROM customers WHERE id=$1 AND household_id=$2 AND active', [Number(req.params.id) || 0, req.household_id])).rows[0];
    if (!c) fail(404, 'Customer not found');
    const jobs = (await pool.query(`SELECT t.id, t.job_number, t.title, t.created_at, t.done_at, b.name AS phase FROM todos t
      LEFT JOIN board_columns b ON b.id = t.column_id WHERE t.customer_id=$1 ORDER BY t.id DESC`, [c.id])).rows;
    for (const j of jobs) { const m = await money(pool, j.id, req.household_id); j.total_cents = m.totals.total_cents; j.balance_cents = m.totals.balance_cents; }
    res.json({ ...c, jobs });
  }));
  app.post('/api/shop/customers', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const c = readCustomer(req.body);
    const r = await pool.query('INSERT INTO customers (household_id, name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.household_id, c.name, c.phone, c.email, c.address, c.notes]);
    // Link a job to the new customer right away (from the job ticket).
    if (req.body.todo_id) {
      const j = await loadJob(pool, req.body.todo_id, req.household_id);
      await pool.query('UPDATE todos SET customer_id=$1 WHERE id=$2', [r.rows[0].id, j.id]);
      notify(req.household_id, { type: 'todo', id: j.id });
    }
    notify(req.household_id, { type: 'customers' }); changed(req.household_id);
    res.json(r.rows[0]);
  }));
  app.put('/api/shop/customers/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const c = readCustomer(req.body);
    const r = await pool.query(`UPDATE customers SET name=$1, phone=$2, email=$3, address=$4, notes=$5, updated_at=now()
      WHERE id=$6 AND household_id=$7 AND active RETURNING *`, [c.name, c.phone, c.email, c.address, c.notes, Number(req.params.id) || 0, req.household_id]);
    if (!r.rows[0]) fail(404, 'Customer not found');
    notify(req.household_id, { type: 'customers' }); changed(req.household_id);
    res.json(r.rows[0]);
  }));
  // Removing a customer keeps their jobs (with the name, phone and address typed on them).
  app.delete('/api/shop/customers/:id', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const r = await pool.query('UPDATE customers SET active=false WHERE id=$1 AND household_id=$2 AND active RETURNING id', [Number(req.params.id) || 0, req.household_id]);
    if (!r.rows[0]) fail(404, 'Customer not found');
    await pool.query('UPDATE todos SET customer_id=NULL WHERE customer_id=$1', [r.rows[0].id]);
    notify(req.household_id, { type: 'customers' });
    res.json({ ok: true });
  }));
  // A job typed without picking a customer: find them in the list (same phone, email or name) or add them.
  async function ensureCustomer(db, job) {
    if (job.customer_id) {
      const c = (await db.query('SELECT * FROM customers WHERE id=$1 AND active', [job.customer_id])).rows[0];
      if (c) return c;
    }
    const name = (job.customer_name || '').trim();
    if (!name) return null;
    const ph = digits(job.customer_phone).slice(-10);
    const all = (await db.query('SELECT * FROM customers WHERE household_id=$1 AND active', [job.household_id])).rows;
    let c = (ph.length >= 7 && all.find((x) => digits(x.phone).slice(-10) === ph))
      || (job.customer_email && all.find((x) => x.email && x.email === job.customer_email))
      || all.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (!c) {
      c = (await db.query('INSERT INTO customers (household_id, name, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [job.household_id, name, job.customer_phone || null, job.customer_email || null, job.job_address || null])).rows[0];
    }
    await db.query('UPDATE todos SET customer_id=$1 WHERE id=$2', [c.id, job.id]);
    return c;
  }

  // ---------- sending the invoice: a private link for WhatsApp / text, email, print ----------
  async function invoiceLink(req, job) {
    let code = job.invoice_code;
    if (!code) {
      code = crypto.randomBytes(12).toString('base64url');
      await pool.query('UPDATE todos SET invoice_code=$1 WHERE id=$2 AND invoice_code IS NULL', [code, job.id]);
      code = (await pool.query('SELECT invoice_code FROM todos WHERE id=$1', [job.id])).rows[0].invoice_code;
    }
    return `${publicOrigin(req)}/i/${code}`;
  }
  // What the send dialog needs: the link, a ready message, and the customer's phone and email.
  app.post('/api/shop/jobs/:id/share', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const d = await invoiceData(req.household_id, req.params.id);
    if (!d.lines.length) fail(400, 'Add parts or charges before sending the invoice');
    await ensureCustomer(pool, d.job);
    const url = await invoiceLink(req, d.job);
    const first = (d.job.customer_name || '').trim().split(/\s+/)[0];
    const due = d.totals.balance_cents;
    const message = `${first ? 'Hi ' + first + ', h' : 'H'}ere is your invoice #${d.job.job_number || d.job.id} from ${d.acct.name}: `
      + `${usd(d.totals.total_cents)} total${d.totals.paid_cents ? `, ${due > 0 ? usd(due) + ' still due' : 'paid in full'}` : ''}.\n${url}`;
    res.json({ url, message, phone: d.job.customer_phone || '', email: d.job.customer_email || '', email_ready: email.enabled });
  }));
  // Record that it was sent (WhatsApp, text, print or the email app) so it shows in history and goes to QuickBooks.
  const HOW = { whatsapp: 'WhatsApp', text: 'text message', print: 'printed', mailapp: 'email' };
  app.post('/api/shop/jobs/:id/sent', ...L, wrap(async (req, res) => {
    shopOnly(req);
    const job = await loadJob(pool, req.params.id, req.household_id);
    const how = HOW[req.body.how] || fail(400, 'How was it sent?');
    const to = text(req.body.to, 'To', { required: false, max: 200 });
    await pool.query('UPDATE todos SET invoice_sent_at=COALESCE(invoice_sent_at, now()) WHERE id=$1', [job.id]);
    await log(pool, job.id, actorOf(req), req.body.how === 'print' ? 'Invoice printed' : `Invoice sent by ${how}${to ? ' to ' + to : ''}`);
    notify(req.household_id, { type: 'todo', id: job.id }); changed(req.household_id);
    res.json({ ok: true });
  }));
  // The customer's view of the invoice (from the WhatsApp, text or email link). No sign-in; the code is private.
  app.get('/i/:code', wrap(async (req, res) => {
    const j = (await pool.query(`SELECT t.id, t.household_id FROM todos t JOIN households h ON h.id = t.household_id
      WHERE t.invoice_code=$1 AND h.screen='shop'`, [String(req.params.code || '')])).rows[0];
    if (!j) return res.status(404).send('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><p style="font-family:Arial;padding:30px;text-align:center">This invoice link is not valid anymore. Please ask the shop for a new one.</p>');
    const d = await invoiceData(j.household_id, j.id);
    res.set('X-Robots-Tag', 'noindex');
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Invoice ${esc(d.job.job_number || d.job.id)} · ${esc(d.acct.name)}</title>
<style>body{margin:0;background:#e5e7eb}.bar{display:flex;gap:10px;align-items:center;justify-content:center;padding:12px;font-family:Arial,sans-serif}
.bar button{font-size:16px;padding:10px 18px;border:0;border-radius:8px;cursor:pointer;background:#2563eb;color:#fff;font-weight:700}
@media print{.bar{display:none}body{background:#fff}} @media (max-width:600px){body>div:last-of-type{padding:16px!important}}</style></head><body>
<div class="bar"><span data-brand></span><button onclick="print()">🖨 Print / Save as PDF</button></div>
${invoiceHtml(d)}<script src="/brand.js"></script></body></html>`);
  }));

  // ---------- phone scanner paired to a shop screen ----------
  async function pairView(req, t) {
    const url = `${publicOrigin(req)}/scan#${t}`;
    return { token: t, url, qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }
  // The shop screen keeps its pairing (token) and gets a QR code for phones to scan.
  app.post('/api/shop/pair', ...L, wrap(async (req, res) => {
    shopOnly(req);
    let t = String(req.body.token || '');
    const ok = t && (await pool.query('SELECT 1 FROM scan_pairs WHERE token=$1 AND household_id=$2', [t, req.household_id])).rows.length;
    if (!ok || req.body.renew) {
      if (ok) await pool.query('DELETE FROM scan_pairs WHERE token=$1', [t]); // "New QR code": phones paired before stop working
      t = token();
      await pool.query('INSERT INTO scan_pairs (token, household_id) VALUES ($1,$2)', [t, req.household_id]);
    }
    res.json(await pairView(req, t));
  }));
  // Which job is open on that screen (scans go to it). null when the board is showing.
  app.post('/api/shop/pair/target', ...L, wrap(async (req, res) => {
    shopOnly(req);
    let target = null;
    if (req.body.todo_id) target = (await loadJob(pool, req.body.todo_id, req.household_id)).id;
    await pool.query('UPDATE scan_pairs SET target_todo_id=$1 WHERE token=$2 AND household_id=$3', [target, String(req.body.token || ''), req.household_id]);
    res.json({ ok: true });
  }));
  async function pairByToken(t) {
    const r = await pool.query(`SELECT p.*, h.name AS shop_name FROM scan_pairs p JOIN households h ON h.id = p.household_id
      WHERE p.token=$1 AND h.active AND h.screen='shop'`, [String(t || '')]);
    if (!r.rows[0]) fail(404, 'This scanner link is no longer valid. Scan the QR code on the shop screen again.');
    pool.query('UPDATE scan_pairs SET last_used=now() WHERE token=$1', [r.rows[0].token]).catch(() => {});
    return r.rows[0];
  }
  async function phoneView(p) {
    if (!p.target_todo_id) return { shop: p.shop_name, job: null };
    const job = await loadJob(pool, p.target_todo_id, p.household_id);
    const m = await money(pool, job.id, p.household_id);
    return { shop: p.shop_name, job: { id: job.id, job_number: job.job_number, title: job.title, customer: job.customer_name, phase: job.phase,
      first_phase: job.first_phase }, lines: m.lines.slice(-30), totals: m.totals };
  }
  const phoneActor = { id: null, name: 'Phone scanner' };
  async function phoneJob(db, p) {
    if (!p.target_todo_id) fail(409, 'Open a job on the shop screen first, then scan.');
    return loadJob(db, p.target_todo_id, p.household_id, true);
  }
  app.get('/api/pair/:token', wrap(async (req, res) => res.json(await phoneView(await pairByToken(req.params.token)))));
  app.post('/api/pair/:token/scan', wrap(async (req, res) => {
    const p = await pairByToken(req.params.token);
    const code = text(req.body.code, 'Barcode', { max: 64 });
    const out = await withTx(async (db) => addLine(db, p.household_id, await phoneJob(db, p), { code, qty: req.body.qty }, phoneActor));
    if (out.found) { notify(p.household_id, { type: 'todo', id: p.target_todo_id }); changed(p.household_id); }
    res.json({ ...out, ...(await phoneView(p)) });
  }));
  // Not in the parts list: add it (optionally saving it to the parts list with its barcode), or a typed charge.
  app.post('/api/pair/:token/custom', wrap(async (req, res) => {
    const p = await pairByToken(req.params.token);
    const out = await withTx(async (db) => {
      const job = await phoneJob(db, p);
      if (req.body.save_part) {
        const part = await createPart(db, p.household_id, readPart({ ...req.body, barcode: req.body.barcode }));
        return addLine(db, p.household_id, job, { part_id: part.id, qty: req.body.qty }, phoneActor);
      }
      return addLine(db, p.household_id, job, { name: req.body.name, price: req.body.price, qty: req.body.qty, taxable: req.body.taxable }, phoneActor);
    });
    notify(p.household_id, { type: 'todo', id: p.target_todo_id }); changed(p.household_id);
    if (req.body.save_part) notify(p.household_id, { type: 'parts' });
    res.json({ ...out, ...(await phoneView(p)) });
  }));
  app.post('/api/pair/:token/remove', wrap(async (req, res) => {
    const p = await pairByToken(req.params.token);
    await withTx(async (db) => {
      const job = await phoneJob(db, p);
      const l = (await db.query('DELETE FROM job_lines WHERE id=$1 AND todo_id=$2 RETURNING *', [Number(req.body.line_id) || 0, job.id])).rows[0];
      if (!l) fail(404, 'Line not found');
      await log(db, job.id, phoneActor, `Removed: ${l.name}${qtyText(l.qty)} ${usd(lineTotal(l))}`);
      await touch(db, job.id);
    });
    notify(p.household_id, { type: 'todo', id: p.target_todo_id }); changed(p.household_id);
    res.json(await phoneView(p));
  }));

  return { money, settings, computeTotals, lineTotal, ensureCustomer, loadJob, invoiceLink };
};
