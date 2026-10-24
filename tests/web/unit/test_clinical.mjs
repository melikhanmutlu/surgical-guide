// C4: the clinical thresholds live in one place (web/clinical.js). Every module reads the same value: a deployment
// profile (window.ClinicalProfile) changes the slot play limit, the canal distance, the guide wall, the metal
// threshold and the starting margin everywhere at once; out-of-range overrides are ignored; the report lists them.
// Run: node test_clinical.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const prof = { slotPlayMax: 4, canalSafe: 3, wall: 3, minWall: 2.2, metalHu: 2800, metalBand: 2, margin: 5, slotTol: 99 };
const P = studio({ post: ['mfg.js', 'metalqc.js', 'canal.js'], extra: { ClinicalProfile: prof, confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const S = St.S, W = P.g;

test('a profile sets every module at once; an out-of-range value keeps the sample value', () => {
  const C = W.Clinical;
  assert.equal(C.v('slotPlayMax'), 4); assert.equal(St.SLOT_PLAY_MAX, 4, 'app.js slot check');
  assert.equal(P.eval('Canal').SAFE, 3, 'canal.js'); assert.equal(St.G_DEFAULT.wall, 3, 'guide wall default');
  assert.equal(P.eval('MetalQC').METAL_HU, 2800); assert.equal(P.eval('MetalQC').BAND_GUIDE, 2);
  assert.equal(P.eval('Mfg').get().minWall, 2.2, 'mfg minimum wall');
  assert.equal(S.lesion.margin, 5, 'starting margin');
  assert.equal(C.v('slotTol'), 0.2, '99 mm is out of range: the sample value stays');
  assert.equal(JSON.stringify(C.changed().sort()), JSON.stringify(['canalSafe', 'margin', 'metalBand', 'metalHu', 'minWall', 'slotPlayMax', 'wall']));
  assert.throws(() => C.v('nope'));
});

test('no module keeps its own copy of these numbers', () => {
  assert.ok(!/SLOT_PLAY_MAX = 3\b/.test(src('app.js')));
  assert.ok(!/SAFE = 2\b/.test(src('canal.js')));
  assert.ok(!/METAL_HU = 2500\b/.test(src('metalqc.js')));
  assert.ok(!/minWall: 2\.0, fit/.test(src('mfg.js').split('PRESETS')[0] + src('mfg.js').split('const DEF')[1].split('\n')[0]));
});

test('the report lists the thresholds and marks the changed ones', () => {
  const h = St.reportHTML ? St.reportHTML() : '';
  assert.match(h, /Klinik eşikler/); assert.match(h, /Vida ile sinir kanalı arası \(en az\) \*/);
});

await run('clinical thresholds (C4)');
