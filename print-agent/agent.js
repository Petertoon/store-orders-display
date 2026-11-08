// Store Orders print agent — runs on the Raspberry Pi at a store's address.
// Polls the server for print jobs and prints them on network receipt printers (port 9100).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');

const cfg = JSON.parse(fs.readFileSync(process.env.AGENT_CONFIG || path.join(__dirname, 'config.json'), 'utf8'));
const SERVER = cfg.server.replace(/\/$/, '');
const POLL_MS = cfg.pollMs || 3000;
const HEALTH_MS = 30000;

const health = {}; // storeId -> { ok, error }

function printerFor(storeId) {
  return cfg.printers.find((p) => p.storeId === storeId);
}

function makePrinter(p) {
  return new ThermalPrinter({
    type: (p.type || 'epson').toLowerCase() === 'star' ? PrinterTypes.STAR : PrinterTypes.EPSON,
    interface: `tcp://${p.ip}:${p.port || 9100}`,
    characterSet: CharacterSet.PC437_USA, // fixes "Encoding not recognized: 'undefined'"
    removeSpecialCharacters: false,
    lineCharacter: '-',
    width: p.width || 48,
    options: { timeout: 5000 },
  });
}

// Plain TCP check, so health doesn't depend on the print library.
function checkPrinter(p) {
  return new Promise((resolve) => {
    const s = net.connect({ host: p.ip, port: p.port || 9100 });
    const done = (ok, error) => { s.destroy(); resolve({ storeId: p.storeId, ok, error: error || null }); };
    s.setTimeout(3000, () => done(false, 'no response'));
    s.on('connect', () => done(true));
    s.on('error', (e) => done(false, e.code || e.message));
  });
}

async function refreshHealth() {
  const results = await Promise.all(cfg.printers.map(checkPrinter));
  results.forEach((r) => {
    const was = health[r.storeId];
    if (!was || was.ok !== r.ok) console.log(`[health] ${r.storeId} printer ${r.ok ? 'ready' : 'DOWN: ' + r.error}`);
    health[r.storeId] = r;
  });
}

// ASCII-only so every printer code page renders it.
const clean = (s) => String(s == null ? '' : s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '');

async function printTicket(job) {
  const p = printerFor(job.store.id);
  if (!p) throw new Error(`no printer configured for store ${job.store.id}`);
  const t = job.ticket;
  const pr = makePrinter(p);
  const when = new Date(t.createdAt).toLocaleString('en-US', {
    timeZone: cfg.timeZone || 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const totalQty = t.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);

  pr.alignCenter();
  pr.bold(true); pr.setTextDoubleHeight(); pr.setTextDoubleWidth();
  pr.println(clean(job.store.name));
  pr.setTextNormal();
  pr.println('PICKUP ORDER');
  pr.setTextDoubleHeight(); pr.setTextDoubleWidth();
  pr.println('#' + clean(t.orderNumber));
  pr.setTextNormal(); pr.bold(false);
  pr.println(when);
  pr.drawLine();

  pr.alignLeft();
  pr.println('Customer: ' + clean(t.customer.name));
  pr.bold(true); pr.setTextDoubleHeight();
  pr.println('Phone: ' + clean(t.customer.phone || 'not given'));
  pr.setTextNormal(); pr.bold(false);
  pr.drawLine();

  pr.tableCustom([
    { text: 'QTY', align: 'LEFT', width: 0.15, bold: true },
    { text: 'ITEM / PRODUCT #', align: 'LEFT', width: 0.85, bold: true },
  ]);
  for (const it of t.items) {
    pr.bold(true); pr.setTextDoubleHeight();
    pr.tableCustom([
      { text: String(it.qty) + 'x', align: 'LEFT', width: 0.15 },
      { text: clean(it.name), align: 'LEFT', width: 0.85 },
    ]);
    pr.setTextNormal(); pr.bold(false);
    pr.tableCustom([
      { text: '', align: 'LEFT', width: 0.15 },
      { text: 'Product #: ' + clean(it.sku || '-'), align: 'LEFT', width: 0.85 },
    ]);
    for (const o of it.options || []) {
      pr.tableCustom([{ text: '', align: 'LEFT', width: 0.15 }, { text: clean(o), align: 'LEFT', width: 0.85 }]);
    }
  }
  pr.drawLine();
  pr.println(`Items: ${totalQty}`);
  if (t.note) { pr.newLine(); pr.bold(true); pr.println('NOTE: ' + clean(t.note)); pr.bold(false); }
  pr.newLine();
  pr.alignCenter(); pr.invert(true); pr.bold(true);
  pr.println('  PAY AT PICKUP  ');
  pr.invert(false); pr.bold(false);
  if (job.attempt > 1) pr.println('(reprint / retry)');
  pr.newLine();
  pr.cut();
  await pr.execute();
}

async function call(pathname, body) {
  const r = await fetch(SERVER + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-id': cfg.agentId, 'x-agent-key': cfg.agentKey },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status}`);
  return r.json();
}

let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const { jobs } = await call('/api/agent/poll', { printers: Object.values(health) });
    for (const job of jobs) {
      try {
        await printTicket(job);
        console.log(`[print] ${job.store.id} order #${job.ticket.orderNumber} OK`);
        await call(`/api/agent/jobs/${job.jobId}/done`, { ok: true });
      } catch (e) {
        console.error(`[print] ${job.store.id} order #${job.ticket.orderNumber} FAILED: ${e.message}`);
        await call(`/api/agent/jobs/${job.jobId}/done`, { ok: false, error: e.message }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[poll]', e.message);
  } finally {
    busy = false;
  }
}

console.log(`Print agent ${cfg.agentId} -> ${SERVER} (${cfg.printers.length} printer(s))`);
refreshHealth().then(poll);
setInterval(refreshHealth, HEALTH_MS);
setInterval(poll, POLL_MS);
