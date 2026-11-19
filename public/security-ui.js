// 🔒 Login & security window, shared by the board, the store screen and the admin page (SECURITY-HANDOVER.md):
// - My login & backup email: backup email, new password (blank keeps it), current password (needed), Save.
// - Support access (account owners only): "Make a code for support" (6 digits, once, 15 minutes) and
//   "Who opened your account" (the log).
// - HBSec.backupBar(): the yellow "Add a backup email" bar for logins that don't have one yet.
// Self-contained (its own window and styles), colored by the page's Ranch/Dark variables.
window.HBSec = (() => {
  const css = `
  #hbsec { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; z-index: 400; padding: 14px; }
  #hbsec.open { display: flex; }
  #hbsec .box { position: relative; background: var(--panel, var(--card, #fff)); color: var(--ink, var(--text, #222)); border: 1px solid var(--line, #ccc); border-radius: 14px;
    padding: 20px 22px; width: 100%; max-width: 560px; max-height: 100%; overflow: auto; font-size: 15.5px; }
  html[data-theme=ranch] #hbsec .box { background: #f4ecdb; }
  #hbsec h2 { margin: 0 34px 4px 0; font-size: 22px; color: var(--head, inherit); }
  #hbsec h3 { margin: 20px 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: var(--head, inherit); }
  #hbsec .x { position: absolute; top: 12px; right: 12px; width: 38px; height: 38px; border-radius: 50%; border: 0; font-size: 18px; cursor: pointer;
    background: var(--btn, #e5e5e5); color: var(--btntx, var(--text, #222)); }
  #hbsec label { display: block; font-size: 14px; font-weight: 700; margin: 10px 0 4px; color: var(--label, inherit); }
  #hbsec input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--inputline, var(--line, #ccc));
    background: var(--input, var(--bg, #fff)); color: var(--ink, var(--text, #222)); font: inherit; }
  #hbsec button.b { font: inherit; font-weight: 700; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line, #ccc); cursor: pointer;
    background: var(--btn, #eee); color: var(--btntx, var(--text, #222)); }
  #hbsec button.pri { background: var(--accent, #2f5a2a); border-color: transparent; color: #fff; }
  #hbsec .muted { color: var(--muted, #777); font-size: 13.5px; }
  #hbsec .err { color: var(--dangertx, #b91c1c); min-height: 20px; font-size: 14px; margin-top: 6px; }
  #hbsec .ok { color: var(--paid, #2f7a2a); font-size: 14px; margin-top: 6px; }
  #hbsec .code { font-size: 44px; font-weight: 800; letter-spacing: 8px; text-align: center; padding: 14px; margin: 10px 0 4px; border-radius: 12px;
    background: var(--card, #fff); border: 2px dashed var(--accent, #2f5a2a); font-variant-numeric: tabular-nums; }
  #hbsec table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 6px; }
  #hbsec th { text-align: left; padding: 6px 8px; background: var(--accent, #2f5a2a); color: #fff; font-weight: 700; }
  html[data-theme=dark] #hbsec th { background: #191b20; color: var(--head, #d9a93a); }
  #hbsec td { padding: 6px 8px; border-bottom: 1px solid var(--line, #ddd); vertical-align: top; }
  #hbsec .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
  .hbbackup { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 14px; background: #fde68a; color: #3b2a05; font-size: 14.5px; }
  .hbbackup button { font: inherit; font-weight: 800; padding: 6px 12px; border: 0; border-radius: 8px; background: #3b2a05; color: #fde68a; cursor: pointer; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function call(path, body) {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong (' + r.status + ')');
    return d;
  }
  let wrap = null;
  const close = () => wrap && wrap.classList.remove('open');
  function open(html) {
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'hbsec';
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      document.body.appendChild(wrap);
    }
    wrap.innerHTML = '<div class="box"><button type="button" class="x" title="Close" aria-label="Close">✕</button>' + html + '</div>';
    wrap.querySelector('.x').onclick = close;
    wrap.classList.add('open');
    return wrap.querySelector('.box');
  }
  const when = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // owner: true on an account's own screen (shows Support access); false for the admin's own login.
  async function loginDialog({ owner = false, place = 'account', onSaved } = {}) {
    let me;
    try { me = await call('/api/me/login'); } catch (e) { return alert(e.message); }
    const box = open(`<h2>🔒 Login &amp; security</h2>
      <div class="muted">Signed in as <b>${esc(me.email)}</b>${owner ? ` · the ${esc(place)} sign-in` : ' · admin'}</div>
      <h3>My login &amp; backup email</h3>
      <div class="muted">A backup email lets you get back in if you forget the password ("Forgot password?" sends a link to both emails). It must be different from the login email.</div>
      <form id="hbsecF" autocomplete="off" onsubmit="return false">
        <label>Backup email</label><input name="backup" type="email" value="${esc(me.backup_email)}" placeholder="another email you check">
        <label>New password <span class="muted">(leave blank to keep it)</span></label><input name="pw" type="password" autocomplete="new-password" placeholder="8 or more characters">
        <label>Current password <span class="muted">(needed to save)</span></label><input name="cur" type="password" autocomplete="current-password">
        <div class="err" id="hbsecErr"></div>
        <div class="acts"><button type="submit" class="b pri" id="hbsecSave">Save</button></div>
      </form>
      ${owner ? `<h3>🔒 Support access</h3>
      <div class="muted">Support can only open this ${esc(place)} with a one-time code from you. If you call for help, make a code here and read it to them. It works once, for 15 minutes, and their access lasts 4 hours. Every visit is listed below.</div>
      <div id="hbsecCode"></div>
      <div class="acts" style="justify-content:flex-start"><button type="button" class="b" id="hbsecMake">Make a code for support</button></div>
      <h3>Who opened your ${esc(place)}</h3><div id="hbsecLog" class="muted">Loading…</div>` : ''}`);
    const f = box.querySelector('#hbsecF');
    box.querySelector('#hbsecSave').onclick = async () => {
      const err = box.querySelector('#hbsecErr'); err.textContent = '';
      try {
        const r = await call('/api/me/password', { current: f.cur.value, password: f.pw.value || undefined, backup_email: f.backup.value });
        err.className = 'ok';
        err.textContent = '✓ Saved.' + (r.signed_out_others ? ' Other screens using this login need to sign in again.' : '') + ' A notice was emailed to your login and backup emails.';
        f.cur.value = f.pw.value = '';
        if (onSaved) onSaved();
      } catch (e) { err.className = 'err'; err.textContent = e.message; }
    };
    if (!owner) return;
    const loadLog = async () => {
      try {
        const rows = await call('/api/support/log');
        box.querySelector('#hbsecLog').innerHTML = rows.length ? `<table><tr><th>When</th><th>Who</th><th>What</th></tr>${rows.map((r) =>
          `<tr><td>${esc(when(r.created_at))}</td><td>${esc(r.user_name || '—')}</td><td>${esc(r.action)}</td></tr>`).join('')}</table>` : 'Nobody has opened it yet.';
      } catch (e) { box.querySelector('#hbsecLog').textContent = e.message; }
    };
    box.querySelector('#hbsecMake').onclick = async () => {
      try {
        const r = await call('/api/support/code', {});
        box.querySelector('#hbsecCode').innerHTML = `<div class="code">${r.code.slice(0, 3)} ${r.code.slice(3)}</div><div class="muted" style="text-align:center">Read this to support. It works once, for ${r.minutes} minutes.</div>`;
        loadLog();
      } catch (e) { alert(e.message); }
    };
    loadLog();
  }

  // The yellow bar for a login without a backup email. Put it at the top of the page.
  function backupBar(before, opts) {
    const bar = document.createElement('div'); bar.className = 'hbbackup';
    bar.innerHTML = '⚠ Add a <b>backup email</b> so you can get back in if you forget the password.<button type="button">Add it now</button>';
    bar.querySelector('button').onclick = () => loginDialog({ ...opts, onSaved: () => bar.remove() });
    (before && before.parentNode ? before.parentNode : document.body).insertBefore(bar, before || document.body.firstChild);
    return bar;
  }
  async function checkBackup(before, opts) {
    try { const me = await call('/api/me/login'); if (me.needs_backup) backupBar(before, opts); } catch (e) { /* not signed in */ }
  }
  return { loginDialog, backupBar, checkBackup, close };
})();
