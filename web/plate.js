/* Reconstruction plate: a plate line walked along the outer bone surface (remaining bone plus fibula grafts, or the
   intact contour when there is no graft), a swept plate with holes at the system's spacing, holes too close to a cut
   marked unusable, guide screws placed on plate holes (pre-drilled holes then match the pre-bent plate), and a
   pre-bending model STL. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Plate = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const COLOR = 0xb8c2cc;
  const SYSTEMS = {
    recon24: { name: '2.4 rekonstrüksiyon', w: 7, t: 2.5, pitch: 8, d: 2.4 },
    mini20: { name: '2.0 mini', w: 5, t: 1.0, pitch: 6, d: 2.0 },
    custom: { name: 'Özel' },
  };
  // screw lengths each system offers (mm); a hole gets the shortest that passes the far cortex by 1 mm
  const LENS = { recon24: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24], mini20: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], custom: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] };
  const JOINT_GAP = 3, GAP = 0.15;   // GAP: modelled clearance between plate and bone (mm)
  const DEF = { on: false, sys: 'recon24', h: 0, ext: 25, w: 7, t: 2.5, pitch: 8, d: 2.4, shift: 0 };
  let P = Object.assign({}, DEF), last = null, timer = null;

  // ---------- plate line ----------
  // bone, and the graft meshes when there are grafts (else the resected piece, the intact contour); F: the intact contour
  // behind the grafts, used in the defect where the line at its height does not meet a graft
  function targets() {
    const out = [], pt = St.parts;
    if (pt.bone) out.push([pt.bone.obj, 'bone']);
    if (pt.grafts && pt.grafts.obj.children.length) pt.grafts.obj.children.forEach(c => c.isMesh && out.push([c, 'graft']));
    else if (pt.resected) out.push([pt.resected.obj, 'defect']);
    return out;
  }
  const fallback = () => (St.parts.grafts && St.parts.grafts.obj.children.length && St.parts.resected ? [[St.parts.resected.obj, 'defect']] : []);
  const rc = new THREE.Raycaster();
  const clipped = h => { const cp = h.object.material && h.object.material.clippingPlanes; return !!cp && cp.some(pl => pl.distanceToPoint(h.point) < -0.05); };
  // The line is found by projection, not by walking over the surface. A free surface walk turns with the surface normal:
  // on the real mandible CT it rolled over the lower border onto the lingual face, or round the end of the bone back
  // to the start (Denetim 4 E1: 235 mm / 652 deg; after a first fix that stopped such walks, the line found was 151 mm /
  // 509 deg under the bone, critical, so no plate could be planned). Here stations march along the arch and at each the
  // bone is met by a ray coming in from the buccal side b: square to the travel direction t and, away from a condyle,
  // level (square to the guide frame's vertical v, at the chosen height). b is carried along the line (it turns with t
  // about v, never about t), so it cannot roll over the crest or the border, and a ray from outside the arch meets the
  // lateral cortex first. t follows the arch (the chord over the last few mm, at most TURN deg per step). Where the bone
  // runs out at the chosen height the station moves up or down (DZ mm; a sloping border) and drifts back to the height;
  // a hit more than JUMP mm deeper or shallower than the last point is not the same face (the end of the bone, a notch);
  // where nothing is met the line ends (ok false: the plate is short there).
  const STEP = 1.5, LIFT = 20, DEEP = 12, JUMP = 4, DZ = 6, TURN = 12, CHORD = 4, NSMOOTH = 4, PSMOOTH = 4;
  function probe(c, b, objs) {
    if (!objs.length) return null;
    rc.set(c.clone().addScaledVector(b, LIFT), b.clone().negate()); rc.far = LIFT + DEEP;
    // graft meshes hold the whole fibula piece and are cut to length by clipping planes: skip the clipped-away part
    const h = rc.intersectObjects(objs.map(t => t[0]), false).find(x => !clipped(x));
    if (!h) return null;
    const nn = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (nn.dot(b) < 0) nn.negate();
    return { p: h.point.clone(), n: nn, kind: objs.find(t => t[0] === h.object)[1] };
  }
  // the bone at station c: the chosen height on the bone / graft, then the intact contour there, then up and down
  function station(c, b, v, T, F, ref, jump) {
    const ok = q => q && Math.abs(q.p.clone().sub(ref).dot(b)) <= jump;
    let q = probe(c, b, T); if (ok(q)) return q;
    q = probe(c, b, F); if (ok(q)) return q;
    for (let dz = 1; dz <= DZ; dz++) for (const s of [dz, -dz]) for (const set of [T, F]) { q = probe(c.clone().addScaledVector(v, s), b, set); if (ok(q)) return q; }
    return null;
  }
  // march from s (on the bone, station guide point g0 at the chosen level) along t0 until stop(point, length) (the
  // length is along the line, so on a curved arch an extension past a cut is measured along the bone); aim: a point the
  // line heads for instead of staying level (the condyle)
  function walk(s, g0, t0, b0, v, T, F, stop, aim) {
    const out = [], pts = [s]; let cur = s, t = t0.clone(), b = b0.clone(), len = 0;
    for (let i = 0; i < 240; i++) {
      let nx = null, c = null;
      for (const st of [STEP, 3, 5]) {
        c = cur.p.clone().addScaledVector(t, st);
        // drift back towards the chosen level, at most 0.5 mm a step
        if (!aim) c.addScaledVector(v, Math.max(-0.5, Math.min(0.5, -c.clone().sub(g0).dot(v))));
        nx = station(c, b, v, T, F, cur.p, Math.max(JUMP, st)); if (nx) break;
      }
      if (!nx) return { pts: out, ok: false };
      const step = nx.p.distanceTo(cur.p); if (step < 0.2) return { pts: out, ok: false };
      len += step; cur = nx; out.push(cur); pts.push(cur);
      if (stop(cur.p, len)) return { pts: out, ok: true };
      // new travel direction: the chord over the last CHORD points, level (or towards the aim), turned at most TURN deg
      let d = cur.p.clone().sub(pts[Math.max(0, pts.length - 1 - CHORD)].p);
      if (aim) d.normalize().add(aim.clone().sub(cur.p).normalize()); else d.addScaledVector(v, -d.dot(v));
      if (d.lengthSq() < 1e-6 || d.dot(t) <= 0) continue;
      d.normalize();
      const ang = t.angleTo(d), lim = THREE.MathUtils.degToRad(TURN);
      if (ang > lim) { const ax = V().crossVectors(t, d).normalize(); d = t.clone().applyAxisAngle(ax, lim); }
      // b carried along: the part of the old b square to the new t (no roll about t)
      b.addScaledVector(d, -b.dot(d)).normalize(); t = d;
      if (!aim) { t.addScaledVector(v, -t.dot(v)).normalize(); b.addScaledVector(v, -b.dot(v)).normalize(); }
    }
    return { pts: out, ok: false };
  }
  function compute() {
    last = null;
    if (!P.on || !S.anchor || !St.parts.bone) return null;
    const E = St.resEnds(); if (!E) return null;
    const T = targets(), { u, v, n } = St.frameAxes();
    // the rays need current world matrices: graft meshes are placed by their matrices, and a line computed right after a
    // rebuild (before the next render updates them) would miss the grafts
    T.forEach(t => t[0].updateMatrixWorld(true));
    const { A, B } = E;
    // start inside the defect: the anchor, or the middle of the two ends when the cuts have moved off it; the buccal
    // direction there is the guide's seating normal, level
    const ea = A.p.clone().sub(S.anchor.p).dot(u), eb = B.p.clone().sub(S.anchor.p).dot(u), shift = 0 > Math.min(ea, eb) + 2 && 0 < Math.max(ea, eb) - 2 ? 0 : (ea + eb) / 2;
    const F = fallback(), g0 = S.anchor.p.clone().addScaledVector(u, shift).addScaledVector(v, P.h), b0 = n.clone().addScaledVector(v, -n.dot(v)).normalize();
    const s0 = station(g0, b0, v, T, F, g0, DEEP); if (!s0) return null;
    // past a cut: the extension is measured along the line from where it leaves the slot
    const past = (beyond, ext) => { let x = null; return (q, len) => { if (x === null && beyond(q)) x = len; return x !== null && len - x >= ext; }; };
    const toA = A.p.clone().sub(s0.p).dot(u) < 0 ? u.clone().negate() : u.clone();
    const ta = toA.clone().addScaledVector(v, -toA.dot(v)).normalize();
    const wa = walk(s0, g0, ta, b0, v, T, F, past(q => q.clone().sub(A.p).dot(A.N) < -A.w / 2, P.ext));
    const wb = E.condyle ? walk(s0, g0, ta.clone().negate(), b0, v, T, F, q => q.distanceTo(B.p) < 10, B.p)
      : walk(s0, g0, ta.clone().negate(), b0, v, T, F, past(q => q.clone().sub(B.p).dot(B.N) > B.w / 2, P.ext));
    let raw = wa.pts.reverse().concat([s0], wb.pts);
    if (raw.length < 4) return null;
    // smooth (a window of +-PSMOOTH stations, symmetric so the ends stay where they are), then resample every 1 mm
    raw = raw.map((q, i) => { const k = Math.min(PSMOOTH, i, raw.length - 1 - i), a = raw.slice(i - k, i + k + 1); const p = V(), nn = V(); a.forEach(x => { p.add(x.p); nn.add(x.n); }); return { p: p.multiplyScalar(1 / a.length), n: nn.normalize(), kind: q.kind }; });
    const cum = [0]; for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + raw[i].p.distanceTo(raw[i - 1].p));
    const L = cum[cum.length - 1], path = [];
    for (let s = 0, j = 0; s <= L; s += 1) {
      while (j < raw.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1), a = raw[j], b = raw[j + 1];
      path.push({ s, p: a.p.clone().lerp(b.p, f), n: a.n.clone().lerp(b.n, f).normalize(), kind: f < 0.5 ? a.kind : b.kind });
    }
    // the plate face follows the bone over its own width, not each facet of the surface mesh: normals averaged over
    // +-NSMOOTH mm (facet noise otherwise adds up to a hundred degrees or more of "bending" over a 80 mm line)
    const ns = path.map((q, i) => { const m = V(); for (let k = Math.max(0, i - NSMOOTH); k <= Math.min(path.length - 1, i + NSMOOTH); k++) m.add(path[k].n); return m.normalize(); });
    path.forEach((q, i) => { const a = path[Math.max(0, i - 1)].p, b = path[Math.min(path.length - 1, i + 1)].p; q.t = b.clone().sub(a).normalize(); q.n.copy(ns[i]).sub(q.t.clone().multiplyScalar(ns[i].dot(q.t))).normalize(); });
    // holes at the plate's spacing, centred on the defect; a hole within 3 mm of a slot edge or of a joint between
    // two fibula segments is not usable
    const pls = St.planesWorld(), mid = L / 2 + P.shift, holes = [], fl = graftPlan(), lower = fl ? fl.segs.filter(g => !g.barrel) : [];
    const joints = lower.slice(1).map(g => ({ p: g.P0, N: g.N0 })), kerf = fl ? (Fibula.plan().kerf || 1) : 0;
    const k0 = Math.ceil((0 - mid) / P.pitch + 0.5), k1 = Math.floor((L - mid) / P.pitch - 0.5);
    for (let k = k0; k <= k1; k++) {
      const s = mid + k * P.pitch, q = path[Math.min(path.length - 1, Math.round(s))];
      const dCut = Math.min(Infinity, ...pls.map(pw => Math.abs(q.p.clone().sub(pw.p).dot(pw.N)) - pw.w / 2 - P.d / 2));
      const sa = q.p.clone().sub(A.p).dot(A.N), region = sa < -A.w / 2 ? 'A' : E.condyle || q.p.clone().sub(B.p).dot(B.N) <= B.w / 2 ? 'defect' : 'B';
      const dJoint = Math.min(Infinity, ...joints.filter(J => q.p.distanceTo(J.p) < 30).map(J => Math.abs(q.p.clone().sub(J.p).dot(J.N)) - kerf / 2 - P.d / 2));
      const h = { s, p: q.p.clone(), n: q.n.clone(), t: q.t.clone(), region, kind: q.kind, dCut, dJoint, usable: dCut >= 3 && dJoint >= JOINT_GAP, why: dCut < 3 ? 'cut' : dJoint < JOINT_GAP ? 'joint' : null };
      h.seg = region === 'defect' && lower.length ? segOf(lower, h.p) : null;
      Object.assign(h, screwFor(h, fl));
      holes.push(h);
    }
    // bending: how much the plate turns, in the plate plane and out of it
    // (twist: the plate's face turning about its own length, as when the line rolls over the crest or lower border)
    let inPlane = 0, outPlane = 0, twist = 0;
    for (let i = 4; i < path.length; i += 4) {
      const a = path[i - 4], b = path[i]; const tb = V().crossVectors(a.t, a.n); inPlane += Math.abs(Math.asin(Math.max(-1, Math.min(1, b.t.dot(tb))))); outPlane += Math.abs(Math.asin(Math.max(-1, Math.min(1, b.t.dot(a.n)))));
      const nb = b.n.clone().addScaledVector(a.t, -b.n.dot(a.t)); if (nb.lengthSq() > 1e-6) twist += Math.abs(Math.atan2(nb.dot(tb), nb.dot(a.n)));
    }
    const r2d = THREE.MathUtils.radToDeg;
    last = { path, holes, L, ok: wa.ok && wb.ok, E, bend: { inPlane: r2d(inPlane), outPlane: r2d(outPlane), twist: r2d(twist) }, graftGap: F.length ? graftGap(path, E, T, g0, b0, v) : null };
    last.crit = assess(last);
    return last;
  }

  // the grafts are placed at their own height (fibula plan): where the line at the chosen height crosses the defect off
  // the grafts (on the intact contour, kind 'defect') the plate does not hold them there. Returned: mm of such line and
  // the grafts' height range at the line's start in the defect (guide-frame height, as P.h) and the height nearest to the
  // chosen one that crosses them 3 mm inside their edge, for the warning
  function graftGap(path, E, T, g0, b0, v) {
    const { A, B } = E, inDef = q => q.clone().sub(A.p).dot(A.N) >= -A.w / 2 && (E.condyle || q.clone().sub(B.p).dot(B.N) <= B.w / 2);
    const miss = path.filter(q => q.kind === 'defect' && inDef(q.p)).length; if (miss < 3) return null;   // 1 mm path samples; a slot edge is not a gap
    const G = T.filter(t => t[1] === 'graft'), hs = [];
    for (let H = -30; H <= 30; H++) if (probe(g0.clone().addScaledVector(v, H - P.h), b0, G)) hs.push(H);
    if (!hs.length) return { mm: miss, lo: null, hi: null, sug: null };
    const lo = hs[0], hi = hs[hs.length - 1], sug = hi - lo < 6 ? (lo + hi) / 2 : Math.min(Math.max(P.h, lo + 3), hi - 3);
    return { mm: miss, lo, hi, sug: Math.max(-15, Math.min(15, Math.round(sug * 2) / 2)) };
  }

  // ---------- plausibility ----------
  // A line that is longer than the defect and both extensions call for, folds onto itself, or bends/twists more than a
  // plate can be bent is not a plate: it is reported as critical (blocks approval and the package; Plate.critical()).
  // Limits: length > 1.6 x expected + 10 mm (expected = cut-to-cut distance + slot halves + extension each side);
  // two points >= 25 mm apart along the line within 6 mm of each other; total bend through the thickness > 450 deg
  // (an angle-to-angle arch is about 300 deg with surface noise), across the edge > 150 deg, or twist > 270 deg
  // (on the real mandible CT a plausible 81 mm line measures 124 / 15 / 60 deg; the line rolling under the bone, 509 / 120 / 499).
  const LIM = { lenRatio: 1.6, lenAdd: 10, foldArc: 25, foldGap: 6, outPlane: 450, inPlane: 150, twist: 270 };
  function assess(R) {
    const out = [], { A, B } = R.E, d = A.p.distanceTo(B.p);
    const want = R.E.condyle ? d + A.w / 2 + P.ext : d + (A.w + B.w) / 2 + 2 * P.ext;
    if (R.L > LIM.lenRatio * want + LIM.lenAdd) out.push({ why: 'length', text: `Plak hattı ${Math.round(R.L)} mm; rezeksiyon ve kesi ötesi uzantıya göre beklenen yaklaşık ${Math.round(want)} mm. Hat kemik çevresinde dolanıyor; plak yüksekliğini ya da uzantıyı değiştirin.` });
    const pp = R.path; let fold = false;
    for (let i = 0; i < pp.length && !fold; i += 2) for (let j = i + LIM.foldArc; j < pp.length; j += 2) if (pp[i].p.distanceTo(pp[j].p) < LIM.foldGap) { fold = true; break; }
    if (fold) out.push({ why: 'fold', text: 'Plak hattı kendi üzerine katlanıyor; plak yüksekliğini ya da kesi ötesi uzantıyı değiştirin.' });
    const b = R.bend;
    if (b.outPlane > LIM.outPlane || b.inPlane > LIM.inPlane || b.twist > LIM.twist) out.push({ why: 'bend', text: `Plak bükmesi gerçekçi değil (${Math.round(b.outPlane)}° yüzeye, ${Math.round(b.inPlane)}° kenara, ${Math.round(b.twist)}° burulma); hat kemik kenarından dönüyor olabilir. Plak yüksekliğini değiştirin.` });
    return out;
  }
  // critical reasons of the current plate line ([] when it is plausible or there is none)
  const critical = () => (P.on && last && last.crit ? last.crit.slice() : []);

  // the fibula plan when grafts are shown (plate holes then also avoid the graft joints)
  function graftPlan() {
    if (!window.Fibula || !Fibula.active() || !St.parts.grafts || !St.parts.grafts.obj.children.length) return null;
    const st = Fibula.state(); return st && st.last && st.last.segs.length ? st.last : null;
  }
  // graft segment that holds point p: between its two end planes, else the one whose axis passes closest
  function segOf(segs, p) {
    const inside = segs.find(g => p.clone().sub(g.P0).dot(g.N0) >= 0 && p.clone().sub(g.P1).dot(g.N1) <= 0);
    if (inside) return inside.i;
    let best = null, bd = Infinity;
    segs.forEach(g => { const t = Math.max(0, Math.min(g.L, p.clone().sub(g.P0).dot(g.x))), d = p.distanceTo(g.P0.clone().addScaledVector(g.x, t)); if (d < bd) { bd = d; best = g.i; } });
    return best;
  }
  // bone under a hole: remaining mandible (without the resected piece) or a graft segment
  function boneHere(q, fl) {
    if (fl) for (let i = 0; i < fl.segs.length; i++) if (Fibula.graftBone(i, q)) return true;
    if (!fl && !S.resRemoved) return St.boneAt(q);
    if (!St.boneAt(q)) return false;
    if (!S.resMask) return true;
    const r = S.red, ix = G.indexOf(r, [q.x, q.y, q.z]).map(Math.round);
    if (ix.some((x, k) => x < 0 || x >= [r.nx, r.ny, r.nz][k])) return true;
    return !S.resMask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])];
  }
  // bicortical screw: walk into the bone along the hole axis until 2 mm of no bone follow; length = far cortex + 1 mm,
  // rounded up to the system's lengths. No exit within 30 mm: monocortical, the longest standard length is proposed.
  // Length convention (conservative, needs confirmation against the plate system's own definition): measured from the
  // plate's top face, i.e. the head seated flush in the plate, so the plate thickness and the modelled plate-bone gap
  // are added to the bone path (Denetim 4 W10: from the bone surface alone the proposal was ~2 mm short and could stop
  // inside the far cortex).
  function screwFor(h, fl) {
    const dir = h.n.clone().negate(), q = V(); let entry = null, lastIn = null, out = 0, t = -1;
    for (; t <= 30; t += 0.25) {
      if (boneHere(q.copy(h.p).addScaledVector(dir, t), fl)) { if (entry === null) entry = t; lastIn = t; out = 0; }
      else if (entry !== null && (out += 0.25) >= 2) break;
    }
    if (entry === null) return { len: null, thick: 0, bi: false };
    const bi = t <= 30, need = Math.max(0, lastIn) + 1 + GAP + P.t, L = LENS[P.sys] || LENS.custom;
    return { len: L.find(x => x >= need) || L[L.length - 1], thick: lastIn - entry, bi: bi && need <= L[L.length - 1] };
  }

  // ---------- plate mesh ----------
  function plateMesh(R) {
    const pos = [], idx = [], gap = GAP, w = P.w / 2, path = R.path;
    path.forEach(q => {
      const b = V().crossVectors(q.t, q.n).normalize();
      [[-w, gap], [w, gap], [w, gap + P.t], [-w, gap + P.t]].forEach(([x, y]) => { const c = q.p.clone().addScaledVector(b, x).addScaledVector(q.n, y); pos.push(c.x, c.y, c.z); });
    });
    for (let i = 0; i < path.length - 1; i++) for (let k = 0; k < 4; k++) {
      const a = i * 4 + k, b = i * 4 + (k + 1) % 4, c = a + 4, d = b + 4; idx.push(a, c, b, b, c, d);
    }
    const e = (path.length - 1) * 4; idx.push(0, 1, 2, 0, 2, 3, e, e + 2, e + 1, e, e + 3, e + 2);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  function draw() {
    const R = last;
    if (!R) { St.setPart('plate', null, null); return; }
    const grp = new THREE.Group(), body = new THREE.Mesh(plateMesh(R), St.mat(COLOR, { metalness: 0.5, roughness: 0.35 }));
    body.name = 'plateBody'; grp.add(body);
    R.holes.forEach(h => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(P.d / 2 + 0.25, P.d / 2 + 0.25, P.t + 0.3, 20), new THREE.MeshStandardMaterial({ color: h.usable ? (h.matched ? 0x2a9d8f : 0x30363c) : 0xc0504d, roughness: 0.6 }));
      m.position.copy(h.p.clone().addScaledVector(h.n, GAP + P.t / 2)); m.quaternion.setFromUnitVectors(V(0, 1, 0), h.n); grp.add(m);
    });
    St.setPart('plate', `${xl('Plak')} (${SYSTEMS[P.sys].name})`, grp, COLOR);
    if (St.renderParts) St.renderParts();
    St.render();
  }
  async function update() {
    try { compute(); } catch (e) { last = null; }
    // a message about an earlier line (e.g. "2 guide screws placed") must not stand next to "no plate line" (Denetim 4 E6)
    if (last) markMatched(); else msg('');
    draw(); renderSum(); St.renderChecks(); St.renderAppr(); if (window.MPR) MPR.redraw();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 350); };

  // ---------- guide screws on plate holes ----------
  // the frame a screw for hole h is given in: in the two-guide layout (split 2) the frame of the piece on the hole's side
  // (app.js screwFrame reads u/v/tilts of a screw with `part` there), else the guide frame
  function holeFrame(h) {
    const f = S.g.split === 2 && St.pieceFrames ? St.pieceFrames() : null;
    if (f && (h.region === 'A' || h.region === 'B')) return Object.assign({ part: h.region === 'A' ? -1 : 1 }, h.region === 'A' ? f.a : f.b);
    return Object.assign({ P: S.anchor.p, part: 0 }, St.frameAxes());
  }
  function screwFromHole(h, base) {
    const { P: o, u, v, n, part } = holeFrame(h), d = h.p.clone().sub(o), dir = h.n.clone().negate();
    const a = Math.asin(Math.max(-1, Math.min(1, -dir.dot(u)))), b = Math.atan2(dir.dot(v), -dir.dot(n));
    return Object.assign({}, base, { u: Math.round(d.dot(u) * 10) / 10, v: Math.round(d.dot(v) * 10) / 10, tiltU: Math.round(THREE.MathUtils.radToDeg(a)), tiltV: Math.round(THREE.MathUtils.radToDeg(b)), ok: false, plate: true }, part ? { part } : {});
  }
  // the hole lies under the guide body: the main body (L x W about the anchor), or in the two-guide layout the piece
  // on its side (from the cut outwards, as far as the piece reaches for its screws)
  function footprint(h) {
    const { P: o, u, v, part } = holeFrame(h), d = h.p.clone().sub(o);
    if (part) return d.dot(u) >= 2 && d.dot(u) <= 22 && Math.abs(d.dot(v)) <= S.g.W / 2 - 2;
    return Math.abs(d.dot(u)) <= S.g.L / 2 - 2 && Math.abs(d.dot(v)) <= S.g.W / 2 - 2;
  }
  function placeScrews() {
    if (!last) return;
    const base = S.screws[0] ? (({ d, D, sleeveH, len }) => ({ d, D, sleeveH, len }))(S.screws[0]) : { d: 2.0, D: 5, sleeveH: 5, len: 10 };
    const pick = reg => last.holes.filter(h => h.region === reg && h.usable && footprint(h)).sort((x, y) => x.dCut - y.dCut).slice(0, 2);
    const hs = [...pick('A'), ...pick('B')];
    if (!hs.length) { msg('Guide alanında kullanılabilir plak deliği yok. Guide\'ı uzatın ya da plak yüksekliğini guide üzerine getirin.'); return; }
    S.screws = hs.map(h => screwFromHole(h, base)); S.sel = null;
    markMatched(); renderSum();
    msg(`${hs.length} guide vidası plak deliklerine yerleştirildi. Ameliyatta bu deliklerden açılan yuvalar ön bükülmüş plağın delikleriyle eşleşir.`);
    St.schedule(false);
  }
  function markMatched() {
    const sw = St.screwsWorld();
    last.holes.forEach(h => { h.matched = sw.some(s => s.entry && s.entry.distanceTo(h.p) < 1.5); });
  }

  // ---------- files ----------
  function mergedSTL(objs) {
    const pos = [], idx = [];
    objs.forEach(o => {
      o.updateMatrixWorld(true);
      const g = o.geometry, Pa = g.attributes.position.array, I = g.index ? g.index.array : null, base = pos.length / 3, M = o.parent && o.parent.isGroup ? o.matrix : new THREE.Matrix4(), q = V();
      for (let i = 0; i < Pa.length; i += 3) { q.set(Pa[i], Pa[i + 1], Pa[i + 2]).applyMatrix4(M); pos.push(q.x, q.y, q.z); }
      if (I) for (let i = 0; i < I.length; i++) idx.push(base + I[i]); else for (let i = 0; i < Pa.length / 3; i++) idx.push(base + i);
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    return St.stlOf({ geometry: g });
  }
  function bendModel() {
    const pt = St.parts, objs = [pt.bone.obj];
    if (pt.grafts && pt.grafts.obj.children.length) pt.grafts.obj.children.forEach(c => c.isMesh && objs.push(c));
    else if (pt.resected) objs.push(pt.resected.obj);
    return mergedSTL(objs);
  }
  const plateSTL = () => { const b = St.parts.plate && St.parts.plate.obj.getObjectByName('plateBody'); return b ? St.stlOf(b) : null; };
  (window.ExportHooks = window.ExportHooks || []).push(files => {
    if (!last) return;
    const s = summary();
    files.push({ name: 'plak_bukme_modeli.stl', data: bendModel() }, { name: 'plak_sablonu.stl', data: plateSTL() }, { name: 'plak_plani.json', data: JSON.stringify(s, null, 2) }, { name: 'plak_vidalari.csv', data: screwCSV(s) });
  });

  // ---------- summary, checks, report ----------
  function summary() {
    if (!last) return null;
    markMatched();   // the guide screws may have moved since the line was computed (Denetim 4 D6: "0 matched" next to 2 placed)
    const cnt = r => last.holes.filter(h => h.region === r && h.usable).length;
    return { sistem: SYSTEMS[P.sys].name, genislik_mm: P.w, kalinlik_mm: P.t, delik_araligi_mm: P.pitch, uzunluk_mm: Math.round(last.L), holes: last.holes.length,
      kullanilabilir: { A: cnt('A'), defekt: cnt('defect'), B: cnt('B') }, kesiye_yakin: last.holes.filter(h => !h.usable).length,
      bukme_deg: { kalinlik_yonunde: Math.round(last.bend.outPlane), kenar_yonunde: Math.round(last.bend.inPlane), burulma: Math.round(last.bend.twist) },
      kritik: critical().map(c => c.text),
      guide_ile_eslesen: last.holes.filter(h => h.matched).length, greft_eklemine_yakin: last.holes.filter(h => h.why === 'joint').length,
      vida_listesi: screwList(),
      delikler: last.holes.map((h, i) => ({ no: i + 1, bolge: h.region, segment: h.seg == null ? null : h.seg + 1, kullanilabilir: h.usable, neden: h.why === 'cut' ? 'kesiye yakın' : h.why === 'joint' ? 'greft eklemine yakın' : null,
        kesiye_mm: +h.dCut.toFixed(1), eklem_mm: Number.isFinite(h.dJoint) ? +h.dJoint.toFixed(1) : null, vida_boyu_mm: h.usable ? h.len : null, kemik_kalinligi_mm: +h.thick.toFixed(1), bikortikal: h.usable && h.len ? h.bi : null,
        konum: h.p.toArray().map(x => +x.toFixed(2)), eksen: h.n.clone().negate().toArray().map(x => +x.toFixed(4)) })) };
  }
  // usable holes grouped by screw length: [[length, count], ...]
  function screwList() {
    const m = new Map(); last.holes.forEach(h => { if (h.usable && h.len) m.set(h.len, (m.get(h.len) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([boy_mm, adet]) => ({ boy_mm, adet }));
  }
  const screwText = s => s.vida_listesi.length ? s.vida_listesi.map(x => `${x.adet} × ${fmt(x.boy_mm, 0)} mm`).join(', ') : '–';
  function screwCSV(s) {
    return 'delik;bolge;segment;vida_boyu_mm;kemik_kalinligi_mm;bikortikal;x;y;z\n' + s.delikler.filter(h => h.kullanilabilir).map(h => [h.no, h.bolge, h.segment || '', h.vida_boyu_mm || '', h.kemik_kalinligi_mm, h.bikortikal ? 'evet' : 'hayir', ...h.konum].join(';')).join('\n') + '\n';
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    if (!P.on || !S.anchor) return [];
    if (!last) return [['warn', 'Uyarı', 'Plak hattı kemik yüzeyinde izlenemedi; plak yüksekliğini değiştirin.', 'guide']];
    const out = [], need = last.E.condyle ? ['A'] : ['A', 'B'];
    need.forEach(r => { const c = last.holes.filter(h => h.region === r && h.usable).length; if (c < 3) out.push(['warn', 'Uyarı', xl(`Plak ${r === 'A' ? 'birinci' : 'ikinci'} kalan segmentte ${c} vidaya yer bırakıyor; en az 3 önerilir (plak uzantısını artırın).`), 'guide']); });
    critical().forEach(c => out.push(['crit', 'Kritik', xl(c.text), 'guide']));
    if (!last.ok) out.push(['warn', 'Uyarı', 'Plak hattı istenen uzunluğa ulaşmadan kemik yüzeyinden çıktı.', 'guide']);
    const gg = last.graftGap;
    if (gg) out.push(['warn', 'Uyarı', gg.lo === null ? xl(`Plak hattı defektte ${gg.mm} mm boyunca grefte değmiyor; bu yükseklikte greft yok. Plak yüksekliğini ya da fibula segmentinin yerini değiştirin.`)
      : xl(`Plak hattı defektte ${gg.mm} mm boyunca grefte değmiyor; greft bu noktada ${fmt(gg.lo, 0)} ile ${fmt(gg.hi, 0)} mm yükseklik arasında. Plak yüksekliğini yaklaşık ${fmt(gg.sug, Number.isInteger(gg.sug) ? 0 : 1)} mm yapın ya da fibula segmentinin yerini değiştirin.`), 'guide']);
    const fl = graftPlan();
    if (fl) fl.segs.filter(g => !g.barrel).forEach(g => { const c = last.holes.filter(h => h.seg === g.i && h.usable).length; if (c < 2) out.push(['warn', 'Uyarı', `Plak greft segmenti ${g.i + 1} üzerinde ${c} vidaya yer bırakıyor; her segmente en az 2 vida önerilir (delik dizisini kaydırın ya da segment boyunu değiştirin).`, 'guide']); });
    const mono = last.holes.filter(h => h.usable && h.len && !h.bi).length, none = last.holes.filter(h => h.usable && !h.len).length;
    if (mono) out.push(['info', 'Bilgi', xl(`${mono} plak deliğinde karşı korteks 30 mm içinde bulunamadı ya da standart boydan uzun; bu vidalar monokortikal kalır.`), 'guide']);
    if (none) out.push(['warn', 'Uyarı', `${none} kullanılabilir plak deliğinin altında kemik yok.`, 'guide']);
    const m = last.holes.filter(h => h.matched).length, gs = S.screws.length;
    if (gs && m < gs && S.screws.some(s => s.plate)) out.push(['info', 'Bilgi', xl(`${gs} guide vidasından ${m} tanesi plak deliğiyle çakışıyor.`), 'guide']);
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(380); d.h2('Plak');
    d.table(['Özellik', 'Değer'], [['Sistem', `${s.sistem} · ${fmt(s.genislik_mm)} × ${fmt(s.kalinlik_mm)} mm · ${xl(`${fmt(s.delik_araligi_mm)} mm aralık`)}`], ['Uzunluk / delik', `${s.uzunluk_mm} mm · ${s.holes} delik`], ['Kullanılabilir delik', `kalan 1: ${s.kullanilabilir.A} · defekt: ${s.kullanilabilir.defekt} · kalan 2: ${s.kullanilabilir.B}`], ['Kesiye yakın (boş bırakılacak)', `${s.kesiye_yakin}`], ['Toplam bükme', `kalınlık yönünde ${s.bukme_deg.kalinlik_yonunde}° · kenar yönünde ${s.bukme_deg.kenar_yonunde}°`], ['Guide vidalarıyla eşleşen delik', `${s.guide_ile_eslesen}`], ['Greft eklemine yakın (boş bırakılacak)', `${s.greft_eklemine_yakin}`], ['Vida boyları (bikortikal)', screwText(s)], ['Not', 'Vida boyları kemik modelinden ölçülür; sinir kanalı ve diş kökleri ayrıca kontrol edilmelidir.']], [0.34, 0.66]);
  });

  // ---------- slices: plate cross-section where it meets the slice ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const body = last && St.parts.plate && St.parts.plate.visible && St.parts.plate.obj.getObjectByName('plateBody');
    if (!body || !A.contour) return;
    ctx.strokeStyle = '#c9d2db'; ctx.lineWidth = 2 * dpr; A.contour(v, { id: 'plateBody', obj: body, base: body.position }, T, ctx);
  });

  // ---------- panel ----------
  function msg(t) { const el = $('plMsg'); if (el) el.textContent = t; }
  const F = [['h', 'Plak yüksekliği', -15, 15, 0.5, 'mm'], ['ext', 'Kesi ötesi uzantı', 10, 45, 1, 'mm'], ['shift', 'Delik kaydırma', -4, 4, 0.5, 'mm'], ['w', 'Plak genişliği', 3, 10, 0.5, 'mm'], ['t', 'Plak kalınlığı', 0.6, 3.5, 0.1, 'mm'], ['pitch', 'Delik aralığı', 4, 12, 0.5, 'mm'], ['d', 'Plak vida çapı', 1.5, 3, 0.1, 'mm']];
  function render() {
    const s = summary();
    $('plateBox').innerHTML = `<h3 class="sub">Plak</h3>
      <label class="chk"><input type="checkbox" id="plOn" ${P.on ? 'checked' : ''}> Plak planla</label>
      ${P.on ? `<div class="ctl"><label for="plSys" class="lbl2">Plak sistemi</label><select id="plSys">${Object.entries(SYSTEMS).map(([k, x]) => `<option value="${k}" ${P.sys === k ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>
      ${F.filter(f => P.sys === 'custom' || !['w', 't', 'pitch'].includes(f[0])).map(([k, t, mn, mx, st, un]) => `<div class="ctl"><div class="ctl-row"><label for="pl_${k}">${t}</label><output id="plo_${k}">${fmt(P[k], st < 1 ? 1 : 0)} ${un}</output></div><input type="range" id="pl_${k}" min="${mn}" max="${mx}" step="${st}" value="${P[k]}"></div>`).join('')}
      <div id="plSum">${sumHTML(s)}</div>
      <div class="btns"><button id="plScrews" ${s && !s.kritik.length ? '' : 'disabled'}><svg class="i"><use href="#i-target"/></svg>Vidaları plağa hizala</button></div>
      <div class="btns"><button id="plBend" class="ghost" ${s ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>Bükme modeli STL</button><button id="plTpl" class="ghost" ${s && !s.kritik.length ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>Plak şablonu STL</button></div>
      <p class="hint more">Kırmızı delikler kesiye ya da greft eklemine 3 mm'den yakındır, boş bırakılır. Yeşil delikler guide vidalarıyla eşleşir. Vida boyu her delikte plak üst yüzeyinden karşı korteksin 1 mm ötesine kadar ölçülür (plak kalınlığı dahil); sinir kanalı ayrıca kontrol edilmelidir.</p><p class="hint" id="plMsg"></p>` : '<p class="hint more">Plak hattı kalan kemik ve greftlerin dış yüzeyini izler; guide vidaları plak deliklerine yerleştirilebilir.</p>'}`;
    wire();
  }
  const sumHTML = s => s ? `<dl class="kv"><dt>Uzunluk</dt><dd>${s.uzunluk_mm} mm · ${s.holes} delik</dd><dt>Kullanılabilir</dt><dd>${s.kullanilabilir.A} · ${s.kullanilabilir.defekt} · ${s.kullanilabilir.B}</dd><dt>Kesiye yakın</dt><dd>${s.kesiye_yakin} delik boş kalır</dd><dt>Bükme</dt><dd>${s.bukme_deg.kalinlik_yonunde}° yüzeye · ${s.bukme_deg.kenar_yonunde}° kenara</dd><dt>Guide ile eşleşen</dt><dd>${s.guide_ile_eslesen}</dd>${s.greft_eklemine_yakin ? `<dt>Greft eklemine yakın</dt><dd>${s.greft_eklemine_yakin} delik boş kalır</dd>` : ''}<dt>Vidalar</dt><dd>${screwText(s)}</dd></dl>${s.kritik.length ? `<p class="hint" style="color:var(--crit)"><b>Kritik</b> · ${s.kritik.map(t => St.esc(xl(t))).join('<br>')}</p>` : ''}` : `<p class="hint">${S.anchor ? 'Plak hattı bulunamadı; yüksekliği değiştirin.' : 'Önce rezeksiyon bölgesini ve kesileri belirleyin.'}</p>`;
  function renderSum() {
    if (!$('plSum')) return;
    const s = summary(); $('plSum').innerHTML = sumHTML(s);
    // a critical line is not a plate: no screws on its holes and no template to bend to (the bone model stays available)
    ['plScrews', 'plBend', 'plTpl'].forEach(id => { $(id).disabled = !s || (id !== 'plBend' && s.kritik.length > 0); });
  }
  function wire() {
    $('plOn').addEventListener('change', e => { P.on = e.target.checked; changed(); });
    if (!P.on) return;
    $('plSys').addEventListener('change', e => { P.sys = e.target.value; if (P.sys !== 'custom') Object.assign(P, SYSTEMS[P.sys], { name: undefined }); delete P.name; changed(); });
    F.forEach(([k, , , , st, un]) => { const el = $('pl_' + k); if (!el) return; el.addEventListener('input', e => { P[k] = +e.target.value; $('plo_' + k).textContent = `${fmt(P[k], st < 1 ? 1 : 0)} ${un}`; later(); St.emit('changed'); }); });
    $('plScrews').addEventListener('click', placeScrews);
    $('plBend').addEventListener('click', () => St.offer('plak_bukme_modeli.stl', new Blob([bendModel()])));
    $('plTpl').addEventListener('click', () => St.offer('plak_sablonu.stl', new Blob([plateSTL()])));
  }
  function changed() { render(); update(); St.emit('changed'); }

  // a stored plan is untrusted input: keep only known keys, with the default's type
  const clean = x => { const o = Object.assign({}, DEF); if (x && typeof x === 'object') for (const k in DEF) { if (!(k in x)) continue; const d = DEF[k], v = x[k];
    if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n)) o[k] = n; } else if (typeof d === 'boolean') o[k] = !!v; else if (typeof d === 'string') { if (typeof v === 'string') o[k] = v.slice(0, 60); } else if (v === null) o[k] = null;
    else if (typeof v === 'string') o[k] = v.slice(0, 8); else if (Number.isFinite(v)) o[k] = v;
    else if (Array.isArray(v) && v.length <= 4 && v.every(Number.isFinite)) o[k] = v.slice(); } return o; };
  (window.PlanExt = window.PlanExt || {}).plate = {
    label: 'Plak planı',
    get: () => P.on ? Object.assign({}, P) : null,
    set(x) { P = clean(x); if (!(P.sys in SYSTEMS)) P.sys = DEF.sys; render(); update(); },
  };
  bus.addEventListener('parts', () => { if (P.on && !S.restoring) later(); });
  // guide screws moved, added or removed: the "matched" count in the panel follows
  bus.addEventListener('changed', () => { if (P.on && last) renderSum(); });
  // a plan restore (undo, redo, reopen) sets the plate while bone/graft parts are still being rebuilt and silences 'parts':
  // recompute once the restore has finished, or the plate stays empty and the package loses its plate files
  bus.addEventListener('planApplied', () => { if (P.on) later(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { P = Object.assign({}, DEF); last = null; draw(); render(); } });
  render();
  return { summary, compute, update, placeScrews, get: () => last, params: () => P, missing: () => !!(P.on && !last), critical, assess, LIM };
})();
