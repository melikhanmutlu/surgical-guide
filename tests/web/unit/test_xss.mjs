// Evidence for the two HTML-injection findings in app.js (synthetic inputs, nothing executes in node: the test only
// shows that attacker-controlled text reaches innerHTML unescaped, while the sibling modules escape the same text).
//  1. renderQC (app.js:362): DICOM Modality (0008,0060) / ConvolutionKernel (0018,1210) strings -> #qc
//  2. renderParts (app.js:963): scene part labels (layer names from a stored plan, layers.js:46) -> #parts
//  3. mfg.js (Denetim 4 G1): production-profile values from a stored plan -> <input value="…"> in #mfgBox
// Run: node test_xss.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { dicom } from './lib/dicomw.mjs';

const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], post: ['mfg.js'] }); const St = await ready(P);
const $ = id => P.g.document.getElementById(id);
const PAY = '<img src=x onerror=alert(1)>';
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 20)); } return true; };

test('renderQC: a DICOM kernel string is escaped in #qc (reportHTML escapes the same field)', async () => {
  const files = [0, 1, 2].map(k => new File([dicom({ rows: 8, cols: 8, pixels: Array.from({ length: 64 }, () => 1500), ipp: [0, 0, k], ps: [0.5, 0.5], sop: `1.2.3.${k + 50}`, icpt: -1024, slope: 1, thickness: 1, kernel: PAY, modality: 'CT' })], `x${k}.dcm`));
  const el = $('dicomFiles'); el.files = files; el.dispatchEvent({ type: 'change', target: el });
  assert.ok(await until(() => ($('qc').innerHTML || '').includes('kernel')), 'quality list rendered');
  assert.ok(!$('qc').innerHTML.includes(PAY) && $('qc').innerHTML.includes('&lt;img'), 'payload must be escaped: ' + $('qc').innerHTML.slice(0, 200));
});

test('renderQC: a non-CT Modality string is also escaped (critical-check message)', async () => {
  // the first load may still be committing its volume; a second load then is refused (loadBlocked), so wait it out
  assert.ok(await until(() => !St.loadBusy(), 60000), 'first load finished');
  const files = [0, 1, 2].map(k => new File([dicom({ rows: 8, cols: 8, pixels: Array.from({ length: 64 }, () => 1500), ipp: [0, 0, k], ps: [0.5, 0.5], sop: `1.2.4.${k + 50}`, series: '1.2.3.99', icpt: -1024, slope: 1, thickness: 1, modality: '<b>X</b>' })], `m${k}.dcm`));
  const el = $('dicomFiles'); el.files = files; el.dispatchEvent({ type: 'change', target: el });
  assert.ok(await until(() => ($('qc').innerHTML || '').includes('Modalite')), 'quality list rendered');
  assert.ok(!$('qc').innerHTML.includes('Modalite <b>X</b>') && $('qc').innerHTML.includes('Modalite &lt;b&gt;X'), $('qc').innerHTML.slice(0, 200));
});

test('renderParts: a scene part label (e.g. a layer name restored from a stored plan) is escaped in #parts', () => {
  const T = P.g.THREE, mesh = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial());
  St.setPart('lay_9', PAY, mesh, 0x123456);
  St.renderParts();
  const html = $('parts').innerHTML;
  assert.ok(!html.includes(PAY), 'label must be escaped: ' + html.slice(0, 300));
});

test('mfg.js (G1): a stored plan\'s production profile cannot break out of the form attributes', () => {
  const ATTR = '"><img src=x onerror=alert(1)>';
  P.g.PlanExt.mfg.set({ prof: 'custom', blade: ATTR, clear: ATTR, slotTol: ATTR, minWall: ATTR, fit: ATTR });
  const html = $('mfgBox').innerHTML;
  assert.ok(html.includes('id="mf_blade"'), 'form rendered');
  assert.ok(!html.includes('<img') && !html.includes('onerror'), 'payload must not reach the markup: ' + html.slice(0, 300));
  assert.ok(Object.values(P.g.Mfg.get()).every(v => v === null || typeof v === 'string' || Number.isFinite(v)), JSON.stringify(P.g.Mfg.get()));
  P.g.PlanExt.mfg.set({ prof: '"><b>x</b>' });
  assert.equal(P.g.Mfg.get().prof, null, 'unknown profile key dropped'); assert.ok(!$('mfgBox').innerHTML.includes('<b>x'));
  P.g.PlanExt.mfg.set(null);
});

await run('HTML injection evidence (app.js)');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
