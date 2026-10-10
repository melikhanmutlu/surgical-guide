/* Fibula guide editing: body parameters (length beyond the segments, width, wrap, wall, clearance) and the guide
   screws (segment, position along it, angle around the fibula axis, drill, sleeve, length). Edits live in the
   fibula plan (fg, fsc), so they are saved, versioned, undoable and reset the fibula approval. */
'use strict';
window.FibGuide = (function () {
  const St = window.Studio; if (!St || !window.Fibula) return null;
  const { S, fmt, bus } = St, $ = id => document.getElementById(id);
  const BODY = [['Lm', 'Uç uzantısı', 3, 20, 0.5, 'mm'], ['W', 'Genişlik', 10, 30, 0.5, 'mm'], ['wrap', 'Sarma derinliği', 0, 15, 0.5, 'mm'], ['wall', 'Duvar kalınlığı', 1.5, 5, 0.1, 'mm'], ['clear', 'Kemik aralığı', 0, 1, 0.05, 'mm']];
  const SCREW = [['off', 'Konum (orta = 0)', -25, 25, 0.5, 'mm'], ['ang', 'Eksen etrafı açı', -40, 40, 1, '°'], ['d', 'Matkap çapı', 1.2, 3.5, 0.1, 'mm'], ['D', 'Kovan dış çapı', 3, 8, 0.1, 'mm'], ['sleeveH', 'Kovan yüksekliği', 0, 12, 0.5, 'mm'], ['len', 'Vida boyu', 6, 30, 1, 'mm']];
  let sel = 0;
  const dec = st => (st < 0.1 ? 2 : st < 1 ? 1 : 0);
  const ctl = (id, t, mn, mx, st, v, un) => `<div class="ctl"><div class="ctl-row"><label for="${id}">${t}</label><output id="${id}O">${fmt(v, dec(st))} ${un}</output></div><input type="range" id="${id}" min="${mn}" max="${mx}" step="${st}" value="${v}"></div>`;

  // write one edit into the plan; the guide is rebuilt when the slider is released
  const P = () => Fibula.plan();
  function setBody(k, v) { const p = P(); p.fg = Object.assign({}, p.fg || {}, { [k]: v }); }
  function screws() { const p = P(), info = Fibula.guideInfo(); if (!p.fsc) p.fsc = info.screws.map(s => Object.assign({}, s)); return p.fsc; }
  function commit() { St.unapprove(P()); Fibula.guideEdited(); render(); }

  function render() {
    const box = $('fgBox'); if (!box) return;
    const info = Fibula.active() ? Fibula.guideInfo() : null;
    if (!info) { box.innerHTML = ''; return; }
    if (box.contains(document.activeElement) && document.activeElement.type === 'range') return;   // do not rebuild under a drag
    const b = Object.assign({}, info.auto, P().fg || {}), list = info.screws; sel = Math.min(sel, list.length - 1);
    const sc = list[sel], R = S.fib.guide && S.fib.guide.result, edited = !!(P().fg || P().fsc);
    box.innerHTML = `<h3 class="sub">Fibula guide'ı</h3>
      ${BODY.map(([k, t, mn, mx, st, un]) => ctl('fg_' + k, t, mn, mx, st, b[k], un)).join('')}
      <p class="hint more">Kesi yuvaları testere payı kadar açılır.</p>
      <div class="ctl"><span class="lbl2">Guide vidaları</span><div class="el-list" id="fgList" role="group" aria-label="Guide vidaları">${list.map((s, i) => `<button class="el ${i === sel ? 'on' : ''}" data-i="${i}" aria-pressed="${i === sel}">Vida ${i + 1}</button>`).join('')}</div></div>
      ${sc ? `<div class="ctl"><label for="fgSeg" class="lbl2">Hangi segment</label><select id="fgSeg">${info.segs.map((g, i) => `<option value="${i}" ${i === sc.seg ? 'selected' : ''}>Segment ${i + 1}${g.barrel ? ' (üst)' : ''}</option>`).join('')}</select></div>
      ${SCREW.map(([k, t, mn, mx, st, un]) => ctl('fs_' + k, t, mn, mx, st, sc[k], un)).join('')}` : ''}
      <div class="btns"><button id="fgAdd" class="ghost"><svg class="i"><use href="#i-plus"/></svg>Vida ekle</button>${list.length > 1 ? '<button id="fgDel" class="sm"><svg class="i"><use href="#i-trash"/></svg>Vidayı sil</button>' : ''}${edited ? '<button id="fgAuto">Otomatik değerlere dön</button>' : ''}</div>`;
    BODY.forEach(([k, , , , st, un]) => wire('fg_' + k, v => setBody(k, v), st, un));
    if (sc) {
      SCREW.forEach(([k, , , , st, un]) => wire('fs_' + k, v => { screws()[sel][k] = v; }, st, un));
      $('fgSeg').addEventListener('change', e => { screws()[sel].seg = +e.target.value; screws()[sel].off = 0; commit(); });
    }
    box.querySelectorAll('#fgList button').forEach(el => el.addEventListener('click', () => { sel = +el.dataset.i; render(); }));
    $('fgAdd').addEventListener('click', () => { const l = screws(), last = l[sel] || l[0]; l.push(Object.assign({}, last, { off: Math.max(-25, Math.min(25, (last.off || 0) + 8)) })); sel = l.length - 1; commit(); });
    if ($('fgDel')) $('fgDel').addEventListener('click', () => { screws().splice(sel, 1); sel = Math.max(0, sel - 1); commit(); });
    if ($('fgAuto')) $('fgAuto').addEventListener('click', () => { P().fg = null; P().fsc = null; sel = 0; commit(); });
  }
  function wire(id, set, st, un) {
    const el = $(id); if (!el) return;
    el.addEventListener('input', () => { set(+el.value); $(id + 'O').textContent = `${fmt(+el.value, dec(st))} ${un}`; });
    el.addEventListener('change', () => { set(+el.value); el.blur(); commit(); });
  }
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(render, 120); };
  ['changed', 'parts', 'planApplied', 'volume', 'fibGuide'].forEach(e => bus.addEventListener(e, later));
  render();
  return { render };
})();
