// Papa's Shop on the job ticket: parts & charges (by search, typed charge, USB scanner or paired phone scanner),
// up-charges per phase, totals with tax, payments, the invoice (print / email), the parts list, and the scanner QR.
// Uses the board's globals (cur, isShop, api, run, esc, openModal, ask, toast, ensureSaved…).
const Shop = (() => {
  let parts = [], summary = {}, money = null, settings = { tax_rate: 0 }, pairToken = null, lastTarget, customers = [], qbJob = null, qbState = null;
  const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dollars = (c) => (c / 100).toFixed(2);
  const METHODS = { cash: 'Cash', check: 'Check', card: 'Card', other: 'Other' };
  const pairKey = () => 'hbPair:' + me.account.id;

  // ---------- start-up (shop accounts only) ----------
  async function init() {
    $('#partsBtn').hidden = false; $('#scanBtn').hidden = false; $('#custBtn').hidden = false; $('#qboBtn').hidden = !me.account.qbo_on;
    await Promise.all([loadParts(), loadCustomers(), api('/api/shop/settings').then((s) => { settings = s; }), qboStatus()]).catch(() => {});
    // Back from signing in to QuickBooks.
    const h = /^#qbo=(.*)$/.exec(location.hash);
    if (h) { history.replaceState(null, '', location.pathname); const msg = decodeURIComponent(h[1]); qboDialog(msg === 'connected' ? '' : msg); }
    // This screen's scanner pairing (kept on the screen, so a paired phone keeps working).
    try { pairToken = localStorage.getItem(pairKey()); } catch (e) { /* storage blocked */ }
    if (pairToken) api('/api/shop/pair', { token: pairToken }).then((p) => savePair(p.token)).catch(() => {});
  }
  function savePair(t) { pairToken = t; try { localStorage.setItem(pairKey(), t); } catch (e) { /* storage blocked */ } }
  async function loadParts() { parts = await api('/api/shop/parts'); renderPartsList(); }
  async function loadCustomers() { customers = await api('/api/shop/customers'); renderCustLink(); }
  async function loadSummary() { summary = await api('/api/shop/summary'); }

  // Scans from the paired phone go to the job open on this screen.
  function target(todoId) {
    if (!pairToken || lastTarget === (todoId || null)) return;
    lastTarget = todoId || null;
    api('/api/shop/pair/target', { token: pairToken, todo_id: todoId || null }).catch(() => {});
  }

  // ---------- board card ----------
  function cardMeta(t) {
    const s = summary[t.id];
    if (!s || !s.lines) return '';
    if (s.total_cents > 0 && s.balance_cents <= 0) return `<span class="ok">✓ Paid ${usd(s.total_cents)}</span>`;
    return `<span>💲 ${usd(s.total_cents)}${s.paid_cents ? ` · <b>${usd(s.balance_cents)} due</b>` : ''}</span>`;
  }

  // ---------- the money part of the ticket ----------
  async function loadMoney() {
    if (!isShop || !cur) return;
    if (!cur.id) { money = null; render(); return; }
    const id = cur.id;
    const [m, qj] = await Promise.all([api(`/api/shop/jobs/${id}/money`), api(`/api/qbo/job/${id}`).catch(() => null)]);
    if (!cur || cur.id !== id) return;
    money = m; qbJob = qj; render(); renderCustLink();
  }
  function lineRow(l) {
    return `<div class="line" data-lid="${l.id}">
      <div class="ln"><b>${esc(l.name)}</b><small>${l.barcode ? '#' + esc(l.barcode) + ' · ' : ''}${esc(l.added_by || '')}${l.taxable ? '' : ' · no tax'}</small></div>
      <input class="lq" type="text" inputmode="decimal" value="${l.qty}" aria-label="Quantity" title="Quantity">
      <span class="lx">×</span>
      <input class="lp" type="text" inputmode="decimal" value="${dollars(l.unit_cents)}" aria-label="Price" title="Price each">
      <b class="lt">${usd(l.total_cents)}</b>
      <button type="button" class="uc ${l.upcharge ? 'on' : ''}" title="Tap to switch between original and up-charge">${l.upcharge ? 'Up-charge' : 'Original'}</button>
      <button type="button" class="lr" title="Remove">×</button></div>`;
  }
  // The shop ticket has three columns: left = add parts & charges, middle = the job's lines, right = totals & payments.
  function render() {
    $('.tgrid').classList.toggle('shop3', !!isShop);
    $('#tLeft').hidden = !isShop; $('#moneyBox').hidden = !isShop; $('#moneySide').hidden = !isShop;
    if (!isShop || !cur) return;
    renderLeft();
    // Keep what's being typed in the payment form when it's redrawn.
    const keep = {};
    ['pAmt', 'pNote'].forEach((id) => { if ($('#' + id)) keep[id] = $('#' + id).value; });
    const openPay = $('#payForm') && !$('#payForm').hidden;
    const method = $('#pMethod .on') ? $('#pMethod .on').dataset.m : null;
    const focusId = document.activeElement && document.activeElement.id;
    if (!cur.id) {
      $('#moneyBox').innerHTML = '<h3>Job ticket</h3><p class="muted" style="font-size:14px">Type the job name first, then add parts and charges from the left.</p>';
      $('#moneySide').innerHTML = '<h3>Totals</h3><p class="muted" style="font-size:14px">$0.00</p>';
      return;
    }
    const m = money || { lines: [], payments: [], totals: {} }, t = m.totals;
    const first = m.first_phase !== false;
    const orig = m.lines.filter((l) => !l.upcharge), ups = m.lines.filter((l) => l.upcharge);
    const phases = [...new Set(ups.map((l) => l.phase || ''))];
    $('#moneyBox').innerHTML = `<h3>Job ticket <small>${first ? '· new lines are the original price' : `· ${esc(m.phase || '')}: new lines are up-charges`}</small></h3>
      <div class="lines">${m.lines.length ? (orig.length ? (ups.length ? '<div class="lgh">Original</div>' : '') + orig.map(lineRow).join('') : '')
        + phases.map((p) => `<div class="lgh up">Up-charges${p ? ' · ' + esc(p) : ''}</div>` + ups.filter((l) => (l.phase || '') === p).map(lineRow).join('')).join('')
        : '<p class="muted" style="font-size:14px;margin:6px 0">No parts or charges yet. Scan or tap a part on the left, or add a charge.</p>'}</div>`;
    $('#moneySide').innerHTML = `<h3>Totals</h3>
      <div class="tots">
        ${ups.length ? `<div><span>Original</span><b>${usd(t.original_cents)}</b></div><div class="upt"><span>Up-charges</span><b>${usd(t.upcharge_cents)}</b></div>` : ''}
        <div><span>Subtotal</span><b>${usd(t.subtotal_cents)}</b></div>
        ${t.tax_rate ? `<div><span>Tax (${t.tax_rate}%)</span><b>${usd(t.tax_cents)}</b></div>` : ''}
        <div class="big"><span>Total</span><b>${usd(t.total_cents)}</b></div>
        ${m.payments.map((p) => `<div class="pay" data-pid="${p.id}"><span>Paid · ${METHODS[p.method] || esc(p.method)}${p.note ? ' · ' + esc(p.note) : ''} <small>${new Date(p.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small></span><b>-${usd(p.amount_cents)}</b><button type="button" class="pr" title="Remove payment">×</button></div>`).join('')}
        ${m.lines.length ? `<div class="big ${t.balance_cents <= 0 ? 'paid' : 'due'}"><span>${t.balance_cents <= 0 ? '✓ Paid in full' : 'Balance due'}</span><b>${usd(Math.max(0, t.balance_cents))}</b></div>` : ''}
      </div>
      <div class="payf" id="payForm" hidden>
        <div class="crow"><label>Amount $<input id="pAmt" type="text" inputmode="decimal"></label><label>Note<input id="pNote" type="text" maxlength="120" placeholder="check #, last 4…"></label></div>
        <div class="pick" id="pMethod">${Object.entries(METHODS).map(([k, v], i) => `<button type="button" data-m="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div>
        <div class="crow" style="justify-content:flex-end"><button type="button" id="pCancel">Cancel</button><button type="button" class="primary" id="pAdd">Add payment</button></div>
      </div>
      <div class="invb"><button type="button" id="payBtn" class="primary" style="background:#16a34a" ${m.lines.length ? '' : 'disabled'}>💵 Take payment</button>
        <button type="button" id="sendBtn" ${m.lines.length ? '' : 'disabled'}>📤 Send invoice</button>
        <button type="button" id="invBtn" ${m.lines.length ? '' : 'disabled'}>🧾 View / print invoice</button></div>
      ${qbLine()}`;
    for (const [id, v] of Object.entries(keep)) if ($('#' + id) && v) $('#' + id).value = v;
    if (openPay) $('#payForm').hidden = false;
    if (method) $$('#pMethod button').forEach((x) => x.classList.toggle('on', x.dataset.m === method));
    if (focusId && $('#moneySide #' + focusId)) $('#' + focusId).focus();
  }
  // Left column: scan / search box with quantity, + Charge, and the parts list to tap. Built once per ticket so typing isn't lost.
  function renderLeft() {
    if (!$('#partQ')) {
      $('#tLeft').innerHTML = `<h3>Add to this job</h3>
        <div class="addrow2"><input id="partQ" type="text" placeholder="Scan barcode or type a part" autocomplete="off" title="A USB scanner works here too">
          <input id="partQty" type="text" inputmode="decimal" value="1" title="Quantity" aria-label="Quantity"></div>
        <button type="button" class="bigbtn" id="chargeBtn" title="Labor, fees or anything not in the parts list">+ Charge / labor / up-charge</button>
        <div class="chargef" id="chargeForm" hidden>
          <div class="fld"><input id="cName" type="text" maxlength="160" placeholder="Description, e.g. Labor"><button type="button" class="mic" data-mic="cName" title="Talk to type">🎤</button></div>
          <div class="crow"><label>Qty<input id="cQty" type="text" inputmode="decimal" value="1"></label><label>Price $<input id="cPrice" type="text" inputmode="decimal" placeholder="0.00"></label></div>
          <div class="crow"><label class="check"><input id="cTax" type="checkbox" checked> Taxable</label><span style="flex:1"></span><button type="button" class="primary" id="cAdd">Add</button></div>
        </div>
        <button type="button" class="bigbtn" id="scanPair">📷 Phone scanner</button>
        <h3 style="margin-top:16px">Parts <small id="pcount"></small></h3>
        <div class="plistL" id="plistL"></div>`;
    }
    renderPartsList();
  }
  function renderPartsList() {
    if (!$('#plistL')) return;
    const q = $('#partQ').value.trim().toLowerCase();
    const list = (q ? parts.filter((p) => [p.name, p.part_number, p.barcode].some((x) => (x || '').toLowerCase().includes(q))) : parts).slice(0, 150);
    $('#pcount').textContent = q ? `· ${list.length} match${list.length === 1 ? '' : 'es'}` : parts.length ? `· ${parts.length}` : '';
    $('#plistL').innerHTML = list.map((p) => `<button type="button" data-part="${p.id}"><span>${esc(p.name)}<small>${[p.part_number, p.barcode && '#' + p.barcode].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</small></span><b>${usd(p.price_cents)}</b></button>`).join('')
      || `<p class="muted" style="font-size:14px">${q ? 'No part matches. Press Enter to add it as a new part.' : 'No parts yet. Add them with 🔩 Parts, or scan one to add it.'}</p>`;
  }
  const qtyNow = () => { const v = $('#partQty') ? $('#partQty').value.trim() : '1'; return v || '1'; };
  const resetAdd = () => { $('#partQ').value = ''; $('#partQty').value = '1'; renderPartsList(); $('#partQ').focus(); };

  // ---------- adding parts and charges ----------
  async function add(body) {
    await ensureSaved();
    const r = await api(`/api/shop/jobs/${cur.id}/lines`, body);
    if (r.found === false) return r;
    toast(`${r.line.upcharge ? 'Up-charge' : 'Added'}: ${r.line.name}`);
    await loadMoney();
    return r;
  }
  function matches(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    return parts.filter((p) => [p.name, p.part_number, p.barcode].some((x) => (x || '').toLowerCase().includes(q))).slice(0, 8);
  }
  // Enter in the box (a USB scanner types the barcode and presses Enter): exact barcode / part number, or the only match.
  async function enter() {
    const v = $('#partQ').value.trim(); if (!v) return;
    const list = matches(v);
    const exact = parts.find((p) => (p.barcode && (p.barcode === v || p.barcode === '0' + v || '0' + p.barcode === v)) || (p.part_number && p.part_number.toLowerCase() === v.toLowerCase()));
    let r;
    const qty = qtyNow();
    if (exact) r = await add({ part_id: exact.id, qty });
    else if (list.length === 1) r = await add({ part_id: list[0].id, qty });
    else if (!list.length) r = await add({ code: v, qty });
    else { toast('More than one part matches. Tap the one you want.'); return; }
    if (r && r.found === false) { notFound(v); return; }
    resetAdd();
  }
  // A code that isn't in the parts list: add it as a new part (and to this job).
  function notFound(v) {
    const isCode = /^[0-9A-Za-z-]{4,}$/.test(v) && /\d/.test(v);
    partDialog({ name: isCode ? '' : v, barcode: /^\d{6,}$/.test(v) ? v : '', part_number: isCode && !/^\d{6,}$/.test(v) ? v : '' }, true);
  }

  // ---------- parts list & invoice settings ----------
  function partForm(p) {
    return `<label>Part name</label><input name="name" maxlength="120" value="${esc(p.name || '')}" required>
      <div class="two"><div><label>Part number</label><input name="part_number" maxlength="60" value="${esc(p.part_number || '')}"></div>
        <div><label>Barcode</label><input name="barcode" maxlength="64" value="${esc(p.barcode || '')}" placeholder="scan or type"></div></div>
      <div class="two"><div><label>Price $</label><input name="price" type="text" inputmode="decimal" value="${p.price_cents != null ? dollars(p.price_cents) : ''}" placeholder="0.00" required></div>
        <div><label class="check" style="margin-top:38px"><input type="checkbox" name="taxable" ${p.taxable === false ? '' : 'checked'}> Taxable</label></div></div>`;
  }
  const readPart = (f) => ({ name: f.name.value, part_number: f.part_number.value, barcode: f.barcode.value, price: f.price.value, taxable: f.taxable.checked });
  function partDialog(p, addToJob) {
    const f = openModal(`<h2>${p.id ? 'Edit part' : addToJob ? 'Not in the parts list yet' : 'New part'}</h2>
      ${addToJob ? '<p class="muted" style="margin:0 0 4px;font-size:14px">Fill it in to add it to the parts list and to this job.</p>' : ''}
      ${partForm(p)}
      <div class="actions"><button type="button" onclick="closeModal()">Cancel</button><button class="primary" id="savePart">${addToJob ? 'Save & add to job' : 'Save'}</button></div>`);
    setTimeout(() => (p.name ? f.price : f.name).focus(), 50);
    $('#savePart').onclick = () => run(async () => {
      if (!f.reportValidity()) return;
      const saved = await api('/api/shop/parts' + (p.id ? '/' + p.id : ''), readPart(f), p.id ? 'PUT' : 'POST');
      await loadParts(); closeModal();
      if (addToJob) { await add({ part_id: saved.id, qty: qtyNow() }); if ($('#partQ')) resetAdd(); }
      else { toast('Part saved'); partsDialog(); }
    });
  }
  function partsDialog(q = '') {
    const list = q ? parts.filter((p) => [p.name, p.part_number, p.barcode].some((x) => (x || '').toLowerCase().includes(q.toLowerCase()))) : parts;
    const f = openModal(`<h2>🔩 Parts &amp; prices</h2>
      <div class="addrow"><input id="pq" type="search" placeholder="Search ${parts.length} parts…" value="${esc(q)}"><button type="button" class="primary" id="newPart">+ New part</button></div>
      <div class="plist">${list.slice(0, 300).map((p) => `<div class="prow" data-pid="${p.id}"><div><b>${esc(p.name)}</b><small>${[p.part_number, p.barcode && '#' + p.barcode, !p.taxable && 'no tax'].filter(Boolean).map(esc).join(' · ')}</small></div>
        <b>${usd(p.price_cents)}</b><button type="button" data-edit>Edit</button><button type="button" data-del title="Remove">🗑</button></div>`).join('') || '<p class="muted">No parts yet.</p>'}</div>
      <hr><h3 style="margin:8px 0 0">🧾 Invoice settings</h3>
      <div class="two"><div><label>Sales tax %</label><input id="sTax" type="text" inputmode="decimal" value="${settings.tax_rate || 0}"></div><div></div></div>
      <label>Under the shop name on invoices (address, phone)</label><textarea id="sHead" rows="3" maxlength="500">${esc(settings.invoice_header || '')}</textarea>
      <label>Note at the bottom of invoices</label><textarea id="sFoot" rows="2" maxlength="1000" placeholder="Thank you! Payment due at pickup.">${esc(settings.invoice_footer || '')}</textarea>
      <div class="actions"><button type="button" id="saveSet">Save invoice settings</button><button type="button" class="primary" onclick="closeModal()">Done</button></div>`);
    $('#pq').oninput = () => { const v = $('#pq').value; partsDialog(v); const i = $('#pq'); i.focus(); i.setSelectionRange(v.length, v.length); };
    $('#newPart').onclick = () => partDialog({});
    $('#saveSet').onclick = () => run(async () => {
      await api('/api/shop/settings', { tax_rate: $('#sTax').value, invoice_header: $('#sHead').value, invoice_footer: $('#sFoot').value }, 'PUT');
      settings = await api('/api/shop/settings'); toast('Invoice settings saved'); loadMoney().catch(() => {});
    });
    f.onclick = async (e) => {
      const row = e.target.closest('[data-pid]'); if (!row) return;
      const p = parts.find((x) => x.id === Number(row.dataset.pid));
      if (e.target.closest('[data-edit]')) return partDialog(p);
      if (e.target.closest('[data-del]')) {
        if (!(await ask(`Remove "${p.name}" from the parts list? Jobs that already used it keep it.`, 'Remove', true))) return partsDialog(q);
        run(async () => { await api('/api/shop/parts/' + p.id, undefined, 'DELETE'); await loadParts(); partsDialog(q); });
      }
    };
  }

  // ---------- phone scanner QR ----------
  async function scannerDialog(renew) {
    const p = await api('/api/shop/pair', { token: pairToken, renew: !!renew });
    savePair(p.token); lastTarget = undefined; target(cur && cur.id);
    const f = openModal(`<h2>📷 Phone scanner</h2>
      <p class="muted" style="margin:0 0 10px;font-size:14px">Scan this QR code with a phone's camera. The phone becomes a barcode scanner for <b>this screen</b>:
        open a job here, then scan parts with the phone and they're added to the job.</p>
      <div class="qr">${p.qr_svg}</div>
      <p class="muted" style="font-size:13px;word-break:break-all;text-align:center">${esc(p.url)}</p>
      <div class="actions"><button type="button" id="renewQr" title="Phones paired before stop working">New QR code</button><button type="button" class="primary" onclick="closeModal()">Done</button></div>`);
    $('#renewQr').onclick = async () => { if (await ask('Make a new QR code? Phones paired to this screen stop working until they scan the new one.', 'New QR code')) scannerDialog(true); else scannerDialog(); };
  }

  // ---------- events ----------
  document.addEventListener('input', (e) => { if (e.target.id === 'partQ') renderPartsList(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'partQ' && e.key === 'Enter') { e.preventDefault(); run(enter); }
    if (e.target.id === 'partQ' && e.key === 'Escape') { $('#partQ').value = ''; renderPartsList(); }
    if (e.target.id === 'partQty' && e.key === 'Enter') { e.preventDefault(); $('#partQ').focus(); }
    if (['cName', 'cQty', 'cPrice'].includes(e.target.id) && e.key === 'Enter') { e.preventDefault(); $('#cAdd').click(); }
    if (['pAmt', 'pNote'].includes(e.target.id) && e.key === 'Enter') { e.preventDefault(); $('#pAdd').click(); }
    if (e.target.matches && e.target.matches('.line input') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#moneyBox, #tLeft, #moneySide')) return;
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.part) return run(async () => { await add({ part_id: Number(b.dataset.part), qty: qtyNow() }); resetAdd(); });
    if (b.id === 'scanPair') return run(() => scannerDialog());
    if (b.id === 'chargeBtn') { $('#chargeForm').hidden = !$('#chargeForm').hidden; if (!$('#chargeForm').hidden) $('#cName').focus(); return; }
    if (b.id === 'cAdd') return run(async () => {
      const body = { name: $('#cName').value, qty: $('#cQty').value, price: $('#cPrice').value, taxable: $('#cTax').checked };
      $('#cName').value = ''; $('#cPrice').value = ''; $('#cQty').value = '1'; $('#chargeForm').hidden = true;
      try { await add(body); } catch (err) { $('#cName').value = body.name; $('#cPrice').value = body.price; $('#cQty').value = body.qty; $('#chargeForm').hidden = false; throw err; }
    });
    const line = b.closest('[data-lid]');
    if (line && b.classList.contains('uc')) return run(async () => { await api(`/api/shop/jobs/${cur.id}/lines/${line.dataset.lid}`, { upcharge: !b.classList.contains('on') }, 'PATCH'); await loadMoney(); });
    if (line && b.classList.contains('lr')) return run(async () => { await api(`/api/shop/jobs/${cur.id}/lines/${line.dataset.lid}`, undefined, 'DELETE'); await loadMoney(); });
    if (b.id === 'payBtn') { $('#payForm').hidden = false; $('#pAmt').value = money && money.totals.balance_cents > 0 ? dollars(money.totals.balance_cents) : ''; $('#pAmt').focus(); $('#pAmt').select(); return; }
    if (b.id === 'pCancel') { $('#payForm').hidden = true; return; }
    if (b.dataset.m) { $$('#pMethod button').forEach((x) => x.classList.toggle('on', x === b)); return; }
    if (b.id === 'pAdd') return run(async () => {
      const method = ($('#pMethod .on') || {}).dataset ? $('#pMethod .on').dataset.m : 'cash';
      await api(`/api/shop/jobs/${cur.id}/payments`, { amount: $('#pAmt').value, method, note: $('#pNote').value });
      $('#pAmt').value = ''; $('#pNote').value = ''; $('#payForm').hidden = true;
      toast('Payment added'); await loadMoney();
    });
    const pay = b.closest('[data-pid]');
    if (pay && b.classList.contains('pr')) return (async () => {
      if (!(await ask('Remove this payment?', 'Remove', true))) return;
      run(async () => { await api(`/api/shop/jobs/${cur.id}/payments/${pay.dataset.pid}`, undefined, 'DELETE'); await loadMoney(); });
    })();
    if (b.id === 'invBtn') { window.open('/invoice/' + cur.id, '_blank'); return; }
    if (b.id === 'sendBtn') return run(sendDialog);
    if (b.id === 'qbOpen') return qboDialog();
  });
  // Quantity / price typed on a line: saved when you leave the box.
  document.addEventListener('change', (e) => {
    const line = e.target.closest && e.target.closest('#moneyBox [data-lid]'); if (!line) return;
    const body = e.target.classList.contains('lq') ? { qty: e.target.value } : { price: e.target.value };
    run(async () => { await api(`/api/shop/jobs/${cur.id}/lines/${line.dataset.lid}`, body, 'PATCH'); await loadMoney(); }).then((r) => { if (r === null) loadMoney(); });
  });
  // ---------- QuickBooks status on the job ----------
  function qbLine() {
    if (!qbJob || !qbState || !qbState.enabled || !qbState.configured || qbJob.enabled === false) return '';
    const st = qbJob.state;
    if (!qbJob.connected && st !== 'synced') return `<div class="qbline">📊 QuickBooks isn't connected. ${st === 'not_yet' ? '' : 'This invoice waits and goes when it is. '}<button type="button" id="qbOpen" class="sm" style="padding:3px 9px">QuickBooks…</button></div>`;
    if (st === 'not_yet') return '<div class="qbline">📊 Goes to QuickBooks when the invoice is sent or printed, a payment is added, or the job is finished.</div>';
    if (st === 'waiting') return '<div class="qbline">📊 ⏳ Waiting to go to QuickBooks…</div>';
    if (st === 'error') return `<div class="qbline err">📊 ⚠ QuickBooks: ${esc(qbJob.error)} <button type="button" id="qbOpen" class="sm" style="padding:3px 9px">Details</button></div>`;
    const diff = qbJob.qbo_total_cents != null && qbJob.qbo_total_cents !== qbJob.total_cents;
    return `<div class="qbline ${diff ? 'err' : 'ok'}">📊 ✓ In QuickBooks as invoice #${esc(cur.job_number)}${diff ? ` · QuickBooks shows ${usd(qbJob.qbo_total_cents)} (it figured the sales tax itself: check the tax setting in QuickBooks)` : ''}</div>`;
  }
  async function qboStatus() {
    qbState = await api('/api/qbo/status');
    if (!qbState.enabled) return qbState;
    const w = qbState.waiting.total;
    $('#qboDot').textContent = !qbState.configured || !qbState.connected ? '📊' : qbState.needs_reconnect || qbState.errors.length || qbState.last_sync_error ? '⚠️' : w ? '⏳' : '✅';
    return qbState;
  }
  let qbTimer;
  function qboChanged() {
    clearTimeout(qbTimer);
    qbTimer = setTimeout(async () => {
      await qboStatus().catch(() => {});
      if (cur && cur.id) { qbJob = await api(`/api/qbo/job/${cur.id}`).catch(() => qbJob); render(); }
      if ($('#qbDlg')) qboDialog(null, true);
    }, 300);
  }
  async function qboDialog(message, quiet) {
    const st = await qboStatus();
    let acc = null;
    if (st.connected && !st.needs_reconnect) acc = await api('/api/qbo/accounts').catch((e) => ({ error: e.message }));
    const opt = (list, sel, none) => (none ? `<option value="">${none}</option>` : '') + (list || []).map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    const w = st.waiting;
    const body = !st.configured
      ? `<div class="qbst">QuickBooks isn't set up on the server yet. Add <b>QBO_CLIENT_ID</b> and <b>QBO_CLIENT_SECRET</b> (the same Intuit app as ContractorPOS) in Render → Environment, and add this redirect address in the Intuit app: <b class="mono">${esc(location.origin)}/api/qbo/callback</b></div>`
      : !st.connected
        ? `<p class="muted" style="font-size:14px">Connect this shop's QuickBooks company. Jobs go to QuickBooks as invoices under the customer, and payments as payments on those invoices, so they match your bank deposits in QuickBooks Banking.</p>
           ${w.total ? `<div class="qbst">⏳ <b>${w.jobs} invoice(s)</b> and <b>${w.payments} payment(s)</b> are waiting. They go as soon as QuickBooks is connected.</div>` : ''}
           <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="qbConnect">Connect to QuickBooks</button></div>`
        : `<div class="qbst">Connected to <b>${esc(st.company_name || 'QuickBooks')}</b>${st.connected_env === 'sandbox' ? ' (sandbox: test company)' : ''}<br>
             ${st.needs_reconnect ? '<b style="color:#fca5a5">⚠ The connection expired. Connect again; nothing is lost.</b><br>' : ''}
             Last sync: ${st.last_sync_at ? new Date(st.last_sync_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet'}${st.syncing ? ' · syncing…' : ''}<br>
             ${w.total ? `⏳ Waiting: ${w.jobs} invoice(s), ${w.payments} payment(s)${w.removals ? `, ${w.removals} removal(s)` : ''}` : '✅ Everything is in QuickBooks'}
             ${st.last_sync_error ? `<br><span style="color:#fca5a5">⚠ ${esc(st.last_sync_error)}</span>` : ''}</div>
           ${st.errors.length ? `<div class="qbst" style="color:#fca5a5">${st.errors.map((e) => `Job #${esc(e.job_number)} ${esc(e.title || '')}: ${esc(e.qbo_error)}`).join('<br>')}</div>` : ''}
           ${acc && acc.error ? `<div class="qbst" style="color:#fca5a5">${esc(acc.error)}</div>` : ''}
           ${acc && !acc.error ? `<label>Income account for parts &amp; labor</label><select id="qbInc">${opt(acc.income, st.settings.income_account_id, 'Choose…')}</select>
             <label>Payments go to</label><select id="qbDep">${opt(acc.bank, st.settings.deposit_account_id, 'Undeposited Funds (group them into bank deposits in QuickBooks)')}</select>
             <div class="muted" style="font-size:13px;margin-top:4px">Undeposited Funds is best when several payments go to the bank together; QuickBooks Banking then matches the deposit.</div>` : ''}
           <div class="actions" style="justify-content:space-between"><span>${st.needs_reconnect ? '<button type="button" class="primary" id="qbConnect">Connect again</button>' : ''}
             <button type="button" class="danger" id="qbDisc">Disconnect</button></span>
             <span>${st.errors.length ? '<button type="button" id="qbRetry">Try errors again</button> ' : ''}${acc && !acc.error ? '<button type="button" id="qbSave">Save</button> ' : ''}<button type="button" class="primary" id="qbSync" ${st.needs_reconnect ? 'disabled' : ''}>Sync now</button></span></div>`;
    if (quiet && !$('#qbDlg')) return;
    openModal(`<div id="qbDlg"><h2>📊 QuickBooks</h2>${message ? `<div class="qbst" style="color:#fcd34d">${esc(message)}</div>` : ''}${body}
      <div class="actions"><button type="button" onclick="closeModal()">Close</button></div></div>`);
    const go = (id, fn) => { if ($('#' + id)) $('#' + id).onclick = () => run(fn); };
    go('qbConnect', async () => { const r = await api('/api/qbo/connect'); location.href = r.url; });
    go('qbSync', async () => { $('#qbSync').disabled = true; $('#qbSync').textContent = 'Syncing…'; await api('/api/qbo/sync', {}); await qboDialog(); toast('Sync finished'); });
    go('qbRetry', async () => { await api('/api/qbo/retry', {}); await qboDialog(); });
    go('qbSave', async () => { await api('/api/qbo/settings', { income_account_id: $('#qbInc').value, deposit_account_id: $('#qbDep').value }, 'PUT'); toast('QuickBooks settings saved'); await qboDialog(); });
    go('qbDisc', async () => {
      if (!(await ask('Disconnect QuickBooks? Nothing already in QuickBooks changes. New invoices and payments wait here until you connect again.', 'Disconnect', true))) return qboDialog();
      await api('/api/qbo/disconnect', {}); await qboDialog();
    });
  }

  // ---------- customers ----------
  function renderCustLink() {
    const box = $('#custLink'); if (!box || !isShop || !cur) return;
    const c = cur.customer_id && customers.find((x) => x.id === cur.customer_id);
    if (c) box.innerHTML = `<span>👤 From the customer list: <b>${esc(c.name)}</b>${c.balance_cents > 0 ? ` · owes ${usd(c.balance_cents)} in all` : ''}</span><button type="button" data-cust-open="${c.id}">Open</button><button type="button" id="custUnlink">Unlink</button>`;
    else if ((cur.customer_name || '').trim()) box.innerHTML = `<span class="muted">Not in the customer list yet.</span><button type="button" id="custSave">＋ Save as a customer</button>`;
    else box.innerHTML = '';
  }
  function custMatches(v) {
    v = v.trim().toLowerCase(); if (!v) return [];
    const d = v.replace(/\D/g, '');
    return customers.filter((c) => c.name.toLowerCase().includes(v) || (c.email || '').includes(v) || (d.length >= 3 && (c.phone || '').replace(/\D/g, '').includes(d))).slice(0, 6);
  }
  function pickCustomer(c) {
    $('#custSug').hidden = true;
    const set = [['#tCust', 'customer_name', c.name], ['#tPhone', 'customer_phone', c.phone || ''], ['#tEmail', 'customer_email', c.email || ''], ['#tAddr', 'job_address', c.address || '']];
    for (const [id, k, v] of set) { $(id).value = v; queue(k, v); }
    queue('customer_id', c.id); custLinks(); flush(); renderCustLink();
  }
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'tCust' || !isShop) return;
    const list = custMatches(e.target.value);
    $('#custSug').hidden = !list.length;
    $('#custSug').innerHTML = list.map((c) => `<button type="button" data-cpick="${c.id}"><span>${esc(c.name)}<small>${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</small></span>${c.balance_cents > 0 ? `<b>owes ${usd(c.balance_cents)}</b>` : ''}</button>`).join('');
    // Typing a different name unlinks the customer; the job keeps what's typed.
    if (cur && cur.customer_id) { const c = customers.find((x) => x.id === cur.customer_id); if (c && c.name !== e.target.value) { queue('customer_id', null); } }
    renderCustLink();
  });
  document.addEventListener('click', (e) => {
    const p = e.target.closest('[data-cpick]');
    if (p) return pickCustomer(customers.find((c) => c.id === Number(p.dataset.cpick)));
    if (e.target.id === 'custUnlink') { queue('customer_id', null); flush(); return renderCustLink(); }
    if (e.target.id === 'custSave') return run(async () => {
      await ensureSaved();
      await api('/api/shop/customers', { name: $('#tCust').value, phone: $('#tPhone').value, email: $('#tEmail').value, address: $('#tAddr').value, todo_id: cur.id });
      await loadCustomers(); await refreshTicket(); toast('Saved to the customer list');
    });
    const o = e.target.closest('[data-cust-open]');
    if (o) return customerDialog(Number(o.dataset.custOpen));
    if (!e.target.closest('#custSug') && e.target.id !== 'tCust' && $('#custSug')) $('#custSug').hidden = true;
  });
  function customersDialog(q = '') {
    const list = q ? customers.filter((c) => [c.name, c.phone, c.email].some((x) => (x || '').toLowerCase().includes(q.toLowerCase()))) : customers;
    const owed = customers.reduce((n, c) => n + c.balance_cents, 0);
    openModal(`<h2>👥 Customers</h2>
      <div class="addrow"><input id="cq" type="search" placeholder="Search ${customers.length} customers…" value="${esc(q)}"><button type="button" class="primary" id="newCust">+ New customer</button></div>
      ${owed ? `<div class="muted" style="font-size:14px;margin-top:6px">Owed by all customers: <b style="color:#fbbf24">${usd(owed)}</b></div>` : ''}
      <div class="clist">${list.map((c) => `<div class="crow2" data-cust-open="${c.id}"><div><b>${esc(c.name)}</b><small>${[c.phone, c.email].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</small></div>
        <div style="text-align:right;flex:none"><small>${c.jobs} job${c.jobs === 1 ? '' : 's'}</small>${c.balance_cents > 0 ? `<b style="color:#fbbf24">owes ${usd(c.balance_cents)}</b>` : ''}</div></div>`).join('') || '<p class="muted">No customers yet. They are added here, from a job ("Save as a customer"), or by themselves when an invoice is sent.</p>'}</div>
      <div class="actions"><button type="button" class="primary" onclick="closeModal()">Done</button></div>`);
    $('#cq').oninput = () => { const v = $('#cq').value; customersDialog(v); const i = $('#cq'); i.focus(); i.setSelectionRange(v.length, v.length); };
    $('#newCust').onclick = () => customerDialog(null);
  }
  async function customerDialog(id) {
    const c = id ? await api('/api/shop/customers/' + id) : { name: '', jobs: [] };
    const f = openModal(`<h2>${id ? esc(c.name) : 'New customer'}</h2>
      <label>Name</label><input name="name" maxlength="120" value="${esc(c.name)}" required>
      <div class="two"><div><label>Phone</label><input name="phone" type="tel" maxlength="40" value="${esc(c.phone || '')}"></div>
        <div><label>Email</label><input name="email" type="email" maxlength="200" value="${esc(c.email || '')}"></div></div>
      <label>Address</label><input name="address" maxlength="300" value="${esc(c.address || '')}">
      <label>Notes</label><textarea name="notes" rows="2" maxlength="2000">${esc(c.notes || '')}</textarea>
      ${id ? `<h3 style="margin:14px 0 4px">Jobs</h3><div class="clist" style="max-height:30vh">${c.jobs.map((j) => `<div class="crow2" data-job-open="${j.id}"><div><b>#${esc(j.job_number || j.id)} ${esc(j.title || '')}</b><small>${esc(j.phase || '')} · ${new Date(j.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</small></div>
        <div style="text-align:right;flex:none"><small>${usd(j.total_cents)}</small>${j.balance_cents > 0 && j.total_cents ? `<b style="color:#fbbf24">owes ${usd(j.balance_cents)}</b>` : j.total_cents ? '<small style="color:#86efac">paid</small>' : ''}</div></div>`).join('') || '<p class="muted">No jobs yet.</p>'}</div>` : ''}
      <div class="actions">${id ? '<button type="button" class="danger" id="delCust" style="margin-right:auto">Remove</button><button type="button" id="jobForCust">+ New job</button>' : ''}
        <button type="button" onclick="Shop.customersDialog()">Back</button><button class="primary" id="saveCust">Save</button></div>`);
    $('#saveCust').onclick = () => run(async () => {
      if (!f.reportValidity()) return;
      const body = { name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, notes: f.notes.value };
      await api('/api/shop/customers' + (id ? '/' + id : ''), body, id ? 'PUT' : 'POST');
      await loadCustomers(); toast('Customer saved'); customersDialog();
    });
    f.onclick = (e) => {
      const j = e.target.closest('[data-job-open]');
      if (j) { closeModal(); openTicket(Number(j.dataset.jobOpen)); }
    };
    if (id) {
      $('#delCust').onclick = async () => {
        if (!(await ask(`Remove ${c.name} from the customer list? Their jobs stay, with the name and phone typed on them.`, 'Remove', true))) return customerDialog(id);
        run(async () => { await api('/api/shop/customers/' + id, undefined, 'DELETE'); await loadCustomers(); customersDialog(); });
      };
      $('#jobForCust').onclick = () => {
        closeModal(); newTicket(firstCol().id);
        pickCustomer(customers.find((x) => x.id === id) || c);
        setTimeout(() => $('#tTitle').focus(), 80);
      };
    }
  }

  // ---------- sending the invoice: WhatsApp, text, email, print ----------
  const waNumber = (raw) => { let d = String(raw || '').replace(/\D/g, ''); if (d.length === 10) d = '1' + d; return d; };
  async function sendDialog() {
    await ensureSaved(); await flush();
    const s = await api(`/api/shop/jobs/${cur.id}/share`, {});
    const id = cur.id;
    const mark = (how, to) => api(`/api/shop/jobs/${id}/sent`, { how, to }).then(() => refreshTicket()).catch(() => {});
    const f = openModal(`<h2>📤 Send invoice #${esc(cur.job_number || cur.id)}</h2>
      <label>Message</label><textarea name="msg" rows="4">${esc(s.message)}</textarea>
      <div class="muted" style="font-size:13px;margin-top:4px">The link opens the invoice for the customer (no sign-in). Print or save it as a PDF from there too.</div>
      <div class="two"><div><label>Phone (WhatsApp / text)</label><input name="phone" type="tel" value="${esc(s.phone)}" placeholder="(325) 555-1234"></div>
        <div><label>Email</label><input name="email" type="email" value="${esc(s.email)}" placeholder="customer@email.com"></div></div>
      <div class="sendgrid">
        <button type="button" class="wa" data-how="whatsapp">🟢 WhatsApp</button><button type="button" data-how="text">💬 Text</button>
        <button type="button" data-how="email">✉ Email</button><button type="button" data-how="print">🖨 Print</button></div>
      <div class="actions"><button type="button" onclick="closeModal()">Done</button></div>`);
    f.onclick = (e) => {
      const b = e.target.closest('[data-how]'); if (!b) return;
      const msg = f.msg.value, phone = f.phone.value.trim(), mail = f.email.value.trim();
      if (b.dataset.how === 'whatsapp') {
        window.open(`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
        mark('whatsapp', phone); toast('WhatsApp opened');
      } else if (b.dataset.how === 'text') {
        if (!phone) return toast('Type the phone number first', 'bad');
        location.href = `sms:${phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(msg)}`;
        mark('text', phone);
      } else if (b.dataset.how === 'email') {
        if (!mail) return toast('Type the email address first', 'bad');
        if (s.email_ready) {
          run(async () => { b.disabled = true; try { await api(`/api/shop/jobs/${id}/email-invoice`, { to: mail }); toast('Invoice emailed'); refreshTicket(); } finally { b.disabled = false; } });
        } else {
          // No email set up on the server: open the computer's or phone's email app instead.
          location.href = `mailto:${encodeURIComponent(mail)}?subject=${encodeURIComponent(`Invoice #${cur.job_number || id}`)}&body=${encodeURIComponent(msg)}`;
          mark('mailapp', mail);
        }
      } else if (b.dataset.how === 'print') {
        window.open('/invoice/' + id, '_blank'); mark('print');
      }
    };
  }
  return { init, loadParts, loadCustomers, loadSummary, loadMoney, render, cardMeta, target, partsDialog, scannerDialog,
    customersDialog, qboDialog, qboChanged,
    reset() { money = null; qbJob = null; if ($('#tLeft')) $('#tLeft').innerHTML = ''; } }; // a fresh left column for each job
})();
