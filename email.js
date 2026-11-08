// Emails each new store ticket to that store's address(es).
// Uses any SMTP account: Gmail (with an App Password), Outlook, Zoho, Resend, etc.
// Turned off automatically when SMTP_HOST / SMTP_USER / SMTP_PASS aren't set.
const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Chicago';

const enabled = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const transport = enabled
  ? nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    })
  : null;
if (!enabled) console.warn('[email] SMTP not configured — store emails are off');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const recipients = (store) =>
  (Array.isArray(store.email) ? store.email : String(store.email || '').split(','))
    .map((e) => e.trim()).filter(Boolean);

function build(store, t) {
  const isTest = String(t.orderId).startsWith('test-');
  const when = new Date(t.createdAt).toLocaleString('en-US', {
    timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const totalQty = t.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  const subject = `${isTest ? '[TEST] ' : ''}New pickup order #${t.orderNumber} — ${store.name}`;

  const rows = t.items.map((i) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #ddd;font-size:18px;font-weight:bold;vertical-align:top">${esc(i.qty)}×</td>
      <td style="padding:8px;border-bottom:1px solid #ddd">
        <div style="font-size:16px;font-weight:bold">${esc(i.name)}</div>
        <div style="color:#555;font-family:monospace">Product #: ${esc(i.sku || '-')}</div>
        ${(i.options || []).length ? `<div style="color:#555">${esc(i.options.join(' · '))}</div>` : ''}
      </td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <div style="background:${esc(store.color || '#333')};color:#fff;padding:14px 16px;border-radius:8px 8px 0 0">
      <div style="font-size:14px">${esc(store.name)}</div>
      <div style="font-size:24px;font-weight:bold">${isTest ? 'TEST ' : ''}Pickup order #${esc(t.orderNumber)}</div>
      <div style="font-size:14px">${esc(when)}</div>
    </div>
    <div style="border:1px solid #ddd;border-top:0;padding:16px;border-radius:0 0 8px 8px">
      <p style="margin:0 0 4px"><b>Customer:</b> ${esc(t.customer.name)}</p>
      <p style="margin:0 0 14px;font-size:18px"><b>Phone:</b> ${esc(t.customer.phone || 'not given')}</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><th style="text-align:left;padding:8px;border-bottom:2px solid #111">Qty</th>
            <th style="text-align:left;padding:8px;border-bottom:2px solid #111">Item</th></tr>
        ${rows}
      </table>
      <p style="margin:12px 0 0">Items: <b>${totalQty}</b></p>
      ${t.note ? `<p style="background:#fff7d6;padding:8px;border-radius:6px"><b>Note:</b> ${esc(t.note)}</p>` : ''}
      <p style="background:#111;color:#fff;text-align:center;padding:10px;font-weight:bold;border-radius:6px;margin-top:16px">PAY AT PICKUP</p>
    </div>
  </div>`;

  const text = [
    `${store.name} — ${isTest ? 'TEST ' : ''}pickup order #${t.orderNumber}`, when, '',
    `Customer: ${t.customer.name}`, `Phone: ${t.customer.phone || 'not given'}`, '',
    ...t.items.map((i) => `${i.qty}x ${i.name}  (Product #: ${i.sku || '-'})${i.options && i.options.length ? '\n    ' + i.options.join(', ') : ''}`),
    '', `Items: ${totalQty}`, t.note ? `Note: ${t.note}` : '', '', 'PAY AT PICKUP',
  ].filter((l) => l !== null).join('\n');

  return { subject, html, text };
}

// Resolves to { ok, error } — never throws, so an email problem can't block an order.
async function sendTicketEmail(store, ticket) {
  const to = recipients(store);
  if (!to.length) return { ok: true, skipped: true };
  if (!enabled) return { ok: false, error: 'SMTP not configured' };
  try {
    const { subject, html, text } = build(store, ticket);
    await transport.sendMail({ from: EMAIL_FROM, to, subject, html, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendTicketEmail, recipients, enabled, build };
