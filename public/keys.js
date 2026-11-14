// Voice typing (🎤) and the on-screen keyboard (⌨) for HomeBoard.
// Both type into whatever text box is in use and fire an "input" event, so the ticket saves as usual.
// A button with data-mic="<id of a text box>" starts voice typing into that box.

const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Android Chrome repeats words in "continuous" mode, so there it listens one sentence at a time.
  const continuous = !/Android/i.test(navigator.userAgent);
  let rec = null, cur = null;
  if (!SR) document.documentElement.classList.add('nomic');

  function write(t) {
    const { el, before, after } = cur;
    t = t.trim();
    if (!t) return;
    const startOfSentence = !before.trim() || /[.!?]\s*$/.test(before) || /\n\s*$/.test(before);
    if (startOfSentence) t = t[0].toUpperCase() + t.slice(1);
    const sp1 = before && !/\s$/.test(before) ? ' ' : '';
    const sp2 = after && !/^\s/.test(after) ? ' ' : '';
    el.value = before + sp1 + t + sp2 + after;
    const pos = (before + sp1 + t).length;
    try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text box with a cursor */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function stop() { if (rec) try { rec.stop(); } catch (e) { /* already stopped */ } }
  function start(el, btn) {
    if (!SR) { toast('Voice typing is not available in this browser. Use Chrome or Edge, or the 🎤 on your phone keyboard.', 'bad'); return; }
    if (cur) { const same = cur.el === el; stop(); if (same) return; }
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = continuous;
    cur = { el, btn, before: el.value.slice(0, s), after: el.value.slice(e) };
    rec = r;
    $$('[data-mic]').forEach((b) => b.classList.toggle('listening', b.dataset.mic === el.id));
    r.onresult = (ev) => {
      if (rec !== r) return;
      let all = '';
      for (let i = 0; i < ev.results.length; i++) all += ev.results[i][0].transcript;
      write(all);
    };
    r.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Allow the microphone for this site to use voice typing', 'bad');
      else if (ev.error === 'no-speech') toast('I didn\'t hear anything. Tap 🎤 and talk.', 'bad');
      else if (ev.error !== 'aborted') toast('Voice typing stopped: ' + ev.error, 'bad');
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null; cur = null;
      $$('[data-mic].listening').forEach((b) => b.classList.remove('listening'));
    };
    try { r.start(); } catch (err) { rec = null; cur = null; toast('Voice typing could not start', 'bad'); }
  }
  // Any 🎤 button on the page.
  document.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-mic]')) e.preventDefault(); }); // keep the box focused
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mic]'); if (!b) return;
    e.preventDefault();
    const el = document.getElementById(b.dataset.mic);
    if (el) { el.focus(); start(el, b); }
  });
  return { start, stop, supported: !!SR, listening: () => !!cur };
})();

const Keys = (() => {
  let on = false;
  try { on = localStorage.getItem('hbKeys') === '1'; } catch (e) { /* storage blocked */ }
  let target = null, shift = false, caps = false, mode = 'abc', repeat = null;
  const isText = (t) => t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && ['text', 'search', 'password', 'tel', ''].includes(t.type || ''))) && !t.readOnly && !t.disabled;
  const box = document.createElement('div');
  box.id = 'osk'; box.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  if (document.body) document.body.appendChild(box);

  const L = {
    abc: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
      ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'], ['?123', '🎤', ',', ' ', '.', '⏎', 'hide']],
    sym: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '$', '&', '*', '(', ')', '"', '%', '/'], ['-', '+', '=', ':', ';', '!', '?', '_', '<', '>'],
      ['ABC', '~', '[', ']', '{', '}', '|', '\\', '⌫'], ['ABC', '🎤', ',', ' ', '.', '⏎', 'hide']],
  };
  const wide = { ' ': 'space', '⏎': 'enter', '⇧': 'mod', '⌫': 'mod', '?123': 'mod', ABC: 'mod', hide: 'mod', '🎤': 'mod' };
  function render() {
    const up = shift || caps;
    box.innerHTML = L[mode].map((row) => `<div class="krow">${row.map((k) => {
      const show = k === ' ' ? 'space' : k === 'hide' ? '⌄' : (up && k.length === 1 ? k.toUpperCase() : k);
      const cls = [wide[k] || '', k === '⇧' && caps ? 'caps' : '', k === '⇧' && shift ? 'on' : '', k === '🎤' && !Voice.supported ? 'off' : ''].join(' ');
      return `<button type="button" class="key ${cls}" data-k="${esc(k)}" ${k === 'hide' ? 'title="Hide keyboard"' : ''}>${esc(show)}</button>`;
    }).join('')}</div>`).join('');
  }
  function insert(s) {
    if (!target || !document.body.contains(target)) return;
    const el = target;
    try {
      const a = el.selectionStart, b = el.selectionEnd;
      el.setRangeText(s, a, b, 'end');
    } catch (e) { el.value += s; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function backspace() {
    if (!target) return;
    const el = target;
    try {
      let a = el.selectionStart, b = el.selectionEnd;
      if (a === b) { if (!a) return; a -= 1; }
      el.setRangeText('', a, b, 'end');
    } catch (e) { el.value = el.value.slice(0, -1); }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function press(k) {
    if (k === '⌫') return backspace();
    if (k === '⇧') { if (shift) { shift = false; caps = !caps; } else if (caps) caps = false; else shift = true; return render(); }
    if (k === '?123') { mode = 'sym'; return render(); }
    if (k === 'ABC') { mode = 'abc'; return render(); }
    if (k === 'hide') { hide(); if (target) target.blur(); return; }
    if (k === '🎤') { if (target) Voice.start(target, null); return; }
    if (k === '⏎') {
      if (!target) return;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      if (target.dispatchEvent(ev) && target.tagName === 'TEXTAREA') insert('\n');
      return;
    }
    let ch = k;
    if ((shift || caps) && k.length === 1) ch = k.toUpperCase();
    insert(ch);
    if (shift) { shift = false; render(); }
    // Capital letter after ". " at the start of a sentence.
    if (k === ' ' && target && /[.!?] $/.test(target.value.slice(0, target.selectionStart)) && !caps) { shift = true; render(); }
  }
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    e.preventDefault(); // keep the text box focused
    b.classList.add('down');
    press(b.dataset.k);
    if (b.dataset.k === '⌫') {
      clearInterval(repeat);
      const t0 = Date.now();
      repeat = setInterval(() => { if (Date.now() - t0 > 450) backspace(); }, 70);
    }
  });
  const up = () => { clearInterval(repeat); $$('.key.down', box).forEach((b) => b.classList.remove('down')); };
  box.addEventListener('pointerup', up); box.addEventListener('pointerleave', up); box.addEventListener('pointercancel', up);
  box.addEventListener('contextmenu', (e) => e.preventDefault());

  function show() {
    if (!box.parentNode) document.body.appendChild(box);
    render(); box.hidden = false;
    document.documentElement.style.setProperty('--oskh', box.offsetHeight + 'px');
    document.documentElement.classList.add('osk-open');
    if (target) setTimeout(() => target.scrollIntoView({ block: 'nearest' }), 30);
  }
  function hide() {
    box.hidden = true;
    document.documentElement.style.setProperty('--oskh', '0px');
    document.documentElement.classList.remove('osk-open');
  }
  // While the on-screen keyboard is on, stop the device's own keyboard from popping up too.
  const quiet = (t) => { if (on && isText(t)) t.setAttribute('inputmode', 'none'); };
  document.addEventListener('pointerdown', (e) => quiet(e.target), true);
  document.addEventListener('focusin', (e) => {
    if (!isText(e.target)) return;
    target = e.target; quiet(target);
    if (on) show();
  });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!isText(document.activeElement) && !box.matches(':hover')) hide();
  }, 120));
  window.addEventListener('resize', () => { if (!box.hidden) document.documentElement.style.setProperty('--oskh', box.offsetHeight + 'px'); });

  function set(v) {
    on = !!v;
    try { localStorage.setItem('hbKeys', on ? '1' : '0'); } catch (e) { /* storage blocked */ }
    $$('input, textarea').forEach((t) => { if (t.getAttribute('inputmode') === 'none') t.removeAttribute('inputmode'); });
    $$('[data-keys]').forEach((b) => b.classList.toggle('on', on));
    if (on) { const t = isText(document.activeElement) ? document.activeElement : target; if (t && document.body.contains(t)) { target = t; quiet(t); t.focus(); show(); } } else hide();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-keys]')) set(!on); });
  document.addEventListener('DOMContentLoaded', () => $$('[data-keys]').forEach((b) => b.classList.toggle('on', on)));
  return { set, isOn: () => on, show, hide, refresh: () => $$('[data-keys]').forEach((b) => b.classList.toggle('on', on)) };
})();
