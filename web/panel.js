// Panel tidy-up layer: folds long explanations behind an "i" toggle, gives buttons a visual tier
// (danger for removal, ghost for helpers) and remembers which optional sections are open.
// It works on markup the step modules render, so it watches both side panels for changes.
(() => {
  const KEY = 'sg.panel.v1';
  let mem = {};
  try { mem = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { mem = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { /* storage blocked */ } };
  const keyOf = t => t.replace(/\s+/g, ' ').trim().replace(/[\d.,]+/g, '#').slice(0, 48);
  let uid = 0;

  // ---------- "i" toggles ----------
  // A `.hint.more` paragraph is explanation, not status. It moves next to its heading (or the control
  // it explains) and stays folded until the "i" beside that heading is pressed.
  function anchorFor(h) {
    if (h.dataset.for) {
      const el = document.getElementById(h.dataset.for);
      const lab = el && (document.querySelector(`label[for="${h.dataset.for}"]`) || (el.closest('label.chk')));
      if (lab) return { at: lab, after: lab.closest('.ctl') || lab, inside: !!lab.closest('.ctl') };
      if (el && el.matches('button')) return { at: el.parentElement, after: el.closest('.btns') || el, btn: el };
    }
    for (let p = h.previousElementSibling; p; p = p.previousElementSibling) {
      // a box whose own heading is hidden inside a collapsible section answers to that section's summary
      if (p.matches('details.sec > .col > h3.sub:first-child')) return { at: p.parentElement.parentElement.querySelector(':scope > summary'), after: p };
      if (p.matches('h3.sub')) return { at: p, after: p };
      if (p.matches('summary')) return { at: p, after: p };
    }
    const par = h.parentElement;
    if (par && par.matches('details')) return { at: par.querySelector(':scope > summary'), after: par.querySelector(':scope > summary') };
    // otherwise the nearest collapsible section's summary carries the "i"; the text stays where it is
    const sec = h.closest('details.sec, details.sub-d, details.sub');
    if (sec) return { at: sec.querySelector(':scope > summary'), after: null };
    return null;
  }
  // hovering the "i" shows the explanation itself, not a generic word
  const tip = (b, ts) => { const t = ts.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join('\n\n'); b.title = t; b.setAttribute('aria-label', 'Açıklama: ' + t); };
  function fold(h) {
    if (h.dataset.folded) return;
    h.dataset.folded = '1';
    const a = anchorFor(h);
    h.id = h.id || 'inf' + (++uid);
    h.classList.add('info-t');
    // a heading that already has an "i" gets no second one; its button opens every text under it
    const prev = a && a.at && [...a.at.children].find(c => c.matches('button.info') && c._ts && c._ts.every(t => t.isConnected));
    if (prev) {
      prev._ts.push(h); prev.setAttribute('aria-controls', prev._ts.map(t => t.id).join(' ')); tip(prev, prev._ts);
      h.classList.toggle('shut', prev.getAttribute('aria-expanded') !== 'true');
      prev._ts[prev._ts.length - 2].after(h);
      return;
    }
    const k = keyOf(h.textContent), open = !!mem['i:' + k];
    h.classList.toggle('shut', !open);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'info'; b.textContent = 'i';
    tip(b, [h]);
    b.setAttribute('aria-controls', h.id); b.setAttribute('aria-expanded', String(open));
    b.dataset.k = k; b._t = h; b._ts = [h];
    if (a && a.btn) { a.btn.after(b); a.after.after(h); b.style.alignSelf = 'center'; }
    else if (a && a.at) {
      // headings keep trailing counters on the right, so the button sits right after the title text
      const tail = a.at.matches('h3.sub, summary') ? [...a.at.children].find(c => !c.matches('.sn, .info')) : null;
      if (tail) a.at.insertBefore(b, tail); else a.at.appendChild(b);
      if (a.after) { if (a.inside) a.after.appendChild(h); else a.after.after(h); }
    } else {
      const row = document.createElement('span');
      row.className = 'info-row'; const lead = document.createElement('span'); lead.textContent = h.textContent.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0];
      row.append(b, lead);
      row.addEventListener('click', e => { if (e.target !== b) b.click(); });
      h.before(row); b._row = row;
    }
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button.info');
    if (!b || !b._t) return;
    e.preventDefault(); e.stopPropagation();   // inside a <summary> the click must not fold the section
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    b._ts.forEach(t => t.classList.toggle('shut', !open));
    const d = b.parentElement.matches('summary') && b.parentElement.parentElement;
    if (open && d && !d.open) d.open = true;
    if (open) mem['i:' + b.dataset.k] = 1; else delete mem['i:' + b.dataset.k];
    save();
  }, true);

  // ---------- button tiers ----------
  const DANGER = /(^|\s)(\S+(ı|i|u|ü|yı|yi|yu|yü|ları|leri) sil|Sil|Kaldır|Onayı geri çek|Geri çek|Düzeltmeleri kaldır|Planı sıfırla)$/;
  const GHOST = /^(Varsayılan(a dön)?|Otomatik değerlere dön|Tahmini noktaya dön|İşaretleri temizle|Temizle|Not ekle|Not|Listeyi yenile|Yeniden hesapla|Örnek veriyle dene|Sentetik deneme|HTML)$/;
  function tier(b) {
    if (b.dataset.tier || b.matches('.primary, .ghost, .danger, .link, .ibtn, .tab, .el, .info, .seg button, .presets button, .hud button, .edge, .cellmode')) return;
    b.dataset.tier = '1';
    const t = b.textContent.replace(/\s+/g, ' ').trim();
    const trash = !!b.querySelector('use[href="#i-trash"]');
    if (trash || DANGER.test(t) || t === '×') b.classList.add('danger');
    if (GHOST.test(t) || t === '×') b.classList.add('ghost');
  }

  // ---------- optional sections remember open/closed ----------
  function sec(d) {
    if (d.dataset.mem || !d.id) return;
    d.dataset.mem = '1';
    if (('s:' + d.id) in mem) d.open = !!mem['s:' + d.id];
    d.addEventListener('toggle', () => { mem['s:' + d.id] = d.open ? 1 : 0; save(); });
  }

  // ---------- short choices as segments ----------
  // A <select data-seg> with two or three options is shown as a segmented control. The select stays
  // in the DOM (hidden) and keeps being the source of truth, so module code reading .value still works.
  const VAL = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  function segify(sel) {
    if (sel.dataset.segd) return;
    sel.dataset.segd = '1';
    const seg = document.createElement('span');
    seg.className = 'seg'; seg.setAttribute('role', 'group');
    const lab = sel.id && document.querySelector(`label[for="${sel.id}"]`);
    if (lab) seg.setAttribute('aria-label', lab.textContent.trim());
    const paint = () => seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === VAL.get.call(sel))));
    const build = () => {
      seg.innerHTML = '';
      [...sel.options].forEach(o => {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.v = o.value; b.textContent = o.dataset.short || o.textContent; b.title = o.textContent;
        b.addEventListener('click', () => {
          if (VAL.get.call(sel) === o.value) return;
          VAL.set.call(sel, o.value); paint();
          sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        seg.appendChild(b);
      });
      paint();
    };
    Object.defineProperty(sel, 'value', { configurable: true, get() { return VAL.get.call(sel); }, set(v) { VAL.set.call(sel, v); paint(); } });
    sel.addEventListener('change', paint);
    new MutationObserver(build).observe(sel, { childList: true });
    sel.hidden = true; sel.after(seg); build();
    sel._seg = seg;
  }

  function sweep(root) {
    root.querySelectorAll('select[data-seg]').forEach(segify);
    root.querySelectorAll('.hint.more').forEach(fold);
    root.querySelectorAll('button').forEach(tier);
    root.querySelectorAll('details.sec, details.sub-d').forEach(sec);
    // a re-render can drop the text an "i" pointed at; drop the orphan button too
    root.querySelectorAll('button.info').forEach(b => { if (b._ts && !b._ts.some(t => t.isConnected)) (b._row || b).remove(); });
  }
  // runs in the observer's microtask, before the browser paints, so folded text never flashes open
  const roots = ['leftPanel', 'rightPanel', 'dlgSet'].map(id => document.getElementById(id)).filter(Boolean);
  const run = () => roots.forEach(sweep);
  const mo = new MutationObserver(run);
  roots.forEach(r => mo.observe(r, { childList: true, subtree: true, characterData: true }));
  run();
  window.Panel = { sweep: run };
})();
