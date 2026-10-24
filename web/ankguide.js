/* Ankle cutting guide (malleolar fracture case type): an osteotomy guide on one piece of the ankle (by default the
   tibia), with a saw slot along the planned cut, K-wire sleeves on both sides of the cut, and the wedge that fills an
   opening osteotomy of the chosen angle.

   The guide is placed by a click on the bone: the point and the surface normal there are the guide frame (u along the
   bone's long axis in the surface plane, v = n x u, n the seating normal). The body, the slot and the sleeves are the
   studio's own guide (app.js buildGuide + gkernel.js), run on the piece's signed distance field instead of the whole
   bone mask, in the piece's CT position; the guide follows the piece if the piece is moved.
   The wedge: the bone's cross-section on the cut plane (holes filled), thickness 0 at the hinge (the far cortex, away
   from the guide) growing with tan(angle) towards the guide side.
   Research prototype, not for clinical use: the cut, the angle and the wedge are the surgeon's decisions. */
'use strict';
window.AnkGuide = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  // body and cut defaults (engineering assumptions; the clinical team sets the final values)
  const DEF = { off: 0, tiltA: 0, tiltB: 0, kerf: 0.8, blade: 0.6, deg: 8, L: 40, W: 24, wrap: 6, wall: 3, pinD: 2.0, pinDu: 11 };
  const LIM = { off: [-25, 25], tiltA: [-30, 30], tiltB: [-30, 30], kerf: [0.4, 2], blade: [0.3, 1.5], deg: [0, 20], L: [24, 60], W: [16, 40], wrap: [2, 12], wall: [2, 4.5], pinD: [1.2, 3.2], pinDu: [6, 20] };
  // material presets (plan M6.6; typical starting values, the manufacturer validates them): bone clearance, slot
  // tolerance over the blade, thinnest wall, drill-hole fit; "unset" until the team chooses the process. A metal sleeve
  // (sleeve: 'metal') is pressed into the printed hole: the hole is the sleeve's outer diameter (drill + 2 x SLEEVE_WALL)
  const MAT = {
    unset: { name: 'Belirsiz (seçilmedi)', clear: 0.3, slotTol: 0.2, minWall: 2.5, fit: 0.1 },
    sla: { name: 'SLA reçine (biyouyumlu)', clear: 0.2, slotTol: 0.2, minWall: 2.0, fit: 0.1 },
    polyjet: { name: 'PolyJet (MED610)', clear: 0.25, slotTol: 0.2, minWall: 2.0, fit: 0.15 },
    pa12: { name: 'SLS PA12', clear: 0.3, slotTol: 0.3, minWall: 2.5, fit: 0.2 },
  };
  // the slot's lip (St.slotDepth): long enough that the blade tilts at most 90 % of the slot play limit in the planned
  // slot, at least the studio's default, at most LIP_MAX mm (a wider slot past that stays critical)
  const LIP_MAX = 8;
  const lipOf = q => { const lim = 0.9 * (St.SLOT_PLAY_MAX || 3) * Math.PI / 180, need = Math.max(0, q.kerf - q.blade) / Math.tan(lim);
    return Math.min(LIP_MAX, Math.max(St.G_DEFAULT.boss || 0, Math.ceil(need * 2) / 2)); };
  const SLEEVES = { printed: 'Basılı delik', metal: 'Metal kovan' }, SLEEVE_WALL = 0.5;
  // a pin or drill hole in the guide: { d: hole, D: sleeve outer } for the drill / wire diameter dr
  const holeOf = (dr, q) => { const m = MAT[q.mat] || MAT.unset, metal = q.sleeve === 'metal'; return { d: (metal ? dr + 2 * SLEEVE_WALL : dr) + m.fit, D: dr + (metal ? 2 * SLEEVE_WALL : 0) + 2.5, metal }; };
  const COL = { guide: 0x3f7fd9, wedge: 0xe0a03a, slot: 0xd9534f };
  // the joint (sample threshold, the clinical team sets it): the saw cut and the K-wires stay JOINT_MIN mm away from the
  // articular surface = the guide bone's surface within JOINT_NEAR mm of the talus (the plafond, the malleolar facets)
  const JOINT = { near: 4, min: 5 };
  let st = null;          // { piece, c, P, n, prm }: the placement (piece-own coordinates) and the settings
  let out = null;         // { key, guide, wedge, info } the last build
  let picking = false, job = null;
  const holders = {};     // part id -> Group that follows the piece's pivot

  const clamp = (k, x) => Math.max(LIM[k][0], Math.min(LIM[k][1], +x));
  const prm = () => (st ? st.prm : Object.assign({ mat: 'unset', sleeve: 'printed' }, DEF));
  const piece = () => (st ? A.pieces().find(p => p.name === st.piece && p.c.distanceTo(V(...st.c)) < 5) || A.pieces().find(p => p.c.distanceTo(V(...st.c)) < 5) || null : null);
  const r3 = q => [q.x, q.y, q.z].map(x => Math.round(x * 1000) / 1000);

  // ---------- geometry ----------
  // the principal axis of a piece's surface vertices (own coordinates), pointing up (+z); z when the piece is not long
  const axes = new WeakMap();
  function boneAxis(p) {
    const g = p.mesh.geometry; let a = axes.get(g); if (a) return a;
    const P = g.attributes.position.array, n = P.length / 3, step = Math.max(1, Math.floor(n / 20000)), c = [0, 0, 0]; let k = 0;
    for (let v = 0; v < n; v += step, k++) for (let j = 0; j < 3; j++) c[j] += P[3 * v + j];
    c.forEach((x, j) => { c[j] = x / k; });
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let v = 0; v < n; v += step) { const d = [P[3 * v] - c[0], P[3 * v + 1] - c[1], P[3 * v + 2] - c[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] += d[i] * d[j]; }
    let e = [0, 0, 1];
    for (let it = 0; it < 60; it++) { const f = [0, 1, 2].map(i => C[3 * i] * e[0] + C[3 * i + 1] * e[1] + C[3 * i + 2] * e[2]), l = Math.hypot(...f) || 1; e = f.map(x => x / l); }
    // a long bone: the first eigenvalue well above the others (else the scan axis); the axis is then refined as the line
    // through the centres of 5 mm slices of its upper 70 % (the shaft: the flared metaphysis and a malleolus pull a plain
    // principal axis off the leg)
    const lam = [0, 1, 2].reduce((s, i) => s + e[i] * (C[3 * i] * e[0] + C[3 * i + 1] * e[1] + C[3 * i + 2] * e[2]), 0), tr = C[0] + C[4] + C[8];
    if (!(lam > 0.6 * tr)) { a = V(0, 0, 1); axes.set(g, a); return a; }
    if (e[2] < 0) e = e.map(x => -x);
    let lo = Infinity, hi = -Infinity; const tt = [];
    for (let v = 0; v < n; v += step) { const t = (P[3 * v] - c[0]) * e[0] + (P[3 * v + 1] - c[1]) * e[1] + (P[3 * v + 2] - c[2]) * e[2]; tt.push([v, t]); if (t < lo) lo = t; if (t > hi) hi = t; }
    const from = lo + 0.3 * (hi - lo), bins = new Map();
    tt.forEach(([v, t]) => { if (t < from) return; const k = Math.floor((t - from) / 5); let b = bins.get(k); if (!b) bins.set(k, b = [0, 0, 0, 0]); b[0] += P[3 * v]; b[1] += P[3 * v + 1]; b[2] += P[3 * v + 2]; b[3]++; });
    const cs = [...bins.values()].filter(b => b[3] >= 10).map(b => [b[0] / b[3], b[1] / b[3], b[2] / b[3]]);
    if (cs.length >= 3) {
      const m = [0, 1, 2].map(j => cs.reduce((s, q) => s + q[j], 0) / cs.length), D = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      cs.forEach(q => { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[3 * i + j] += (q[i] - m[i]) * (q[j] - m[j]); });
      let f = e.slice(); for (let it = 0; it < 60; it++) { const h = [0, 1, 2].map(i => D[3 * i] * f[0] + D[3 * i + 1] * f[1] + D[3 * i + 2] * f[2]), l = Math.hypot(...h) || 1; f = h.map(x => x / l); }
      e = f[0] * e[0] + f[1] * e[1] + f[2] * e[2] < 0 ? f.map(x => -x) : f;
    }
    a = V(...e).multiplyScalar(e[2] < 0 ? -1 : 1).normalize();
    axes.set(g, a); return a;
  }
  function frame() {
    const p = piece(); if (!p || !st) return null;
    const P = V(...st.P), n = V(...st.n).normalize();
    // u: the bone's long axis (principal axis of its surface, plan M6.5) laid into the surface plane; the scan's z axis
    // when the piece has no clear long axis
    const ax = boneAxis(p);
    let u = ax.clone().addScaledVector(n, -ax.dot(n)); if (u.lengthSq() < 0.05) u = V(1, 0, 0).addScaledVector(n, -n.x);
    u.normalize();
    return { p, P, n, u, v: V().crossVectors(n, u).normalize() };
  }
  // the cut: through P + off along u, normal u turned by tiltA about v (towards the guide) and tiltB about n (sideways)
  function cutPlane(f) {
    const q = prm(), d = Math.PI / 180;
    const N = f.u.clone().applyAxisAngle(f.v, q.tiltA * d).applyAxisAngle(f.n, q.tiltB * d).normalize();
    return { p: f.P.clone().addScaledVector(f.u, q.off), N, w: q.kerf, off: q.off };
  }
  // K-wires: one above and one below the cut, on the guide's centre line, straight into the bone (-n)
  function pins(f) {
    const q = prm();
    return [1, -1].map(s => {
      const top = f.P.clone().addScaledVector(f.u, q.off + s * q.pinDu).addScaledVector(f.n, 15), dir = f.n.clone().negate();
      let entry = null;
      for (let t = 0; t <= 45; t += 0.25) { const x = top.clone().addScaledVector(dir, t); if (A.sdfAt(f.p, x) <= 0) { entry = x; break; } }
      const h = holeOf(q.pinD, q); return { entry, dir, side: s, sc: { d: h.d, D: h.D, sleeveH: 8, len: 40 } };
    });
  }
  // the bone's section on the cut plane, holes filled: {fp, nA, R, h, a, b}
  function section(f, pl) {
    const N = pl.N, a = f.n.clone().addScaledVector(N, -f.n.dot(N)).normalize(), b = V().crossVectors(N, a);
    const h = 0.4, R = 45, nA = Math.round(2 * R / h) + 1, fp = new Uint8Array(nA * nA), x = V();
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) {
      x.copy(pl.p).addScaledVector(a, i * h - R).addScaledVector(b, j * h - R);
      if (A.sdfAt(f.p, x) <= 0) fp[i + nA * j] = 1;
    }
    // fill holes: everything not reached from the border through empty cells is inside
    const seen = new Uint8Array(nA * nA), q = [];
    for (let i = 0; i < nA; i++) for (const id of [i, i + nA * (nA - 1), i * nA, i * nA + nA - 1]) if (!fp[id] && !seen[id]) { seen[id] = 1; q.push(id); }
    while (q.length) { const id = q.pop(), i = id % nA, j = (id / nA) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nA || jj >= nA) continue; const k = ii + nA * jj; if (!fp[k] && !seen[k]) { seen[k] = 1; q.push(k); } } }
    let area = 0; for (let k = 0; k < fp.length; k++) if (!seen[k]) { fp[k] = 1; area++; }
    return { fp, nA, R, h, a, b, area: area * h * h };
  }
  // the opening wedge: thickness (s - sHinge) tan(angle) over the section; s along a (towards the guide). Built as a
  // prism on the section's cells: the base exactly on the cut plane, the top exactly on the plane of the angle (its
  // outline smoothed within those planes only, so the angle stays exact, plan M6.7); the edge thinner than WEDGE_MIN mm
  // at the hinge is left out (a wedge cannot end in a knife edge)
  const WEDGE_MIN = 0.3;
  async function wedge(f, pl) {
    const q = prm(); if (!(q.deg > 0)) return null;
    const sec = section(f, pl), { fp, nA, R, h, a, b } = sec;
    let i0 = nA, i1 = -1, j0 = nA, j1 = -1;
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) if (fp[i + nA * j]) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    if (i1 < 0) return null;
    const tn = Math.tan(q.deg * Math.PI / 180), sHinge = (i0 - 0.5) * h, Hmax = (i1 + 0.5 - (i0 - 0.5)) * h * tn;
    const keep = new Uint8Array(nA * nA);
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) if (fp[i + nA * j] && ((i - 0.5) * h - sHinge) * tn >= WEDGE_MIN) keep[i + nA * j] = 1;
    const K = (i, j) => i >= 0 && j >= 0 && i < nA && j < nA && keep[i + nA * j];
    // corners (I, J) between cells: in-plane coordinates s, t (mm, from the section's corner)
    const M = nA + 1, cs = new Float32Array(M * M), ct = new Float32Array(M * M), used = new Uint8Array(M * M), bnd = new Uint8Array(M * M);
    for (let J = 0; J < M; J++) for (let I = 0; I < M; I++) {
      const c = I + M * J, k = [K(I - 1, J - 1), K(I, J - 1), K(I - 1, J), K(I, J)], nk = k.filter(Boolean).length;
      cs[c] = (I - 0.5) * h; ct[c] = (J - 0.5) * h; used[c] = nk > 0; bnd[c] = nk > 0 && nk < 4;
    }
    // the outline smoothed in the plane: each boundary corner moves towards the mean of its boundary neighbours
    for (let it = 0; it < 4; it++) {
      const ns = cs.slice(), nt = ct.slice();
      for (let J = 0; J < M; J++) for (let I = 0; I < M; I++) {
        const c = I + M * J; if (!bnd[c]) continue;
        let sx = 0, sy = 0, n = 0;
        for (const [dI, dJ] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const I2 = I + dI, J2 = J + dJ; if (I2 < 0 || J2 < 0 || I2 >= M || J2 >= M) continue; const c2 = I2 + M * J2; if (!bnd[c2]) continue;
          // only along the outline: the edge between the two corners has a kept cell on one side only
          const e = dI ? [K(Math.min(I, I2), J - 1), K(Math.min(I, I2), J)] : [K(I - 1, Math.min(J, J2)), K(I, Math.min(J, J2))];
          if (e[0] === e[1]) continue; sx += cs[c2]; sy += ct[c2]; n++;
        }
        if (n) { ns[c] = 0.5 * cs[c] + 0.5 * sx / n; nt[c] = 0.5 * ct[c] + 0.5 * sy / n; }
      }
      cs.set(ns); ct.set(nt);
    }
    const pos = [], idx = [], vid = new Int32Array(2 * M * M).fill(-1);
    const vert = (c, top) => {
      const k = c + (top ? M * M : 0); if (vid[k] >= 0) return vid[k];
      const s0 = cs[c] - R, t0 = ct[c] - R, z = top ? Math.max(0, (cs[c] - sHinge) * tn) : 0;
      ['x', 'y', 'z'].forEach(ax => pos.push(pl.p[ax] + a[ax] * s0 + b[ax] * t0 + pl.N[ax] * z));
      return (vid[k] = pos.length / 3 - 1);
    };
    // a quad with the outward direction o (local s, t, z): wound so its normal points along o
    const loc = v => { const x = V(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]).sub(pl.p); return V(x.dot(a), x.dot(b), x.dot(pl.N)); };
    const quad = (v0, v1, v2, v3, o) => {
      const p0 = loc(v0), n = V().subVectors(loc(v1), p0).cross(V().subVectors(loc(v2), p0));
      if (n.dot(o) >= 0) idx.push(v0, v1, v2, v0, v2, v3); else idx.push(v0, v2, v1, v0, v3, v2);
    };
    const C = (I, J) => I + M * J;
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) {
      if (!K(i, j)) continue;
      const c00 = C(i, j), c10 = C(i + 1, j), c11 = C(i + 1, j + 1), c01 = C(i, j + 1);
      quad(vert(c00, 0), vert(c01, 0), vert(c11, 0), vert(c10, 0), V(0, 0, -1));
      quad(vert(c00, 1), vert(c10, 1), vert(c11, 1), vert(c01, 1), V(0, 0, 1));
      if (!K(i + 1, j)) quad(vert(c10, 0), vert(c11, 0), vert(c11, 1), vert(c10, 1), V(1, 0, 0));
      if (!K(i - 1, j)) quad(vert(c00, 0), vert(c01, 0), vert(c01, 1), vert(c00, 1), V(-1, 0, 0));
      if (!K(i, j + 1)) quad(vert(c01, 0), vert(c11, 0), vert(c11, 1), vert(c01, 1), V(0, 1, 0));
      if (!K(i, j - 1)) quad(vert(c00, 0), vert(c10, 0), vert(c10, 1), vert(c00, 1), V(0, -1, 0));
    }
    if (!idx.length) return null;
    const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new T.Mesh(geo, new T.MeshStandardMaterial({ color: COL.wedge, roughness: 0.6, metalness: 0, side: T.DoubleSide, transparent: true, opacity: 0.85 }));
    await St.sleep();
    return { mesh, info: { deg: q.deg, open: Hmax, width: (j1 - j0 + 1) * h, depth: (i1 - i0 + 1) * h, area: sec.area } };
  }

  // ---------- measured back from the built meshes ----------
  // seating (plan M6.4): the guide's inner face (vertices facing the bone within clear + 1 mm of it): how far it lies
  // from the planned clearance, as quantiles of |sdf - clear| (mm)
  function seatFit(p, mesh, clear) {
    const g = mesh.geometry; if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position.array, Nn = g.attributes.normal.array, x = V(), e = 0.5, d = [];
    const step = Math.max(1, Math.floor(P.length / 3 / 30000));
    for (let v = 0; v < P.length / 3; v += step) {
      x.fromArray(P, 3 * v); const s0 = A.sdfAt(p, x); if (!(s0 > -0.5 && s0 < clear + 1)) continue;
      const gr = V(A.sdfAt(p, V(x.x + e, x.y, x.z)) - A.sdfAt(p, V(x.x - e, x.y, x.z)), A.sdfAt(p, V(x.x, x.y + e, x.z)) - A.sdfAt(p, V(x.x, x.y - e, x.z)), A.sdfAt(p, V(x.x, x.y, x.z + e)) - A.sdfAt(p, V(x.x, x.y, x.z - e)));
      if (!(gr.lengthSq() > 1e-9) || !isFinite(gr.x + gr.y + gr.z)) continue;
      if (gr.normalize().dot(V(Nn[3 * v], Nn[3 * v + 1], Nn[3 * v + 2])) > -0.7) continue;
      d.push(Math.abs(s0 - clear));
    }
    if (d.length < 20) return null;
    d.sort((a, b) => a - b); const q = f => d[Math.min(d.length - 1, Math.floor(f * d.length))];
    return { n: d.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  }
  // the wedge's angle measured on its mesh (plan M6.7): the area-weighted normals of its base (facing -N) and of its
  // inclined face (facing N within 45°), the angle between the two planes (degrees)
  function wedgeAngle(mesh, N) {
    const g = mesh.geometry, P = g.attributes.position.array, I = g.index ? g.index.array : null, nt = I ? I.length / 3 : P.length / 9;
    const a = V(), b = V(), c = V(), base = V(), top = V();
    // outward normals: a mesh wound inside out (negative volume) is read flipped
    let vol = 0; for (let t = 0; t < nt; t++) { const ia = I ? I[3 * t] : 3 * t, ib = I ? I[3 * t + 1] : 3 * t + 1, ic = I ? I[3 * t + 2] : 3 * t + 2; a.fromArray(P, 3 * ia); b.fromArray(P, 3 * ib); c.fromArray(P, 3 * ic); vol += a.dot(b.cross(c)); }
    const sg = vol < 0 ? -1 : 1;
    for (let t = 0; t < nt; t++) {
      const ia = I ? I[3 * t] : 3 * t, ib = I ? I[3 * t + 1] : 3 * t + 1, ic = I ? I[3 * t + 2] : 3 * t + 2;
      a.fromArray(P, 3 * ia); b.fromArray(P, 3 * ib); c.fromArray(P, 3 * ic);
      const n = b.sub(a).cross(c.sub(a)), area = n.length(); if (!(area > 0)) continue; // |n| = 2 x area
      const u = n.clone().multiplyScalar(sg / area), k = u.dot(N);
      if (k < -0.97) base.addScaledVector(u, area); else if (k > 0.7) top.addScaledVector(u, area);
    }
    if (base.lengthSq() < 1e-9 || top.lengthSq() < 1e-9) return null;
    return Math.acos(Math.max(-1, Math.min(1, -base.normalize().dot(top.normalize())))) * 180 / Math.PI;
  }

  // ---------- the joint: how far the cut and the wires stay from the articular surface ----------
  // all in the guide bone's own (CT) coordinates; the talus is sampled through both pieces' motions
  function jointPts(f) {
    const tal = A.pieces().find(p => p.role === 'talus' && p !== f.p); if (!tal) return null;
    const P = f.p.mesh.geometry.attributes.position.array, out = [], x = V();
    const step = Math.max(1, Math.floor(P.length / 3 / 40000));
    for (let v = 0; v < P.length / 3; v += step) {
      x.fromArray(P, 3 * v); const d = A.sdfAt(tal, A.toOwn(tal, A.toWorld(f.p, x)));
      if (d < JOINT.near) out.push(x.x, x.y, x.z);
    }
    return { tal, J: new Float32Array(out) };
  }
  const minTo = (J, x) => { let m = Infinity; for (let k = 0; k < J.length; k += 3) { const dx = J[k] - x.x, dy = J[k + 1] - x.y, dz = J[k + 2] - x.z, d = dx * dx + dy * dy + dz * dz; if (d < m) m = d; } return Math.sqrt(m); };
  function joint(f, pl, scs) {
    const jp = jointPts(f); if (!jp || !jp.J.length) return null;
    const { J, tal } = jp, sec = section(f, pl), x = V();
    // the saw: every cell of the bone's section on the cut plane (the blade cuts through the whole section)
    let slot = Infinity;
    for (let j = 0; j < sec.nA; j += 2) for (let i = 0; i < sec.nA; i += 2) {
      if (!sec.fp[i + sec.nA * j]) continue;
      x.copy(pl.p).addScaledVector(sec.a, i * sec.h - sec.R).addScaledVector(sec.b, j * sec.h - sec.R);
      const d = minTo(J, x); if (d < slot) slot = d;
    }
    // a wire: from where it enters the bone to where it leaves the far cortex (the last bone point within 60 mm)
    const pins = scs.map(s => {
      if (!s.entry) return null;
      let last = 0; const y = V();
      for (let t = 0; t <= 60; t += 0.5) { y.copy(s.entry).addScaledVector(s.dir, t); if (A.sdfAt(f.p, y) <= 0) last = t; }
      let d = Infinity, talus = false;
      for (let t = 0; t <= last; t += 0.5) {
        y.copy(s.entry).addScaledVector(s.dir, t); d = Math.min(d, minTo(J, y));
        if (A.sdfAt(tal, A.toOwn(tal, A.toWorld(f.p, y))) <= 0) talus = true;
      }
      return { d, len: last, talus };
    });
    return { slot, pins, n: J.length / 3 };
  }

  // ---------- build ----------
  const keyOf = () => JSON.stringify(st);
  async function make() {
    if (!on()) return;
    const f = frame(); if (!f) { St.alertMsg(xl('Önce guide\'ın oturacağı kemiğe tıklayın.')); return; }
    const me = job = {}, key = keyOf(), q = prm(), pl = cutPlane(f), scs = pins(f);
    const m = MAT[q.mat] || MAT.unset, g = Object.assign({}, St.G_DEFAULT, { L: q.L, W: q.W, wrap: q.wrap, wall: q.wall, uc: q.off, vc: 0, split: 0, rot: 0, roll: 0, bar: 0, stopP: 0, stopT: 0, stopB: 0, wrapU: null, clear: m.clear, fit: 0, blade: q.blade, boss: lipOf(q) });
    const occ = x => { const s = A.sdfAt(f.p, x); return s === Infinity ? 0 : Math.max(0, Math.min(1, 0.5 - s / 0.8)); };
    St.busy(true, xl('Guide oluşturuluyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      const r = await St.buildGuide({ g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [pl], scs, bone: x => A.sdfAt(f.p, x) <= 0, field: occ, h: 0.4 });
      if (me !== job) return;
      const w = await wedge(f, pl);
      if (me !== job) return;
      const pins_ = r.result.screwInfo.map((s, i) => ({ side: scs[i].side, ok: !!s.ok, entry: !!scs[i].entry, inBone: s.inBone || 0, crosses: !!s.crossesPlane }));
      const jt = joint(f, pl, scs);
      out = { key, piece: f.p, guide: r.mesh, wedge: w && w.mesh, prod: null, req: { g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [pl], scs, wrapProfile: r.result.wrapProfile, seatDir: r.result.seatDir, gap: null }, info: { volume: r.result.volume, contact: r.result.contact, undercut: r.result.undercut, seat: r.result.seat, pieces: r.result.pieces, pins: pins_, wedge: w && w.info, joint: jt, fit: seatFit(f.p, r.mesh, g.clear), play: St.slotPlay ? St.slotPlay(q.kerf, q.blade, St.slotDepth(g)) : null } };
      if (w) out.info.wedge.measured = wedgeAngle(w.mesh, pl.N);
      show(); St.emit('changed');
    } catch (e) { St.alertMsg(xl('Guide oluşturulamadı: ') + (e.message || e)); }
    finally { if (me === job) { job = null; St.busy(false); } render(); }
  }
  // the production STL: the same body, slot and sleeves on the server (Manifold, 0.2 mm), on the full-resolution CT of
  // this piece only (the piece's cells of the segmentation, as a field on the reduced grid)
  async function production() {
    if (!ready() || !St.serverGuide) return;
    const me = out, p = out.piece, r = S.red, F = new Float32Array(r.nx * r.ny * r.nz);
    const L = A.labels(); for (let i = 0; i < F.length; i++) if (L[i] === p.label) F[i] = 1;
    St.busy(true, xl('Üretim STL\'i sunucuda hazırlanıyor…'), { f: 0, restart: true });
    try {
      const thr = +($('thr') ? $('thr').value : 300);
      const res = await St.serverGuide(Object.assign({ vol: S.vol, red: r, F, thr }, out.req), null, f => St.busy(true, xl('Üretim STL\'i sunucuda hazırlanıyor…'), { f }));
      if (me !== out) return;
      out.prod = res; St.emit('changed');
      if (!res.productionOk) St.alertMsg(xl('Sunucu üretim STL\'ini basıma uygun bulmadı: ') + (res.issues || []).map(i => i.code).join(', '));
    } catch (e) { St.alertMsg(String(e.message || e)); }
    finally { St.busy(false); render(); }
  }
  function holder(id, label, mesh, color, p) {
    if (!mesh) { St.setPart(id, null, null); delete holders[id]; return; }
    const g = new T.Group(); mesh.position.copy(p.c).negate(); g.add(mesh); g.userData.piece = p; holders[id] = g;
    St.setPart(id, label, g, color); sync();
  }
  function sync() { Object.values(holders).forEach(g => { const pv = g.userData.piece.pivot; g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); g.updateMatrixWorld(true); }); }
  function show() {
    const live = out && out.key === keyOf() && on();
    holder('ankGuide', xl('Guide'), live ? out.guide : null, COL.guide, out && out.piece);
    holder('ankWedge', xl('Kama'), live ? out.wedge : null, COL.wedge, out && out.piece);
    St.renderParts(); St.render();
  }
  function drop() { job = null; out = null; holder('ankGuide', '', null); holder('ankWedge', '', null); St.renderParts && St.renderParts(); }

  // ---------- placing: a click on a piece while "Yerleştir" is on ----------
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = picking && on() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const meshes = A.pieces().filter(p => p.role !== 'out' && p.mesh.parent && p.mesh.parent.visible).map(p => p.mesh);
    const h = St.ray.intersectObjects(meshes, false)[0]; if (!h) return;
    const p = h.object.userData.ankle, nW = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    place(p, A.toOwn(p, h.point), nW.applyQuaternion(p.q.clone().invert()));
    picking = false; render();
  });
  // a placement in the piece's own coordinates; the normal is averaged over the bone around the point (as app.js frameAt)
  function place(p, P, nGuess) {
    let n = nGuess.clone().normalize();
    const e = 1.0, g = V((A.sdfAt(p, V(P.x + e, P.y, P.z)) - A.sdfAt(p, V(P.x - e, P.y, P.z))), (A.sdfAt(p, V(P.x, P.y + e, P.z)) - A.sdfAt(p, V(P.x, P.y - e, P.z))), (A.sdfAt(p, V(P.x, P.y, P.z + e)) - A.sdfAt(p, V(P.x, P.y, P.z - e))));
    if (isFinite(g.length()) && g.length() > 1e-6) n = g.normalize().add(n).normalize();
    st = { piece: p.name, c: r3(p.c), P: r3(P), n: r3(n), prm: Object.assign({ mat: 'unset', sleeve: 'printed' }, st ? st.prm : DEF) };
    changed();
  }
  function changed() { if (out && out.key !== keyOf()) { out = null; show(); } St.emit('changed'); render(); }
  // an automatic placement (plan M6.1) on the tibia in its CT position: candidates on the anterior half of the distal
  // tibia, the cut 25-40 mm over the talar dome (so it stays >= JOINT.min mm from the joint), turned -45..45° about the
  // bone axis from straight anterior; the best seat wins: the share of the guide's footprint that finds bone within
  // the wrap depth under it, less its unevenness (the spread of those depths)
  function suggest() {
    const tib = A.pieces().find(p => p.role === 'tibia'), tal = A.pieces().find(p => p.role === 'talus');
    if (!tib || !tal) return { why: 'Tibia ve talus gerekli.' };
    const LMr = window.AnkLM && AnkLM.result(), ct = LMr && LMr.ct && LMr.ct.ok ? LMr.ct : null;
    // the CT position: the dome and the anterior direction from the joint measures, else from the pieces
    const dome = ct && ct.L.dome ? ct.L.dome.clone() : tal.c.clone(), post = ct ? ct.post.clone() : V(0, 1, 0);
    const ax = boneAxis(tib), q = prm(); let best = { s: -Infinity };
    const tc = tib.c.clone();
    for (const hgt of [25, 30, 35, 40]) for (const ang of [-45, -30, -15, 0, 15, 30, 45]) {
      // the bone's centre at that height, and the ray towards it from in front
      const z = dome.z + hgt, at = tc.clone().addScaledVector(ax, (z - tc.z) / (ax.z || 1));
      const dir = post.clone().addScaledVector(ax, -post.dot(ax)).normalize().applyAxisAngle(ax, ang * Math.PI / 180);
      const start = at.clone().addScaledVector(dir, -60); let P = null;
      for (let t = 0; t < 70; t += 0.25) { const x = start.clone().addScaledVector(dir, t); if (A.sdfAt(tib, x) <= 0) { P = x; break; } }
      if (!P) continue;
      const n = dir.clone().negate(), u = ax.clone().addScaledVector(n, -ax.dot(n)).normalize(), v = V().crossVectors(n, u);
      let hit = 0, tot = 0; const dz = [];
      for (let a = -q.L / 2; a <= q.L / 2; a += 2) for (let b = -q.W / 2; b <= q.W / 2; b += 2) {
        tot++; const top = P.clone().addScaledVector(u, a).addScaledVector(v, b).addScaledVector(n, 3);
        for (let t = 0; t <= q.wrap + 3; t += 0.5) if (A.sdfAt(tib, top.clone().addScaledVector(n, -t)) <= 0) { hit++; dz.push(t); break; }
      }
      if (dz.length < 4) continue;
      const m = dz.reduce((x, y) => x + y, 0) / dz.length, sd = Math.sqrt(dz.reduce((x, y) => x + (y - m) * (y - m), 0) / dz.length);
      const sc = hit / tot - 0.05 * sd - 0.002 * Math.abs(ang);
      if (sc > best.s) best = { s: sc, P, n, hgt, ang, cover: hit / tot, sd };
    }
    if (!best.P) return { why: 'Tibianın ön yüzünde uygun yer bulunamadı.' };
    place(tib, best.P, best.n);
    return { height: best.hgt, angle: best.ang, cover: best.cover, spread: best.sd };
  }

  // ---------- panel ----------
  const SL = [['off', 'Kesi yüksekliği', 'mm', 1], ['tiltA', 'Kesi eğimi (guide yönünde)', '°', 1], ['tiltB', 'Kesi eğimi (yana)', '°', 1], ['deg', 'Kama açısı', '°', 0.5], ['kerf', 'Testere yarığı', 'mm', 0.05], ['blade', 'Testere bıçağı kalınlığı', 'mm', 0.05],
    ['L', 'Guide boyu', 'mm', 1], ['W', 'Guide eni', 'mm', 1], ['wrap', 'Sarma derinliği', 'mm', 0.5], ['wall', 'Duvar', 'mm', 0.5], ['pinD', 'K-teli çapı', 'mm', 0.1], ['pinDu', 'Tel ile kesi arası', 'mm', 1]];
  // a material: its clearance and fit go into the build, the slot to blade + its tolerance, the wall up to its minimum
  function setMat(k) {
    if (!st || !MAT[k]) return; const m = MAT[k], q = st.prm;
    st.prm = Object.assign({}, q, { mat: k, kerf: clamp('kerf', Math.round((q.blade + m.slotTol) * 100) / 100), wall: clamp('wall', Math.max(q.wall, m.minWall)) });
    changed();
  }
  function render() {
    const box = $('ankGuideBox'); if (!box) return;
    const f = frame(), q = prm(), live = out && out.key === keyOf();
    const sl = ([k, lbl, unit, step]) => `<div class="ctl"><div class="ctl-row"><label for="ag_${k}">${xl(lbl)}</label><output id="ag_${k}O">${fmt(q[k], step < 1 ? 1 : 0)} ${unit}</output></div><input type="range" id="ag_${k}" min="${LIM[k][0]}" max="${LIM[k][1]}" step="${step}" value="${q[k]}" ${f ? '' : 'disabled'}></div>`;
    const info = live ? out.info : null, w = info && info.wedge;
    box.innerHTML = `<p class="hint more">${xl('Guide\'ın oturacağı kemiğe (genelde distal tibia) tıklayın; tıklanan nokta guide\'ın merkezi, oradaki yüzey oturma yönüdür. Kesi guide\'ın ortasından geçer; ayarları değiştirip guide\'ı yeniden oluşturun.')}</p>
      <div class="btns"><button id="agPick" aria-pressed="${picking}">${picking ? xl('Kemiğe tıklayın…') : f ? xl('Yeniden yerleştir') : xl('Yerleştir')}</button>
      <button id="agAuto" ${job ? 'disabled' : ''} title="${xl('Distal tibianın ön yüzünde, eklemin 25-40 mm üstünde en iyi oturan yeri seçer.')}">${xl('Otomatik yerleştir')}</button>
      <button class="primary" id="agMake" ${f && !job ? '' : 'disabled'}>${xl('Guide oluştur')}</button>
      <button id="agProd" ${live && !job ? '' : 'disabled'} title="${xl('Aynı guide sunucuda 0,2 mm ızgarada, su geçirmez olarak üretilir.')}">${xl('Üretim STL\'i')}</button></div>
      ${f ? `<p class="hint">${xl('Kemik')}: <b>${esc(f.p.name)}</b></p>` : ''}
      <details class="sec" open><summary>${xl('Kesi ve kama')}</summary><div class="col">${SL.slice(0, 6).map(sl).join('')}</div></details>
      <details class="sec"><summary>${xl('Guide gövdesi ve teller')}</summary><div class="col">${SL.slice(6).map(sl).join('')}</div></details>
      <details class="sec"><summary>${xl('Malzeme ve kovan')}</summary><div class="col">
        <div class="ctl"><div class="ctl-row"><label for="ag_mat">${xl('Baskı malzemesi')}</label></div><select id="ag_mat" ${f ? '' : 'disabled'}>${Object.entries(MAT).map(([k, m]) => `<option value="${k}" ${q.mat === k ? 'selected' : ''}>${xl(m.name)}</option>`).join('')}</select></div>
        <div class="ctl"><div class="ctl-row"><label for="ag_sleeve">${xl('Tel ve matkap delikleri')}</label></div><select id="ag_sleeve" ${f ? '' : 'disabled'}>${Object.entries(SLEEVES).map(([k, m]) => `<option value="${k}" ${q.sleeve === k ? 'selected' : ''}>${xl(m)}</option>`).join('')}</select></div>
        <p class="hint more">${xl('Malzeme kemik boşluğunu, yuva toleransını, en ince duvarı ve delik geçme payını belirler; değerler tipik başlangıçtır, üretici doğrular. Metal kovanda delik kovanın dış çapıdır.')}</p></div></details>
      ${info ? `<dl class="kv"><dt>${xl('Guide hacmi')}</dt><dd>${fmt(info.volume / 1000, 1)} cm³</dd><dt>${xl('Temas alanı')}</dt><dd>${fmt(info.contact, 0)} mm²</dd>
        <dt>${xl('K-telleri')}</dt><dd>${info.pins.map(p => (p.ok ? `${fmt(p.inBone, 0)} mm ${xl('kemikte')}` : xl('yok'))).join(' · ')}</dd>
        <dt>${xl('Eklemden uzaklık')}</dt><dd>${info.joint ? `${xl('kesi')} ${fmt(info.joint.slot, 1)} mm · ${xl('teller')} ${info.joint.pins.map(p => (p ? fmt(p.d, 1) : '–')).join(' / ')} mm` : xl('ölçülemedi')}</dd>
        <dt>${xl('Üretim STL\'i')}</dt><dd>${out.prod ? (out.prod.productionOk ? `${xl('hazır')} · ${fmt(out.prod.volume / 1000, 1)} cm³` : xl('basıma uygun değil')) : xl('alınmadı')}</dd>
        ${w ? `<dt>${xl('Kama')}</dt><dd>${fmt(w.deg, 1)}° · ${xl('açılma')} ${fmt(w.open, 1)} mm · ${fmt(w.depth, 0)} × ${fmt(w.width, 0)} mm${w.measured != null ? ` · ${xl('STL\'de ölçülen')} ${fmt(w.measured, 1)}°` : ''}</dd>` : ''}
        <dt>${xl('Oturma')}</dt><dd>${info.fit ? `${xl('iç yüz')} p50 ${fmt(info.fit.p50, 2)} · p99 ${fmt(info.fit.p99, 2)} mm` : '–'}${info.seat && info.seat.ok ? ` · ${xl('uygun yön')} ${info.seat.free}/${info.seat.dirs.length}` : ''}</dd>
        <dt>${xl('Yuva boşluğu')}</dt><dd>${info.play != null ? `${fmt(info.play, 1)}°` : '–'}</dd>
        <dt>${xl('Malzeme')}</dt><dd>${xl((MAT[q.mat] || MAT.unset).name)} · ${xl(SLEEVES[q.sleeve] || SLEEVES.printed)}</dd></dl>` : f ? `<p class="hint">${xl('Ayarlar değişti ya da guide henüz oluşturulmadı.')}</p>` : ''}`;
    $('agPick').addEventListener('click', () => { picking = !picking; render(); });
    $('agMake').addEventListener('click', () => make());
    $('agAuto').addEventListener('click', () => { const r = suggest(); if (r.why) St.alertMsg(xl(r.why)); });
    $('ag_mat').addEventListener('change', e => setMat(e.target.value));
    $('ag_sleeve').addEventListener('change', e => { if (st && SLEEVES[e.target.value]) { st.prm = Object.assign({}, st.prm, { sleeve: e.target.value }); changed(); } });
    $('agProd').addEventListener('click', () => production());
    SL.forEach(([k, , unit, step]) => { const el = $('ag_' + k); if (!el) return;
      el.addEventListener('input', () => { $('ag_' + k + 'O').textContent = `${fmt(+el.value, step < 1 ? 1 : 0)} ${unit}`; });
      el.addEventListener('change', () => { if (!st) return; st.prm = Object.assign({}, st.prm, { [k]: clamp(k, el.value) }); changed(); }); });
  }

  // ---------- checks, outputs, plan ----------
  function checks() {
    if (!on() || !st) return [];
    const o = [];
    if (!(out && out.key === keyOf())) { o.push(['warn', 'Uyarı', xl('Guide ayarları değişti; guide\'ı yeniden oluşturun.'), 'ank']); return o; }
    out.info.pins.forEach(p => {
      const nm = p.side > 0 ? xl('Üst K-teli') : xl('Alt K-teli');
      if (!p.entry || !p.ok) o.push(['warn', 'Uyarı', xl(`${nm} kemiğe ulaşmıyor ya da guide gövdesinin dışında kaldı.`), 'ank']);
      else if (p.crosses) o.push(['crit', 'Kritik', xl(`${nm} testere yarığını kesiyor; teli kesiden uzaklaştırın.`), 'ank']);
      else if (p.inBone < 10) o.push(['warn', 'Uyarı', xl(`${nm} kemikte yalnız ${fmt(p.inBone, 0)} mm ilerliyor.`), 'ank']);
    });
    if (out.info.pieces > 1) o.push(['warn', 'Uyarı', xl('Guide birden fazla parçaya bölündü; ölçüleri büyütün.'), 'ank']);
    // seating (the studio's own rules for the mandible guide) and the material
    const q = prm(), m = MAT[q.mat] || MAT.unset, se = out.info.seat;
    if (se && se.ok) {
      if (!se.free) o.push(['crit', 'Kritik', xl('Guide hiçbir yönde takılamıyor; sarma derinliğini azaltın ya da guide\'ı taşıyın.'), 'ank']);
      else {
        if (se.worstSlide && se.worstSlide.r < 0.05) o.push(['warn', 'Uyarı', xl(`Teller takılmadan önce guide kayabilir: temasın yalnız %${fmt(se.worstSlide.r * 100, 0)}'i direnç gösteriyor.`), 'ank']);
        if (se.worstRot && se.worstRot.r < 0.05) o.push(['warn', 'Uyarı', xl(`Guide dönebilir: temasın yalnız %${fmt(se.worstRot.r * 100, 0)}'i direnç gösteriyor.`), 'ank']);
      }
    } else if (out.info.undercut > 4) o.push(['crit', 'Kritik', xl(`Guide kemiğin altına sarıyor (${fmt(out.info.undercut, 0)} mm² alttan kesik); oturtulup çıkarılamaz.`), 'ank']);
    if (out.info.contact < 150) o.push(['warn', 'Uyarı', xl(`Temas alanı ${fmt(out.info.contact, 0)} mm²; oturma belirsiz olabilir (örnek eşik 150 mm²).`), 'ank']);
    const SPM = St.SLOT_PLAY_MAX || 3;
    if (out.info.play != null && out.info.play > SPM + 1e-6) o.push(['crit', 'Kritik', xl(`Testere yuvada ${fmt(out.info.play, 1)}° eğilebilir (yuva ${fmt(q.kerf, 2)} mm, bıçak ${fmt(q.blade, 2)} mm); en çok ${SPM}° olmalı. Yuvayı bıçağa göre daraltın.`), 'ank']);
    if (q.kerf < q.blade + 0.05) o.push(['crit', 'Kritik', xl(`Testere yarığı (${fmt(q.kerf, 2)} mm) bıçaktan (${fmt(q.blade, 2)} mm) dar ya da eşit; bıçak girmez.`), 'ank']);
    if (q.wall < m.minWall - 1e-6) o.push(['crit', 'Kritik', xl(`Guide duvarı ${fmt(q.wall, 1)} mm; seçilen malzeme için en az ${fmt(m.minWall, 1)} mm.`), 'ank']);
    if (q.mat === 'unset' || !MAT[q.mat]) o.push(['info', 'Bilgi', xl('Baskı malzemesi seçilmedi: boşluklar varsayılan değerlerde (belirsiz). Kesi guide\'ı adımında "Malzeme ve kovan" bölümünden seçin.'), 'ank']);
    const jt = out.info.joint;
    if (!jt) o.push(['warn', 'Uyarı', xl('Eklem yüzeyi bulunamadı (talus yok ya da guide kemiğine değmiyor); kesinin ve tellerin ekleme uzaklığı denetlenmedi.'), 'ank']);
    else {
      if (jt.slot < JOINT.min) o.push(['crit', 'Kritik', xl(`Testere kesisi eklem yüzeyine ${fmt(jt.slot, 1)} mm yaklaşıyor (en az ${JOINT.min} mm); kesiyi eklemden uzaklaştırın.`), 'ank']);
      jt.pins.forEach((p, i) => {
        if (!p) return; const nm = out.info.pins[i] && out.info.pins[i].side > 0 ? xl('Üst K-teli') : xl('Alt K-teli');
        if (p.talus) o.push(['crit', 'Kritik', xl(`${nm} eklemi geçip talusa giriyor; teli kaldırın ya da yönünü değiştirin.`), 'ank']);
        else if (p.d < JOINT.min) o.push(['crit', 'Kritik', xl(`${nm} eklem yüzeyine ${fmt(p.d, 1)} mm yaklaşıyor (en az ${JOINT.min} mm).`), 'ank']);
      });
    }
    if (!(out.prod && out.prod.productionOk)) o.push(['warn', 'Uyarı', xl('Guide\'ın üretim STL\'i alınmadı; pakette yalnız tarayıcı önizlemesi var (dosya adı "BASMAYIN"). Kesi guide\'ı adımında "Üretim STL\'i" düğmesine basın.'), 'ank']);
    return o;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);
  const ready = () => !!(out && out.key === keyOf() && on());
  // One frame for every file of the package: the CT's patient coordinates (LPS, mm) with every piece in its planned
  // (reduced) position, the frame of the reduced model. The guide and the wedge are built on their piece in its CT
  // position and carried here by that piece's motion x' = q (x - c) + c + t (cerceve.json, ankle.js, has every motion).
  function toPlan(stl, p) {
    if (!p || !A.moved(p)) return stl;
    const u = stl.slice(), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = dv.getUint32(80, true), x = V();
    for (let t = 0, o = 84; t < n; t++, o += 50) for (let k = 0; k < 4; k++) {
      const b = o + 12 * k; x.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true));
      if (k === 0) x.applyQuaternion(p.q); else x.copy(A.toWorld(p, x));
      dv.setFloat32(b, x.x, true); dv.setFloat32(b + 4, x.y, true); dv.setFloat32(b + 8, x.z, true);
    }
    return u;
  }
  // the guide: the server's production STL when there is one; else the browser preview, named so it is not printed
  function files() {
    if (!ready()) return [];
    const p = out.piece, prod = out.prod && out.prod.productionOk;
    const fs = [prod ? { name: 'guide/kesi_guide.stl', data: toPlan(out.prod.stl, p) } : { name: 'guide/kesi_guide_onizleme_BASMAYIN.stl', data: toPlan(St.stlOf(out.guide), p) }];
    if (out.wedge) fs.push({ name: 'guide/kama.stl', data: toPlan(St.stlOf(out.wedge), p) });
    return fs;
  }
  (window.PlanExt = window.PlanExt || {}).ankGuide = {
    label: 'Malleol guide\'ı',
    get: () => (on() && st ? JSON.parse(JSON.stringify(st)) : null),
    set(x) {
      const ok = x && typeof x.piece === 'string' && [x.c, x.P, x.n].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite));
      if (!ok) { st = null; drop(); render(); return; }
      const p0 = Object.assign({ mat: 'unset', sleeve: 'printed' }, DEF); Object.keys(DEF).forEach(k => { if (x.prm && x.prm[k] != null && Number.isFinite(+x.prm[k])) p0[k] = clamp(k, x.prm[k]); });
      if (x.prm && MAT[x.prm.mat]) p0.mat = x.prm.mat; if (x.prm && SLEEVES[x.prm.sleeve]) p0.sleeve = x.prm.sleeve;
      // plans saved before the blade was a field: their slot was their own choice, the blade the studio's default
      st = { piece: x.piece.slice(0, 40), c: x.c.map(Number), P: x.P.map(Number), n: x.n.map(Number), prm: p0 }; out = null; show(); render();
    },
  };

  bus.addEventListener('changed', () => { sync(); St.render(); });
  bus.addEventListener('caseType', () => { if (!on()) { st = null; drop(); } render(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { st = null; } drop(); render(); });
  bus.addEventListener('bone', () => { drop(); render(); });
  bus.addEventListener('ankPieces', () => { drop(); render(); });
  if ($('stAnkG')) $('stAnkG').addEventListener('toggle', () => { if (!$('stAnkG').open) { picking = false; } render(); });
  render();
  return { on, place, suggest, setMat, boneAxis, seatFit, wedgeAngle, holeOf, MAT, make, production, frame, cutPlane, pins, section, files, ready, checks, joint, toPlan, JOINT, state: () => st, info: () => (out ? out.info : null), parts: () => out, LIM, DEF, set: (k, v) => { if (st) { st.prm = Object.assign({}, st.prm, { [k]: clamp(k, v) }); changed(); } } };
})();
