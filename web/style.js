// Design-style preview: ?style=f1|f2|f3 (or the switcher in the corner) loads one of the alternative style sheets on top
// of the base design; ?font= (or the second switcher) tries another typeface on top of the chosen style. The choice is remembered per browser. Without it the base design is shown unchanged.
(() => {
  const STY = { f1: 'Ferah · Deniz', f2: 'Ferah · Gök', f3: 'Ferah · Adaçayı' };
  let cur = new URLSearchParams(location.search).get('style');
  try { if (!cur) cur = localStorage.getItem('sg.style'); } catch (e) { /* storage blocked */ }
  const FONTS = { inter: 'Inter', roboto: 'Roboto', source: 'Source Sans', geist: 'Geist' };
  let font = new URLSearchParams(location.search).get('font');
  try { if (!font) font = localStorage.getItem('sg.font'); } catch (e) { /* storage blocked */ }
  const link = document.createElement('link'); link.rel = 'stylesheet'; document.head.appendChild(link);
  function set(s) {
    cur = STY[s] ? s : '';
    if (cur) { document.documentElement.dataset.style = cur; link.href = 'styles/ferah.css'; }
    else { delete document.documentElement.dataset.style; link.removeAttribute('href'); }
    try { localStorage.setItem('sg.style', cur); } catch (e) { /* storage blocked */ }
    bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === cur)));
    fbar.hidden = !cur;
    window.dispatchEvent(new Event('resize'));
  }
  function setFont(f) {
    font = FONTS[f] ? f : '';
    if (font) document.documentElement.dataset.font = font; else delete document.documentElement.dataset.font;
    try { localStorage.setItem('sg.font', font); } catch (e) { /* storage blocked */ }
    fbar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === font)));
  }
  const bar = document.createElement('div');
  bar.className = 'stylebar'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Tasarım stili');
  bar.innerHTML = '<span>Stil</span>' + [['', 'Mevcut'], ...Object.entries(STY)].map(([k, n]) => `<button type="button" data-s="${k}">${n}</button>`).join('');
  bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) set(b.dataset.s); });
  const fbar = document.createElement('div');
  fbar.className = 'stylebar fontbar'; fbar.setAttribute('role', 'group'); fbar.setAttribute('aria-label', 'Yazı tipi');
  fbar.innerHTML = '<span>Font</span>' + [['', 'Stilin kendi'], ...Object.entries(FONTS)].map(([k, n]) => `<button type="button" data-f="${k}">${n}</button>`).join('');
  fbar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setFont(b.dataset.f); });
  const css = document.createElement('style');
  css.textContent = '.stylebar{position:fixed;left:12px;bottom:12px;z-index:80;display:flex;gap:2px;align-items:center;padding:3px;border-radius:999px;background:#111;color:#eee;font:500 12px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.3)}.stylebar span{padding:0 8px;opacity:.7}.stylebar button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px}.stylebar button[aria-pressed=true]{background:#fff;color:#111}.fontbar{bottom:48px}.stylebar[hidden]{display:none}';
  document.head.appendChild(css);
  document.body.append(fbar, bar);
  set(cur); setFont(font);
})();
