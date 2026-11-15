// The Lokaalapp logo circle (top left of every screen). Set on the admin page: a picture and a link.
// A page shows it by having <span data-brand></span> where the circle goes.
(function () {
  const css = document.createElement('style');
  css.textContent = `.brandlogo{display:inline-flex;flex:none;width:44px;height:44px;border-radius:50%;overflow:hidden;
    border:2.5px solid #7ac143;background:#111;box-shadow:0 1px 4px rgba(0,0,0,.35);vertical-align:middle;margin-right:8px}
    .brandlogo img{width:100%;height:100%;object-fit:cover;display:block}
    a.brandlogo:active{transform:scale(.94)}
    @media (max-width:600px){.brandlogo{width:38px;height:38px}}`;
  document.head.appendChild(css);
  function put(b) {
    document.querySelectorAll('[data-brand]').forEach((slot) => {
      slot.innerHTML = '';
      if (!b.has_logo) return;
      const el = document.createElement(b.link ? 'a' : 'span');
      el.className = 'brandlogo';
      if (b.link) { el.href = b.link; el.target = '_blank'; el.rel = 'noopener'; }
      el.title = b.title || '';
      const img = document.createElement('img');
      img.src = '/brand-logo?v=' + encodeURIComponent(b.v); img.alt = b.title || 'Logo';
      el.appendChild(img);
      slot.appendChild(el);
    });
  }
  window.Brand = { refresh: () => fetch('/api/brand').then((r) => r.json()).then(put).catch(() => {}) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.Brand.refresh);
  else window.Brand.refresh();
})();
