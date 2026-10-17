// Layer list names (Katmanlar): any row can be renamed. The name is kept with the plan (ext.names) and comes back on
// reopen, an empty name goes back to the default, and a rename moves no approval: the plan hash (web/audit.js) and the
// item approvals stay as they were. Also the view bar: it is docked under the whole viewer (3D and slice panels), not
// floated inside the 3D cell. Synthetic bone only. Run: node test_layer_names.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const P = studio({ post: ['audit.js', 'layers.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mandible() {
  const sp = [0.8, 0.8, 0.8], nx = 125, ny = 60, nz = 33, origin = [-50, -24, -20], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 48 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-names' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.lesion.condyle = null; S.guideOn = true;   // (as a reopened plan stores it: no condylar end)
  St.placeScrews(); await St.rebuildResection(); await St.regenerate();
}

let hash0 = '', saved = null;
test('setup: a plan with an approved resection and an engineer approval in the audit log', async () => {
  await mandible();
  assert.ok(St.parts.bone, 'bone layer exists');
  P.doc.getElementById('surgeon').value = 'test'; St.stamp(S.lesion);
  assert.equal(S.lesion.ok, true);
  hash0 = W.Audit.planHash();
  assert.equal(St.planOf().ext.names, undefined, 'no names entry while nothing was renamed (old plans unchanged)');
});

test('renaming a layer: shown in the list, saved with the plan, plan hash and approvals unchanged', async () => {
  assert.equal(typeof St.renamePart, 'function', 'Studio.renamePart exists');
  assert.equal(St.renamePart('bone', '  Sol   mandibula  '), true);
  assert.equal(St.partName('bone'), 'Sol mandibula', 'spaces tidied');
  assert.match(P.doc.getElementById('parts').innerHTML, /translate="no">Sol mandibula</, 'list shows the new name (not translated)');
  assert.deepEqual({ ...St.planOf().ext.names }, { bone: 'Sol mandibula' });
  assert.equal(W.Audit.planHash(), hash0, 'plan hash (approval chain) unchanged by a rename');
  assert.equal(S.lesion.ok, true, 'resection approval kept');
  assert.equal(St.renamePart('nope', 'x'), false, 'unknown layer ignored');
  assert.equal(St.renamePart('bone', 'x'.repeat(200)), true); assert.equal(St.partName('bone').length, 60, 'name capped at 60');
  St.renamePart('bone', 'Sol mandibula');
  saved = St.clone(St.planOf());
});

test('reopen: the name comes back; a plan without names opens with the default ones', async () => {
  St.renamePart('bone', '');
  assert.equal(St.partName('bone'), St.parts.bone.label, 'empty name -> default');
  assert.equal(St.planOf().ext.names, undefined);
  await St.applyPlan(St.clone(saved)); await sleep(50);
  assert.equal(St.partName('bone'), 'Sol mandibula', 'name restored on reopen');
  assert.equal(W.Audit.planHash(), hash0, 'hash after reopen unchanged');
  assert.equal(S.lesion.ok, true, 'approval kept after reopen');
  const plain = St.clone(saved); delete plain.ext.names;
  await St.applyPlan(plain); await sleep(50);
  assert.equal(St.partName('bone'), St.parts.bone.label, 'plan without names -> default names');
  const bad = St.clone(saved); bad.ext.names = { bone: 42, resected: '  ', guide: 'Kılavuz A' };
  await St.applyPlan(bad); await sleep(50);
  assert.equal(St.partName('bone'), St.parts.bone.label, 'non-string name ignored');
  assert.deepEqual({ ...St.planOf().ext.names }, { guide: 'Kılavuz A' });
});

test('view bar is docked under the whole viewer (slice panels open or not)', () => {
  const html = src('index.html'), kart = src('styles/kart.css');
  const rule = sel => (new RegExp('^' + sel.replace(/[.[\]"=()]/g, '\\$&') + ' \\{([^}]*)\\}', 'm').exec(html) || [])[1] || '';
  assert.match(rule('.stagewrap'), /display:\s*flex/); assert.match(rule('.stagewrap'), /flex-direction:\s*column/);
  assert.doesNotMatch(rule('.views'), /position:\s*absolute/, 'views take the space above the bar');
  assert.doesNotMatch(rule('.hud'), /position:\s*absolute|bottom:/, 'the bar is not floated over the views');
  assert.doesNotMatch(html, /\.views\[[^\]]*\]\[data-max=""\] ~ \.hud/, 'no rule moves the bar into the 3D cell in 2x2 / strip');
  assert.doesNotMatch(/html\[data-style="k1"\] \.hud \{([^}]*)\}/.exec(kart)[1], /border-radius:\s*12px/, 'card style keeps it a docked bar');
});

await run('layer names and docked view bar');
await new Promise(r => process.stdout.write('', r)); process.exit(process.exitCode || 0);
