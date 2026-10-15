// Headless Guide Studio driver (Playwright + SwiftShader). One fresh browser page per run, so runs are repeatable.
//   node driver.mjs --port 8861 --out <dir> --scenario '<json>'
// scenario keys (all optional):
//   mandible: "sample" (default) | {dicom: "<dir with one series>"}
//   fibula:   "sample" (default) | {dicom: "<dir>"} | null (no fibula)
//   thr: bone threshold HU (mandible), split: 0|1, perSide: 1|2, fibN: 1..3, condyle: "R"|"L",
//   lesion: {points: [[x,y,z],...], radius: mm} painted lesion (world LPS mm); otherwise the sample spot (autoPrep)
//   g: {key: value} guide body overrides applied before the guide is made, server: false to skip /guide
//   probe: JS function body (may await) evaluated in the page before extraction; its JSON result goes to run.json .probe
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Playwright as for the e2e scenarios (tests/web/e2e/lib.js): PW_MODULE, else the machine's shared install
const { chromium } = await import(pathToFileURL(path.join(process.env.PW_MODULE || '/opt/node-tools/node_modules/playwright', 'index.mjs')).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const PORT = +(args.port || 8861), OUT = args.out, SC = JSON.parse(args.scenario || '{}');
const CDN = args.cdn || process.env.TUT_CDN || path.join(OUT || '.', '..', 'cdn');
if (!OUT) { console.error('--out required'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'driver.log'), s + '\n'); };
const listDir = d => fs.readdirSync(d).filter(f => !f.startsWith('.')).map(f => path.join(d, f)).filter(f => fs.statSync(f).isFile()).sort();

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=8192'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: false });
// CDN libraries from a local cache (file name = URL path with / -> _), fonts dropped; nothing goes to the internet
await ctx.route('https://cdn.jsdelivr.net/**', async r => {
  const u = new URL(r.request().url()), f = path.join(CDN, u.pathname.replace(/^\/npm\//, '').replace(/@/g, '_').replace(/\//g, '_'));
  if (!fs.existsSync(f)) {
    // the repository's vendored copy of the same build (tests/web/unit/vendor), else one download with curl (it honours
    // the proxy settings) into the cache folder; the browser itself never goes to the internet
    const vend = path.join(HERE, '..', 'web', 'unit', 'vendor', path.basename(u.pathname));
    fs.mkdirSync(CDN, { recursive: true });
    if (/three@0\.147\.0\/build\/|dicom-parser@1\.8\.21\//.test(u.pathname) && fs.existsSync(vend)) fs.copyFileSync(vend, f);
    else try { execFileSync('curl', ['-sSfL', '--retry', '2', '-o', f, u.href], { timeout: 180000 }); } catch (e) { try { fs.unlinkSync(f); } catch (x) {} }
  }
  if (fs.existsSync(f)) return r.fulfill({ path: f, contentType: 'application/javascript' });
  log('CDN MISS', u.href, f); return r.abort();
});
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
const page = await ctx.newPage();
const consoleLog = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleLog.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => consoleLog.push('pageerror: ' + e.message));
page.on('dialog', d => d.accept());

const t0 = Date.now();
try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.Studio && window.Studio.S && window.Studio.S.red && window.Studio.parts.bone, null, { timeout: 300000 });
  // (evaluated over the devtools protocol: the page's CSP admits no inline or injected script, rightly)
  await page.evaluate(fs.readFileSync(path.join(HERE, 'page_helpers.js'), 'utf8'));
  await page.evaluate(() => H.idle(1500));
  log('sample mandible loaded', (Date.now() - t0) / 1000, 's');
  if (SC.mandible && SC.mandible.dicom) {
    const files = listDir(SC.mandible.dicom); log('mandible DICOM files', files.length);
    await page.setInputFiles('#dicomFiles', files);
    await page.waitForFunction(() => window.Studio.S.kind === 'dicom' && window.Studio.S.source && window.Studio.S.source.type === 'dicom', null, { timeout: 900000 });
    await page.evaluate(() => H.idle(2500));
    log('mandible DICOM loaded', await page.evaluate(() => JSON.stringify([Studio.S.vol.nx, Studio.S.vol.ny, Studio.S.vol.nz, Studio.S.red.sp])));
  }
  if (SC.thr) {
    await page.evaluate(async t => { const el = document.getElementById('thr'); el.value = t; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); await H.sleep(300); await H.idle(2000); }, SC.thr);
    log('threshold', SC.thr);
  }
  if (SC.perSide) await page.evaluate(n => { document.getElementById('perSide').value = String(n); }, SC.perSide);
  if (SC.g) await page.evaluate(g => Object.assign(Studio.S.g, g), SC.g);
  if (SC.lesion) {
    await page.evaluate(async L => {
      Lesion.setTool('paint');
      const inp = document.getElementById('lsRad'); inp.value = L.radius || 4; inp.dispatchEvent(new Event('input'));
      L.points.forEach((p, i) => Lesion.paint(p, null, i === 0));
      Lesion.strokeEnd(); Lesion.setTool('paint');
      await H.idle(1500);
    }, SC.lesion);
    log('lesion painted', SC.lesion.points.length, 'points');
  }
  if (SC.condyle) {
    // condylar resection: set the type first (Ref finds the condyles), the plan follows from the lesion / spot
    // bounded wait: report the page state instead of hanging when the app never goes idle
    const st = await page.evaluate(async side => {
      const el = document.getElementById('resType'); el.value = side; el.dispatchEvent(new Event('change')); await H.sleep(500);
      const r = await Promise.race([H.idle(1500).then(() => 'idle'), H.sleep(20000).then(() => 'not idle after 20 s')]);
      return { r, busy: !document.getElementById('busy').hidden, busyText: document.getElementById('busyText').textContent, ref: !!(window.Ref && Ref.get()),
               cond: window.Ref && Ref.get() ? Ref.get().cond : null, condyle: Studio.S.lesion.condyle, alert: (document.querySelector('.alert, #alert, [role=alert]') || {}).textContent || null };
    }, SC.condyle);
    log('condyle', SC.condyle, JSON.stringify(st));
    // app.js:902 regenerate() returns before busy(false) when there is no plan yet, so the 'Rezeksiyon güncelleniyor…'
    // pill stays up until the next build; continue (the autoPrep build clears it) instead of waiting
    if (st.r !== 'idle') log('condyle: app never went idle (stale busy pill) – continuing');
  }
  await page.evaluate(async () => { document.getElementById('autoPrep').click(); await H.sleep(500); await H.idle(2500); });
  log('autoPrep done', await page.evaluate(() => document.getElementById('guideStat').textContent));
  if (SC.split !== undefined) {
    await page.evaluate(async s => { const el = document.getElementById('g_split'); el.value = String(s); el.dispatchEvent(new Event('change')); await H.sleep(400); await H.idle(2500); }, SC.split);
    log('split', SC.split);
  }
  const fib = SC.fibula === undefined ? 'sample' : SC.fibula;
  if (fib) {
    if (fib === 'sample') await page.evaluate(() => document.getElementById('fibSample').click());
    else { const files = listDir(fib.dicom); log('fibula DICOM files', files.length); await page.setInputFiles('#fibFiles', files); }
    await page.waitForFunction(() => window.Fibula && Fibula.active(), null, { timeout: 900000 }).catch(e => log('fibula not active', e.message));
    await page.evaluate(() => H.idle(3000));
    if (SC.fibN) { await page.evaluate(async n => { document.querySelector(`#fibN button[data-n="${n}"]`).click(); await H.sleep(600); await H.idle(3000); }, SC.fibN); log('fibN', SC.fibN); }
    log('fibula', await page.evaluate(() => JSON.stringify(Fibula.summary() && { n: Fibula.summary().segment_sayisi, segs: Fibula.summary().segmentler.map(s => s.boy_mm), guide: !!Studio.S.fib.guide, msg: document.getElementById('fibMsg').textContent })));
  }
  await page.screenshot({ path: path.join(OUT, 'screen.png') });
  const probe = SC.probe ? await page.evaluate(src => (new Function('return (async () => {' + src + '})()'))(), SC.probe).catch(e => 'probe error: ' + e.message) : undefined;
  if (probe !== undefined) log('probe', JSON.stringify(probe).slice(0, 2000));
  const data = await page.evaluate(o => H.extract(o), { server: SC.server !== false });
  if (probe !== undefined) data.probe = probe;
  // split the big base64 fields into files
  const dump = (obj, key, name) => { if (obj && obj[key]) { fs.writeFileSync(path.join(OUT, name), Buffer.from(obj[key], 'base64')); obj[key] = name; } };
  const vol = (obj, name) => { if (obj) { fs.writeFileSync(path.join(OUT, name + '.raw'), Buffer.from(obj.data, 'base64')); obj.data = name + '.raw'; } };
  for (const [g, pre] of [[data.guide, 'm'], [data.fib && data.fib.guide, 'f']]) {
    if (!g) continue;
    dump(g, 'stl', `${pre}_guide_preview.stl`); dump(g, 'bone', `${pre}_bone_app.stl`);
    vol(g.hu, `${pre}_hu`); vol(g.field, `${pre}_field`);
    if (g.server) dump(g.server, 'stl', `${pre}_guide_server.stl`);
  }
  if (data.bar) { dump(data.bar, 'stl', 'm_bar_preview.stl'); if (data.bar.server) dump(data.bar.server, 'stl', 'm_bar_server.stl'); }
  data.console = consoleLog; data.seconds = (Date.now() - t0) / 1000; data.scenario = SC;
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(data, null, 1));
  log('done', data.seconds, 's; console issues:', consoleLog.length);
} catch (e) {
  log('FAILED', e.stack || e.message);
  try { await page.screenshot({ path: path.join(OUT, 'fail.png') }); } catch (x) {}
  fs.writeFileSync(path.join(OUT, 'error.txt'), String(e.stack || e) + '\n' + consoleLog.join('\n'));
  process.exitCode = 1;
} finally { await browser.close(); }
