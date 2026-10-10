// Design-style preview: ?style=a|b|c (or the switcher in the corner) loads one of the alternative style sheets on top
// of the base design. The choice is remembered per browser. Without it the base design is shown unchanged.
(() => {
  const STY = { a: 'Klinik ferah', b: 'Okuma odası', c: 'Editoryal' };
  let cur = new URLSearchParams(location.search).get('style');
  try { if (!cur) cur = localStorage.getItem('sg.style'); } catch (e) { /* storage blocked */ }
  const link = document.createElement('link'); link.rel = 'stylesheet'; document.head.appendChild(link);
  function set(s) {
    cur = STY[s] ? s : '';
    if (cur) { document.documentElement.dataset.style = cur; link.href = `styles/${{ a: 'a-klinik', b: 'b-okuma', c: 'c-editoryal' }[cur]}.css`; }
    else { delete document.documentElement.dataset.style; link.removeAttribute('href'); }
    try { localStorage.setItem('sg.style', cur); } catch (e) { /* storage blocked */ }
    bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === cur)));
    window.dispatchEvent(new Event('resize'));
  }
  const bar = document.createElement('div');
  bar.className = 'stylebar'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Tasarım stili');
  bar.innerHTML = '<span>Stil</span>' + [['', 'Mevcut'], ...Object.entries(STY)].map(([k, n]) => `<button type="button" data-s="${k}">${k ? k.toUpperCase() + ' · ' : ''}${n}</button>`).join('');
  bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) set(b.dataset.s); });
  const css = document.createElement('style');
  css.textContent = '.stylebar{position:fixed;left:12px;bottom:12px;z-index:80;display:flex;gap:2px;align-items:center;padding:3px;border-radius:999px;background:#111;color:#eee;font:500 12px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.3)}.stylebar span{padding:0 8px;opacity:.7}.stylebar button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px}.stylebar button[aria-pressed=true]{background:#fff;color:#111}';
  document.head.appendChild(css);
  document.body.appendChild(bar);
  set(cur);
})();
