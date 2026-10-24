/* Reference guide comparison (malleolar fracture, plan M9): a guide (and a wedge) designed in another program, loaded as
   STL, is laid on this case's bone and compared with the studio's guide.

   - alignment: the reference may or may not come from the same CT, so it is fitted to the bone it seats on: a
     trimmed point-to-surface ICP of its triangles onto the bone piece's distance field (each triangle's centre towards
     the bone surface along the field's gradient; only triangles within REACH mm of the bone whose face turns to it,
     and of those the KEEP share closest to the fitted clearance: the guide's inner face). Several starts (as loaded, and turned ±8° about each axis through its centre);
     the start that ends with the smallest median distance wins. As loaded within 1 mm and 1° = the same CT.
   - seating: the median and 90th percentile of the inner face's distance to the bone after the fit
   - against the studio's guide: the centres' distance and the surface distances (metrics.js) both ways
   - wedge: its angle from its two largest flat faces (area-weighted normal clusters), against the planned angle
   Research prototype, not for clinical use. */
'use strict';
window.RefCmp = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  const FIT = { reach: 6, keep: 0.6, facing: 0.7, maxOff: 1, iters: 30, coarse: 8, sample: 2500, turn: 8 };
  let ref = null, wedgeRef = null, res = null;

  // ---------- STL ----------
  function parseStl(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const n = u.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (u.byteLength === 84 + 50 * n && n > 0) {
      const P = new Float32Array(9 * n);
      for (let t = 0, o = 84; t < n; t++, o += 50) for (let k = 0; k < 9; k++) P[9 * t + k] = dv.getFloat32(o + 12 + 4 * k, true);
      return P;
    }
    // ASCII
    const txt = new TextDecoder().decode(u), out = [], re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
    while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    if (!out.length || out.length % 9) throw new Error(xl('STL okunamadı.'));
    return Float32Array.from(out);
  }

  // ---------- alignment ----------
  const horn = (a, b, w) => AnkMirror.horn(a, b, w);
  // triangles (centre and normal), a strided share of them
  function sample(P) {
    const n = P.length / 9, step = Math.max(1, Math.floor(n / FIT.sample)), o = [], a = V(), b = V(), c = V();
    for (let t = 0; t < n; t += step) {
      a.set(P[9 * t], P[9 * t + 1], P[9 * t + 2]); b.set(P[9 * t + 3], P[9 * t + 4], P[9 * t + 5]); c.set(P[9 * t + 6], P[9 * t + 7], P[9 * t + 8]);
      const nr = b.clone().sub(a).cross(c.clone().sub(a)); if (!(nr.lengthSq() > 1e-12)) continue;
      o.push({ x: a.clone().add(b).add(c).multiplyScalar(1 / 3), n: nr.normalize() });
    }
    return o;
  }
  const grad = (p, x) => { const e = 0.5; return V(A.sdfAt(p, V(x.x + e, x.y, x.z)) - A.sdfAt(p, V(x.x - e, x.y, x.z)), A.sdfAt(p, V(x.x, x.y + e, x.z)) - A.sdfAt(p, V(x.x, x.y - e, x.z)), A.sdfAt(p, V(x.x, x.y, x.z + e)) - A.sdfAt(p, V(x.x, x.y, x.z - e))); };
  // the distances of the kept (closest) vertices under a pose (q, t about nothing: x' = q x + t)
  function fitOnce(pts, p, q0, t0, iters = FIT.iters) {
    // the inner face lies at the guide's own clearance off the bone (unknown, the same all over): each vertex goes to the
    // bone surface offset by that clearance (the kept vertices' median distance, 0 to MAXOFF mm: a guide lifted off the
    // bone and a guide with a wider clearance look alike on a round bone, so a wider gap is read as a lift), so the fit
    // does not pull the guide in;
    // after the first step the kept share is the vertices closest to that offset surface (closest to the bone would
    // drag the clearance down a little every step)
    let q = q0.clone(), t = t0.clone(), med = Infinity, p90 = Infinity, nk = 0, off = 0;
    for (let it = 0; it < iters; it++) {
      const pairs = [];
      for (const { x, n } of pts) {
        const y = x.clone().applyQuaternion(q).add(t), s = A.sdfAt(p, y); if (!isFinite(s) || Math.abs(s) > FIT.reach) continue;
        const g = grad(p, y); if (!(g.lengthSq() > 1e-9) || !isFinite(g.x + g.y + g.z)) continue;
        g.normalize(); if (n.clone().applyQuaternion(q).dot(g) > -FIT.facing) continue;   // only faces turned to the bone
        pairs.push({ a: y, g, s, d: Math.abs(s - (it ? off : 0)) });
      }
      if (pairs.length < 30) return null;
      pairs.sort((u, v) => u.d - v.d); const kept = pairs.slice(0, Math.max(30, Math.floor(FIT.keep * pairs.length)));
      const ss = kept.map(z => z.s).sort((u, v) => u - v); off = Math.max(0, Math.min(FIT.maxOff, ss[Math.floor(ss.length / 2)]));
      kept.forEach(z => { z.b = z.a.clone().addScaledVector(z.g, -(z.s - off)); z.e = Math.abs(z.s - off); });
      const es = kept.map(z => z.e).sort((u, v) => u - v);
      med = es[Math.floor(es.length / 2)]; p90 = es[Math.floor(0.9 * es.length)]; nk = kept.length;
      const h = horn(kept.map(z => z.a), kept.map(z => z.b), kept.map(() => 1));
      q = h.q.clone().multiply(q); t = t.clone().applyQuaternion(h.q).add(h.t);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(h.q.w))) * 180 / Math.PI;
      if (h.t.length() < 0.005 && ang < 0.01) break;
    }
    return { q, t, med, p90, n: nk, off };
  }
  // the bone piece the reference seats on: the one most of its vertices lie near
  function seatPiece(pts) {
    let best = null, bn = 0;
    A.pieces().filter(p => p.role !== 'out').forEach(p => { let n = 0; pts.forEach(({ x }) => { const s = A.sdfAt(p, x); if (isFinite(s) && Math.abs(s) < FIT.reach) n++; }); if (n > bn) { bn = n; best = p; } });
    return best;
  }
  function align(P, piece) {
    const pts = sample(P), c = pts.reduce((a, b) => a.add(b.x), V()).multiplyScalar(1 / pts.length);
    const p = piece || seatPiece(pts); if (!p) return { why: 'Referans guide hiçbir kemiğe yakın değil; aynı BT\'den olmayabilir.' };
    const starts = [new T.Quaternion()];
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(ax => [-1, 1].forEach(sg => starts.push(new T.Quaternion().setFromAxisAngle(V(...ax), sg * FIT.turn * Math.PI / 180))));
    // every start a few steps, the best one to the end
    let best = null;
    starts.forEach(q0 => {
      // turned about the reference's centre: x' = q0 (x - c) + c
      const t0 = c.clone().sub(c.clone().applyQuaternion(q0)), r = fitOnce(pts, p, q0, t0, FIT.coarse);
      if (r && (!best || r.med < best.med)) best = r;
    });
    if (best) best = fitOnce(pts, p, best.q, best.t) || best;
    if (!best) return { why: 'Referans guide kemiğe hizalanamadı.' };
    const ang = 2 * Math.acos(Math.min(1, Math.abs(best.q.w))) * 180 / Math.PI, move = c.clone().applyQuaternion(best.q).add(best.t).sub(c).length();
    return { piece: p, q: best.q, t: best.t, med: best.med, p90: best.p90, off: best.off, n: best.n, angle: ang, move, same: ang < 1 && move < 1 };
  }

  // ---------- comparison with the studio's guide ----------
  function compare(P, a) {
    const g = window.AnkGuide && AnkGuide.ready() ? AnkGuide.parts() : null; if (!g || !window.Metrics) return null;
    const gp = g.guide.geometry, Q = gp.attributes.position.array, mine = { positions: Q, indices: gp.index ? gp.index.array : null };
    const moved = new Float32Array(P.length), x = V();
    for (let i = 0; i < P.length; i += 3) { x.set(P[i], P[i + 1], P[i + 2]).applyQuaternion(a.q).add(a.t); moved[i] = x.x; moved[i + 1] = x.y; moved[i + 2] = x.z; }
    const idx = Uint32Array.from({ length: moved.length / 3 }, (_, i) => i), other = { positions: moved, indices: idx };
    const cm = arr => { const c = [0, 0, 0]; for (let i = 0; i < arr.length; i += 3) { c[0] += arr[i]; c[1] += arr[i + 1]; c[2] += arr[i + 2]; } return c.map(v => v / (arr.length / 3)); };
    const c1 = cm(moved), c2 = cm(Q), sameBone = g.piece === a.piece;
    const st = Math.max(1, Math.round(moved.length / 3 / 3000));
    return { centre: Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]), refToMine: Metrics.surfaceDistance(other, mine, { step: st }), mineToRef: Metrics.surfaceDistance(mine, other, { step: Math.max(1, Math.round(Q.length / 3 / 3000)) }), sameBone };
  }
  // ---------- wedge angle from its two largest flat faces ----------
  function wedgeAngleOf(P) {
    const cl = [], a = V(), b = V(), c = V();
    for (let t = 0; t < P.length; t += 9) {
      a.set(P[t], P[t + 1], P[t + 2]); b.set(P[t + 3], P[t + 4], P[t + 5]); c.set(P[t + 6], P[t + 7], P[t + 8]);
      const n = b.clone().sub(a).cross(c.clone().sub(a)), ar = n.length() / 2; if (!(ar > 0)) continue; n.normalize();
      let k = cl.find(z => z.n.clone().normalize().dot(n) > Math.cos(3 * Math.PI / 180));
      if (!k) cl.push(k = { n: V(), w: 0 }); k.n.addScaledVector(n, ar); k.w += ar;
    }
    cl.sort((u, v) => v.w - u.w); if (cl.length < 2) return null;
    const n1 = cl[0].n.clone().normalize();
    // the second face: the largest one not parallel to the first (a side wall may be large too: take the one closest to
    // facing the other way)
    const cand = cl.slice(1, 6).filter(z => z.n.clone().normalize().dot(n1) < -0.8).sort((u, v) => v.w - u.w)[0];
    if (!cand) return null;
    return 180 - Math.acos(Math.max(-1, Math.min(1, n1.dot(cand.n.clone().normalize())))) * 180 / Math.PI;
  }

  // ---------- run, show ----------
  function run() {
    res = null; if (!ref) { render(); return null; }
    const a = align(ref.P); if (a.why) { res = { why: a.why }; render(); return res; }
    res = { a, cmp: compare(ref.P, a), wedge: wedgeRef ? wedgeAngleOf(wedgeRef.P) : null };
    show(); render(); return res;
  }
  function show() {
    if (!res || !res.a || !on()) { St.setPart('ankRef', null, null); St.render(); return; }
    const P = ref.P, geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(P, 3)); geo.computeVertexNormals();
    const m = new T.Mesh(geo, new T.MeshStandardMaterial({ color: 0x8e6bbf, transparent: true, opacity: 0.55, side: T.DoubleSide }));
    m.quaternion.copy(res.a.q);
    const p = res.a.piece, g = new T.Group(); g.add(m);
    // the reference sits on its piece in the CT position; it follows the piece's planned motion like the studio's guide
    const pv = p.pivot; if (pv) { g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); }
    // (m is placed relative to the piece's centre: x' = q x + t - c inside the pivot)
    m.position.set(res.a.t.x - p.c.x, res.a.t.y - p.c.y, res.a.t.z - p.c.z);
    St.setPart('ankRef', xl('Referans guide'), g, 0x8e6bbf); St.renderParts && St.renderParts(); St.render();
  }
  function load(bytes, name) { ref = { P: parseStl(bytes), name: String(name || 'referans.stl').slice(0, 80) }; return run(); }
  function loadWedge(bytes, name) { wedgeRef = { P: parseStl(bytes), name: String(name || 'kama.stl').slice(0, 80) }; if (res && res.a) res.wedge = wedgeAngleOf(wedgeRef.P); render(); return res; }
  function render() {
    const box = $('ankRef'); if (!box) return;
    if (!on()) { box.innerHTML = ''; return; }
    const a = res && res.a, c = res && res.cmp, gi = window.AnkGuide && AnkGuide.info();
    box.innerHTML = `<p class="hint more">${xl('Başka bir programla hazırlanmış guide\'ın STL\'ini yükleyin: kemiğe hizalanır (aynı BT\'den olmayabilir), oturması ölçülür ve bu guide ile karşılaştırılır.')}</p>
      <div class="btns"><label class="btn">${xl('Referans guide STL')}<input type="file" id="refGuideIn" accept=".stl" hidden></label><label class="btn">${xl('Referans kama STL')}<input type="file" id="refWedgeIn" accept=".stl" hidden></label></div>
      ${res && res.why ? `<p class="hint">${esc(xl(res.why))}</p>` : ''}
      ${a ? `<dl class="kv"><dt>${xl('Kemik')}</dt><dd>${esc(xl(a.piece.name))}</dd>
        <dt>${xl('Hizalama')}</dt><dd>${a.same ? xl('yüklendiği konumda (aynı BT koordinatı)') : `${fmt(a.move, 1)} mm · ${fmt(a.angle, 1)}° ${xl('taşındı')}`}</dd>
        <dt>${xl('Oturma (iç yüz)')}</dt><dd>${xl('boşluk')} ${fmt(a.off, 2)} mm · ${xl('sapma medyanı')} ${fmt(a.med, 2)} · p90 ${fmt(a.p90, 2)} mm</dd>
        ${c ? `<dt>${xl('Bu guide ile')}</dt><dd>${xl('merkezler arası')} ${fmt(c.centre, 1)} mm · ${xl('yüzey uzaklığı ortalaması')} ${fmt(c.refToMine.mean, 1)} mm${c.sameBone ? '' : ` · ${xl('başka kemikte')}`}</dd>` : ''}
        ${res.wedge != null ? `<dt>${xl('Referans kama açısı')}</dt><dd>${fmt(res.wedge, 1)}°${gi && gi.wedge ? ` · ${xl('plan')} ${fmt(gi.wedge.deg, 1)}°` : ''}</dd>` : ''}</dl>` : ''}`;
    const rd = (id, f) => { const el = $(id); if (el) el.addEventListener('change', async e => { const file = e.target.files && e.target.files[0]; if (!file) return; try { f(new Uint8Array(await file.arrayBuffer()), file.name); } catch (err) { St.alertMsg(String(err.message || err)); } }); };
    rd('refGuideIn', load); rd('refWedgeIn', loadWedge);
  }
  ['changed', 'ankPieces'].forEach(ev => bus.addEventListener(ev, () => { if (res && res.a) show(); }));
  bus.addEventListener('caseType', () => { if (!on()) { ref = null; wedgeRef = null; res = null; show(); } render(); });
  bus.addEventListener('volume', () => { ref = null; wedgeRef = null; res = null; show(); render(); });
  render();
  return { parseStl, align, compare, wedgeAngleOf, load, loadWedge, run, result: () => res, FIT };
})();
