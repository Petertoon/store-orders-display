// Security, the same rules as MultiPOS (SECURITY-HANDOVER.md):
// 1. Support access codes: the admin opens an account's screen only with a one-time 6-digit code from the account's
//    owner (emailed to the owner's login/backup email, or made by the owner on their screen and read over the phone).
//    A code works once, for 15 minutes, 5 wrong tries; 5 emailed codes an hour. Access lasts 4 hours. For the first
//    3 days after an account is made ("setup days") the admin can open it without a code. Every visit is logged and
//    the owner sees the log. Support can't change the owner's sign-in email or password (except on setup days).
// 2. Account recovery: every login (account owners and admins) keeps a backup email. "Forgot password?" emails a
//    one-time, 30-minute reset link to both emails. Password and backup-email changes email a notice.
// Codes and reset links are stored only as SHA-256 hashes. In HomeBoard each account has one login: its owner.
const crypto = require('crypto');

const CODE_MINUTES = 15, CODE_TRIES = 5, CODES_PER_HOUR = 5, ACCESS_HOURS = 4, SETUP_DAYS = 3, RESET_MINUTES = 30;

module.exports = function setupSecurity(app, deps) {
  const { pool, wrap, fail, text, bcrypt, cleanEmail, cleanPassword, requireSignIn, requireAdmin, requireLogin, COOKIE, email, appName } = deps;
  const A = [requireSignIn, requireAdmin];
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const hashCode = (c) => sha256('hb-support:' + c);
  const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c) : null);
  const origin = (req) => (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`);
  const TZ = process.env.TIME_ZONE || 'America/Chicago';
  const clock = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

  async function supportLog(hid, login, action, db = pool) {
    await db.query('INSERT INTO support_access_log (household_id, login_id, user_name, action) VALUES ($1,$2,$3,$4)',
      [hid, login ? login.id : null, login ? (login.is_admin ? `${login.email} (support)` : login.email) : null, action]);
  }
  // The account, its owner's login, and whether it's still in its setup days.
  async function accountInfo(hid, db = pool) {
    const r = await db.query(`SELECT h.id, h.name, h.screen, h.created_at, h.created_at > now() - interval '${SETUP_DAYS} days' AS in_setup,
        h.created_at + interval '${SETUP_DAYS} days' AS setup_until, l.id AS owner_id, l.email, l.backup_email
      FROM households h LEFT JOIN LATERAL (SELECT * FROM logins WHERE household_id = h.id ORDER BY id LIMIT 1) l ON true WHERE h.id=$1`, [Number(hid) || 0]);
    if (!r.rows[0]) fail(404, 'Account not found');
    return r.rows[0];
  }
  // No back doors: support can't change the owner's sign-in (except on setup days, logged).
  // db: the caller's transaction (it may already hold the account's row).
  async function noBackdoor(req, hid, what, db = pool) {
    const a = await accountInfo(hid, db);
    if (!a.in_setup) fail(403, `For the owner's security, support can't ${what}. Ask the owner to do it on their screen (🔒 Login & security), or to use "Forgot password?".`);
    await supportLog(a.id, req.login, `During setup days: ${what}`, db);
  }

  // ---------- emails ----------
  const wrapHtml = (title, body) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#2b2417">
    <div style="background:#2f5a2a;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">${title}</div>
    <div style="border:1px solid #dccdb0;border-top:0;padding:18px;border-radius:0 0 10px 10px;background:#fffaf0">${body}</div></div>`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function sendTo(list, subject, html, txt) {
    const out = [];
    for (const to of [...new Set(list.filter(Boolean).map((e) => e.toLowerCase()))]) out.push(await email.sendMail({ to, subject, html, text: txt }));
    return out;
  }
  async function changeNotice(login, oldBackup, what) {
    const when = new Date().toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await sendTo([login.email, oldBackup, login.backup_email], `Your ${appName} login was changed`,
      wrapHtml('Your login was changed', `<p>The ${esc(what)} for the ${appName} login <b>${esc(login.email)}</b> was changed on ${esc(when)}.</p>
        <p>If you did this, there's nothing to do. If you didn't, use <b>Forgot password?</b> on the sign-in page right away and contact support.</p>`),
      `The ${what} for the ${appName} login ${login.email} was changed on ${when}. If this wasn't you, use "Forgot password?" on the sign-in page right away and contact support.`);
  }

  // ---------- 1. support access ----------
  // The admin's code window: who it is, setup days, where a code can be emailed (masked).
  app.get('/api/admin/access/:id', ...A, wrap(async (req, res) => {
    const a = await accountInfo(req.params.id);
    res.json({ id: a.id, name: a.name, screen: a.screen, in_setup: a.in_setup, setup_until: a.setup_until,
      main: maskEmail(a.email), backup: maskEmail(a.backup_email), email_ok: email.enabled });
  }));
  app.post('/api/admin/access/:id/send', ...A, wrap(async (req, res) => {
    const a = await accountInfo(req.params.id);
    if (!email.enabled) fail(400, 'Email is not set up. Ask the owner to make a code on their screen (🔒 Login & security → Support access).');
    if (!a.email) fail(400, 'This account has no login');
    const to = ['main', 'backup', 'both'].includes(req.body.to) ? req.body.to : 'main';
    if (to !== 'main' && !a.backup_email) fail(400, "The owner hasn't added a backup email yet");
    const recent = (await pool.query(`SELECT count(*)::int AS n FROM support_codes WHERE household_id=$1 AND made_by='email' AND created_at > now() - interval '1 hour'`, [a.id])).rows[0].n;
    if (recent >= CODES_PER_HOUR) fail(429, `${CODES_PER_HOUR} codes an hour is the most that can be emailed. Try again later, or ask the owner to make one.`);
    const code = newCode();
    await pool.query("UPDATE support_codes SET used_at = now() WHERE household_id=$1 AND made_by='email' AND used_at IS NULL", [a.id]); // older emailed codes stop working
    await pool.query(`INSERT INTO support_codes (household_id, code_hash, made_by, requested_by, expires_at) VALUES ($1,$2,'email',$3, now() + interval '${CODE_MINUTES} minutes')`,
      [a.id, hashCode(code), req.login.id]);
    const list = to === 'main' ? [a.email] : to === 'backup' ? [a.backup_email] : [a.email, a.backup_email];
    const shown = code.slice(0, 3) + ' ' + code.slice(3);
    const sent = await sendTo(list, `${appName} support access code: ${shown}`,
      wrapHtml('Support access code', `<p>Support (${esc(req.login.email)}) asked to open your ${appName} account <b>${esc(a.name)}</b>.</p>
        <p style="font-size:34px;font-weight:bold;letter-spacing:6px;text-align:center;margin:18px 0">${shown}</p>
        <p>Give this code to support <b>only if you asked them for help</b>. It works once, for ${CODE_MINUTES} minutes. Access lasts ${ACCESS_HOURS} hours, and every visit shows in <b>🔒 Login &amp; security → Who opened your account</b>.</p>
        <p>If you didn't ask for help, ignore this email. Without the code nobody can open your account.</p>`),
      `Support (${req.login.email}) asked to open your ${appName} account "${a.name}". Code: ${shown}. Give it to support only if you asked for help. It works once, for ${CODE_MINUTES} minutes.`);
    if (!sent.some((x) => x.ok)) fail(502, 'The email could not be sent: ' + ((sent[0] || {}).error || 'unknown error'));
    await supportLog(a.id, req.login, `Code emailed to the ${to === 'main' ? 'main email' : to === 'backup' ? 'backup email' : 'main and backup email'}`);
    res.json({ ok: true, sent_to: list.map(maskEmail) });
  }));
  // Open an account: with the owner's code, or without one on setup days. Access lasts 4 hours.
  async function enter(req, res) {
    const a = await accountInfo(req.params.id);
    let how;
    if (a.in_setup && !req.body.code) how = 'Opened during setup days (no code needed)';
    else {
      const code = String(req.body.code || '').replace(/\D/g, '');
      if (code.length !== 6) fail(400, a.in_setup ? 'Type the 6-digit code' : 'This account needs a 6-digit code from its owner');
      const codes = (await pool.query(`SELECT * FROM support_codes WHERE household_id=$1 AND used_at IS NULL AND expires_at > now() AND attempts < ${CODE_TRIES} ORDER BY created_at DESC`, [a.id])).rows;
      const hit = codes.find((x) => x.code_hash === hashCode(code));
      if (!hit) {
        if (codes.length) await pool.query('UPDATE support_codes SET attempts = attempts + 1 WHERE id = ANY($1)', [codes.map((x) => x.id)]);
        await supportLog(a.id, req.login, 'Wrong code entered');
        fail(403, 'That code is not right, was already used, or ran out (codes work once, for 15 minutes). Ask the owner for a new one.');
      }
      await pool.query('UPDATE support_codes SET used_at = now() WHERE id=$1', [hit.id]);
      how = hit.made_by === 'owner' ? "Opened with the owner's code" : 'Opened with an emailed code';
    }
    const u = await pool.query(`UPDATE sessions SET acting_household_id=$1, acting_until = now() + interval '${ACCESS_HOURS} hours' WHERE token=$2 RETURNING acting_until`, [a.id, req.cookies[COOKIE]]);
    await supportLog(a.id, req.login, `${how} · access until ${clock(u.rows[0].acting_until)}`);
    res.json({ ok: true, until: u.rows[0].acting_until });
  }
  app.post('/api/admin/enter/:id', ...A, wrap(enter));
  app.post('/api/admin/open/:id', ...A, wrap(enter)); // the old address, same rules
  app.post('/api/admin/leave', ...A, wrap(async (req, res) => {
    const s = (await pool.query('SELECT acting_household_id, acting_until > now() AS live FROM sessions WHERE token=$1', [req.cookies[COOKIE]])).rows[0];
    await pool.query('UPDATE sessions SET acting_household_id=NULL, acting_until=NULL WHERE token=$1', [req.cookies[COOKIE]]);
    if (s && s.acting_household_id && s.live) await supportLog(s.acting_household_id, req.login, 'Left the account');
    res.json({ ok: true });
  }));

  // The owner (the account's own login, never support) makes a code to read to support over the phone.
  const realOwner = (req) => { if (req.login.is_admin) fail(403, 'Only the account owner can do this'); };
  app.post('/api/support/code', requireLogin, wrap(async (req, res) => {
    realOwner(req);
    const code = newCode();
    await pool.query(`INSERT INTO support_codes (household_id, code_hash, made_by, expires_at) VALUES ($1,$2,'owner', now() + interval '${CODE_MINUTES} minutes')`,
      [req.household_id, hashCode(code)]);
    await supportLog(req.household_id, req.login, 'Code made by the owner');
    res.json({ code, minutes: CODE_MINUTES });
  }));
  app.get('/api/support/log', requireLogin, wrap(async (req, res) => {
    realOwner(req);
    const r = await pool.query('SELECT created_at, user_name, action FROM support_access_log WHERE household_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [req.household_id]);
    res.json(r.rows);
  }));

  // ---------- 2. account recovery ----------
  const cleanBackup = (v, loginEmail) => {
    const b = cleanEmail(v);
    if (b === String(loginEmail).toLowerCase()) fail(400, 'The backup email must be different from the login email');
    return b;
  };
  app.get('/api/me/login', requireSignIn, wrap(async (req, res) => {
    const l = (await pool.query('SELECT email, backup_email, is_admin FROM logins WHERE id=$1', [req.login.id])).rows[0];
    res.json({ email: l.email, backup_email: l.backup_email || '', needs_backup: !l.backup_email, admin: l.is_admin });
  }));
  // Change the password and/or the backup email. Needs the current password. A backup email is required.
  async function changeLogin(req, res) {
    const l = (await pool.query('SELECT * FROM logins WHERE id=$1', [req.login.id])).rows[0];
    if (!(await bcrypt.compare(String(req.body.current || ''), l.password_hash))) fail(400, 'The current password is wrong');
    const wantsBackup = 'backup_email' in req.body;
    const backup = wantsBackup && String(req.body.backup_email || '').trim() ? cleanBackup(req.body.backup_email, l.email) : (wantsBackup ? null : l.backup_email);
    if (!backup) fail(400, 'A backup email is required. It lets you get back in if you forget your password.');
    const pw = req.body.password ? cleanPassword(req.body.password, 'The new password') : null;
    if (!pw && backup === l.backup_email) fail(400, 'Nothing changed');
    if (pw) await pool.query('UPDATE logins SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), l.id]);
    if (backup !== l.backup_email) await pool.query('UPDATE logins SET backup_email=$1 WHERE id=$2', [backup, l.id]);
    if (pw) await pool.query('DELETE FROM sessions WHERE login_id=$1 AND token<>$2', [l.id, req.cookies[COOKIE]]); // sign out every other screen
    const what = [pw ? 'password' : null, backup !== l.backup_email ? 'backup email' : null].filter(Boolean).join(' and ');
    if (l.household_id) await supportLog(l.household_id, req.login, `Owner changed the ${what}`);
    await changeNotice({ ...l, backup_email: backup }, l.backup_email, what);
    res.json({ ok: true, signed_out_others: !!pw });
  }
  app.post('/api/me/password', requireSignIn, wrap(changeLogin));
  app.post('/api/password', requireSignIn, wrap(changeLogin)); // the old address

  // Forgot password: the same answer whether or not the email has a login. 5 an hour per IP and email.
  const forgotHits = new Map();
  app.post('/api/password/forgot', wrap(async (req, res) => {
    const e = String(req.body.email || '').trim().toLowerCase();
    const key = req.ip + '|' + e, now = Date.now(), rec = (forgotHits.get(key) || []).filter((t) => now - t < 3600000);
    rec.push(now); forgotHits.set(key, rec);
    if (rec.length > 5) fail(429, 'Too many reset requests. Try again in an hour.');
    const u = e && (await pool.query('SELECT * FROM logins WHERE lower(email)=$1', [e])).rows[0];
    if (u && email.enabled) {
      const t = crypto.randomBytes(24).toString('base64url');
      await pool.query('UPDATE password_resets SET used_at = now() WHERE login_id=$1 AND used_at IS NULL', [u.id]); // old links die
      await pool.query(`INSERT INTO password_resets (login_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '${RESET_MINUTES} minutes')`, [u.id, sha256(t)]);
      const link = `${origin(req)}/reset#${t}`;
      await sendTo([u.email, u.backup_email], `Reset your ${appName} password`,
        wrapHtml('Reset your password', `<p>Someone asked to reset the password for the ${appName} login <b>${esc(u.email)}</b>.</p>
          <p style="text-align:center;margin:20px 0"><a href="${link}" style="background:#2f5a2a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
          <p>The link works once, for ${RESET_MINUTES} minutes. Resetting signs out every screen using this login.</p>
          <p>If you didn't ask for this, ignore this email; your password stays the same.</p>`),
        `Reset the password for the ${appName} login ${u.email}: ${link}\nThe link works once, for ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email.`);
    }
    res.json({ ok: true, email_ok: email.enabled });
  }));
  // What the reset page needs to know (without using up the link).
  app.post('/api/password/reset-info', wrap(async (req, res) => {
    const r = (await pool.query(`SELECT l.email, l.backup_email FROM password_resets p JOIN logins l ON l.id = p.login_id
      WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at > now()`, [sha256(String(req.body.token || ''))])).rows[0];
    if (!r) fail(400, 'This reset link is not valid anymore. Links work once, for 30 minutes; only the newest one works. Ask for a new one.');
    res.json({ email: maskEmail(r.email), has_backup: !!r.backup_email, backup: r.backup_email ? maskEmail(r.backup_email) : null });
  }));
  app.post('/api/password/reset', wrap(async (req, res) => {
    const r = (await pool.query(`SELECT p.id AS pid, l.* FROM password_resets p JOIN logins l ON l.id = p.login_id
      WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at > now()`, [sha256(String(req.body.token || ''))])).rows[0];
    if (!r) fail(400, 'This reset link is not valid anymore. Links work once, for 30 minutes; only the newest one works. Ask for a new one.');
    const pw = cleanPassword(req.body.password, 'The new password');
    // Every login here is an account owner or an admin, so a backup email is required (kept if one is already set).
    const backup = String(req.body.backup_email || '').trim() ? cleanBackup(req.body.backup_email, r.email) : r.backup_email;
    if (!backup) fail(400, 'Add a backup email, so you can get back in next time');
    await pool.query('UPDATE password_resets SET used_at = now() WHERE id=$1', [r.pid]);
    await pool.query('UPDATE logins SET password_hash=$1, backup_email=$2 WHERE id=$3', [await bcrypt.hash(pw, 10), backup, r.id]);
    await pool.query('DELETE FROM sessions WHERE login_id=$1', [r.id]); // every device signs out
    if (r.household_id) await supportLog(r.household_id, null, `Password reset with an emailed link${backup !== r.backup_email ? ' (backup email changed)' : ''}`);
    await changeNotice({ ...r, backup_email: backup }, r.backup_email, backup !== r.backup_email ? 'password and backup email' : 'password');
    res.json({ ok: true });
  }));

  return { noBackdoor, supportLog, maskEmail };
};
