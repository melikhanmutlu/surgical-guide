// Browser-preview guide mesh (what guide.stl and the 3MF carry when no server is reachable): closed, 2-manifold, one body,
// slot widths on the setting, surface at the design clearance. Synthetic bone only (no patient data).
// Run: node test_guide_mesh.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio(); const St = await ready(P); const T = P.g.THREE, G = P.eval('G');
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const G0 = { rot: 0, roll: 0, L: 40, W: 22, wrap: 5, wall: 2.5, clear: 0.3, bridge: 4, side: 1, split: 0, flange: 3, peri: 0, fit: 0, stopT: 0, stopB: 0, stopL: 6, stopD: 5 };
// bone density with a 1 mm wide transition (soft field), and the boolean bone derived from it
const soft = f => ({ field: q => Math.max(0, Math.min(1, 0.5 + f(q) / 1.0)), bone: q => f(q) > 0 });
// signed "depth inside the bone" (positive inside): a straight bar (top at z = 0) and a round rod (axis along x at z = -R, radius R)
const bar = q => Math.min(-q.z, 14 + q.z, 8 - Math.abs(q.y), 70 - Math.abs(q.x));
const rod = R => q => Math.min(R - Math.hypot(q.y, q.z + R), 70 - Math.abs(q.x));
const build = (bone, o = {}) => St.buildGuide(Object.assign({ pls: [], scs: [], P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), h: 0.4, fast: true }, soft(bone), o, { g: Object.assign({}, G0, o.g || {}) }));

// mesh topology as a printer / trimesh sees it: vertices merged by exact float32 position
function topology(mesh) {
  const p = mesh.geometry.attributes.position.array, ix = mesh.geometry.index.array, key = new Map(), id = [];
  for (let i = 0; i < p.length; i += 3) { const k = p[i] + ',' + p[i + 1] + ',' + p[i + 2]; if (!key.has(k)) key.set(k, key.size); id.push(key.get(k)); }
  const edges = new Map(), dir = new Map(); let degenerate = 0, vol = 0, inconsistent = 0;
  const parent = Array.from({ length: key.size }, (_, i) => i), find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < ix.length; t += 3) {
    const a = id[ix[t]], b = id[ix[t + 1]], c = id[ix[t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    const A = ix[t] * 3, B = ix[t + 1] * 3, C = ix[t + 2] * 3;
    const ux = p[B] - p[A], uy = p[B + 1] - p[A + 1], uz = p[B + 2] - p[A + 2], wx = p[C] - p[A], wy = p[C + 1] - p[A + 1], wz = p[C + 2] - p[A + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (Math.hypot(cx, cy, cz) < 1e-9) degenerate++;
    vol += (p[A] * (p[B + 1] * p[C + 2] - p[B + 2] * p[C + 1]) - p[A + 1] * (p[B] * p[C + 2] - p[B + 2] * p[C]) + p[A + 2] * (p[B] * p[C + 1] - p[B + 1] * p[C])) / 6;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const k = Math.min(x, y) + '_' + Math.max(x, y); edges.set(k, (edges.get(k) || 0) + 1);
      const dk = x + '>' + y; if (dir.has(dk)) inconsistent++; dir.set(dk, 1);
    }
    parent[find(a)] = find(b); parent[find(b)] = find(c);
  }
  let nonManifold = 0, open = 0; for (const n of edges.values()) { if (n === 2) continue; if (n === 1) open++; else nonManifold++; }
  const roots = new Set(); for (const k of new Set(id)) roots.add(find(k));
  return { open, nonManifold, degenerate, inconsistent, vol, bodies: roots.size, faces: ix.length / 3, edges: edges.size };
}

test('preview mesh of a straight bar: closed, 2-manifold, consistently wound, one body, outward (positive volume)', async () => {
  const o = await build(bar), t = topology(o.mesh);
  assert.equal(t.open, 0, 'open edges'); assert.equal(t.nonManifold, 0, 'non-manifold edges'); assert.equal(t.inconsistent, 0, 'winding'); assert.equal(t.degenerate, 0, 'degenerate faces');
  assert.equal(t.bodies, 1); assert.ok(t.vol > 0, 'signed volume ' + t.vol);
  near(t.vol, o.result.volume, o.result.volume * 0.1, 'mesh volume matches the node-count volume (boundary nodes are counted whole)');
});

test('preview mesh with slots, screws, a tilted slot and a bridge: still closed, manifold, one body, for several grid phases', async () => {
  const a = 25 * Math.PI / 180;
  for (const ph of [0, 0.13, 0.27]) {
    const sc = { d: 2, D: 5, sleeveH: 5, len: 10 };
    const o = await build(rod(7), { P: V(0, 0, ph), pls: [{ p: V(-9, 0, 0), N: V(1, 0, 0), w: 1.2 }, { p: V(8, 0, 0), N: V(Math.cos(a), Math.sin(a), 0), w: 1.0 }], scs: [{ sc, dir: V(0, 0, -1), entry: V(-14, 0, 0) }, { sc, dir: V(0, 0, -1), entry: V(14, 1, 0) }], g: { L: 44 } });
    const t = topology(o.mesh);
    assert.equal(t.open + t.nonManifold + t.inconsistent + t.degenerate, 0, `phase ${ph}: ${JSON.stringify(t)}`);
    assert.equal(t.bodies, 1, 'phase ' + ph); assert.equal(o.result.pieces, 1); assert.ok(t.vol > 0);
  }
});

test('preview mesh: slot width within ±0.1 mm of the setting (1.2 and 0.8 mm), straight and tilted', async () => {
  for (const [w, yaw] of [[1.2, 0], [0.8, 0], [1.2, 25]]) {
    const a = yaw * Math.PI / 180, N = V(Math.cos(a), Math.sin(a), 0), p0 = V(5, 0, 0);
    for (const ph of [0, 0.2]) {
      const o = await build(bar, { P: V(0, 0, ph), pls: [{ p: p0, N, w }] }), pos = o.mesh.geometry.attributes.position.array;
      // vertices of the two slot walls at mid-shell height, away from the bridge: signed distance to the plane
      const lo = [], hi = [];
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2]; if (Math.abs(y) > 4 || z < G0.clear + 0.6 || z > G0.clear + G0.wall - 0.6) continue;
        const d = (x - p0.x) * N.x + (y - p0.y) * N.y; if (Math.abs(d) < 2) (d < 0 ? lo : hi).push(d);
      }
      assert.ok(lo.length > 20 && hi.length > 20);
      near(Math.min(...hi) - Math.max(...lo), w, 0.1, `slot ${w} mm yaw ${yaw} phase ${ph}`);
    }
  }
});

test('preview mesh: with a bone density the inner surface sits at the design clearance (0.3 mm) within 0.1 mm for every grid phase', async () => {
  const z = [];
  for (const ph of [0, 0.1, 0.2, 0.3]) {
    const pos = (await build(bar, { P: V(0, 0, ph) })).mesh.geometry.attributes.position.array, zs = [];
    for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1]) < 4 && Math.abs(pos[i]) < 8 && pos[i + 2] > -0.2 && pos[i + 2] < 1.4) zs.push(pos[i + 2]);
    zs.sort((a, b) => a - b); z.push(zs[zs.length >> 1]);
  }
  z.forEach(v => near(v, 0.3, 0.1, `inner surface by phase ${z.map(x => x.toFixed(2)).join(', ')}`));
});

test('preview mesh: a slender round rod (R = 4.5, W far wider than the rod) still comes out as ONE body when the bridge reaches the shell', async () => {
  // W follows the rod: shell outer radius R + clear + wall, bridge starts W/2 - bridge from the axis
  const R = 4.5, W = Math.round(2 * (R + 2.8) + 2), o = await build(rod(R), { g: { W, wrap: 3.5 } });
  assert.equal(o.result.pieces, 1); const t = topology(o.mesh); assert.equal(t.bodies, 1); assert.equal(t.open + t.nonManifold, 0);
});

test('G.marchTets: a sphere and two touching diagonal blobs give closed manifold surfaces (no coincident vertices)', () => {
  const n = 24, f = new Float32Array(n * n * n).fill(1);
  const at = (i, j, k) => i + n * (j + n * k);
  for (let k = 1; k < n - 1; k++) for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) f[at(i, j, k)] = Math.hypot(i - 11.5, j - 11.5, k - 11.5) - 7.3;
  // two cubes that only touch along an edge (the case that breaks one-vertex-per-cell meshing)
  const g = new Float32Array(n * n * n).fill(1);
  for (const [x, y, z] of [[4, 4, 4], [5, 5, 4], [4, 4, 5], [5, 5, 5]]) g[at(x, y, z)] = -1;
  for (const [x, y, z] of [[5, 4, 12], [4, 5, 12], [5, 4, 13], [4, 5, 13]]) g[at(x, y, z)] = -1;
  for (const fld of [f, g]) {
    const net = G.marchTets(fld, n, n, n, 0), geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(net.positions, 3)); geo.setIndex(new T.BufferAttribute(net.indices, 1));
    const t = topology({ geometry: geo });
    assert.equal(t.open + t.nonManifold + t.inconsistent + t.degenerate, 0, JSON.stringify(t)); assert.ok(t.vol > 0);
  }
});

// distance from point p to triangle (a, b, c): the plane projection when it falls inside, else the nearest edge
function distPointTri(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]], dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const seg = (s, e) => { const d = sub(e, s), l2 = dot(d, d), u = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, s), d) / l2)) : 0; return Math.hypot(p[0] - s[0] - u * d[0], p[1] - s[1] - u * d[1], p[2] - s[2] - u * d[2]); };
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], nn = dot(n, n);
  if (nn > 0) {
    const h = dot(ap, n) / nn, q = [p[0] - h * n[0], p[1] - h * n[1], p[2] - h * n[2]], aq = sub(q, a);
    const d00 = dot(ab, ab), d01 = dot(ab, ac), d11 = dot(ac, ac), d20 = dot(aq, ab), d21 = dot(aq, ac), den = d00 * d11 - d01 * d01;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    if (v >= 0 && w >= 0 && v + w <= 1) return Math.abs(h) * Math.sqrt(nn);
  }
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}
test('G.decimate / Studio.simplifyMesh: far fewer triangles, still closed 2-manifold with one body, surface moved < 0.05 mm, volume kept', async () => {
  const sc = { d: 2, D: 5, sleeveH: 5, len: 10 };
  const o = await build(rod(7), { pls: [{ p: V(-9, 0, 0), N: V(1, 0, 0), w: 1.2 }, { p: V(8, 0, 0), N: V(1, 0, 0), w: 1.0 }], scs: [{ sc, dir: V(0, 0, -1), entry: V(-14, 0, 0) }], g: { L: 44 } });
  const before = topology(o.mesh), p0 = o.mesh.geometry.attributes.position.array.slice(), i0 = o.mesh.geometry.index.array.slice();
  const holder = new T.Group(); holder.add(o.mesh);
  assert.equal(await St.simplifyMesh(o.mesh), true);
  const after = topology(o.mesh);
  assert.equal(after.open + after.nonManifold + after.inconsistent + after.degenerate, 0, JSON.stringify(after)); assert.equal(after.bodies, 1);
  assert.ok(after.faces < before.faces / 2.5, `faces ${before.faces} -> ${after.faces}`);
  near(after.vol, before.vol, before.vol * 0.005, 'volume');
  // every new vertex (sampled) lies on the old surface to within 0.05 mm
  const pn = o.mesh.geometry.attributes.position.array, vtx = i => [p0[3 * i], p0[3 * i + 1], p0[3 * i + 2]];
  let worst = 0; const nv = pn.length / 3;
  for (let s = 0; s < 120; s++) {
    const k = Math.floor(s * nv / 120), p = [pn[3 * k], pn[3 * k + 1], pn[3 * k + 2]]; let d = Infinity;
    for (let t = 0; t < i0.length; t += 3) { const dd = distPointTri(p, vtx(i0[t]), vtx(i0[t + 1]), vtx(i0[t + 2])); if (dd < d) d = dd; }
    worst = Math.max(worst, d);
  }
  assert.ok(worst < 0.05, 'surface moved by ' + worst);
});

run('guide preview mesh');
