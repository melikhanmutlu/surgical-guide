// Denetim 4 follow-ups in app.js / masks.js / audit.js / dates.js (synthetic straight bar "mandible"):
//  AR-10 a checks row keeps its list item role: the link (data-go, role=button, tabindex) is an inner element
//  AR-5  "Rezeksiyon aralığı" and "güvenlik payı" (not "sınır" / a bare "pay"), the renamed cut button
//  AR-7  keyboard pick in the region and screw modes: Enter on the 3D view takes the surface in the middle of the view
//  dates approval stamps follow the interface language (DateFmt in dates.js: "Oct 14, 2026" in English)
//  W21  an approval that does not match the opened plan is not carried over, and the panel says why
//  W25  rebuild jobs run one at a time; one that finds a newer edit queued leaves the work to it
//  D3   "Ayır" (mask split) needs two marked labels; layer and eye buttons are named "İşaretle: …", "Göster: …"
//  confirm dialogs: the reworded questions
// Run: node test_d4_app2.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const P = studio({ post: ['store.js', 'audit.js', 'dates.js', 'masks.js'], extra: { addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = (el, k) => (el.listeners.keydown || []).forEach(f => f({ type: 'keydown', key: k, preventDefault() {} }));

// straight bar along x (|x| < 58, top z = 0)
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-d4b' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan() {
  await St.settled();
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate();
}
// the camera straight above the bar, looking down at a point on it
function lookDown(x = 30) { const c = St.camera; c.position.set(x, 0, 150); c.up.set(0, 1, 0); c.lookAt(x, 0, 0); c.updateMatrixWorld(); c.updateProjectionMatrix(); }

test('AR-10: a checks row with a target keeps its list item role; the link is an inner element', async () => {
  await plan(); S.screws = []; St.renderChecks();
  const html = $('checks').innerHTML;
  assert.ok(/data-go=/.test(html), 'a row with a target: ' + html.slice(0, 300));
  assert.ok(!/<li[^>]*(role=|tabindex=|data-go=)/.test(html), 'no role / tabindex / data-go on the li: ' + html.slice(0, 300));
  assert.match(html, /<li class="crit"><div class="go" data-go="guide" title="[^"]*" tabindex="0" role="button"><b>[^<]*<\/b><span>/);
  assert.ok(/\.checks li > \[data-go\]/.test(src('index.html')) && /querySelectorAll\('\.checks li > \[data-go\]'\)/.test(src('app.js')), 'style and handlers follow the inner element');
});

test('AR-5: resection extent and safety margin wording (approval row, pending list, cut button)', async () => {
  await plan(); S.lesion.ok = false; St.renderAppr();
  assert.ok(St.pendingList().includes('Rezeksiyon aralığı'), JSON.stringify(St.pendingList()));
  const a = $('appr').innerHTML;
  assert.ok(/Rezeksiyon aralığı/.test(a) && /güvenlik payı/.test(a) && !/Rezeksiyon sınırı|, pay /.test(a), a.slice(0, 400));
  assert.ok(src('index.html').includes('Kesileri aralık + güvenlik payına göre koy</button>'));
  const app = src('app.js'); assert.ok(!/Kesileri sınıra göre koy|'Rezeksiyon sınırı'/.test(app), 'old names left in app.js');
});

test('an edit after full approval locks the package at once, before the rebuild (e2e A1.8f showed "Onaylı plan")', async () => {
  await plan(); await St.settled();
  const hooks = W.PendingHooks; W.PendingHooks = [];      // the audit sign-offs are not under test here
  try {
    $('surgeon').value = 'Dr X'; [S.lesion, ...S.planes, ...S.screws].forEach(o => St.stamp(o)); S.crit = 0; S.qc = [];
    St.renderAppr(); assert.equal($('expZip').disabled, false, 'approved plan: package open ' + JSON.stringify(St.pendingList()));
    S.planes[0].off += 0.5; St.unapprove(S.planes[0]); St.schedule(true, true);
    assert.equal($('expZip').disabled, true, 'locked in the same tick as the edit');
    assert.ok(St.pendingList().includes('Kesi 1'));
    await St.settled(); assert.equal($('expZip').disabled, true, 'still locked after the rebuild');
  } finally { W.PendingHooks = hooks; }
});

test('dates: approval stamps follow the interface language (English spells the month)', async () => {
  const at = new Date(2026, 9, 14, 9, 5).toISOString(), D = W.DateFmt;
  assert.ok(D, 'DateFmt published by dates.js');
  assert.equal(D.dateTime(at), '14.10.2026 09:05');
  assert.equal(D.time(at), '09:05');
  W.I18N = { lang: 'en', t: s => s };
  try {
    assert.ok(/Oct 14, 2026/.test(D.dateTime(at)) && /09:05/.test(D.dateTime(at)), D.dateTime(at));
    assert.ok(/Oct 14, 2026/.test(D.date(at)), D.date(at));
    assert.equal(D.time(at), '09:05');
    await plan(); Object.assign(S.lesion, { ok: true, by: 'Dr Y', at }); St.renderAppr();
    assert.ok(/title="Dr Y · Oct 14, 2026/.test($('appr').innerHTML), $('appr').innerHTML.slice(0, 600));
  } finally { delete W.I18N; S.lesion.ok = false; }
  assert.equal(D.date(''), '–', 'no date: a dash');
  for (const f of ['report.js', 'audit.js', 'store.js', 'app.js']) assert.ok(/DateFmt(\.dateTime|\[k\])/.test(src(f)), f + ' uses DateFmt');
});

test('AR-7: Enter on the 3D view picks the region in the middle of the view; a screw the same way', async () => {
  await plan(); S.anchor = null; S.planes = []; S.screws = []; S.guideOn = false; await St.settled();
  const cv = St.renderer.domElement;
  lookDown(30); St.setMode('anchor');
  assert.equal($('stage').getAttribute('data-kbpick'), '', 'the ring is shown');
  assert.ok(/Klavye: .*Enter/.test($('modeBadge').textContent), $('modeBadge').textContent);
  key(cv, 'Enter');
  assert.ok(S.anchor, 'anchor set from the keyboard'); near(S.anchor.p.x, 30, 2, 'under the middle of the view'); near(S.anchor.p.z, 0, 1.5, 'on the top surface');
  assert.equal(S.mode, 'orbit'); assert.equal($('stage').getAttribute('data-kbpick'), null, 'ring gone');
  assert.ok(S.planes.length >= 1, 'cuts suggested as after a click');
  // screws: the guide must exist
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.guideOn = true; S.screws = []; await St.regenerate();
  const n0 = S.screws.length; lookDown(30); St.setMode('screw'); key(cv, 'Enter');
  assert.equal(S.screws.length, n0 + 1, 'screw added'); const sc = S.screws[S.screws.length - 1];
  assert.equal(sc.hand, 1); near(sc.u, 30, 2, 'at the middle of the view');
  // nothing under the middle: a message, nothing set
  St.setMode('screw'); const c = St.camera; c.position.set(0, 0, 150); c.lookAt(0, 0, 300); c.updateMatrixWorld();
  $('caseMsg').textContent = ''; key(cv, 'Enter');
  assert.equal(S.screws.length, n0 + 1); assert.ok(/ortasında kemik ya da guide yok/.test($('caseMsg').textContent), $('caseMsg').textContent);
  St.setMode('orbit'); await St.settled();
});

test('W25: a rebuild job waits for the one running; of two queued only the newest runs', async () => {
  await plan(); await St.settled();
  let release; const held = St.exclusive(() => new Promise(r => { release = r; }));
  const j0 = St.live.jobs || 0;
  St.schedule(false); await sleep(300);
  assert.equal(St.live.jobs || 0, j0, 'no job while another one runs');
  St.schedule(false); await sleep(300);
  release(); await held; await St.settled();
  assert.equal(St.live.jobs, j0 + 1, 'the older queued job left the work to the newer one');
});

test('W21: an approval that does not match the opened plan is not carried over, and the panel says why', async () => {
  await plan(); await St.settled();
  const A = W.Audit, base = St.clone(St.planOf()); delete (base.ext || {}).audit;
  await St.applyPlan(St.clone(base)); await St.settled();
  const h = A.planHash();
  const chainOf = plans => { let prev = '0'.repeat(64); return plans.map(([role, ph], i) => { const e = { n: i + 1, at: '2026-01-01T10:00:00.000Z', role, name: role === 'eng' ? 'Müh A' : 'Dr B', action: 'onay', comment: '', plan: ph, prev }; e.hash = A.sha256([e.prev, e.n, e.at, e.role, e.name, e.action, e.comment, e.plan].join('|')); prev = e.hash; return e; }); };
  const withLog = log => Object.assign(St.clone(base), { ext: Object.assign({}, base.ext, { audit: { log } }) });
  // approved on an older hash (an older version, or a plan edited after approval)
  $('caseMsg').textContent = '';
  await St.applyPlan(withLog(chainOf([['eng', 'f'.repeat(64)], ['sur', 'f'.repeat(64)]])));
  assert.equal(A.chain().ok, true, 'a valid chain');
  assert.equal(A.status('eng').ok, false); assert.equal(A.status('sur').ok, false);
  assert.equal(JSON.stringify(A.staleOnOpen().sort()), '["eng","sur"]');
  assert.ok(/plan açılırken eşleşmedi/.test($('auditBox').innerHTML), 'panel explains: ' + $('auditBox').innerHTML.slice(0, 300));
  assert.ok(/2 plan onayı .*eşleşmiyor.*yeniden onaylayın/.test($('caseMsg').textContent), $('caseMsg').textContent);
  assert.ok(St.pendingList().some(x => /Mühendis/.test(x)), 'still pending');
  // the same plan approved on its own hash opens approved, without the notice
  $('caseMsg').textContent = '';
  await St.applyPlan(withLog(chainOf([['eng', h], ['sur', h]])));
  assert.equal(A.status('eng').ok, true); assert.equal(A.staleOnOpen().length, 0);
  assert.ok(!/eşleşmiyor/.test($('caseMsg').textContent));
  await St.applyPlan(St.clone(base)); await St.settled();
});

test('D3: "Ayır" needs two marked labels; layer and eye buttons are named action first', async () => {
  await St.settled(); S.anchor = null; S.planes = []; S.screws = []; S.guideOn = false;
  const r = S.red, n = r.nx * r.ny * r.nz, thr = +$('thr').value - 100;
  let v0 = -1; for (let v = 0; v < n; v++) if (r.hu[v] >= thr) { v0 = v; break; }
  assert.ok(v0 >= 0);
  const rleOne = (at, len) => [at, len, n - at - len].map(x => x.toString(36)).join(','), none = n.toString(36);
  await W.PlanExt.masks.set({ dims: [r.nx, r.ny, r.nz], layers: [{ name: 'Kemik A', color: 0x46c98b }, { name: 'Kemik B', color: 0x4f8fe6 }], seeds: [rleOne(v0, 4), none], plan: [1] });
  assert.equal($('mkRun').disabled, true, 'one label marked: Ayır off');
  // (a plan opened with one marked label keeps its old one-layer result: its bone is not changed under it)
  await W.Masks.run(); assert.ok(/en az iki kemiği/.test($('mkStat').textContent), 'run() refuses: ' + $('mkStat').textContent);
  assert.ok(/aria-label="İşaretle: Kemik A"/.test($('mkLayers').innerHTML), $('mkLayers').innerHTML.slice(0, 300));
  let v1 = -1; for (let v = n - 1; v >= 0; v--) if (r.hu[v] >= thr) { v1 = v; break; }
  await W.PlanExt.masks.set({ dims: [r.nx, r.ny, r.nz], layers: [{ name: 'Kemik A', color: 0x46c98b }, { name: 'Kemik B', color: 0x4f8fe6 }], seeds: [rleOne(v0, 4), rleOne(v1 - 3, 4)], plan: [1] });
  assert.equal($('mkRun').disabled, false, 'two labels marked: Ayır on');
  W.Masks.renderList();
  assert.ok(/aria-label="(Göster|Gizle): [^"]+"/.test($('comps').innerHTML) || !/data-eye/.test($('comps').innerHTML), $('comps').innerHTML.slice(0, 400));
  assert.ok(!/ile işaretle'\)|xl\(on \? 'gizle'/.test(src('masks.js')), 'the glued labels are gone');
  await W.PlanExt.masks.set(null);
});

test('confirm dialogs: the reworded questions', () => {
  const app = src('app.js'), imp = src('implant.js');
  for (const q of ['Plan sıfırlansın mı? Kesiler, guide ve vidalar silinir; onaylar da düşer.', 'Seri değiştirilsin mi? Bu serideki kesiler ve guide silinir.',
    'Örnek vaka yüklensin mi? Mevcut plan (kesiler, vidalar, guide) silinir.', 'Plan dosyası açılınca mevcut plan (kesiler, vidalar, guide) silinir. Devam edilsin mi?'])
    assert.ok(app.includes(`confirm('${q}')`), q);
  assert.ok(imp.includes('confirm(`İmplantlar yeniden yerleştirilsin mi? Mevcut ${list.length} implant silinir.`)'));
  assert.ok(!/Emin misiniz\?|Başka seri açılınca/.test(app));
});

await run('Denetim 4 app follow-ups');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
