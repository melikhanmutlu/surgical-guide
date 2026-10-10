/* Tissue layers: each layer is the surface of a Hounsfield range (skin, muscle, fat, contrast vessels, teeth or
   metal, or a custom range), shown in 3D with its own colour, visibility and opacity, next to the bone model used
   for planning. Layers are for looking and for marking (the lesion brush paints on whatever layer is visible);
   the plan itself always uses the bone segmentation of the Anatomy step. */
'use strict';
window.Layers = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus } = St, $ = id => document.getElementById(id);
  const PRESETS = {
    skin: { name: 'Cilt (dış yüzey)', min: -300, max: 3071, color: 0xe2a48c, opacity: 0.22, outer: true },
    muscle: { name: 'Kas ve yumuşak doku', min: 20, max: 100, color: 0xc0504d, opacity: 0.35 },
    fat: { name: 'Yağ', min: -150, max: -30, color: 0xf0d58c, opacity: 0.3 },
    vessel: { name: 'Damar (kontrastlı BT)', min: 180, max: 450, color: 0xb02a5a, opacity: 0.7 },
    teeth: { name: 'Diş ve metal', min: 1500, max: 3071, color: 0xf4f1e6, opacity: 0.9 },
    custom: { name: 'Özel aralık', min: 0, max: 200, color: 0x5a8fd6, opacity: 0.5 },
  };
  let layers = [], seq = 0;
  const pid = L => 'layer_' + L.id;

  // the surface of one HU range on the working grid (every second voxel on large volumes)
  async function build(L) {
    St.setPart(pid(L), null, null);
    const r = S.red; if (!r || !r.hu || !L.on) { render(); return; }
    St.busy(true, `${L.name} katmanı oluşturuluyor…`); await St.sleep();
    try {
      const f = r.nx * r.ny * r.nz > 16e6 ? 2 : 1, nx = Math.ceil(r.nx / f), ny = Math.ceil(r.ny / f), nz = Math.ceil(r.nz / f);
      let m = new Uint8Array(nx * ny * nz);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const h = r.hu[Math.min(r.nx - 1, i * f) + r.nx * (Math.min(r.ny - 1, j * f) + r.ny * Math.min(r.nz - 1, k * f))];
        m[i + nx * (j + ny * k)] = h >= L.min && h <= L.max ? 1 : 0;
      }
      const { labels, comps } = G.components(m, nx, ny, nz, L.outer ? 50 : 20);
      L.empty = !comps.length;
      if (!comps.length) { render(); return; }
      if (L.outer) {
        // the body: largest piece with the airway and every closed cavity filled in
        const top = comps[0].label; for (let v = 0; v < m.length; v++) m[v] = labels[v] === top ? 1 : 0;
        const ext = G.exterior(m, nx, ny, nz); for (let v = 0; v < m.length; v++) m[v] = ext[v] ? 0 : 1;
      } else {
        // drop specks below the minimum size
        const ok = new Set(comps.map(c => c.label)); for (let v = 0; v < m.length; v++) m[v] = ok.has(labels[v]) ? 1 : 0;
      }
      const mat = new THREE.MeshStandardMaterial({ color: L.color, roughness: 0.75, side: THREE.DoubleSide, transparent: true, opacity: 1, depthWrite: false });
      const mesh = St.meshFromNets(G.surfaceNets(G.blur(m, nx, ny, nz), nx, ny, nz), (x, y, z) => G.worldOf(r, x * f, y * f, z * f), mat);
      mesh.renderOrder = 2;
      St.setPart(pid(L), L.name, mesh, L.color);
      opacity(L);
    } finally { St.busy(false); St.renderParts(); St.render(); }
  }
  function opacity(L) {
    const pt = St.parts[pid(L)]; if (!pt) return;
    pt.obj.traverse(c => { if (c.material) { c.material.opacity = L.opacity; c.material.transparent = L.opacity < 1; c.material.depthWrite = L.opacity >= 1; c.material.needsUpdate = true; } });
    pt.opacity = 1; pt.obj.renderOrder = L.opacity < 1 ? 2 : 0;
  }
  function show(id, on) {
    const pt = St.parts[id]; if (!pt) return false;
    pt.visible = on; pt.obj.visible = on; St.renderParts(); St.render(); return true;
  }
  function add(kind, o) {
    const p = PRESETS[kind] || PRESETS.custom;
    const L = Object.assign({ id: ++seq, kind, on: true }, p, o || {});
    layers.push(L); render(); return build(L);
  }
  function remove(L) { layers = layers.filter(x => x !== L); St.setPart(pid(L), null, null); render(); St.renderParts(); St.render(); }

  // ---------- panel ----------
  const hex = c => '#' + c.toString(16).padStart(6, '0');
  function render() {
    const box = $('layerList'); if (!box) return;
    const bone = St.parts.bone, thr = +$('thr').value;
    box.innerHTML = `<li class="lay"><label><input type="checkbox" data-bone ${bone && bone.visible ? 'checked' : ''}><i style="background:${hex(St.COLORS.bone)}"></i>Kemik (planlama modeli)</label>
        <span class="hu"><input type="number" data-bthr value="${thr}" min="120" max="800" step="10" aria-label="Kemik eşiği (HU)"> HU üstü</span></li>` +
      layers.map(L => `<li class="lay"><label><input type="checkbox" data-on="${L.id}" ${L.on ? 'checked' : ''}><i style="background:${hex(L.color)}"></i>${St.esc(L.name)}</label>
        <span class="hu"><input type="number" data-min="${L.id}" value="${L.min}" step="10" aria-label="${St.esc(L.name)} alt HU"> – <input type="number" data-max="${L.id}" value="${L.max}" step="10" aria-label="${St.esc(L.name)} üst HU"> HU</span>
        <input type="range" min="0.05" max="1" step="0.05" value="${L.opacity}" data-op="${L.id}" title="Saydamlık" aria-label="${St.esc(L.name)} saydamlığı">
        <button class="x" data-del="${L.id}" title="Katmanı kaldır" aria-label="${St.esc(L.name)} katmanını kaldır">×</button>
        ${L.empty ? '<small class="hint">Bu aralıkta doku bulunamadı.</small>' : ''}</li>`).join('');
    const byId = id => layers.find(L => L.id === +id);
    box.querySelector('[data-bone]').addEventListener('change', e => { show('bone', e.target.checked); if (St.parts.resected && !S.resRemoved) show('resected', e.target.checked); });
    box.querySelector('[data-bthr]').addEventListener('change', e => { const v = Math.max(120, Math.min(800, Math.round(+e.target.value / 10) * 10)); $('thr').value = v; $('thr').dispatchEvent(new Event('input')); $('thr').dispatchEvent(new Event('change')); });
    box.querySelectorAll('[data-on]').forEach(el => el.addEventListener('change', () => { const L = byId(el.dataset.on); L.on = el.checked; if (!show(pid(L), L.on) && L.on) build(L); }));
    box.querySelectorAll('[data-min],[data-max]').forEach(el => el.addEventListener('change', () => {
      const L = byId(el.dataset.min || el.dataset.max), v = Math.max(-1024, Math.min(3071, +el.value || 0));
      if (el.dataset.min) L.min = v; else L.max = v;
      if (L.min > L.max) [L.min, L.max] = [L.max, L.min];
      L.on = true; build(L).then(render);
    }));
    box.querySelectorAll('[data-op]').forEach(el => el.addEventListener('input', () => { const L = byId(el.dataset.op); L.opacity = +el.value; opacity(L); St.render(); }));
    box.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => remove(byId(el.dataset.del))));
  }
  $('layerBox').innerHTML = `<h3 class="sub">Görüntü katmanları</h3>
    <p class="hint more">Her katman bir HU aralığının yüzeyidir. Kemiği kapatıp yumuşak doku üstünde lezyonu işaretleyebilirsiniz; planlama her zaman kemik modeliyle yapılır.</p>
    <ul class="layers" id="layerList"></ul>
    <div class="btns"><select id="layerKind" aria-label="Eklenecek katman">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name} (${p.min} – ${p.max} HU)</option>`).join('')}</select><button id="layerAdd">Katman ekle</button></div>`;
  $('layerAdd').addEventListener('click', () => {
    const k = $('layerKind').value, have = layers.find(L => L.kind === k && k !== 'custom');
    if (have) { have.on = true; if (!show(pid(have), true)) build(have); render(); return; }
    add(k);
  });

  // new volume: skin on by default; the other layers keep their ranges and are rebuilt if they were on
  bus.addEventListener('volume', async () => {
    if (!layers.length) layers.push(Object.assign({ id: ++seq, kind: 'skin', on: true }, PRESETS.skin));
    for (const L of layers) await build(L);
    render();
  });
  ['parts', 'planApplied'].forEach(t => bus.addEventListener(t, () => { const b = document.querySelector('#layerList [data-bone]'); if (b && St.parts.bone) b.checked = St.parts.bone.visible; }));
  $('thr').addEventListener('change', () => setTimeout(render, 0));

  // layer settings are part of the plan (ranges, colours, visibility; the surfaces are rebuilt on open)
  (window.PlanExt = window.PlanExt || {}).layers = {
    label: 'Katmanlar',
    get: () => layers.map(({ kind, name, min, max, color, opacity: op, on, outer }) => ({ kind, name, min, max, color, opacity: op, on, outer: !!outer })),
    async set(x) {
      if (!Array.isArray(x)) return;
      layers.forEach(L => St.setPart(pid(L), null, null));
      layers = x.slice(0, 12).filter(o => o && typeof o === 'object').map(o => Object.assign({ id: ++seq }, PRESETS[o.kind] || PRESETS.custom, {
        kind: PRESETS[o.kind] ? o.kind : 'custom', name: typeof o.name === 'string' ? o.name.slice(0, 60) : (PRESETS[o.kind] || PRESETS.custom).name,
        min: Math.max(-1024, Math.min(3071, +o.min || 0)), max: Math.max(-1024, Math.min(3071, +o.max || 0)),
        color: Number.isFinite(+o.color) ? +o.color : 0x5a8fd6, opacity: Math.max(0.05, Math.min(1, +o.opacity || 0.5)), on: !!o.on, outer: !!o.outer }));
      for (const L of layers) await build(L);
      render();
    },
  };
  render();
  return { add, list: () => layers, targets: () => layers.map(L => St.parts[pid(L)]).filter(pt => pt && pt.visible).map(pt => pt.obj), PRESETS };
})();
