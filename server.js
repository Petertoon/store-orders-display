// Server: first-run admin setup, sign-in, accounts (each uses one kind of screen), the admin back end,
// people on an account ("who are you?"), and the board (board.js).
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { pool, init } = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' })); // Wix orders with many items can be large
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const SESSION_DAYS = 60; // a kitchen or shop screen should stay signed in
const COOKIE = 'hb_session';
const MEMBER_COOKIE = 'hb_member';
const APP_NAME = process.env.APP_NAME || 'HomeBoard';

// The kinds of screens. Each account uses one; the admin back end has a tab for each.
const SCREENS = {
  todo: { label: "Mama's To-Do", icon: '🏠' },
  shop: { label: "Papa's Shop", icon: '🔧' },
  store: { label: 'Store Orders', icon: '🛒' },
};

// ---------- helpers ----------
const token = (n = 24) => crypto.randomBytes(n).toString('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
function text(value, label, { required = true, max = 200 } = {}) {
  const s = (value ?? '').toString().trim();
  if (required && !s) fail(400, `${label} is required`);
  if (s.length > max) fail(400, `${label} is too long`);
  return s;
}
const cleanColor = (c, fallback) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : fallback);
const MEMBER_COLORS = ['#3b82f6', '#ec4899', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6', '#ef4444', '#64748b'];
const cleanEmail = (v) => {
  const e = text(v, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email');
  return e;
};
const cleanPassword = (v, label = 'Password') => {
  const p = text(v, label, { max: 200 });
  if (p.length < 8) fail(400, `${label} must be at least 8 characters`);
  return p;
};
const cleanScreen = (v) => (SCREENS[v] ? v : fail(400, 'Choose which screen the account uses'));
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// ---------- sign-in ----------
// req.login = who signed in. Account logins work in their own account; the admin works in the account they opened.
// req.household_id = the account; req.account = its row; req.member = the person picked on this screen (may be null).
async function loadLogin(req) {
  const t = req.cookies[COOKIE];
  if (!t) return null;
  const { rows } = await pool.query(
    `SELECT l.id, l.email, l.is_admin, l.household_id, s.acting_household_id
       FROM sessions s JOIN logins l ON l.id = s.login_id
      WHERE s.token = $1 AND s.expires_at > now()`, [t]);
  // Screens that stay on (kitchen, shop, store) never get signed out: each day of use renews the sign-in.
  if (rows[0]) pool.query(`UPDATE sessions SET expires_at = now() + interval '${SESSION_DAYS} days'
    WHERE token=$1 AND expires_at < now() + interval '${SESSION_DAYS - 1} days'`, [t]).catch(() => {});
  return rows[0] || null;
}
const requireSignIn = wrap(async (req, res, next) => {
  req.login = await loadLogin(req);
  if (!req.login) fail(401, 'Please sign in');
  next();
});
const requireAdmin = (req, res, next) => (req.login.is_admin ? next() : next(new HttpError(403, 'Admin only')));
// Everything on a screen: needs an account that's switched on (the admin can open a switched-off one to look).
const requireLogin = wrap(async (req, res, next) => {
  req.login = await loadLogin(req);
  if (!req.login) fail(401, 'Please sign in');
  const hid = req.login.is_admin ? req.login.acting_household_id : req.login.household_id;
  if (!hid) fail(400, 'Open an account from the admin page first');
  const a = await pool.query('SELECT id, name, screen, active FROM households WHERE id=$1', [hid]);
  if (!a.rows[0]) fail(400, 'Open an account from the admin page first');
  if (!a.rows[0].active && !req.login.is_admin) fail(403, 'This account is switched off. Contact the administrator.');
  req.account = a.rows[0];
  req.household_id = a.rows[0].id;
  req.member = null;
  if (req.login.is_admin) {
    req.member = { id: null, name: 'Admin' };
  } else {
    const mid = parseInt(req.cookies[MEMBER_COOKIE], 10);
    if (mid) {
      const m = await pool.query('SELECT id, name, color FROM members WHERE id=$1 AND household_id=$2 AND active', [mid, hid]);
      req.member = m.rows[0] || null;
    }
  }
  next();
});

// Simple brute-force protection for sign-in.
const loginAttempts = new Map();
function checkLoginRate(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  loginAttempts.set(key, rec);
  if (rec.n > 20) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}
async function startSession(res, loginId) {
  const t = token();
  await pool.query(`INSERT INTO sessions (token, login_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [t, loginId]);
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_DAYS * 86400000 });
}
const memberCookie = (res, id) => res.cookie(MEMBER_COOKIE, String(id), { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 365 * 86400000 });
const adminExists = async () => (await pool.query('SELECT 1 FROM logins WHERE is_admin LIMIT 1')).rows.length > 0;

app.get('/api/setup-status', wrap(async (req, res) => res.json({ needs_setup: !(await adminExists()), app_name: APP_NAME })));

// First run only: creates the admin sign-in (you). Accounts are then made on the admin page.
app.post('/api/setup', wrap(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const hash = await bcrypt.hash(cleanPassword(req.body.password), 10);
  const id = await withTx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(777002)');
    if ((await db.query('SELECT 1 FROM logins WHERE is_admin LIMIT 1')).rows.length) fail(403, 'Setup has already been completed');
    if ((await db.query('SELECT 1 FROM logins WHERE email=$1', [email])).rows.length) fail(400, 'That email is already used by an account');
    return (await db.query('INSERT INTO logins (email, password_hash, is_admin) VALUES ($1,$2,true) RETURNING id', [email, hash])).rows[0].id;
  });
  await startSession(res, id);
  res.json({ ok: true, admin: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = text(req.body.email, 'Email').toLowerCase();
  checkLoginRate(email + '|' + req.ip);
  const { rows } = await pool.query(
    'SELECT l.*, h.active FROM logins l LEFT JOIN households h ON h.id = l.household_id WHERE l.email=$1', [email]);
  const ok = rows[0] && (await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash));
  if (!ok) fail(401, 'Wrong email or password');
  if (!rows[0].is_admin && rows[0].active === false) fail(403, 'This account is switched off. Contact the administrator.');
  await startSession(res, rows[0].id);
  res.clearCookie(MEMBER_COOKIE);
  res.json({ ok: true, admin: rows[0].is_admin });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (req.cookies[COOKIE]) await pool.query('DELETE FROM sessions WHERE token=$1', [req.cookies[COOKIE]]);
  res.clearCookie(COOKIE); res.clearCookie(MEMBER_COOKIE);
  res.json({ ok: true });
}));

app.get('/api/me', requireLogin, wrap(async (req, res) => {
  const m = await pool.query('SELECT id, name, color FROM members WHERE household_id=$1 AND active ORDER BY position, id', [req.household_id]);
  res.json({ app_name: APP_NAME, admin: req.login.is_admin, account: { ...req.account, screen_label: SCREENS[req.account.screen].label },
    household: { id: req.household_id, name: req.account.name }, email: req.login.email, member: req.login.is_admin ? null : req.member, members: m.rows });
}));

// "Who are you?" on this screen.
app.post('/api/me/member', requireLogin, wrap(async (req, res) => {
  const m = await pool.query('SELECT id, name, color FROM members WHERE id=$1 AND household_id=$2 AND active', [req.body.member_id, req.household_id]);
  if (!m.rows[0]) fail(404, 'Person not found');
  memberCookie(res, m.rows[0].id);
  res.json(m.rows[0]);
}));

// ---------- account settings & people (from the account's own screen) ----------
app.put('/api/household', requireLogin, wrap(async (req, res) => {
  await pool.query('UPDATE households SET name=$1 WHERE id=$2', [text(req.body.name, 'Name', { max: 80 }), req.household_id]);
  board.notify(req.household_id, { type: 'members' });
  res.json({ ok: true });
}));
app.post('/api/password', requireSignIn, wrap(async (req, res) => {
  const l = await pool.query('SELECT * FROM logins WHERE id=$1', [req.login.id]);
  if (!(await bcrypt.compare(String(req.body.current || ''), l.rows[0].password_hash))) fail(400, 'The current password is wrong');
  const pw = cleanPassword(req.body.password, 'The new password');
  await pool.query('UPDATE logins SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), req.login.id]);
  // Sign out every other screen.
  await pool.query('DELETE FROM sessions WHERE login_id=$1 AND token<>$2', [req.login.id, req.cookies[COOKIE]]);
  res.json({ ok: true });
}));
async function addMember(db, hid, name, color) {
  const n = await db.query('SELECT count(*)::int AS n, COALESCE(max(position),0) AS p FROM members WHERE household_id=$1 AND active', [hid]);
  if (n.rows[0].n >= 30) fail(400, '30 people is the most an account can have');
  return (await db.query('INSERT INTO members (household_id, name, color, position) VALUES ($1,$2,$3,$4) RETURNING id, name, color',
    [hid, text(name, 'Name', { max: 40 }), cleanColor(color, MEMBER_COLORS[n.rows[0].n % MEMBER_COLORS.length]), n.rows[0].p + 1])).rows[0];
}
app.post('/api/members', requireLogin, wrap(async (req, res) => {
  const m = await addMember(pool, req.household_id, req.body.name, req.body.color);
  board.notify(req.household_id, { type: 'members' });
  res.json(m);
}));
app.put('/api/members/:id', requireLogin, wrap(async (req, res) => {
  const r = await pool.query('UPDATE members SET name=$1, color=$2 WHERE id=$3 AND household_id=$4 AND active RETURNING id',
    [text(req.body.name, 'Name', { max: 40 }), cleanColor(req.body.color, '#3b82f6'), req.params.id, req.household_id]);
  if (!r.rows[0]) fail(404, 'Person not found');
  board.notify(req.household_id, { type: 'members' });
  res.json({ ok: true });
}));
// Removing a person keeps their name in history; their to-dos/jobs become "for anyone".
app.delete('/api/members/:id', requireLogin, wrap(async (req, res) => {
  const n = await pool.query('SELECT count(*)::int AS n FROM members WHERE household_id=$1 AND active', [req.household_id]);
  if (n.rows[0].n <= 1) fail(400, 'An account needs at least one person');
  const r = await pool.query('UPDATE members SET active=false WHERE id=$1 AND household_id=$2 AND active RETURNING id', [req.params.id, req.household_id]);
  if (!r.rows[0]) fail(404, 'Person not found');
  await pool.query('UPDATE todos SET member_id=NULL WHERE member_id=$1 AND household_id=$2', [req.params.id, req.household_id]);
  board.notify(req.household_id, { type: 'members' });
  res.json({ ok: true });
}));

// ---------- admin back end ----------
const A = [requireSignIn, requireAdmin];
app.get('/api/admin/accounts', ...A, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT h.id, h.name, h.screen, h.active, h.created_at,
      (SELECT l.email FROM logins l WHERE l.household_id = h.id ORDER BY l.id LIMIT 1) AS email,
      (SELECT count(*) FROM members m WHERE m.household_id = h.id AND m.active)::int AS people,
      (SELECT count(*) FROM todos t WHERE t.household_id = h.id AND t.done_at IS NULL)::int AS open_items,
      (SELECT max(t.updated_at) FROM todos t WHERE t.household_id = h.id) AS last_activity,
      (SELECT row_to_json(s) FROM store_settings s WHERE s.household_id = h.id) AS store,
      (SELECT count(*) FROM tickets k JOIN store_settings s ON s.code = k.store_id
        WHERE s.household_id = h.id AND k.status IN ('new', 'picking', 'ready'))::int AS open_orders
    FROM households h ORDER BY lower(h.name), h.id`);
  const me = await pool.query('SELECT email FROM logins WHERE id=$1', [req.login.id]);
  res.json({ app_name: APP_NAME, email: me.rows[0].email, screens: SCREENS, accounts: rows, acting: req.login.acting_household_id });
}));
// A new account: its name, which screen it uses, its sign-in, and its people.
app.post('/api/admin/accounts', ...A, wrap(async (req, res) => {
  const name = text(req.body.name, 'Account name', { max: 80 });
  const screen = cleanScreen(req.body.screen);
  const email = cleanEmail(req.body.email);
  const hash = await bcrypt.hash(cleanPassword(req.body.password), 10);
  const people = (Array.isArray(req.body.members) ? req.body.members : []).map((n) => text(n, 'Name', { required: false, max: 40 })).filter(Boolean).slice(0, 30);
  if (!people.length && screen !== 'store') fail(400, 'Add at least one person');
  const id = await withTx(async (db) => {
    if ((await db.query('SELECT 1 FROM logins WHERE email=$1', [email])).rows.length) fail(400, 'That email is already used');
    const h = await db.query('INSERT INTO households (name, screen) VALUES ($1,$2) RETURNING id', [name, screen]);
    await db.query('INSERT INTO logins (household_id, email, password_hash) VALUES ($1,$2,$3)', [h.rows[0].id, email, hash]);
    for (const p of people) await addMember(db, h.rows[0].id, p);
    if (screen === 'store') await stores.saveSettings(db, h.rows[0].id, name, req.body.store || {});
    return h.rows[0].id;
  });
  res.json({ id });
}));
// Rename, change screen, switch on/off, change sign-in email or password.
app.put('/api/admin/accounts/:id', ...A, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  await withTx(async (db) => {
    const h = await db.query('SELECT * FROM households WHERE id=$1 FOR UPDATE', [id]);
    if (!h.rows[0]) fail(404, 'Account not found');
    const a = h.rows[0];
    const name = 'name' in req.body ? text(req.body.name, 'Account name', { max: 80 }) : a.name;
    const screen = 'screen' in req.body ? cleanScreen(req.body.screen) : a.screen;
    const active = 'active' in req.body ? !!req.body.active : a.active;
    await db.query('UPDATE households SET name=$1, screen=$2, active=$3 WHERE id=$4', [name, screen, active, id]);
    // Store Orders accounts: their store settings (needed the first time an account moves to the Store Orders tab).
    if (screen === 'store' && (req.body.store || !(await stores.settingsFor(id, db)))) await stores.saveSettings(db, id, name, req.body.store || {});
    if (req.body.email) {
      const email = cleanEmail(req.body.email);
      if ((await db.query('SELECT 1 FROM logins WHERE email=$1 AND household_id IS DISTINCT FROM $2', [email, id])).rows.length) fail(400, 'That email is already used');
      const l = await db.query('UPDATE logins SET email=$1 WHERE household_id=$2 RETURNING id', [email, id]);
      if (!l.rows.length && req.body.password) await db.query('INSERT INTO logins (household_id, email, password_hash) VALUES ($1,$2,$3)', [id, email, await bcrypt.hash(cleanPassword(req.body.password), 10)]);
    }
    if (req.body.password) {
      await db.query('UPDATE logins SET password_hash=$1 WHERE household_id=$2', [await bcrypt.hash(cleanPassword(req.body.password), 10), id]);
      await db.query('DELETE FROM sessions WHERE login_id IN (SELECT id FROM logins WHERE household_id=$1)', [id]);
    }
    // Switching off keeps screens signed in: they show "switched off" and come back when it's switched on again.
  });
  board.notify(id, { type: 'account' });
  res.json({ ok: true });
}));
app.delete('/api/admin/accounts/:id', ...A, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM households WHERE id=$1 RETURNING id', [Number(req.params.id) || 0]);
  if (!r.rows[0]) fail(404, 'Account not found');
  res.json({ ok: true });
}));
// Open an account's screen (see what they see). Leave goes back to the admin page.
app.post('/api/admin/open/:id', ...A, wrap(async (req, res) => {
  const h = await pool.query('SELECT id FROM households WHERE id=$1', [Number(req.params.id) || 0]);
  if (!h.rows[0]) fail(404, 'Account not found');
  await pool.query('UPDATE sessions SET acting_household_id=$1 WHERE token=$2', [h.rows[0].id, req.cookies[COOKIE]]);
  res.json({ ok: true });
}));
app.post('/api/admin/leave', ...A, wrap(async (req, res) => {
  await pool.query('UPDATE sessions SET acting_household_id=NULL WHERE token=$1', [req.cookies[COOKIE]]);
  res.json({ ok: true });
}));

// ---------- the board ----------
const board = require('./board')(app, { pool, wrap, fail, text, cleanColor, requireLogin });

// ---------- Store Orders ----------
const stores = require('./stores')(app, { pool, wrap, fail, text, cleanColor, requireLogin, requireSignIn, requireAdmin, notify: board.notify });

// ---------- pages ----------
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/', wrap(async (req, res) => {
  if (!(await adminExists())) return res.redirect('/setup');
  const l = await loadLogin(req);
  if (!l) return res.redirect('/login');
  if (l.is_admin && !l.acting_household_id) return res.redirect('/admin');
  // Store Orders accounts get the store screen; everything else the board.
  const a = await pool.query('SELECT screen FROM households WHERE id=$1', [l.is_admin ? l.acting_household_id : l.household_id]);
  page(a.rows[0] && a.rows[0].screen === 'store' ? 'store.html' : 'board.html')(req, res);
}));
app.get('/admin', wrap(async (req, res) => {
  const l = await loadLogin(req);
  if (!l) return res.redirect('/login');
  if (!l.is_admin) return res.redirect('/');
  page('admin.html')(req, res);
}));
// Render's health check (both addresses, so an existing store-orders-display service keeps working).
app.get(['/healthz', '/health'], (req, res) => res.json({ ok: true }));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much text to save at once' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`));
  // Clear out expired sessions once a day.
  setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 86400000);
}).catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
