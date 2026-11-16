// Shopping lists on Mama's To-Do (🛒 button): up to 5 pages the family names (Groceries, Walmart, Clothing…).
// Each page is a checklist: type, talk (🎤) or use the on-screen keyboard to add items; tap the box when it's
// in the cart; "Clear checked items" when done. Other screens update live (the "shopping" message).
const Shopping = (() => {
  let data = null, pageId = null, mode = null; // mode: null | 'rename' | 'new'
  const root = () => $('#slRoot');
  const page = () => (data && data.pages.find((p) => p.id === pageId)) || (data && data.pages[0]) || null;
  const who = (id) => (typeof members !== 'undefined' && members.find((m) => m.id === id)) || null;
  const left = (p) => p.items.filter((i) => !i.done).length;

  function open(id) {
    if (id) pageId = id;
    mode = null;
    const f = openModal(`<div id="slRoot">
      <div class="slhead"><h2>🛒 Shopping lists</h2><button type="button" data-keys title="On-screen keyboard">⌨</button><button type="button" id="slDone">Done</button></div>
      <div class="sltabs" id="slTabs"></div>
      <div class="slbar" id="slBar"></div>
      <div class="sladd"><div class="fld"><input id="slNew" type="text" maxlength="200" placeholder="Add an item…" autocomplete="off" enterkeyhint="enter"><button type="button" class="mic" data-mic="slNew" title="Talk to type">🎤</button></div><button type="button" class="primary" id="slAdd">Add</button></div>
      <div id="slList" class="sllist"><div class="muted">Loading…</div></div>
      <div class="slfoot" id="slFoot"></div></div>`);
    f.closest('.modal').classList.add('slmodal');
    Keys.refresh();
    f.onclick = click;
    $('#slNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    load().then(() => { if (!matchMedia('(pointer: coarse)').matches || Keys.isOn()) $('#slNew').focus(); });
  }

  async function load() {
    try { data = await api('/api/shopping'); } catch (e) { toast(e.message, 'bad'); return; }
    if (!root()) return;
    if (!page()) pageId = null;
    if (!pageId && data.pages[0]) pageId = data.pages[0].id;
    render();
  }

  function render() {
    const p = page(); if (!root() || !p) return;
    const full = data.pages.length >= data.max_pages;
    $('#slTabs').innerHTML = data.pages.map((x) => `<button type="button" class="sltab ${x.id === p.id ? 'on' : ''}" data-page="${x.id}">${esc(x.name)}${left(x) ? `<span class="n">${left(x)}</span>` : ''}</button>`).join('') +
      (full ? '' : '<button type="button" class="sltab addp" data-a="new">+ New page</button>');
    if (mode === 'rename' || mode === 'new') {
      $('#slBar').innerHTML = `<input id="slName" type="text" maxlength="30" placeholder="${mode === 'new' ? 'Name the new page, like Walmart' : 'Page name'}" value="${mode === 'rename' ? esc(p.name) : ''}" autocomplete="off">
        <button type="button" class="primary" data-a="saveName">${mode === 'new' ? 'Create page' : 'Save'}</button><button type="button" data-a="cancelName">Cancel</button>`;
      const n = $('#slName'); n.focus(); n.select();
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } if (e.key === 'Escape') { e.stopPropagation(); mode = null; render(); } });
    } else {
      $('#slBar').innerHTML = `<span class="muted">Page:</span> <b>${esc(p.name)}</b><span style="flex:1"></span>
        <button type="button" class="link" data-a="rename">✏️ Rename</button><button type="button" class="link" data-a="delPage">🗑 Delete page</button>`;
    }
    const todo = p.items.filter((i) => !i.done), got = p.items.filter((i) => i.done);
    const row = (i) => {
      const m = who(i.member_id);
      return `<div class="slitem ${i.done ? 'done' : ''}" data-item="${i.id}"><button type="button" class="slcb" data-a="tick" title="${i.done ? 'Put back on the list' : 'Got it'}">${i.done ? '✓' : ''}</button>
        <span class="t">${esc(i.text)}</span>${m ? `<span class="by" style="--mc:${esc(m.color)}">${esc(m.name)}</span>` : ''}<button type="button" class="x" data-a="del" title="Remove">✕</button></div>`;
    };
    $('#slList').innerHTML = (todo.length ? todo.map(row).join('') : `<div class="muted slempty">${got.length ? 'Everything is in the cart! 🎉' : 'Nothing on this list yet. Add the first item above.'}</div>`) +
      (got.length ? `<div class="slsec">In the cart (${got.length})</div>${got.map(row).join('')}` : '');
    $('#slFoot').innerHTML = got.length ? `<button type="button" data-a="clear">🧹 Clear checked items</button>` : '';
  }

  async function add() {
    const p = page(), el = $('#slNew'), t = el.value.trim();
    if (!p || !t) { el.focus(); return; }
    el.value = '';
    try {
      await api(`/api/shopping/pages/${p.id}/items`, { text: t });
      await load();
    } catch (e) { el.value = t; toast(e.message, 'bad'); }
    el.focus();
  }
  async function saveName() {
    const name = $('#slName').value.trim(); if (!name) { $('#slName').focus(); return; }
    try {
      if (mode === 'new') pageId = (await api('/api/shopping/pages', { name })).id;
      else await api(`/api/shopping/pages/${page().id}`, { name }, 'PUT');
      mode = null; await load(); $('#slNew').focus();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function click(e) {
    const tab = e.target.closest('[data-page]');
    if (tab) { pageId = Number(tab.dataset.page); mode = null; render(); return; }
    if (e.target.closest('#slDone')) { closeModal(); return; }
    if (e.target.closest('#slAdd')) { add(); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, p = page(), item = b.closest('[data-item]'), iid = item && Number(item.dataset.item);
    try {
      if (a === 'tick') {
        const it = p.items.find((i) => i.id === iid);
        it.done = !it.done; render(); // feels instant; the server confirms
        await api('/api/shopping/items/' + iid, { done: it.done }, 'PUT'); await load();
      } else if (a === 'del') {
        p.items = p.items.filter((i) => i.id !== iid); render();
        await api('/api/shopping/items/' + iid, undefined, 'DELETE'); await load();
      } else if (a === 'clear') {
        const r = await api(`/api/shopping/pages/${p.id}/clear`, {});
        toast(`Cleared ${r.removed} item${r.removed === 1 ? '' : 's'}`); await load();
      } else if (a === 'new' || a === 'rename') { mode = a; render(); }
      else if (a === 'cancelName') { mode = null; render(); }
      else if (a === 'saveName') await saveName();
      else if (a === 'delPage') {
        const keep = p.id, n = p.items.length;
        const yes = await ask(`Delete the page "${p.name}"${n ? ` and its ${n} item${n === 1 ? '' : 's'}` : ''}?`, 'Delete page', true);
        if (yes) { await api('/api/shopping/pages/' + keep, undefined, 'DELETE'); pageId = null; toast('Page deleted'); }
        open();
      }
    } catch (err) { toast(err.message, 'bad'); load(); }
  }

  // Another screen changed a list: refresh if it's open here (keeps whatever is being typed).
  function changed() { if (root() && mode === null) load(); }
  return { open, changed };
})();
