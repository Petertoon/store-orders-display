// Shared helpers for all HomeBoard pages.
async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && !path.startsWith('/api/login') && !location.pathname.startsWith('/login')) {
    location.href = loginPage(); throw new Error('Please log in');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg, kind = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ''), 2800);
}
// The sign-in page this screen came from (/login/shop etc.), so signing out goes back to the right one.
function loginPage() {
  try { const p = localStorage.getItem('hb_login'); if (p && /^\/login(\/[a-z]+)?$/.test(p)) return p; } catch (e) { /* ok */ }
  return '/login';
}
async function logout() {
  await api('/api/logout', {}).catch(() => {});
  location.href = loginPage();
}
// Today's date as 2026-11-14 in this screen's time zone.
function isoDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Look of the program: 'ranch' (default) or 'dark'. The page's <head> sets the remembered look before drawing;
// this applies the account's own setting once it's known, and remembers it for next time on this screen.
function applyTheme(t) {
  t = t === 'dark' ? 'dark' : 'ranch';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('hb_theme', t); } catch (e) { /* ok */ }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#17191e' : '#d9c093';
}
