// Pads on the kept side (K3 F1, gkernel.js; the server builds the same, tests/server/test_pads_clip.py). With g.pads the
// guide touches the bone only on two round pads past each saw slot and stands `relief` mm off elsewhere. The side used
// to be "away from the body centre uc" only: right for one guide over both cuts, wrong for one piece of a two-piece
// guide, whose body lies on the uc side of its slot, so the pads fell off the body and the guide touched bone nowhere.
//  - g.padSide = +1 / -1 puts the pads on that side (u) of every slot
//  - a pad whose centre is off the body length is not built (and not in k.pads)
//  - with fewer than 2 pads left no relief is applied: the guide is the guide without pads
// Run: node test_padside.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: ['mfg.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
// app.js hands the kernel a fixed set of g fields; padSide goes in here so the kernel is tested on its own
const GK = P.eval('GKernel'), run0 = GK.run;
let extra = {};
GK.run = (K, onP) => run0(Object.assign({}, K, { g: Object.assign({}, K.g, extra) }), onP);

// straight bar of bone along x, top at z = 0; one cut across x = 0; the body centred at u = uc
const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;
const occ = (gr, uu, vv, nn) => { const i = Math.round((uu - gr.lo[0]) / gr.h), j = Math.round((vv - gr.lo[1]) / gr.h), k = Math.round((nn - gr.lo[2]) / gr.h); return gr.Gm[i + gr.nx * (j + gr.ny * k)]; };
const build = async (g, ex = {}) => {
  extra = ex;
  try {
    return await St.buildGuide({ P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [], bone: BAR, h: 0.4, fast: true,
      g: Object.assign({}, St.G_DEFAULT, { wrapU: null, boss: 0, L: 24, W: 12 }, g) });
  } finally { extra = {}; }
};
const c = 0.3, low = c + 0.5;      // the inner surface sits at the clearance; relieved, 1 mm higher

test('piece layout (slot at the -u end, uc = +9): padSide +1 puts both pads on the body past the slot; the guide touches there only', async () => {
  const plain = await build({ uc: 9 }), on = await build({ uc: 9, pads: true }, { padSide: 1 });
  const pads = on.result.pads;
  assert.equal(pads.length, 2, JSON.stringify(pads));
  for (const [pu, pv] of pads) { near(pu, 0.4 + 2 + 4 + 1, 1e-6, 'pad u on +u past the slot'); near(Math.abs(pv), 5, 1e-6); }
  // touches under the pads, stands off elsewhere (the plain guide touches everywhere)
  for (const pv of [4.5, -4.5]) { assert.equal(occ(on.grid, 7.4, pv, low), 1, 'pad at v ' + pv); assert.equal(occ(plain.grid, 7.4, pv, low), 1); }
  for (const uu of [4, 15]) { assert.equal(occ(on.grid, uu, 0, low), 0, 'relieved at u ' + uu); assert.equal(occ(plain.grid, uu, 0, low), 1); }
  assert.ok(on.result.volume < plain.result.volume);
  // padSide -1 on this body: the pads would lie past the slot at u = -7.4, off the body (-3 .. 21): none, no relief
  const neg = await build({ uc: 9, pads: true }, { padSide: -1 });
  assert.equal(neg.result.pads.length, 0);
  assert.equal(neg.result.volume, plain.result.volume);
});

test('pads off the body are dropped; with fewer than 2 left the guide is not relieved (old rule on a piece, short body)', async () => {
  // no padSide on the piece: away from uc = -u, off the body
  const plain = await build({ uc: 9 }), old = await build({ uc: 9, pads: true });
  assert.equal(old.result.pads.length, 0, JSON.stringify(old.result.pads));
  assert.equal(old.result.volume, plain.result.volume, 'the inner surface as without pads');
  assert.equal(occ(old.grid, 4, 0, low), 1);
  // a short body (L 12: ends 6 mm past the slot, the pads would sit at 7.4)
  const sp = await build({ L: 12 }), sh = await build({ L: 12, pads: true });
  assert.equal(sh.result.pads.length, 0);
  assert.equal(sh.result.volume, sp.result.volume);
  // the single guide (slot in the middle, uc = 0): unchanged, 2 pads on +u
  const one = await build({ pads: true });
  assert.equal(one.result.pads.length, 2); near(one.result.pads[0][0], 7.4, 1e-6);
});

await run('padside');
