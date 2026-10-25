/* Malleolar fracture (ankle) case type, milestone 1: the bones and fracture fragments of an ankle CT, a virtual
   reduction (each piece moved and turned back into place by hand), measurements of the reduction (displacement, contact,
   gap, overlap with the neighbouring bone), the reduced model as STL (to pre-bend a plate on a printed model) and a
   package once the plan is approved.

   Pieces are the bone components of the threshold mask (or the layers of "Bitişik kemikleri ayır" when touching bones
   were split). Each piece is shown as its own mesh inside a pivot at its centre c; a reduction is a rigid motion
   p' = q (p - c) + c + t, saved with the plan (PlanExt.ankle) and undoable. The reduction is a surgeon's decision:
   the module measures it, it never calls it right. Research prototype, not for clinical use. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Ankle = (function () {
  const St = window.Studio; if (!St || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const on = () => CaseType.get() === 'ankle';
  const PALETTE = [0xe0a03a, 0x4f8fe6, 0x9b6ad6, 0x2bb0b0, 0xd46a9a, 0x46c98b, 0xc9a227, 0x7f8c99], FIXED = 0xd8d2c8;
  // sample thresholds (our engineering assumptions, not from the literature); the clinical team sets the final values
  const LIM = { overlapWarn: 0.5, overlapCrit: 1.0, gapWarn: 2.0, contact: 0.8, near: 4, minCm3: 0.2 };
  const CLASSES = ['', 'Weber A', 'Weber B', 'Weber C', 'İzole medial malleol', 'Bimalleoler', 'Trimalleoler', 'Diğer'];
  let pieces = [], built = '', sel = -1, metrics = [], pend = null, buildJob = null;
  let meta = { side: '', cls: '' }, red = { ok: false }, autoSide = '', unmatched = [];
  const hex = c => '#' + c.toString(16).padStart(6, '0');

  // ---------- pieces from the segmentation ----------
  const r3 = q => [q.x, q.y, q.z].map(x => Math.round(x * 10) / 10);
  // ---------- joints: touching bones are one threshold component ----------
  // On a real ankle CT the joint space is narrower than the voxel blur: at 300 HU the tibia and the talus came out as one
  // piece (2026-10-23 anonymised CT; the "talus" was then the calcaneus). Every large component is cut at its thin necks
  // (G.separator, the watershed the mandible uses) with a low neck ratio: a joint contact is much thinner than the bones
  // on both sides, a bone's own narrowings (trabecular metaphysis, talar neck) are not. Labels are rewritten in place.
  const SEP = { minCm3: 10, ratio: 0.3 };
  // A fracture fragment pressed against its bone is one threshold component too: the fracture line is a band of partial
  // volume brighter than the threshold, as thick as the bones on both sides (no neck for the watershed). At a higher
  // threshold (thr + HYS.dHu) only the dense bone is left: the fragment's cortex and the main bone's cortex come apart
  // there. Every such dense piece that reaches the bone's outer surface (a cortex, not a trabecular island inside) seeds
  // a seeded split (G.splitSeeds: paths through dense bone are cheap, so the border settles in the low-density band).
  // Two regions stay apart only when the voxels along their border are low density (see below): a
  // fracture line, not a bone's own cortex that thins out at the higher threshold. Low density: the lower voxel of each
  // pair across the border averages under thr + HYS.border (sample values, our assumption).
  const HYS = { dHu: 250, border: 75, minCm3: 2, seedCm3: 0.25, surf: 0.15, maxSeeds: 8 };
  function separate(r, labels, comps, thr = THR_ANKLE) {
    const vox = r.sp[0] * r.sp[1] * r.sp[2] / 1000, minVox = Math.max(1, Math.round(LIM.minCm3 / vox)), out = [];
    let base = 0; for (let v = 0; v < labels.length; v++) if (labels[v] > base) base = labels[v];
    base = Math.max(base, 1) + 1;
    comps.forEach(c => {
      if (c.size * vox < SEP.minCm3) { out.push(c); return; }
      const sep = G.separator(labels, r.nx, r.ny, r.nz, r.sp, { label: c.label });
      const cs = sep.empty ? [] : sep.run({ ratio: SEP.ratio, base, out: labels, minSize: minVox });
      if (cs.length > 1) { out.push(...cs); base += cs.ids + 1; } else { if (!sep.empty) sep.restore(c.label); out.push(c); }
    });
    if (!r.hu) return out.sort((a, b) => b.size - a.size);
    const fin = [];
    out.forEach(c => {
      if (c.size * vox < HYS.minCm3) { fin.push(c); return; }
      const cs = hysteresis(r, labels, c, thr, base, minVox);
      if (cs) { fin.push(...cs); base += cs.length + 1; } else fin.push(c);
    });
    return fin.sort((a, b) => b.size - a.size);
  }
  // the hysteresis split of one component (labels rewritten in place); null when it stays one piece
  function hysteresis(r, labels, c, thr, base, minVox) {
    const { nx, ny, nz, hu } = r, vox = r.sp[0] * r.sp[1] * r.sp[2] / 1000, thrHi = thr + HYS.dHu;
    let b = c.box;
    if (!b) {
      b = [nx, ny, nz, -1, -1, -1];
      for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) if (labels[v] === c.label) {
        if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
      }
    }
    if (b[3] < 0) return null;
    const cx = b[3] - b[0] + 3, cy = b[4] - b[1] + 3, cz = b[5] - b[2] + 3, cxy = cx * cy, N = cxy * cz;
    const full = (i, j, k) => (i + b[0] - 1) + nx * ((j + b[1] - 1) + ny * (k + b[2] - 1));
    const dom = new Uint8Array(N), hi = new Uint8Array(N), H = new Int16Array(N);
    for (let k = 1; k < cz - 1; k++) for (let j = 1; j < cy - 1; j++) for (let i = 1; i < cx - 1; i++) {
      const v = full(i, j, k); if (labels[v] !== c.label) continue;
      const m = i + cx * (j + cy * k); dom[m] = 1; H[m] = hu[v]; if (hu[v] >= thrHi) hi[m] = 1;
    }
    const nb = [-1, 1, -cx, cx, -cxy, cxy];
    const hc = G.components(hi, cx, cy, cz, Math.max(2, Math.round(HYS.seedCm3 / vox)));
    // a seed reaches the outer surface: enough of its voxels have a neighbour outside the component
    const surf = new Map(hc.comps.map(s => [s.label, 0]));
    for (let m = 0; m < N; m++) { const l = hc.labels[m]; if (!l || !surf.has(l)) continue; for (let a = 0; a < 6; a++) if (!dom[m + nb[a]]) { surf.set(l, surf.get(l) + 1); break; } }
    const seedsOk = hc.comps.filter(s => surf.get(s.label) >= HYS.surf * s.size).slice(0, HYS.maxSeeds);
    if (seedsOk.length < 2) return null;
    const idOf = new Map(seedsOk.map((s, i) => [s.label, i + 1])), seeds = new Uint8Array(N);
    for (let m = 0; m < N; m++) { const id = idOf.get(hc.labels[m]); if (id) seeds[m] = id; }
    const { lab } = G.splitSeeds({ nx: cx, ny: cy, nz: cz, hu: H }, dom, seeds, thr, thrHi + 300);
    // borders: per pair, voxel count and HU sum; regions with a dense border (or too small) are merged
    const K = seedsOk.length, cnt = new Float64Array((K + 1) * (K + 1)), sum = new Float64Array((K + 1) * (K + 1)), size = new Int32Array(K + 1);
    for (let m = 0; m < N; m++) {
      const a = lab[m]; if (!a) continue; size[a]++;
      for (let t = 1; t < 6; t += 2) { const u = m + nb[t], q = lab[u]; if (q && q !== a) { const lo = Math.min(a, q), hi2 = Math.max(a, q), x = lo * (K + 1) + hi2; cnt[x]++; sum[x] += Math.min(H[m], H[u]); } }
    }
    const par = Array.from({ length: K + 1 }, (_, i) => i), find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let a = 1; a <= K; a++) for (let q = a + 1; q <= K; q++) { const x = a * (K + 1) + q; if (cnt[x] && sum[x] / cnt[x] >= thr + HYS.border) par[find(q)] = find(a); }
    // small regions join the neighbour they share the longest border with
    for (let pass = 0; pass < K; pass++) {
      const gs = new Map(); for (let a = 1; a <= K; a++) gs.set(find(a), (gs.get(find(a)) || 0) + size[a]);
      const small = [...gs.entries()].filter(([, s]) => s < Math.max(minVox, Math.round(HYS.seedCm3 * 2 / vox))).map(([g]) => g);
      if (!small.length || gs.size < 2) break;
      const g = small[0]; let best = -1, bn = 0;
      for (let a = 1; a <= K; a++) for (let q = 1; q <= K; q++) { if (a === q || find(a) !== g || find(q) === g) continue; const x = Math.min(a, q) * (K + 1) + Math.max(a, q); if (cnt[x] > bn) { bn = cnt[x]; best = find(q); } }
      if (best < 0) break; par[g] = best;
    }
    const groups = [...new Set(Array.from({ length: K }, (_, i) => find(i + 1)))];
    if (groups.length < 2) return null;
    const gid = new Map(groups.map((g, i) => [g, base + i + 1])), info = groups.map(g => ({ label: gid.get(g), size: 0, cx: 0, cy: 0, cz: 0 }));
    for (let k = 1; k < cz - 1; k++) for (let j = 1; j < cy - 1; j++) for (let i = 1; i < cx - 1; i++) {
      const m = i + cx * (j + cy * k); if (!dom[m]) continue;
      const a = lab[m]; if (!a) continue;            // unreachable specks keep the old label
      const L = gid.get(find(a)), e = info[groups.indexOf(find(a))]; labels[full(i, j, k)] = L;
      e.size++; e.cx += i + b[0] - 1; e.cy += j + b[1] - 1; e.cz += k + b[2] - 1;
    }
    return info.filter(e => e.size).map(e => ({ label: e.label, size: e.size, centroid: [e.cx / e.size, e.cy / e.size, e.cz / e.size], hys: true }));
  }

  // ---------- the ankle region and the anatomical names ----------
  // Names are a guess shown as such; each can be changed in the panel.
  // - outside the body: a piece whose surface mostly lies against air (in the axial plane, within 1.7 mm) or whose
  //   voxels mostly lie within 3 mm of air is a splint, cast or table ("Atel / dış nesne": hidden, not measured, not
  //   exported). Bone lies under skin and soft tissue; a cast's outer surface is the air.
  // - tibia and fibula: the two longest remaining pieces (the larger is the tibia; on a CT of both legs, those of the
  //   chosen side). Up = towards the knee: the end of the shafts nearer a scan edge.
  // - talus: the largest piece over 5 cm³ that touches the tibia (within 6 mm) below the tibia's middle
  // - the ankle level is the talar dome (the talus' top); without a talus the tibia's distal end. The region kept
  //   (crop, ROI) runs from `below` mm under to `above` mm over it; a piece with under 30 % of its voxels inside is
  //   left out (knee, femur, patella on a long scan; the toes).
  // - a fracture fragment lies within 6 mm of the tibia or the fibula and is named from where it lies against the
  //   distal tibia; a bone touching only the talus or the foot (navicular, calcaneus) is "Diğer kemik".
  const MAXP = 16, THR_ANKLE = 300, THR_MAND = 250, NEAR_FRAG = 6, NEAR_TAL = 6, IN_ROI = 0.3;
  const ROI_DEF = { above: 100, below: 40, side: '' }, ROI_LIM = { above: [30, 250], below: [10, 100] };
  const NAMES = ['Tibia', 'Fibula', 'Talus', 'Lateral malleol', 'Medial malleol', 'Posterior malleol', 'Diğer kemik', 'Atel / dış nesne'];
  const roleOf = n => ({ Tibia: 'tibia', Fibula: 'fibula', Talus: 'talus', 'Diğer kemik': 'other', 'Atel / dış nesne': 'out' })[n] || 'frag';
  let roi = Object.assign({}, ROI_DEF), roiInfo = null;
  // one pass over the labels: per piece its slice range, per-slice voxel counts and in-plane sums (the centroid of
  // any slab), bounding box, and how much of its surface lies against air
  function stats(list) {
    const r = S.red, hu = r.hu, nx = r.nx, ny = r.ny, nz = r.nz, nxy = nx * ny, A = Math.max(1, Math.round(1.7 / r.sp[0])), A3 = Math.max(1, Math.round(3 / r.sp[0]));
    const L = LB(), by = new Map();
    list.forEach(p => { p.st = { kLo: Infinity, kHi: -Infinity, n: 0, nAir3: 0, bnd: 0, bndAir: 0, sl: new Float64Array(nz * 3), box: [nx, ny, nz, -1, -1, -1] }; by.set(p.label, p.st); });
    const air = v => hu && hu[v] < -500;
    for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) {
      const l = L[v], e = by.get(l); if (!e) continue;
      if (k < e.kLo) e.kLo = k; if (k > e.kHi) e.kHi = k; e.n++;
      const b = e.box; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
      e.sl[3 * k]++; e.sl[3 * k + 1] += i; e.sl[3 * k + 2] += j;
      if ((i >= A3 && air(v - A3)) || (i + A3 < nx && air(v + A3)) || (j >= A3 && air(v - A3 * nx)) || (j + A3 < ny && air(v + A3 * nx))) e.nAir3++;
      const bd = (i > 0 && L[v - 1] !== l) || (i < nx - 1 && L[v + 1] !== l) || (j > 0 && L[v - nx] !== l) || (j < ny - 1 && L[v + nx] !== l) || (k > 0 && L[v - nxy] !== l) || (k < nz - 1 && L[v + nxy] !== l);
      if (!bd) continue;
      e.bnd++;
      let near = false;
      for (let s = 1; s <= A && !near; s++) near = (i >= s && air(v - s)) || (i + s < nx && air(v + s)) || (j >= s && air(v - s * nx)) || (j + s < ny && air(v + s * nx));
      if (near) e.bndAir++;
    }
    list.forEach(p => { const e = p.st; p.kLo = e.kLo; p.kHi = e.kHi; p.airFrac = e.n ? e.nAir3 / e.n : 0; p.skinFrac = e.bnd ? e.bndAir / e.bnd : 0; });
  }
  const wOf = (r, i, j, k) => (r.origin ? G.worldOf(r, i, j, k) : [i * r.sp[0], j * r.sp[1], k * r.sp[2]]);
  // in-plane centroid (world) of a piece's slices ka..kb
  function slabC(p, ka, kb) {
    const r = S.red, sl = p.st.sl; let n = 0, si = 0, sj = 0;
    for (let k = Math.max(0, Math.min(ka, kb)); k <= Math.min(r.nz - 1, Math.max(ka, kb)); k++) { n += sl[3 * k]; si += sl[3 * k + 1]; sj += sl[3 * k + 2]; }
    if (!n) return null;
    return V(...wOf(r, si / n, sj / n, (ka + kb) / 2));
  }
  // smallest distance (mm) from piece p to each of the labels in `to`, looked for up to R mm away (else Infinity)
  function gaps(p, to, R = 10) {
    const r = S.red, L = LB(), b = p.st.box, pad = [0, 1, 2].map(a => Math.ceil(R / r.sp[a]) + 1);
    const lo = [0, 1, 2].map(a => Math.max(0, b[a] - pad[a])), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, b[a + 3] + pad[a]));
    const cx = hi[0] - lo[0] + 1, cy = hi[1] - lo[1] + 1, cz = hi[2] - lo[2] + 1, m = new Uint8Array(cx * cy * cz), out = new Map(to.map(l => [l, Infinity]));
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) { const row = lo[0] + r.nx * (lo[1] + j + r.ny * (lo[2] + k)), o = cx * (j + cy * k); for (let i = 0; i < cx; i++) if (L[row + i] === p.label) m[o + i] = 1; }
    const d = G.sdf(m, cx, cy, cz, r.sp);
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) { const row = lo[0] + r.nx * (lo[1] + j + r.ny * (lo[2] + k)), o = cx * (j + cy * k); for (let i = 0; i < cx; i++) { const l = L[row + i]; if (out.has(l) && d[o + i] < out.get(l)) out.set(l, d[o + i]); } }
    out.forEach((v, l) => { if (v > R) out.set(l, Infinity); });
    return out;
  }
  // names every piece of `list` and decides the region kept; returns the side of the ankle ('R', 'L' or '')
  // pieces outside the region (or on the other leg) get role 'roi' / 'side' and are left out by build()
  // prev: the last build's pieces (label -> { role, size }); a tibia, fibula or talus whose voxels did not change (a hand
  // split or an edit of another piece) keeps its role instead of being guessed again
  function names(list, want = roi, prev = null) {
    const r = S.red, sp = r.sp[2];
    stats(list);
    const info = { bilateral: false, side: '', mid: null, kDome: null, up: 1, outRoi: 0, otherSide: 0, talus: false };
    list.forEach(p => { p.role = ''; p.name = ''; if (p.skinFrac > 0.25 || p.airFrac > 0.5) { p.name = 'Atel / dış nesne'; p.role = 'out'; } });
    const len = p => (p.kHi - p.kLo) * sp;
    // a CT of both legs: two long pieces of about the same size far apart side to side; the leg with more pieces
    // (the fracture's fragments) is planned unless the user chose a side. Patient right is -x (LPS).
    const long = list.filter(p => !p.role && len(p) > 40).sort((a, b) => b.size - a.size);
    if (long.length >= 3 && long[1].size > 0.5 * long[0].size && Math.abs(long[0].c.x - long[1].c.x) > 60) {
      const mid = (long[0].c.x + long[1].c.x) / 2, sideOf = p => (p.c.x < mid ? 'R' : 'L');
      const cnt = { R: 0, L: 0 }; list.forEach(p => { if (!p.role) cnt[sideOf(p)]++; });
      info.bilateral = true; info.mid = mid; info.side = want.side === 'R' || want.side === 'L' ? want.side : cnt.L > cnt.R ? 'L' : 'R';
      list.forEach(p => { if (p.role !== 'out' && sideOf(p) !== info.side) { p.role = 'side'; p.name = 'Diğer kemik'; info.otherSide++; } });
      // the other leg's tibia and fibula (the two longest of its pieces, the larger the tibia): the mirror template (ankmirror.js)
      const os = list.filter(p => p.role === 'side' && len(p) > 25).sort((a, b) => len(b) - len(a)).slice(0, 2).sort((a, b) => b.size - a.size);
      info.other = os.map(p => ({ label: p.label, role: p === os[0] ? 'tibia' : 'fibula', c: p.c.clone() }));
    }
    const keepR = role => { if (!prev) return null; const p = list.find(x => !x.role && prev.has(x.label) && prev.get(x.label).role === role && Math.abs(x.size - prev.get(x.label).size) <= 0.02 * prev.get(x.label).size); if (p) { p.role = role; p.name = { tibia: 'Tibia', fibula: 'Fibula', talus: 'Talus' }[role]; } return p || null; };
    let tib = keepR('tibia'), fib = keepR('fibula');
    const keptTal = keepR('talus');
    const nearSh = (a, b) => Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) < 60;
    if (!tib || !fib) {
      const sh = list.filter(p => !p.role && len(p) > 25).sort((a, b) => len(b) - len(a)).slice(0, (tib ? 0 : 1) + (fib ? 0 : 1)).sort((a, b) => b.size - a.size);
      if (!tib && !fib) { tib = sh[0] || null; fib = sh[1] && nearSh(sh[1], sh[0]) ? sh[1] : null; }
      else if (!tib) tib = sh[0] && nearSh(sh[0], fib) ? sh[0] : null;
      else fib = sh[0] && nearSh(sh[0], tib) ? sh[0] : null;
    }
    if (tib) { tib.name = 'Tibia'; tib.role = 'tibia'; }
    if (fib) { fib.name = 'Fibula'; fib.role = 'fibula'; }
    // up (towards the knee, in slice order): the shafts leave the scan by the edge they come nearer to
    const sh = tib || fib; let up = 1;
    if (sh) up = sh.kLo <= (r.nz - 1 - sh.kHi) ? -1 : 1;
    info.up = up;
    const distalK = p => (up > 0 ? p.kLo : p.kHi), proxK = p => (up > 0 ? p.kHi : p.kLo);
    // the talus: the largest piece over 5 cm³ that touches the tibia, with its centre below the tibia's middle
    const g = new Map();
    const gapsOf = p => { if (!g.has(p.label)) g.set(p.label, gaps(p, [tib, fib].filter(Boolean).map(x => x.label))); return g.get(p.label); };
    let tal = keptTal;
    if (tib && !tal) {
      const kMid = (tib.kLo + tib.kHi) / 2, below = p => (up > 0 ? kOfC(p) < kMid : kOfC(p) > kMid);
      const cand = list.filter(p => !p.role && p.cm3 > 5 && below(p)).sort((a, b) => b.size - a.size);
      for (const p of cand) { if (gapsOf(p).get(tib.label) <= NEAR_TAL) { tal = p; break; } }
    }
    if (tal) { tal.name = 'Talus'; tal.role = 'talus'; info.talus = true; }
    // the ankle level and the region kept
    const kD = tal ? proxK(tal) : tib ? distalK(tib) : fib ? distalK(fib) : null;
    info.kDome = kD;
    if (kD != null) {
      const k0 = kD - up * want.below / sp, k1 = kD + up * want.above / sp, kl = Math.min(k0, k1), kh = Math.max(k0, k1);
      info.kLo = kl; info.kHi = kh;
      list.forEach(p => {
        if (p.role === 'out' || p.role === 'side' || p === tib || p === fib || p === tal) return;
        let n = 0; for (let k = Math.max(0, Math.ceil(kl)); k <= Math.min(r.nz - 1, Math.floor(kh)); k++) n += p.st.sl[3 * k];
        if (n < IN_ROI * p.st.n) { p.role = 'roi'; p.name = 'Diğer kemik'; info.outRoi++; }
      });
    }
    // fracture fragments: near the tibia or the fibula; named against the distal tibia (its last 25 mm)
    const kT = tib ? distalK(tib) : null, tc = tib ? slabC(tib, kT, kT + up * 25 / sp) || tib.c : null, fc = fib ? slabC(fib, distalK(fib), distalK(fib) + up * 25 / sp) || fib.c : null;
    const lat = tc && fc ? V().subVectors(fc, tc).setZ(0).normalize() : null, post = lat ? V(-lat.y, lat.x, 0) : null;
    if (post && post.y < 0) post.negate();     // posterior is +y in LPS
    let n = 0;
    list.filter(p => !p.role).forEach(p => {
      const gp = tib || fib ? gapsOf(p) : new Map(), dT = tib ? gp.get(tib.label) : Infinity, dF = fib ? gp.get(fib.label) : Infinity;
      p.gapT = dT; p.gapF = dF;
      if (!(Math.min(dT, dF) <= NEAR_FRAG)) { p.name = 'Diğer kemik'; p.role = 'other'; return; }
      p.role = 'frag';
      if (dF < dT) { p.name = 'Lateral malleol'; return; }
      if (lat) {
        const d = V().subVectors(p.c, tc).setZ(0);
        if (-d.dot(lat) > 8) { p.name = 'Medial malleol'; return; }
        if (d.dot(post) > 6) { p.name = 'Posterior malleol'; return; }
      }
      p.name = `Parça ${++n}`;
    });
    roiInfo = info;
    // the side of the ankle: the fibula is lateral, a right ankle has it on the patient's right (-x in LPS)
    return tib && fib ? (fib.c.x < tib.c.x ? 'R' : 'L') : '';
    function kOfC(p) { let s = 0, w = 0; for (let k = p.kLo; k <= p.kHi; k++) { s += k * p.st.sl[3 * k]; w += p.st.sl[3 * k]; } return w ? s / w : (p.kLo + p.kHi) / 2; }
  }
  // all the threshold components of the current labels (app.js keeps them all for the ankle; the list it shows is capped)
  const comps0 = () => (S.compsAll && S.compsAll.labels === S.labels ? S.compsAll.comps : S.comps) || [];
  // ---------- brush and eraser edits (segedit.js, saved with the plan) on the pieces (plan M1.3) ----------
  // The pieces are the labels with the edits laid over: an erased voxel leaves its piece; an added voxel joins the piece
  // it touches (grown out from the pieces through the added voxels), added voxels touching no piece are new pieces.
  // labVer counts in-place label changes (a split by hand), so the view is rebuilt.
  let lv = null, labVer = 0, lastRed = null;
  function view() {
    const src = S.labels, c0 = comps0(), E = window.SegEdit && SegEdit.edits ? SegEdit.edits() : null;
    if (!src || !E || E.add.length !== src.length) return { L: src, comps: c0 };
    const key = SegEdit.key() + '|' + labVer + '|' + c0.length;
    if (lv && lv.src === src && lv.key === key) return lv;
    const r = S.red, nx = r.nx, nxy = r.nx * r.ny, N = src.length, L = src.slice(), known = new Set(c0.map(c => c.label));
    let maxL = 0; for (let v = 0; v < N; v++) { if (E.del[v]) L[v] = 0; if (L[v] > maxL) maxL = L[v]; }
    const q = [], nbr = v => [v % nx > 0 ? v - 1 : -1, v % nx < nx - 1 ? v + 1 : -1, ((v / nx) | 0) % r.ny > 0 ? v - nx : -1, ((v / nx) | 0) % r.ny < r.ny - 1 ? v + nx : -1, v >= nxy ? v - nxy : -1, v + nxy < N ? v + nxy : -1];
    for (let v = 0; v < N; v++) if (E.add[v] && !known.has(L[v])) { L[v] = 0; for (const u of nbr(v)) if (u >= 0 && !E.add[u] && known.has(L[u])) { L[v] = L[u]; q.push(v); break; } }
    for (let h = 0; h < q.length; h++) { const v = q[h]; for (const u of nbr(v)) if (u >= 0 && E.add[u] && !L[u]) { L[u] = L[v]; q.push(u); } }
    // added voxels touching no piece: new pieces
    const left = new Uint8Array(N); let any = false; for (let v = 0; v < N; v++) if (E.add[v] && !L[v]) { left[v] = 1; any = true; }
    if (any) { const cc = G.components(left, r.nx, r.ny, r.nz, 1); for (let v = 0; v < N; v++) if (cc.labels[v]) { L[v] = maxL + cc.labels[v]; known.add(L[v]); } }
    const acc = new Map(); for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < nx; i++, v++) {
      const l = L[v]; if (!l || !known.has(l)) continue; let e = acc.get(l); if (!e) acc.set(l, e = [0, 0, 0, 0]); e[0]++; e[1] += i; e[2] += j; e[3] += k;
    }
    const comps = [...acc.entries()].map(([label, e]) => ({ label, size: e[0], centroid: [e[1] / e[0], e[2] / e[0], e[3] / e[0]] })).sort((a, b) => b.size - a.size);
    lv = { src, key, L, comps }; return lv;
  }
  const LB = () => view().L, allComps = () => view().comps;

  // ---------- a piece cut in two by hand (plan M1.2) ----------
  // Two points, one on each side of the fracture line, in CT position. The piece's voxels go to the nearer point along
  // the cheapest path through dense bone (G.splitSeeds), so the cut settles in the low-density fracture line. The points
  // are saved with the plan and laid on the labels again after a new segmentation (a split already made is skipped).
  let splits = [], splitMode = null, pendSplit = null;
  const vecOk = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  function labelNear(r, L, w) {
    const c = G.indexOf(r, [w.x, w.y, w.z]).map(Math.round), votes = new Map();
    for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = c[0] + di, j = c[1] + dj, k = c[2] + dk; if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) continue;
      const l = L[i + r.nx * (j + r.ny * k)]; if (l > 0) votes.set(l, (votes.get(l) || 0) + 1 / (1 + di * di + dj * dj + dk * dk));
    }
    return votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
  }
  // returns the two labels, or null when the points are not on one piece
  function splitLabels(a, b) {
    const r = S.red, L = S.labels; if (!r || !L) return null;
    const la = labelNear(r, L, a), lb = labelNear(r, L, b); if (!la || la !== lb) return null;
    const N = L.length, dom = new Uint8Array(N), seeds = new Uint8Array(N);
    for (let v = 0; v < N; v++) if (L[v] === la) dom[v] = 1;
    [a, b].forEach((w, s) => {
      const c = G.indexOf(r, [w.x, w.y, w.z]), rad = r.sp.map(x => Math.ceil(2.5 / x));
      for (let k = Math.round(c[2]) - rad[2]; k <= Math.round(c[2]) + rad[2]; k++) for (let j = Math.round(c[1]) - rad[1]; j <= Math.round(c[1]) + rad[1]; j++) for (let i = Math.round(c[0]) - rad[0]; i <= Math.round(c[0]) + rad[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) continue;
        const v = i + r.nx * (j + r.ny * k); if (dom[v] && Math.hypot((i - c[0]) * r.sp[0], (j - c[1]) * r.sp[1], (k - c[2]) * r.sp[2]) <= 2.5) seeds[v] = s + 1;
      }
    });
    const thr = +($('thr') ? $('thr').value : THR_ANKLE), { lab } = G.splitSeeds(r, dom, seeds, thr, thr + 1000);
    let maxL = 0; for (let v = 0; v < N; v++) if (L[v] > maxL) maxL = L[v];
    const nl = maxL + 1, acc = { [la]: [0, 0, 0, 0], [nl]: [0, 0, 0, 0] };
    for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) {
      if (!dom[v]) continue; if (lab[v] === 2) L[v] = nl; const e = acc[L[v]]; e[0]++; e[1] += i; e[2] += j; e[3] += k;
    }
    if (!acc[nl][0] || !acc[la][0]) { for (let v = 0; v < N; v++) if (L[v] === nl) L[v] = la; return null; }
    const cs = S.compsAll && S.compsAll.labels === L ? S.compsAll.comps : S.comps, mk = l => ({ label: +l, size: acc[l][0], centroid: [acc[l][1] / acc[l][0], acc[l][2] / acc[l][0], acc[l][3] / acc[l][0]] });
    const at = cs.findIndex(c => c.label === la); if (at >= 0) cs.splice(at, 1, mk(la), mk(nl)); else cs.push(mk(la), mk(nl));
    cs.sort((x, y) => y.size - x.size);
    labVer++;
    return [la, nl];
  }
  const applySplits = () => splits.forEach(s => splitLabels(V(...s.a), V(...s.b)));
  // the user's two clicks (world points on the shown pieces, taken back to the CT position of the clicked piece)
  function splitPiece(i, wa, wb) {
    const p = pieces[i]; if (!p) return false;
    const a = toOwn(p, wa), b = toOwn(p, wb), keep = { t: p.t.clone(), q: p.q.clone() };
    const ls = splitLabels(a, b); if (!ls) return false;
    splits.push({ a: r3(a), b: r3(b) });
    pendSplit = { labels: ls, t: keep.t, q: keep.q };
    unapprove(); pend = planGet(); built = ''; build();
    return true;
  }
  const sigOf = () => S.labels && S.comps ? allComps().map(c => `${c.label}:${c.size}`).join(',') + '|' + S.red.nx + 'x' + S.red.ny + 'x' + S.red.nz + '|' + roi.above + ',' + roi.below + ',' + roi.side + '|' + labVer : '';

  async function build() {
    if (!on() || !S.red || !S.labels || !S.comps) return;
    if (splits.length) applySplits();
    const sig = sigOf(); if (sig === built && pieces.length) { show(); return; }
    const job = buildJob = {}, r = S.red, vox = r.sp[0] * r.sp[1] * r.sp[2] / 1000;
    const prevRoles = pieces.length && lastRed === r ? new Map(pieces.map(p => [p.label, { role: p.role, size: p.size }])) : null;
    lastRed = r;
    // a rebuild of the same case (new threshold, a split, an edit): the motions go with the pieces that match them
    if (pieces.length && prevRoles && !pend) pend = planGet();
    drop();
    const mk = c => ({ label: c.label, size: c.size, cm3: c.size * vox, c: V(...G.worldOf(r, ...c.centroid)) });
    const all = allComps(), cand = all.filter(c => c.size * vox >= LIM.minCm3).map(mk);
    const side = autoSide = names(cand, roi, prevRoles);
    // the pieces shown: the named bones first, then fragments and the rest by size, at most MAXP
    const rank = { tibia: 0, fibula: 1, talus: 2, frag: 3, other: 4, out: 5 };
    const keep = cand.filter(p => p.role !== 'roi' && p.role !== 'side').sort((a, b) => (rank[a.role] - rank[b.role]) || b.size - a.size);
    const list = keep.slice(0, MAXP);
    // pieces too small to show (under LIM.minCm3) inside the region and near the tibia or fibula may be fragments: counted
    const tf = list.filter(p => p.role === 'tibia' || p.role === 'fibula').map(p => p.label), small = all.filter(c => c.size * vox < LIM.minCm3).map(mk);
    let nSmall = 0;
    if (tf.length && small.length && roiInfo && roiInfo.kDome != null) {
      stats(small);
      small.forEach(p => { const kc = (p.kLo + p.kHi) / 2; if (kc < roiInfo.kLo || kc > roiInfo.kHi) return; const g = gaps(p, tf, NEAR_FRAG); if ([...g.values()].some(d => d <= NEAR_FRAG)) nSmall++; });
    }
    if (roiInfo) { roiInfo.capped = keep.length - list.length; roiInfo.small = nSmall; }
    list.forEach(p => { delete p.st; });
    if (!meta.side && side) meta.side = side;
    St.busy(true, xl('Kırık parçaları hazırlanıyor…')); await St.sleep();
    try {
      // one pass for every piece's bounding box; each piece is then meshed and measured on its own box only
      const box = new Map(list.map(p => [p.label, [r.nx, r.ny, r.nz, -1, -1, -1]])), L = LB();
      for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) {
        const b = box.get(L[v]); if (!b) continue;
        if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
      }
      let fi = 0;
      for (const p of list) {
        const b = box.get(p.label), PAD = Math.max(6, Math.ceil(10 / Math.min(...r.sp))), lo = [0, 1, 2].map(a => Math.max(0, b[a] - PAD)), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, b[a + 3] + PAD));
        const [cx, cy, cz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), m = new Uint8Array(cx * cy * cz);
        for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) { const row = lo[0] + r.nx * (lo[1] + j + r.ny * (lo[2] + k)), o = cx * (j + cy * k); for (let i = 0; i < cx; i++) if (L[row + i] === p.label) m[o + i] = 1; }
        const crop = { m: m.slice(), lo, nx: cx, ny: cy, nz: cz };
        const net = await St.blurNetsOf(m, cx, cy, cz);
        if (job !== buildJob) return;
        p.color = p.role === 'frag' ? PALETTE[fi++ % PALETTE.length] : FIXED;
        const mat = new T.MeshStandardMaterial({ color: p.color, roughness: 0.7, metalness: 0, side: T.DoubleSide });
        p.mesh = St.meshFromNets(net, (x, y, z) => St.toWorldRed(x + lo[0], y + lo[1], z + lo[2]), mat); p.mesh.position.copy(p.c).negate(); p.mesh.userData.ankle = p;
        p.pivot = new T.Group(); p.pivot.add(p.mesh); p.t = V(); p.q = new T.Quaternion(); place(p);
        p.sdf = await sdfOf(crop);
        if (job !== buildJob) return;
      }
      pieces = list; built = sig; sel = pieces.findIndex(p => p.role === 'frag');
      pieces.forEach((p, i) => St.setPart('ank' + i, p.name, p.pivot, p.color));
      if (pend) { const x = pend; pend = null; restore(x); }
      if (pendSplit) { const ps = pendSplit; pendSplit = null; pieces.forEach((p, k) => { if (ps.labels.includes(p.label)) setMotion(k, ps.t, ps.q, false); }); }
      show(); measure(); render(); renderRoi(); St.renderParts(); St.emit('ankPieces'); St.emit('changed');
      if (window.MPR) MPR.redraw();
    } finally { if (job === buildJob) { buildJob = null; St.busy(false); } }
  }
  function drop() { Object.keys(St.parts).filter(k => /^ank\d/.test(k)).forEach(k => St.setPart(k, null, null)); pieces = []; built = ''; sel = -1; metrics = []; attach(); }
  // signed distance (mm, outside > 0) of a piece on its bounding box + 10 mm (at least 6 voxels): the measurements and
  // the joint landmarks (anklm.js: a medial gutter is 3-5 mm wide) sample it
  async function sdfOf(c) {
    const r = S.red, { nx, ny, nz } = c;
    let d = null; const p = St.bg && St.bg('ank', { op: 'sdf', mask: c.m, nx, ny, nz, sp: r.sp });
    if (p) try { d = await p; } catch (e) { /* the worker failed: in the page */ }
    if (!d) { await St.sleep(); d = G.sdf(c.m, nx, ny, nz, r.sp); }
    return { d, lo: c.lo, nx, ny, nz };
  }
  // trilinear sample of a piece's distance at a world point in the piece's own (CT) position; far away = +Infinity
  function sdfAt(p, q) {
    // scalar code (no arrays per call): the guide samples this a million times
    const s = p.sdf, r = S.red, o = r.origin, a = r.axes, sp = r.sp, dx = q.x - o[0], dy = q.y - o[1], dz = q.z - o[2];
    const fx = (dx * a[0][0] + dy * a[0][1] + dz * a[0][2]) / sp[0] - s.lo[0], fy = (dx * a[1][0] + dy * a[1][1] + dz * a[1][2]) / sp[1] - s.lo[1], fz = (dx * a[2][0] + dy * a[2][1] + dz * a[2][2]) / sp[2] - s.lo[2];
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= s.nx - 1 && fy <= s.ny - 1 && fz <= s.nz - 1)) return Infinity;
    const ix = Math.min(s.nx - 2, Math.floor(fx)), iy = Math.min(s.ny - 2, Math.floor(fy)), iz = Math.min(s.nz - 2, Math.floor(fz));
    const wx = fx - ix, wy = fy - iy, wz = fz - iz, nx = s.nx, nxy = s.nx * s.ny, d = s.d, b = ix + nx * iy + nxy * iz;
    const c00 = d[b] * (1 - wx) + d[b + 1] * wx, c10 = d[b + nx] * (1 - wx) + d[b + nx + 1] * wx;
    const c01 = d[b + nxy] * (1 - wx) + d[b + nxy + 1] * wx, c11 = d[b + nxy + nx] * (1 - wx) + d[b + nxy + nx + 1] * wx;
    return (c00 * (1 - wy) + c10 * wy) * (1 - wz) + (c01 * (1 - wy) + c11 * wy) * wz;
  }

  // ---------- the region kept (step Anatomi): mm under / over the talar dome, the leg on a CT of both legs ----------
  const clampR = (k, x) => Math.max(ROI_LIM[k][0], Math.min(ROI_LIM[k][1], Math.round(+x) || ROI_DEF[k]));
  function setRoi(x, edit = true) {
    const nr = { above: clampR('above', x && x.above != null ? x.above : roi.above), below: clampR('below', x && x.below != null ? x.below : roi.below), side: x && ['R', 'L'].includes(x.side) ? x.side : '' };
    if (nr.above === roi.above && nr.below === roi.below && nr.side === roi.side) return false;
    const keepPlan = pieces.length ? planGet() : null;
    roi = nr;
    if (edit) unapprove();
    if (on() && S.labels) { if (keepPlan) pend = Object.assign(keepPlan, { roi: nr }); built = ''; build(); }
    renderRoi(); if (window.MPR) MPR.redraw();
    if (edit) St.emit('changed');
    return true;
  }
  function renderRoi() {
    const box = $('ankRoi'); if (!box) return;
    if (!on()) { box.innerHTML = ''; return; }
    const ri = roiInfo, sl = (k, lbl) => `<div class="ctl"><div class="ctl-row"><label for="ankRoi_${k}">${xl(lbl)}</label><output id="ankRoi_${k}O">${roi[k]} mm</output></div><input type="range" id="ankRoi_${k}" min="${ROI_LIM[k][0]}" max="${ROI_LIM[k][1]}" step="5" value="${roi[k]}"></div>`;
    const sum = ri ? [ri.kDome == null ? xl('Ayak bileği seviyesi bulunamadı; bölge uygulanmadı.') : ri.talus ? xl('Seviye: talus kubbesi.') : xl('Seviye: tibianın alt ucu (talus bulunamadı).'),
      ri.outRoi ? xl(`${ri.outRoi} yapı bölge dışında.`) : '', ri.otherSide ? xl(`Diğer bacaktan ${ri.otherSide} yapı dışarıda.`) : ''].filter(Boolean).join(' ') : '';
    box.innerHTML = `<h3 class="sub">${xl('Ayak bileği bölgesi')}</h3>${sl('above', 'Talus kubbesinin üstü')}${sl('below', 'Talus kubbesinin altı')}
      ${ri && ri.bilateral ? `<div class="ctl"><label for="ankRoiSide" class="lbl2">${xl('Planlanan bacak')}</label><select id="ankRoiSide"><option value="">${xl('Otomatik')}</option><option value="R">${xl('Sağ')}</option><option value="L">${xl('Sol')}</option></select></div>` : ''}
      <p class="hint more">${xl('Kırık parçaları yalnız bu bölgede aranır; diz, uyluk ve ayak önü dışarıda kalır. Koronal ve sagittal kesitlerde turuncu kesikli çizgiler bölgenin sınırıdır.')}</p>${sum ? `<p class="hint">${esc(sum)}</p>` : ''}`;
    ['above', 'below'].forEach(k => { const el = $('ankRoi_' + k);
      el.addEventListener('input', () => { $('ankRoi_' + k + 'O').textContent = `${el.value} mm`; });
      el.addEventListener('change', () => setRoi({ [k]: +el.value, side: roi.side })); });
    if ($('ankRoiSide')) { $('ankRoiSide').value = roi.side; $('ankRoiSide').addEventListener('change', e => setRoi({ side: e.target.value })); }
  }
  // the region's two bounds on the coronal and sagittal slices
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, Tf, dpr, A) => {
    if (!on() || !roiInfo || roiInfo.kDome == null || !S.red || v.axis === 2 || !A.planeLine) return;
    const r = S.red, N = V(...r.axes[2]).normalize();
    [roiInfo.kLo, roiInfo.kHi].forEach(k => {
      const L = A.planeLine(v, V(...G.worldOf(r, 0, 0, k)), N); if (!L) return;
      ctx.strokeStyle = 'rgba(224,160,58,.9)'; ctx.lineWidth = 1.4 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(Tf.fx(L.a[0]), Tf.fy(L.a[1])); ctx.lineTo(Tf.fx(L.b[0]), Tf.fy(L.b[1])); ctx.stroke(); ctx.setLineDash([]);
      A.label(ctx, xl('Bölge sınırı'), Tf.fx(L.a[0]) + 6 * dpr, Tf.fy(L.a[1]) - 4 * dpr, '#e0a03a', dpr);
    });
  });

  // ---------- the rigid motion of a piece ----------
  function place(p) { p.pivot.position.copy(p.c).add(p.t); p.pivot.quaternion.copy(p.q); p.pivot.updateMatrixWorld(true); }
  const moved = p => p.t.lengthSq() > 1e-8 || Math.abs(p.q.w) < 1 - 1e-10;
  const angleOf = q => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
  const toWorld = (p, q0) => q0.clone().sub(p.c).applyQuaternion(p.q).add(p.c).add(p.t);
  const toOwn = (p, w) => w.clone().sub(p.c).sub(p.t).applyQuaternion(p.q.clone().invert()).add(p.c);
  function unapprove() { if (red.ok) red = { ok: false }; unmatched = []; }
  // a piece moved by the gizmo, the API or a restored plan; edit = a user change (drops the approval, one history step)
  function setMotion(i, t, q, edit = true) {
    const p = pieces[i]; if (!p) return;
    p.t.copy(t); p.q.copy(q).normalize(); place(p);
    if (edit) { unapprove(); measure(); render(); St.emit('changed'); }
    St.render();
  }
  function reset(i) { if (i == null) pieces.forEach((p, k) => setMotion(k, V(), new T.Quaternion(), false)); else setMotion(i, V(), new T.Quaternion(), false); unapprove(); measure(); render(); St.emit('changed'); }

  // ---------- measurements ----------
  // For every piece, its surface (up to ~3000 vertices, area-weighted) is moved to its reduced position and sampled in
  // the distance field of every other piece (taken back into that piece's own position). Near = within LIM.near mm.
  // The partner is the piece with the largest near area (the other side of the fracture, or the joint partner).
  // contact: area within ±LIM.contact mm; gap: area-weighted mean distance over the near area outside the partner;
  // overlap: deepest point of the surface inside the partner.
  function measure() {
    metrics = pieces.map((p, i) => {
      if (p.role === 'out') return { i, name: p.name, role: p.role, moved: moved(p), dist: p.t.length(), ang: angleOf(p.q), partner: -1, contact: 0, gap: null, over: 0, overWith: -1 };
      const g = p.mesh.geometry, P = g.attributes.position.array, I = g.index.array, nv = P.length / 3, area = new Float32Array(nv);
      const a = V(), b = V(), c = V();
      for (let t = 0; t < I.length; t += 3) { a.fromArray(P, I[t] * 3); b.fromArray(P, I[t + 1] * 3); c.fromArray(P, I[t + 2] * 3); const A = b.sub(a).cross(c.sub(a)).length() / 6; area[I[t]] += A; area[I[t + 1]] += A; area[I[t + 2]] += A; }
      const step = Math.max(1, Math.floor(nv / 3000)), per = pieces.map(() => ({ near: 0, contact: 0, gapSum: 0, gapA: 0, over: 0 }));
      const q0 = V();
      for (let v = 0; v < nv; v += step) {
        q0.fromArray(P, v * 3); const w = toWorld(p, q0), A = area[v] * step;
        pieces.forEach((o, j) => {
          if (j === i || o.role === 'out') return;
          const s = sdfAt(o, toOwn(o, w)); if (!(s < LIM.near)) return;
          const m = per[j]; m.near += A; if (Math.abs(s) <= LIM.contact) m.contact += A;
          if (s > 0) { m.gapSum += s * A; m.gapA += A; } else if (-s > m.over) m.over = -s;
        });
      }
      let best = -1; per.forEach((m, j) => { if (j !== i && m.near > 0 && (best < 0 || m.near > per[best].near)) best = j; });
      const m = best >= 0 ? per[best] : null;
      return { i, name: p.name, role: p.role, moved: moved(p), dist: p.t.length(), ang: angleOf(p.q), partner: best,
        contact: m ? m.contact : 0, gap: m && m.gapA ? m.gapSum / m.gapA : null, over: Math.max(0, ...per.map((x, j) => (j === i ? 0 : x.over))),
        overWith: per.reduce((k, x, j) => (j !== i && x.over > (k < 0 ? 0 : per[k].over) ? j : k), -1) };
    });
  }
  function checks() {
    if (!on() || !pieces.length) return [];
    const out = [];
    metrics.forEach(m => {
      if (m.role !== 'frag') return;
      const with_ = m.overWith >= 0 ? pieces[m.overWith].name : '';
      if (m.over >= LIM.overlapCrit) out.push(['crit', 'Kritik', xl(`${m.name}, ${with_} ile ${fmt(m.over, 1)} mm iç içe geçiyor; iki kemik aynı yeri dolduramaz. Parçayı geri çekin.`), 'ank']);
      else if (m.over >= LIM.overlapWarn) out.push(['warn', 'Uyarı', xl(`${m.name}, ${with_} ile ${fmt(m.over, 1)} mm iç içe; kırık yüzeyleri ezilmiş olabilir, kontrol edin.`), 'ank']);
      if (m.gap != null && m.gap > LIM.gapWarn && m.partner >= 0) out.push(['warn', 'Uyarı', xl(`${m.name} ile ${pieces[m.partner].name} arasında ortalama ${fmt(m.gap, 1)} mm aralık var.`), 'ank']);
    });
    if (unmatched.length) out.push(['warn', 'Uyarı', xl(`Kayıtlı planda ${unmatched.length} parçanın hareketi bugünkü parçalarla eşleşmedi (${unmatched.join(', ')}); bu parçalar BT konumunda. Segmentasyon değişmiş olabilir; redüksiyonu kontrol edin.`), 'ank']);
    if (!pieces.some(moved)) out.push(['info', 'Bilgi', xl('Henüz hiçbir parça taşınmadı; redükte model BT\'deki konumla aynı.'), 'ank']);
    const ri = roiInfo;
    if (ri) {
      if (ri.small) out.push(['warn', 'Uyarı', xl(`Tibia ya da fibulanın yakınında 0,2 cm³'ten küçük ${ri.small} parça var; listede gösterilmiyor. Küçük bir kırık parçası olabilir, kesitlerde kontrol edin.`), 'ank']);
      if (ri.capped) out.push(['warn', 'Uyarı', xl(`${ri.capped} parça liste sınırını (${MAXP}) aştığı için gösterilmiyor; Anatomi adımında ayak bileği bölgesini daraltın.`), 'ank']);
      if (ri.bilateral) out.push(['info', 'Bilgi', xl(`İki bacaklı BT: ${ri.side === 'R' ? 'sağ' : 'sol'} bacak planlanıyor, diğer bacak dışarıda. Anatomi adımında "Planlanan bacak" ile değiştirilebilir.`), 'ank']);
      if (!pieces.some(p => p.role === 'tibia')) out.push(['warn', 'Uyarı', xl('Tibia bulunamadı; parça adlarını elle verin.'), 'ank']);
      else if (!ri.talus) out.push(['warn', 'Uyarı', xl('Talus bulunamadı (tibiaya değen büyük kemik yok); ayak bileği seviyesi tibianın alt ucundan alındı. Adları kontrol edin.'), 'ank']);
    }
    return out;
  }
  // the checks list while the case is an ankle (app.js renderChecks hands over when there is no mandible guide)
  function renderChecks() {
    const out = checks();
    (window.ExtraChecks || []).forEach(f => { try { f().forEach(c => out.push(c)); } catch (e) { /* optional */ } });
    S.crit = out.filter(o => o[0] === 'crit').length; S.checkList = out.slice();
    const rank = { crit: 0, warn: 1, ok: 2 }, infos = out.filter(o => o[0] === 'info'), main = out.filter(o => o[0] !== 'info').sort((a, b) => (rank[a[0]] ?? 3) - (rank[b[0]] ?? 3));
    if (!main.length) main.push(['ok', 'Uygun', 'Tüm kontroller geçti.']);
    const li = ([c, t, m]) => `<li class="${c}"><b>${t}</b><span>${esc(m)}</span></li>`, n = c => out.filter(o => o[0] === c).length;
    if ($('checks')) $('checks').innerHTML = main.map(li).join('');
    if ($('checksInfo')) $('checksInfo').innerHTML = infos.map(li).join('');
    if ($('chkInfoN')) $('chkInfoN').textContent = infos.length || '';
    if ($('chkInfo')) $('chkInfo').hidden = !infos.length;
    if ($('chkSum')) { $('chkSum').innerHTML = (n('crit') ? `<span class="tag crit">${n('crit')} kritik</span>` : '') + (n('warn') ? `<span class="tag warn">${n('warn')} uyarı</span>` : ''); $('chkSum').hidden = !$('chkSum').innerHTML; }
    const box = $('ankWarn'); if (box) { const mine = out.filter(o => o[3] === 'ank' && (o[0] === 'crit' || o[0] === 'warn')); box.innerHTML = mine.length ? `<ul class="checks">${mine.map(li).join('')}</ul>` : ''; }
  }

  // ---------- 3D: which model is shown, the gizmo, picking a piece ----------
  const anatOpen = () => !!($('st2') && $('st2').open);
  function show() {
    if (!on() || !pieces.length) return;
    const frag = !anatOpen(), b = St.parts.bone;
    if (b) { b.visible = !frag; b.obj.visible = !frag; }
    pieces.forEach((p, i) => { const pt = St.parts['ank' + i]; if (pt) { pt.visible = frag && p.role !== 'out'; pt.obj.visible = pt.visible; } });
    attach(); St.renderParts(); St.render();
  }
  let tc = null, dragging = false;
  if (T.TransformControls) {
    tc = new T.TransformControls(St.camera, St.renderer.domElement);
    tc.setSize(0.8); tc.setSpace('world'); tc.visible = false; tc.enabled = false; St.scene.add(tc);
    tc.addEventListener('change', () => St.render());
    tc.addEventListener('dragging-changed', e => {
      dragging = e.value; St.controls.enabled = !e.value;
      if (!e.value && sel >= 0 && pieces[sel]) { const p = pieces[sel]; p.t.copy(p.pivot.position).sub(p.c); p.q.copy(p.pivot.quaternion); unapprove(); measure(); render(); St.emit('changed'); }
    });
    tc.addEventListener('objectChange', () => { const p = pieces[sel]; if (p) { p.t.copy(p.pivot.position).sub(p.c); p.q.copy(p.pivot.quaternion); renderMotion(); } });
  }
  const redOpen = () => !!($('stRed') && $('stRed').open);
  function attach() {
    if (!tc) return;
    const p = on() && redOpen() && !anatOpen() ? pieces[sel] : null;
    if (p) { tc.attach(p.pivot); tc.visible = tc.enabled = true; } else { tc.detach(); tc.visible = tc.enabled = false; }
    St.render();
  }
  function setMode(m) { if (tc) tc.setMode(m); ['ankT', 'ankR'].forEach(id => $(id) && $(id).setAttribute('aria-pressed', String((id === 'ankT') === (m === 'translate')))); }
  document.addEventListener('keydown', e => {
    if (!on() || !redOpen() || sel < 0) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'w' || e.key === 'W') setMode('translate'); else if (e.key === 'e' || e.key === 'E') setMode('rotate');
  });
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = on() && redOpen() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null;
    if (!d || dragging || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4 || !pieces.length) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const h = St.ray.intersectObjects(pieces.map(p => p.mesh).filter(m => m.parent && m.parent.visible), false)[0];
    if (splitMode) {
      if (!h || pieces.indexOf(h.object.userData.ankle) !== splitMode.i) { St.alertMsg(xl('Bölünecek parçanın üstüne tıklayın.')); return; }
      splitMode.pts.push(h.point.clone());
      if (splitMode.pts.length < 2) { render(); return; }
      const m = splitMode; splitMode = null;
      if (!splitPiece(m.i, m.pts[0], m.pts[1])) St.alertMsg(xl('Parça bölünemedi: iki nokta aynı parçada olmalı ve kırık hattının iki yanında durmalı.'));
      render(); return;
    }
    if (h) choose(pieces.indexOf(h.object.userData.ankle));
  });
  function choose(i) { sel = i; attach(); render(); }
  // a piece's name (and with it its role) chosen by hand: fragments are measured and coloured, a splint is left out
  function rename(i, name, edit = true) {
    const p = pieces[i]; if (!p || !name) return;
    p.name = String(name).slice(0, 40); p.role = roleOf(p.name);
    const frag = pieces.filter(x => x.role === 'frag');
    p.color = p.role === 'frag' ? PALETTE[frag.indexOf(p) % PALETTE.length] : FIXED; p.mesh.material.color.setHex(p.color);
    const pt = St.parts['ank' + i]; if (pt) { pt.label = p.name; pt.color = p.color; }
    if (edit) { unapprove(); measure(); show(); render(); St.emit('changed'); }
  }

  // ---------- panel ----------
  function renderMotion() {
    const p = pieces[sel], box = $('ankMotion'); if (!box) return;
    if (!p) { box.innerHTML = ''; return; }
    const e = new T.Euler().setFromQuaternion(p.q, 'XYZ'), d = THREE.MathUtils.radToDeg, m = metrics[sel];
    box.innerHTML = `<dl class="kv"><dt>${xl('Öteleme (x, y, z)')}</dt><dd>${[p.t.x, p.t.y, p.t.z].map(x => fmt(x, 1)).join(' / ')} mm</dd>
      <dt>${xl('Dönme (x, y, z)')}</dt><dd>${[e.x, e.y, e.z].map(x => fmt(d(x), 1)).join(' / ')}°</dd>
      <dt>${xl('Toplam')}</dt><dd>${fmt(p.t.length(), 1)} mm · ${fmt(angleOf(p.q), 1)}°</dd>
      <dt>${xl('Hacim')}</dt><dd>${fmt(p.cm3, 1)} cm³</dd>
      <dt>${xl('Komşu kemik')}</dt><dd>${m && m.partner >= 0 ? esc(pieces[m.partner].name) : '–'}</dd>
      <dt>${xl('Temas alanı')}</dt><dd>${m && m.partner >= 0 ? fmt(m.contact, 0) + ' mm²' : '–'}</dd></dl>`;
  }
  function render() {
    const box = $('ankBody'); if (!box) return;
    if (!pieces.length) { box.innerHTML = `<p class="hint">${xl('Parçalar BT yüklenip kemik ayrılınca burada listelenir.')}</p>`; renderAppr(); return; }
    const row = (p, i) => { const m = metrics[i] || {};
      return `<tr class="${i === sel ? 'on' : ''}"><td><button class="link" data-sel="${i}"><i class="dot" style="background:${hex(p.color)}"></i>${esc(p.name)}</button></td>
        <td>${m.moved ? `${fmt(m.dist, 1)} · ${fmt(m.ang, 0)}°` : '–'}</td><td>${m.gap != null ? fmt(m.gap, 1) : '–'}</td><td>${m.over ? fmt(m.over, 1) : '0'}</td></tr>`; };
    box.innerHTML = `<div class="tbl"><table><thead><tr><th>${xl('Parça')}</th><th title="${xl('Öteleme (mm) ve dönme (°)')}">${xl('Hareket')}</th><th title="${xl('Komşu kemiğe ortalama aralık (mm)')}">${xl('Aralık')}</th><th title="${xl('Komşu kemiğin içine giren en derin nokta (mm)')}">${xl('Çakışma')}</th></tr></thead>
      <tbody>${pieces.map(row).join('')}</tbody></table></div>
      <p class="hint more">${xl('Hareket: parçanın BT\'deki konumundan öteleme (mm) ve dönme. Aralık: komşu kemiğe 4 mm\'den yakın yüzeyin ortalama uzaklığı (mm). Çakışma: komşunun içine giren en derin nokta (mm). Eşikler örnektir; klinik ekip belirler.')}</p>
      <h3 class="sub">${xl('Seçili parça')}: ${pieces[sel] ? esc(pieces[sel].name) : '–'}</h3>
      ${pieces[sel] ? `<div class="ctl"><label for="ankName" class="lbl2">${xl('Ad')}</label><select id="ankName">${(NAMES.includes(pieces[sel].name) ? NAMES : [pieces[sel].name, ...NAMES]).map(n => `<option value="${esc(n)}" ${n === pieces[sel].name ? 'selected' : ''}>${esc(xl(n))}</option>`).join('')}</select></div>` : ''}
      <span class="seg tools" role="group" aria-label="${xl('Taşıma aracı')}"><button id="ankT" aria-pressed="${!tc || tc.mode === 'translate'}">${xl('Taşı (W)')}</button><button id="ankR" aria-pressed="${!!tc && tc.mode === 'rotate'}">${xl('Döndür (E)')}</button></span>
      <div id="ankMotion" class="col"></div>
      <div class="btns"><button id="ankReset" class="sm" ${pieces[sel] && moved(pieces[sel]) ? '' : 'disabled'}>${xl('Parçayı BT konumuna döndür')}</button><button id="ankResetAll" class="ghost sm" ${pieces.some(moved) ? '' : 'disabled'}>${xl('Tümünü sıfırla')}</button>
        <button id="ankSplit" class="ghost sm" aria-pressed="${!!splitMode}" ${pieces[sel] ? '' : 'disabled'}>${splitMode ? xl(`Kırık hattının iki yanına tıklayın (${splitMode.pts.length}/2)`) : xl('Parçayı ikiye böl')}</button></div>
      ${splits.length ? `<p class="hint">${xl(`Elle bölme: ${splits.length}. Plana kaydedilir; yeni segmentasyonda yeniden uygulanır.`)}</p>` : ''}
      <p class="hint more">${xl('Parçayı 3B görünümde tıklayarak ya da listeden seçin; okları sürükleyerek taşıyın, halkalarla döndürün. Ölçümler fare bırakılınca yenilenir. Kemiğe kaynaşmış bir kırık parçası için "Parçayı ikiye böl"e basıp kırık hattının iki yanına birer kez tıklayın; kemik fırçası ve silgisi (Anatomi adımı) parçaları da düzeltir.')}</p>`;
    box.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => choose(+b.dataset.sel)));
    if ($('ankName')) $('ankName').addEventListener('change', e => rename(sel, e.target.value));
    $('ankT').addEventListener('click', () => setMode('translate')); $('ankR').addEventListener('click', () => setMode('rotate'));
    $('ankReset').addEventListener('click', () => reset(sel)); $('ankResetAll').addEventListener('click', () => reset(null));
    $('ankSplit').addEventListener('click', () => { splitMode = splitMode ? null : sel >= 0 ? { i: sel, pts: [] } : null; render(); });
    renderMotion(); renderAppr(); renderChecks();
  }
  function renderMeta() {
    const box = $('ankCase'); if (!box) return;
    box.innerHTML = `<div class="ctl"><label for="ankSide" class="lbl2">${xl('Taraf')}</label><select id="ankSide"><option value="">${xl('Bilinmiyor')}</option><option value="R">${xl('Sağ ayak bileği')}</option><option value="L">${xl('Sol ayak bileği')}</option></select></div>
      <div class="ctl"><label for="ankCls" class="lbl2">${xl('Kırık tipi')}</label><select id="ankCls">${CLASSES.map(c => `<option value="${esc(c)}">${c ? esc(xl(c)) : xl('Seçilmedi')}</option>`).join('')}</select></div>
      <p class="hint more">${xl('Taraf fibulanın konumundan önerilir. Kırık tipi cerrahın seçimidir; uygulama sınıflama yapmaz.')}</p>`;
    $('ankSide').value = meta.side; $('ankCls').value = meta.cls;
    $('ankSide').addEventListener('change', e => { meta.side = e.target.value; unapprove(); St.emit('changed'); renderAppr(); });
    $('ankCls').addEventListener('change', e => { meta.cls = e.target.value; unapprove(); St.emit('changed'); renderAppr(); });
  }

  // ---------- approval (step "İnceleme ve onay") ----------
  const initials = n => (n || '').split(/\s+/).filter(w => w && !/^(dr|prof|doç|doc|op|uzm)\.?$/i.test(w)).map(w => w[0].toLocaleUpperCase('tr-TR')).slice(0, 2).join('') || '?';
  function renderAppr() {
    const box = $('ankAppr'); if (!box) return;
    if (!on() || !pieces.length) { box.innerHTML = ''; return; }
    const crit = checks().some(c => c[0] === 'crit'), qcCrit = (S.qc || []).some(q => q[0] === 'crit'), nMoved = pieces.filter(moved).length;
    box.innerHTML = `<h3 class="sub">${xl('Öğe onayları')}</h3><ul class="review">
      <li class="sum"><button class="go" data-ank-go="st1"><span class="nm">${xl('Görüntü kalitesi')}</span></button><span class="tag ${qcCrit ? 'crit' : 'ok'}">${qcCrit ? 'Kritik' : 'Uygun'}</span></li>
      <li><button class="go" data-ank-go="stRed"><span class="nm">${xl('Redüksiyon')}</span><small>${xl(`${nMoved} parça taşındı`)}${meta.cls ? ' · ' + esc(xl(meta.cls)) : ''}</small></button>
        <span class="act">${red.ok ? `<span class="badge" title="${esc(red.by || '')}"><span class="ini">${esc(initials(red.by))}</span></span>` : ''} <button id="ankOk">${red.ok ? 'Kaldır' : 'Onayla'}</button></span></li>
      ${items().map(it => { const ok = itemOk(it), stale = !ok && appr[it.k]; return `<li><button class="go" data-ank-go="${it.go}"><span class="nm">${esc(xl(it.name))}</span>${stale ? `<small>${xl('Plan değişti; yeniden onaylayın.')}</small>` : ''}</button>
        <span class="act">${ok ? `<span class="badge" title="${esc(appr[it.k].by)}"><span class="ini">${esc(initials(appr[it.k].by))}</span></span>` : ''} <button data-ank-item="${esc(it.k)}">${ok ? xl('Kaldır') : xl('Onayla')}</button></span></li>`; }).join('')}
      <li class="sum"><button class="go" data-ank-go="checks"><span class="nm">${xl('Otomatik kontroller')}</span></button><span class="tag ${crit ? 'crit' : 'ok'}">${crit ? 'Kritik' : 'Geçti'}</span></li></ul>
      <p class="hint" id="ankApprMsg"></p>`;
    box.querySelectorAll('[data-ank-go]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.ankGo; if (id === 'checks') St.goTo('data'); else if ($(id)) $(id).open = true; }));
    $('ankOk').addEventListener('click', approve);
    box.querySelectorAll('[data-ank-item]').forEach(b => b.addEventListener('click', () => approveItem(b.dataset.ankItem)));
  }
  function approve() {
    const name = $('surgeon').value.trim(), msg = t => { if ($('ankApprMsg')) $('ankApprMsg').textContent = xl(t); };
    if (red.ok) { red = { ok: false }; renderAppr(); St.emit('changed'); return; }
    if (!name) { msg('Önce onaylayan cerrahın adını yazın.'); $('surgeon').focus(); return; }
    if (checks().some(c => c[0] === 'crit')) { msg('Redüksiyonda kritik kontrol var; önce düzeltin.'); return; }
    red = { ok: true, by: name, at: new Date().toISOString(), sig: sig() };
    renderAppr(); St.emit('changed');
  }
  // the approval is bound to what was approved: the pieces' motions and the case data
  function sig() {
    const t = JSON.stringify([meta, pieces.map(p => [r3(p.c), [p.t.x, p.t.y, p.t.z].map(x => Math.round(x * 1000) / 1000), [p.q.x, p.q.y, p.q.z, p.q.w].map(x => Math.round(x * 1e5) / 1e5)])]);
    let a = 0x811c9dc5; for (let i = 0; i < t.length; i++) a = Math.imul(a ^ t.charCodeAt(i), 16777619);
    return (a >>> 0).toString(16).padStart(8, '0');
  }
  // ---------- item approvals (plan M7.1): each screw, the cutting guide, the wedge and the drill guide ----------
  // An approval is kept with what it approved (a signature of the item and of its piece's motion); when the item
  // changes the approval no longer counts ("Plan değişti"). Stamps are not part of the plan's design hash (audit.js).
  let appr = {};          // key -> { by, at, sig }
  const hsh = t => (window.Audit ? Audit.sha256(t).slice(0, 16) : String(t.length));
  const mot = p => (p ? JSON.stringify([[p.t.x, p.t.y, p.t.z].map(x => Math.round(x * 1000) / 1000), [p.q.x, p.q.y, p.q.z, p.q.w].map(x => Math.round(x * 1e5) / 1e5)]) : '');
  function items() {
    const out = [];
    if (window.AnkScrew) {
      const is = AnkScrew.issues(), sc = AnkScrew.screws();
      sc.forEach((z, k) => {
        const p = pieces.find(q => q.name === z.piece), same = sc.filter(y => y.kind === z.kind);
        out.push({ k: 'screw:' + hsh(JSON.stringify([z.kind, z.piece, z.E, z.d])), name: `${(AnkScrew.KIND[z.kind] || {}).name || 'Vida'} ${same.indexOf(z) + 1}`, go: 'stAnkS',
          sig: hsh(JSON.stringify([z.kind, z.piece, z.E, z.d, z.D, z.L]) + mot(p)), crit: is.some(i => i.id === z.id && i.lvl === 'crit') });
      });
      const dg = AnkScrew.drillInfo();
      if (dg) out.push({ k: 'drill', name: 'Matkap guide\'ı', go: 'stAnkS', sig: hsh(JSON.stringify(AnkScrew.screws().filter(z => z.piece === dg.name)) + dg.name + mot(dg.piece)), crit: AnkScrew.drillChecks().some(c => c[0] === 'crit') });
    }
    if (window.AnkGuide && AnkGuide.ready()) {
      const gs = AnkGuide.state(), o = AnkGuide.parts(), gp = pieces.find(q => q.name === gs.piece), ck = AnkGuide.checks();
      const prod = o.prod && o.prod.productionOk ? [o.prod.volume, o.prod.stl.length] : null;
      out.push({ k: 'guide', name: 'Kesi guide\'ı', go: 'stAnkG', sig: hsh(JSON.stringify([gs, prod]) + mot(gp)), crit: ck.some(c => c[0] === 'crit') });
      if (o.wedge) out.push({ k: 'wedge', name: 'Kama', go: 'stAnkG', sig: hsh(JSON.stringify([gs.P, gs.n, gs.prm.off, gs.prm.tiltA, gs.prm.tiltB, gs.prm.deg]) + mot(gp)), crit: false });
    }
    if (window.AnkPlate && AnkPlate.ready()) {
      const o = AnkPlate.parts(), gp = o.o.f.p, prod = o.prod && o.prod.productionOk ? [o.prod.volume, o.prod.stl.length] : null;
      out.push({ k: 'plate', name: 'Dış plak', go: 'stAnkG', sig: hsh(JSON.stringify([AnkPlate.state(), window.AnkGuide && AnkGuide.state(), AnkPlate.screwList(), prod]) + mot(gp)), crit: AnkPlate.checks().some(c => c[0] === 'crit') });
    }
    return out;
  }
  const itemOk = it => !!(appr[it.k] && appr[it.k].sig === it.sig);
  function approveItem(k) {
    const it = items().find(x => x.k === k); if (!it) return false;
    const name = $('surgeon') ? $('surgeon').value.trim() : '', msg = t => { if ($('ankApprMsg')) $('ankApprMsg').textContent = xl(t); };
    if (itemOk(it)) { delete appr[k]; renderAppr(); St.emit('changed'); return true; }
    if (!name) { msg('Önce onaylayan cerrahın adını yazın.'); return false; }
    if (it.crit) { msg(`${it.name}: kritik kontrol var; önce düzeltin.`); return false; }
    appr[k] = { by: name, at: new Date().toISOString(), sig: it.sig }; renderAppr(); St.emit('changed'); return true;
  }
  const allItemsOk = () => items().every(itemOk);
  (window.PlanExt = window.PlanExt || {}).ankAppr = {
    label: 'Malleol öğe onayları',
    get: () => (on() && Object.keys(appr).length ? JSON.parse(JSON.stringify(appr)) : null),
    set(x) { appr = {}; if (x && typeof x === 'object') Object.entries(x).slice(0, 60).forEach(([k, v]) => { if (/^(screw:[0-9a-f]{1,16}|guide|wedge|drill|plate)$/.test(k) && v && typeof v.by === 'string' && typeof v.sig === 'string') appr[k] = { by: v.by.slice(0, 120), at: typeof v.at === 'string' ? v.at.slice(0, 40) : '', sig: v.sig.slice(0, 40) }; }); renderAppr(); },
  };
  (window.PendingHooks = window.PendingHooks || []).push(() => (on() && pieces.length ? [...(!red.ok ? ['Redüksiyon'] : []), ...items().filter(it => !itemOk(it)).map(it => it.name)] : []));

  // ---------- outputs ----------
  // the reduced model: every piece's mesh moved to its reduced position, one STL in patient coordinates (LPS mm)
  function bakedMesh(list) {
    const ms = list.map(p => { p.pivot.updateMatrixWorld(true); const g = p.mesh.geometry.clone(); g.applyMatrix4(p.mesh.matrixWorld); return new T.Mesh(g); });
    return St.mergeMeshes(ms, new T.MeshBasicMaterial());
  }
  const fileName = s => String(s).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'parca';
  const kept = () => pieces.filter(p => p.role !== 'out');
  function reducedStl() { const m = bakedMesh(kept()), out = St.stlOf(m); m.geometry.dispose(); return out; }
  function pieceFiles() {
    const used = new Set();
    return kept().map(p => { let n = fileName(p.name); while (used.has(n)) n += '_2'; used.add(n); const m = bakedMesh([p]), data = St.stlOf(m); m.geometry.dispose(); return { name: `parcalar/${n}_redukte.stl`, data }; });
  }
  // the report's sections from the other malleolar modules (plan M8): joint measures before / after, screws, guide and
  // wedge, the sample thresholds, the print guide with its material alternatives
  const PRINT = [
    ['SLA reçine (biyouyumlu)', 'Oturma yüzü yukarı, 30-45° eğik; destek yalnız dış yüzde', 'Destek dış yüzde, oturma yüzüne değmez', 'Buhar otoklav (ör. 121 °C / 134 °C) reçine üreticisinin onayladığı programla'],
    ['PolyJet (MED610)', 'Oturma yüzü yukarı', 'Destek jeli tamamen temizlenir (delikler ve yuva dahil)', 'Otoklav uygun değil; düşük sıcaklık (EtO ya da hidrojen peroksit plazma)'],
    ['SLS PA12', 'Uzun eksen tabla düzlemine paralel', 'Destek gerekmez; delik ve yuvadan toz temizlenir', 'Buhar otoklav (121 °C / 134 °C)'],
  ];
  function reportExtra() {
    const f1 = x => (x == null ? '–' : fmt(x, 1)), out = [];
    const LMr = window.AnkLM && AnkLM.result();
    if (LMr && LMr.ct.ok && LMr.red.ok) {
      const a = LMr.ct.m, b = LMr.red.m, row = (l, x, y) => `<tr><td>${xl(l)}</td><td>${x}</td><td>${y}</td></tr>`;
      const st = b.steps.map(z => { const c = a.steps.find(y => y.name === z.name) || {}; return row(`${xl('Basamak')}: ${esc(xl(z.name))}`, f1(c.step), f1(z.step)) + row(`${xl('Aralık')}: ${esc(xl(z.name))}`, f1(c.gap), f1(z.gap)); }).join('');
      out.push(`<h2>${xl('Eklem ölçüleri')}</h2><table><tr><th>${xl('Ölçü (mm)')}</th><th>${xl('BT')}</th><th>${xl('Redükte')}</th></tr>${st}${row('Üst açıklık (SCS)', f1(a.scs), f1(b.scs))}${row('Medial açıklık (MCS)', f1(a.mcs), f1(b.mcs))}${row('Talus kayması (MCS − SCS)', f1(a.shift), f1(b.shift))}${row('Tibiofibular açıklık', f1(a.tfcs), f1(b.tfcs))}</table>`);
    }
    if (window.AnkScrew && AnkScrew.screws().length) {
      const an = AnkScrew.analyse(), is = AnkScrew.issues();
      out.push(`<h2>${xl('Vidalar')}</h2><table><tr><th>${xl('Vida')}</th><th>${xl('Giriş')}</th><th>${xl('Çap')}</th><th>${xl('Boy (mm)')}</th><th>${xl('Karşı korteks (mm)')}</th><th>${xl('Geçtiği parçalar')}</th></tr>${an.map(z => `<tr><td>${esc(xl(`${(AnkScrew.KIND[z.s.kind] || {}).name || 'Vida'} ${AnkScrew.screws().filter(y => y.kind === z.s.kind).findIndex(y => y.id === z.s.id) + 1}`))}</td><td>${esc(xl(z.s.piece))}</td><td>Ø${fmt(z.s.D, 1)}</td><td>${z.s.L}</td><td>${z.lost || z.m.exit == null ? '–' : fmt(z.m.exit, 1)}</td><td>${z.lost ? '–' : esc(z.pieces.map(xl).join(' → '))}</td></tr>`).join('')}</table>
        ${is.length ? `<ul>${is.map(i => `<li><b>${xl(i.lvl === 'crit' ? 'Kritik' : 'Uyarı')}</b> ${esc(xl(i.msg))}</li>`).join('')}</ul>` : ''}`);
    }
    const gi = window.AnkGuide && AnkGuide.ready() ? AnkGuide.info() : null;
    if (gi) {
      const q = AnkGuide.state().prm, w = gi.wedge, m = AnkGuide.MAT[q.mat] || AnkGuide.MAT.unset;
      out.push(`<h2>${xl('Kesi guide\'ı ve kama')}</h2><table>
        <tr><td>${xl('Kemik')}</td><td>${esc(xl(AnkGuide.state().piece))}</td></tr>
        <tr><td>${xl('Eklemden uzaklık')}</td><td>${gi.joint ? `${xl('kesi')} ${fmt(gi.joint.slot, 1)} mm · ${xl('teller')} ${gi.joint.pins.map(z => (z ? fmt(z.d, 1) : '–')).join(' / ')} mm` : '–'}</td></tr>
        <tr><td>${xl('Oturma')}</td><td>${gi.fit ? `p50 ${fmt(gi.fit.p50, 2)} · p99 ${fmt(gi.fit.p99, 2)} mm` : '–'} · ${xl('Temas alanı')} ${fmt(gi.contact, 0)} mm²</td></tr>
        <tr><td>${xl('Yuva boşluğu')}</td><td>${gi.play != null ? fmt(gi.play, 1) + '°' : '–'} (${xl('yuva')} ${fmt(q.kerf, 2)} mm, ${xl('bıçak')} ${fmt(q.blade, 2)} mm)</td></tr>
        <tr><td>${xl('Malzeme')}</td><td>${esc(xl(m.name))} · ${xl(q.sleeve === 'metal' ? 'Metal kovan' : 'Basılı delik')}</td></tr>
        ${w ? `<tr><td>${xl('Kama')}</td><td>${fmt(w.deg, 1)}° (${xl('STL\'de ölçülen')} ${w.measured != null ? fmt(w.measured, 2) + '°' : '–'}) · ${xl('açılma')} ${fmt(w.open, 1)} mm</td></tr>` : ''}</table>`);
    }
    const sp = window.AnkScrew ? AnkScrew.LIM : null, lm = window.AnkLM ? AnkLM.LIM : null, jg = window.AnkGuide ? AnkGuide.JOINT : null;
    out.push(`<h2>${xl('Örnek eşikler')}</h2><p class="m">${xl('Aşağıdaki eşikler literatürden örnek değerlerdir; klinik ekip belirler ve onaylar.')}</p><ul>
      ${lm ? `<li>${xl(`Eklem basamağı ve aralığı ${lm.step} mm; medial açıklık ${lm.mcs} mm; tibiofibular açıklık ${lm.tfcs} mm; posterior parça %${lm.post}`)}</li>` : ''}
      ${jg ? `<li>${xl(`Testere kesisi ve K-telleri eklem yüzeyinden en az ${jg.min} mm`)}</li>` : ''}
      ${sp ? `<li>${xl(`Vida: karşı korteksten taşma ${sp.over} mm, eklem yüzeyine ${sp.joint} mm, vidalar arası ${sp.clear} mm, karşı parçada tutunma ${sp.purchase} mm`)}</li>` : ''}
      <li>${xl(`Yuvada testere eğilmesi en çok ${St.SLOT_PLAY_MAX || 3}°`)}</li></ul>`);
    out.push(`<h2>${xl('Baskı rehberi')}</h2><p class="m">${xl('Malzeme ve yöntem henüz seçilmedi; alternatifler. Değerler tipik başlangıçtır, üretici ve hastanenin sterilizasyon birimi doğrular.')}</p>
      <table><tr><th>${xl('Malzeme')}</th><th>${xl('Yön')}</th><th>${xl('Destek')}</th><th>${xl('Sterilizasyon')}</th></tr>${PRINT.map(r => `<tr>${r.map(c => `<td>${esc(xl(c))}</td>`).join('')}</tr>`).join('')}</table>
      <p class="m">${xl('Metal kovan seçildiyse kovanlar baskıdan sonra deliklere preslenir; delik çapı kovanın dış çapı artı malzemenin geçme payıdır. Basılan guide redükte modelin üstünde denenir.')}</p>`);
    return out.join('');
  }
  function reportHTML(hashes) {
    const A = window.Audit, h = A ? A.planHash() : '', st = r => { const s = A ? A.status(r, h) : { state: 'none' }; return s.state === 'valid' ? `${xl('Onaylı')} · ${esc(s.e.name)}` : s.state === 'stale' ? xl('Plan değişti') : xl('Bekliyor'); };
    const rows = metrics.filter(m => m.role !== 'out').map(m => `<tr><td>${esc(m.name)}</td><td>${fmt(pieces[m.i].cm3, 1)}</td><td>${m.moved ? `${fmt(m.dist, 1)} mm · ${fmt(m.ang, 1)}°` : '–'}</td><td>${m.partner >= 0 ? esc(pieces[m.partner].name) : '–'}</td><td>${m.partner >= 0 ? fmt(m.contact, 0) : '–'}</td><td>${m.gap != null ? fmt(m.gap, 1) : '–'}</td><td>${fmt(m.over, 1)}</td></tr>`).join('');
    const ck = checks().map(c => `<li><b>${esc(xl(c[1]))}</b> ${esc(c[2])}</li>`).join('');
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${xl('Malleol kırığı redüksiyon raporu')}</title>
      <style>body{font:14px/1.5 Inter,system-ui,sans-serif;color:#14181c;max-width:900px;margin:32px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d5dadf;padding:6px 8px;text-align:left}small,.m{color:#5b646e}</style></head><body>
      <h1>${xl('Malleol kırığı redüksiyon raporu')}</h1><p class="m">${xl('Araştırma prototipi · klinik kullanım için değil')}</p>
      <p>${esc(St.caseLine ? St.caseLine() : '')}</p>
      <p>${xl('Taraf')}: ${meta.side === 'R' ? xl('Sağ ayak bileği') : meta.side === 'L' ? xl('Sol ayak bileği') : xl('Bilinmiyor')} · ${xl('Kırık tipi')}: ${meta.cls ? esc(xl(meta.cls)) : xl('Seçilmedi')}</p>
      <h2>${xl('Parçalar ve redüksiyon')}</h2><table><tr><th>${xl('Parça')}</th><th>cm³</th><th>${xl('Hareket')}</th><th>${xl('Komşu')}</th><th>${xl('Temas mm²')}</th><th>${xl('Aralık mm')}</th><th>${xl('Çakışma mm')}</th></tr>${rows}</table>
      ${reportExtra()}
      <h2>${xl('Kontroller')}</h2><ul>${ck || `<li>${xl('Tüm kontroller geçti.')}</li>`}</ul>
      <h2>${xl('Onay')}</h2><p>${xl('Redüksiyon')}: ${red.ok ? `${xl('Onaylı')} · ${esc(red.by)} · ${esc(red.at)}` : xl('Bekliyor')}</p>
      ${items().length ? `<ul>${items().map(it => `<li>${esc(xl(it.name))}: ${itemOk(it) ? `${xl('Onaylı')} · ${esc(appr[it.k].by)} · ${esc(appr[it.k].at)}` : appr[it.k] ? xl('Plan değişti') : xl('Bekliyor')}</li>`).join('')}</ul>` : ''}
      <p>${xl('Mühendis (teknik)')}: ${st('eng')}<br>${xl('Cerrah (klinik)')}: ${st('sur')}</p>
      ${hashes && Object.keys(hashes).length ? `<h2>${xl('Dosya özetleri (SHA-256)')}</h2><table>${Object.entries(hashes).map(([n, h]) => `<tr><td>${esc(n)}</td><td><code>${h}</code></td></tr>`).join('')}</table>` : ''}<p class="m"><small>${xl('Plan özeti (SHA-256):')} ${h}</small></p>
      <p class="m"><small>${xl('Redükte model, parçaların planlanan konumdaki yüzeyleridir (LPS, mm). Plak ön bükme ve eğitim için; doğruluk klinik olarak doğrulanmadı.')}</small></p></body></html>`;
  }
  const packReady = () => { const A = window.Audit; if (!A || !on() || !pieces.length) return false; const h = A.planHash(); return red.ok && allItemsOk() && A.status('eng', h).ok && A.status('sur', h).ok && !S.crit; };
  function renderOut() {
    const box = $('ankOut'); if (!box) return;
    const ready = packReady(), why = [];
    if (!pieces.length) why.push(xl('parça yok'));
    else { if (!red.ok) why.push(xl('redüksiyon onayı')); items().filter(it => !itemOk(it)).forEach(it => why.push(`${xl(it.name)} ${xl('onayı')}`)); const A = window.Audit, h = A ? A.planHash() : ''; if (A && !A.status('eng', h).ok) why.push(xl('mühendis onayı')); if (A && !A.status('sur', h).ok) why.push(xl('cerrah onayı')); if (S.crit) why.push(xl(`${S.crit} kritik kontrol`)); }
    box.innerHTML = `<ol class="deliver">
      <li><div><b>${xl('Redükte model STL\'i')}</b><p class="hint">${xl('Bütün parçalar planlanan konumda, tek dosya. Plak ön bükme için basılabilir; onay gerektirmez.')}</p></div><button id="ankStl" ${pieces.length ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>${xl('İndir')}</button></li>
      ${window.AnkGuide && AnkGuide.ready() ? `<li><div><b>${xl('Kesi guide\'ı ve kama')}</b><p class="hint">${xl('Üretim STL\'i alındıysa o, alınmadıysa tarayıcı önizlemesi ("BASMAYIN" adıyla) ve kama; redükte modelle aynı koordinatta. Pakete de girer.')}</p></div><button id="ankGStl">${xl('İndir')}</button></li>` : ''}
      <li><div><b>${xl('Parça STL\'leri')}</b><p class="hint">${xl('Her parça ayrı dosya (redükte konumda), .zip içinde.')}</p></div><button id="ankParts" ${pieces.length ? '' : 'disabled'}>${xl('İndir')}</button></li>
      <li><div><b>${xl('Rapor')}</b><p class="hint">${xl('Parçalar, ölçümler, kontroller ve onaylar.')}</p></div><button id="ankRep" ${pieces.length ? '' : 'disabled'}>HTML</button></li>
      <li><div><b>${xl('Paket')}</b><p class="hint" id="ankPackMsg">${ready ? xl('Plan onaylı; paket hazır.') : `${xl('Paket için:')} ${why.join(', ')}.`}</p></div><button class="primary" id="ankPack" ${ready ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>${xl('İndir')}</button></li></ol>`;
    const name = () => fileName($('caseName').value.trim() || 'malleol');
    $('ankStl').addEventListener('click', () => St.offer(`${name()}_redukte_model.stl`, new Blob([reducedStl()])));
    if ($('ankGStl')) $('ankGStl').addEventListener('click', () => St.offer(`${name()}_guide.zip`, St.zip(AnkGuide.files())));
    $('ankParts').addEventListener('click', () => St.offer(`${name()}_parcalar.zip`, St.zip(pieceFiles())));
    $('ankRep').addEventListener('click', () => St.offer(`${name()}_rapor.html`, new Blob([reportHTML()], { type: 'text/html' })));
    $('ankPack').addEventListener('click', () => { if (!packReady()) return; St.offer(`${name()}_paket.zip`, St.zip(packFiles())); St.emit('exported'); });
  }
  // every STL of the package is in one frame (the reduced model's); the file says which and how to go back to the CT
  function frameJSON(hashes) {
    const g = window.AnkGuide && AnkGuide.ready() ? AnkGuide.state() : null, q4 = q => [q.x, q.y, q.z, q.w].map(x => Math.round(x * 1e6) / 1e6), m3 = v => [v.x, v.y, v.z].map(x => Math.round(x * 1000) / 1000);
    return JSON.stringify({
      cerceve: 'BT hasta koordinatları (DICOM LPS), mm; her parça planlanan (redükte) konumunda',
      frame: 'CT patient coordinates (DICOM LPS), mm; every piece in its planned (reduced) position',
      donusum: "x' = q (x - c) + c + t, q = [x, y, z, w] birim kuaterniyon; BT konumuna dönüş: x = q^-1 (x' - c - t) + c",
      dosyalar: { 'redukte_model.stl': 'tüm parçalar', 'parcalar/*_redukte.stl': 'her parça ayrı', 'guide/*.stl': g ? `kesi guide'ı ve kama, "${g.piece}" parçasının hareketiyle taşınmış` : 'yok' },
      parcalar: kept().map(p => ({ ad: p.name, c: m3(p.c), t: m3(p.t), q: q4(p.q), tasindi: moved(p) })),
      vidalar: window.AnkScrew ? AnkScrew.screws().map(z => { const w = AnkScrew.world(z); return { tur: z.kind, parca: z.piece, cap_mm: z.D, boy_mm: z.L, giris: w ? m3(w.E) : null, yon: w ? m3(w.d) : null }; }) : [],
      onaylar: Object.assign({ reduksiyon: red.ok ? { by: red.by, at: red.at } : null }, Object.fromEntries(items().map(it => [it.name, itemOk(it) ? { by: appr[it.k].by, at: appr[it.k].at } : null]))),
      sha256: hashes || undefined,
    }, null, 2);
  }
  // every STL's SHA-256 (plan M7.2): written into cerceve.json and the report, so a printed file can be checked
  function stlHashes(files) { const o = {}; if (window.Audit && Audit.sha256b) files.filter(f => /\.stl$/.test(f.name)).forEach(f => { o[f.name] = Audit.sha256b(f.data); }); return o; }
  function packFiles() {
    const stls = [{ name: 'redukte_model.stl', data: reducedStl() }, ...pieceFiles(), ...(window.AnkGuide ? AnkGuide.files() : []), ...(window.AnkCorr ? AnkCorr.files() : []), ...(window.AnkPlate ? AnkPlate.files().filter(f => /\.stl$/.test(f.name)) : []), ...(window.AnkScrew ? AnkScrew.drillFiles() : [])], hs = stlHashes(stls);
    const files = [...stls, ...(window.AnkPlate ? AnkPlate.files().filter(f => !/\.stl$/.test(f.name)) : []), { name: 'cerceve.json', data: frameJSON(hs) }, { name: 'plan.json', data: JSON.stringify(St.planOf(), null, 2) }, { name: 'rapor.html', data: reportHTML(hs) }];
    // the approval log (audit.js); the other export hooks write mandible files (navigation of cuts and screws)
    const extra = []; (window.ExportHooks || []).forEach(f => { try { f(extra); } catch (e) { /* optional */ } });
    extra.filter(f => f.name === 'onay_kaydi.json').forEach(f => files.push(f));
    return files;
  }

  // ---------- plan ----------
  function restore(x) {
    meta = { side: x && ['R', 'L'].includes(x.side) ? x.side : meta.side, cls: x && CLASSES.includes(x.cls) ? x.cls : '' };
    const num = a => Array.isArray(a) && a.every(v => Number.isFinite(+v)) ? a.map(Number) : null;
    pieces.forEach((p, i) => setMotion(i, V(), new T.Quaternion(), false));
    // each saved piece goes to the one piece that matches it best: centre within 8 mm and (when saved) a volume within
    // ±30 % (plan M1.4: a piece whose segmentation changed is not given another piece's motion). Each piece once.
    const ents = (x && Array.isArray(x.pieces) ? x.pieces : []).slice(0, MAXP).map(s => ({ s, c: num(s.c), t: num(s.t), q: num(s.q), v: Number.isFinite(+s.cm3) && +s.cm3 > 0 ? +s.cm3 : null }))
      .filter(e => e.c && e.c.length === 3 && e.t && e.t.length === 3 && e.q && e.q.length === 4);
    const pairs = [];
    ents.forEach((e, k) => pieces.forEach((p, i) => {
      const d = p.c.distanceTo(V(...e.c)), rv = e.v ? p.cm3 / e.v : 1;
      if (d < (e.v ? 8 : 5) && rv > 0.7 && rv < 1 / 0.7) pairs.push({ k, i, cost: d + 10 * Math.abs(Math.log(rv)) });
    }));
    pairs.sort((a, b) => a.cost - b.cost);
    const usedE = new Set(), usedP = new Set();
    pairs.forEach(({ k, i }) => {
      if (usedE.has(k) || usedP.has(i)) return; usedE.add(k); usedP.add(i);
      const { s, t, q } = ents[k], tt = V(...t.map(v => Math.max(-60, Math.min(60, v)))), qq = new T.Quaternion(...q); if (qq.lengthSq() < 1e-6) return;
      setMotion(i, tt, qq, false);
      if (typeof s.name === 'string' && s.name.trim() && s.name !== pieces[i].name) rename(i, s.name, false);
    });
    // a saved motion that found no piece is said, not dropped silently
    unmatched = ents.filter((e, k) => !usedE.has(k) && (Math.hypot(...e.t) > 1e-6 || Math.abs(e.q[3]) < 1 - 1e-9)).map(e => String(e.s.name || '?').slice(0, 40));
    const r = x && x.red;
    red = r && r.ok && typeof r.by === 'string' ? { ok: true, by: r.by.slice(0, 120), at: typeof r.at === 'string' ? r.at.slice(0, 40) : '', sig: typeof r.sig === 'string' ? r.sig : '' } : { ok: false };
    if (red.ok && red.sig !== sig()) { red = { ok: false }; St.alertMsg(xl('Redüksiyon onayı kayıtlı parça konumlarıyla eşleşmiyor; yeniden onaylayın.')); }
    measure(); renderMeta(); render(); renderOut();
  }
  function planGet() {
    return { side: meta.side, cls: meta.cls, roi: Object.assign({}, roi), red: red.ok ? { ok: true, by: red.by, at: red.at, sig: red.sig } : { ok: false },
      splits: splits.map(x => ({ a: x.a.slice(), b: x.b.slice() })),
      pieces: pieces.map(p => ({ c: r3(p.c), cm3: Math.round(p.cm3 * 100) / 100, name: p.name, t: [p.t.x, p.t.y, p.t.z].map(x => Math.round(x * 1000) / 1000), q: [p.q.x, p.q.y, p.q.z, p.q.w].map(x => Math.round(x * 1e6) / 1e6) })) };
  }
  (window.PlanExt = window.PlanExt || {}).ankle = {
    label: 'Malleol redüksiyonu',
    get: () => (on() ? planGet() : null),
    set(x) {
      if (!x) { roi = Object.assign({}, ROI_DEF); splits = []; unmatched = []; if (pieces.length) restore(null); else { meta = { side: '', cls: '' }; red = { ok: false }; } renderRoi(); return; }
      if (x && !on()) CaseType.set('ankle', true);
      // a plan saved with another region: the pieces are found again in that region first
      const want = x.roi && typeof x.roi === 'object' ? x.roi : ROI_DEF, nr = { above: clampR('above', want.above), below: clampR('below', want.below), side: ['R', 'L'].includes(want.side) ? want.side : '' };
      const regionChanged = nr.above !== roi.above || nr.below !== roi.below || nr.side !== roi.side;
      roi = nr; renderRoi();
      // the hand splits of the plan: a split the labels have and the plan not is undone by segmenting again
      const ns = (Array.isArray(x.splits) ? x.splits : []).filter(z => z && vecOk(z.a) && vecOk(z.b)).slice(0, 20).map(z => ({ a: z.a.map(Number), b: z.b.map(Number) }));
      const key = a => JSON.stringify(a), dropped = splits.some(z => !ns.some(w => key(w) === key(z))), splitChanged = key(ns) !== key(splits);
      splits = ns;
      if (dropped && St.segment && S.red && !S.restoring) { pend = x; built = ''; St.segment(false); return; }
      if (!pieces.length || buildJob) { pend = x; return; }
      if (regionChanged || splitChanged) { pend = x; built = ''; build(); return; }
      restore(x);
    },
  };

  // ---------- wiring ----------
  bus.addEventListener('bone', () => { if (on()) build(); else if (pieces.length) drop(); });
  // a new volume is a new case: its pieces come with the 'bone' event that came just before (the side found there is kept)
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { meta = { side: autoSide, cls: '' }; red = { ok: false }; splits = []; unmatched = []; appr = {}; } renderMeta(); render(); renderRoi(); });
  bus.addEventListener('caseType', () => {
    // a built-in sample of the other case type is swapped for this type's sample (nothing planned on it yet)
    const isAnkle = n => /^ankle/.test(n);
    if (!S.restoring && S.source && S.source.type === 'sample' && isAnkle(S.source.name) !== on() && !S.anchor && !pieces.some(moved) && St.loadSample) {
      drop(); St.loadSample(St.sampleFor ? St.sampleFor(on() ? 'ankle' : 'mandible') : on() ? 'ankle' : 'mandible').catch(e => St.alertMsg(String(e.message || e))); return;
    }
  });
  // bone threshold: ankle joint spaces are narrow, at 250 HU the tibia, talus and fibula of a real CT fuse into one
  // piece (2026-10-21 anonymised ankle CT); 300 HU keeps them apart. Only the other type's default is changed, so a
  // threshold set by hand (or by an opened plan) stays.
  function thrForType() {
    const e = $('thr'); if (!e) return false;
    const want = on() ? THR_ANKLE : THR_MAND, other = on() ? THR_MAND : THR_ANKLE;
    if (+e.value !== other) return false;
    e.value = String(want); if ($('thrO')) $('thrO').textContent = want + ' HU'; return true;
  }
  thrForType();
  bus.addEventListener('caseType', () => {
    // a loaded CT (not a sample, which is swapped above) is segmented again at the new threshold when nothing is planned
    // (also when the threshold stays: an ankle cuts touching bones apart at the joints, the mandible's segmentation did not)
    const thrSeg = thrForType(), sepMissing = on() && /^Eşik/.test(S.segMethod || '') && !/eklem ayırma/.test(S.segMethod || '');
    if ((thrSeg || sepMissing) && !S.restoring && S.red && S.source && S.source.type !== 'sample' && !S.anchor && !pieces.some(moved) && St.segment) St.segment(false);
  });
  bus.addEventListener('caseType', () => { if (on()) { renderMeta(); build(); } else { drop(); const b = St.parts.bone; if (b) { b.visible = true; b.obj.visible = true; St.renderParts(); } } render(); renderOut(); renderRoi(); });
  let tmo = null;
  ['changed', 'planApplied', 'lock'].forEach(ev => bus.addEventListener(ev, () => { if (!on()) return; clearTimeout(tmo); tmo = setTimeout(() => { renderAppr(); renderOut(); renderChecks(); }, 120); }));
  ['st2', 'stRed', 'stAnkS', 'stAnkG', 'st7', 'stAnkOut'].forEach(id => $(id) && $(id).addEventListener('toggle', () => { if (!on()) return; show(); if (id === 'stAnkOut') renderOut(); }));
  renderMeta(); render(); renderOut(); renderRoi();

  const planned = () => on() && pieces.length > 0;
  // for ui.js: step completion and the top bar while the case is an ankle
  function status() {
    const A = window.Audit, h = A && pieces.length ? A.planHash() : '', both = !!(A && pieces.length && A.status('eng', h).ok && A.status('sur', h).ok);
    return { done: { stRed: pieces.length > 0 && pieces.some(moved) && !checks().some(c => c[0] === 'crit'), stAnkS: !!(window.AnkScrew && AnkScrew.done()), stAnkG: !!(window.AnkGuide && AnkGuide.ready()), st7: red.ok && both && !S.crit, stAnkOut: false }, ready: red.ok && both && !S.crit, pend: (red.ok ? 0 : 1) + (A && pieces.length && !A.status('eng', h).ok ? 1 : 0) + (A && pieces.length && !A.status('sur', h).ok ? 1 : 0) };
  }
  return { on, planned, status, renderChecks, checks, pieces: () => pieces, selected: () => sel, metrics: () => metrics, select: choose, rename, _names: names, separate, splitPiece, splits: () => splits.map(x => ({ a: x.a.slice(), b: x.b.slice() })), labels: LB, unmatched: () => unmatched.slice(), roi: () => Object.assign({}, roi), roiInfo: () => roiInfo, setRoi, building: () => !!buildJob, sdfAt, toWorld, toOwn, moved, setMotion, reset, measure, reducedStl, pieceFiles, reportHTML, packFiles, frameJSON, packReady, approve, approveItem, items, itemOk, stlHashes, build, meta: () => meta, approved: () => red.ok, LIM };
})();
