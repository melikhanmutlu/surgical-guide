// Resection sweep: the full default flow of Guide Studio for a grid of resection regions x lengths x sides, one fresh
// browser per run (Playwright + SwiftShader), results as one JSON per run + one CSV row per run + screenshots.
//   SG_REPO=<repo> BASE=http://127.0.0.1:8870 OUT=<out dir> DATASETS=sample,real MAND_DIR=<dir of one series> FIB_DIR=<dir> node sweep.js
// env (all optional): REGIONS=symphysis,parasymphysis,body,angle,ramus,condyle  LENGTHS=20,30,45,60,80  SIDES=L,R
//   RUN_BUDGET_MS=120000 (planning budget per run, after the data is loaded)  LOAD_TIMEOUT_MS=600000  FORCE=1 (redo finished runs)
//   CDN_CACHE=<dir> (CDN scripts fetched once with curl through the proxy, then served from the cache)  SHOT_EVERY=5 (passing runs)
//   PW_MODULE=/opt/node-tools/node_modules/playwright  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const PW = process.env.PW_MODULE || '/opt/node-tools/node_modules/playwright';
const { chromium } = require(PW);

const HERE = __dirname;
const BASE = process.env.BASE || 'http://127.0.0.1:8870';
const OUT = path.resolve(process.env.OUT || path.join(HERE, 'out'));
const CDN_CACHE = process.env.CDN_CACHE || path.join(OUT, 'cdn');
const DATASETS = (process.env.DATASETS || 'sample,real').split(',').filter(Boolean);
const REGIONS = (process.env.REGIONS || 'symphysis,parasymphysis,body,angle,ramus,condyle').split(',').filter(Boolean);
const LENGTHS = (process.env.LENGTHS || '20,30,45,60,80').split(',').map(Number).filter(Boolean);
const SIDES = (process.env.SIDES || 'L,R').split(',').filter(Boolean);
const RUN_BUDGET = +(process.env.RUN_BUDGET_MS || 120000), LOAD_TIMEOUT = +(process.env.LOAD_TIMEOUT_MS || 600000);
const SHOT_EVERY = +(process.env.SHOT_EVERY || 5);
const MAND_DIR = process.env.MAND_DIR, FIB_DIR = process.env.FIB_DIR;
fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true }); fs.mkdirSync(path.join(OUT, 'ekran'), { recursive: true }); fs.mkdirSync(CDN_CACHE, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'sweep.log'), s + '\n'); };
const listDir = d => fs.readdirSync(d).filter(f => !f.startsWith('.')).map(f => path.join(d, f)).filter(f => fs.statSync(f).isFile()).sort();

// external (CDN) requests are fetched once with curl (it honours the agent proxy) and served from a cache
function cdnFetch(url) {
  const key = crypto.createHash('sha1').update(url).digest('hex'), f = path.join(CDN_CACHE, key), meta = f + '.type';
  if (!fs.existsSync(f)) {
    try {
      const hdr = execFileSync('curl', ['-sS', '-L', '-A', 'Mozilla/5.0 Chrome/120', '-D', '-', '-o', f, url], { timeout: 60000 }).toString();
      const m = [...hdr.matchAll(/content-type:\s*([^\r\n]+)/ig)].pop();
      fs.writeFileSync(meta, m ? m[1] : 'application/octet-stream');
    } catch (e) { try { fs.unlinkSync(f); } catch (_) {} return null; }
  }
  return { body: fs.readFileSync(f), type: fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8') : 'application/octet-stream' };
}

// ---------- CSV ----------
const COLS = ['dataset', 'region', 'side', 'len', 'id', 'status', 'error', 'plan_ok', 'n_cuts', 'cut_offs', 'cut_angles', 'res_len_mm', 'res_vol_cm3', 'lesion_from', 'lesion_to', 'condyle', 'arch_s', 'arch_sEnd', 'anchor', 'axis_dot_dir',
  'g_L', 'g_W', 'g_wrap', 'split', 'bar', 'm_pieces', 'm_undercut_mm2', 'm_contact_mm2', 'm_seat_ok', 'm_seat_free', 'm_seat_dirs', 'm_seat_tilt', 'm_seat_block_mm2', 'm_fit_band_pct', 'm_fit_tight_pct', 'm_screws', 'm_screws_null', 'm_screws_ok', 'm_screw_inbone_min', 'm_screw_cross',
  'm_crit', 'm_warn', 'f_active', 'f_FR', 'f_n', 'f_seg_lens', 'f_seg_min', 'f_angle_max', 'f_dev', 'f_proxLeft', 'f_defect_L', 'f_guide_pieces', 'f_guide_seat_free', 'f_guide_dirs', 'f_guide_contact', 'f_guide_wrap', 'f_guide_fit_band_pct', 'f_guide_screws_ok', 'f_crit', 'f_warn',
  'crit_total', 'qc_crit', 'pill', 'approval_blocked', 'approval_why', 'checks', 't_load_m_s', 't_plan_s', 't_load_f_s', 't_fib_s', 't_total_s', 'shots'];
const csvPath = path.join(OUT, 'tarama_app.csv');
const q = v => { if (v === undefined || v === null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csvRow(row) { if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, COLS.join(',') + '\n'); fs.appendFileSync(csvPath, COLS.map(c => q(row[c])).join(',') + '\n'); }

// one run's JSON -> flat CSV row (also used by summarize.py through the JSON; kept here so the CSV is complete while running)
function flatten(r) {
  const d = r.data || {}, R = d.result, F = d.fib, FG = F && F.guide && F.guide.result, FR = F && F.res, fitM = d.fit && d.fit.m, fitF = d.fit && d.fit.f;
  const checks = d.checks || [], fchecks = F ? F.checks || [] : [];
  const cnt = (arr, c, pred) => arr.filter(x => x[0] === c && (!pred || pred(x))).length;
  const mRef = x => !x[3] || x[3] !== 'fib';
  const sorted = (d.planes || []).slice().sort((a, b) => a.off - b.off);
  const qcCrit = (d.qc || []).filter(x => x[0] === 'crit').length;
  const blocked = (d.crit || 0) + qcCrit > 0;
  const why = [];
  if (d.crit) why.push(`${d.crit} kritik: ` + checks.filter(x => x[0] === 'crit').map(x => x[2]).join(' / '));
  if (qcCrit) why.push('görüntü kalitesi kritik');
  if (!R) why.push('guide yok');
  return {
    dataset: r.dataset, region: r.region, side: r.side, len: r.len, id: r.id, status: r.status, error: r.error || '',
    plan_ok: r.setup && r.setup.ok ? 1 : 0, n_cuts: d.planes ? d.planes.length : '', cut_offs: sorted.map(p => p.off), cut_angles: sorted.map(p => [p.yaw, p.pitch]),
    res_len_mm: d.resEnds ? d.resEnds.L : '', res_vol_cm3: d.resectedVolume != null ? +(d.resectedVolume / 1000).toFixed(2) : '', lesion_from: d.lesion && d.lesion.from, lesion_to: d.lesion && d.lesion.to, condyle: d.lesion && d.lesion.condyle || '',
    arch_s: r.setup && r.setup.centre ? r.setup.centre.s : '', arch_sEnd: r.setup && r.setup.centre ? r.setup.centre.sEnd : '', anchor: d.anchor && d.anchor.p, axis_dot_dir: r.setup && r.setup.axisDotDir,
    g_L: d.g && d.g.L, g_W: d.g && d.g.W, g_wrap: d.g && d.g.wrap, split: d.g && d.g.split ? 1 : 0, bar: R && R.bar ? (R.bar.ok ? `${R.bar.route} ${R.bar.len} mm, ${R.bar.clear} mm` : 'yok: ' + R.bar.why) : '',
    m_pieces: R ? R.pieces : '', m_undercut_mm2: R ? R.undercut : '', m_contact_mm2: R ? R.contact : '', m_seat_ok: R && R.seat ? (R.seat.ok ? 1 : 0) : '', m_seat_free: R && R.seat && R.seat.ok ? R.seat.free : '', m_seat_dirs: R && R.seat && R.seat.ok ? R.seat.ndirs : '',
    m_seat_tilt: R && R.seat && R.seat.ok ? R.seat.bestTilt : '', m_seat_block_mm2: R && R.seat && R.seat.ok ? R.seat.bestBlock : '', m_fit_band_pct: fitM && fitM.mode === 'gap' ? Math.round(fitM.inBand * 100) : '', m_fit_tight_pct: fitM && fitM.mode === 'gap' ? Math.round(fitM.tight * 100) : '',
    m_screws: d.screws ? d.screws.length : '', m_screws_null: d.screws ? d.screws.filter(s => !s).length : '', m_screws_ok: R ? R.screwInfo.filter(s => s.ok).length : '', m_screw_inbone_min: R && R.screwInfo.some(s => s.ok) ? Math.min(...R.screwInfo.filter(s => s.ok).map(s => s.inBone)) : '', m_screw_cross: R ? R.screwInfo.filter(s => s.crossesPlane).length : '',
    m_crit: cnt(checks, 'crit', mRef), m_warn: cnt(checks, 'warn', mRef),
    f_active: F ? 1 : 0, f_FR: F ? F.FR : '', f_n: F ? F.plan.n : '', f_seg_lens: FR ? FR.segs.map(s => s.L) : '', f_seg_min: FR && FR.segs.length ? Math.min(...FR.segs.map(s => s.L)) : '', f_angle_max: FR && FR.segs.length ? Math.max(...FR.segs.flatMap(s => [s.a0, s.a1])) : '',
    f_dev: FR ? FR.dev : '', f_proxLeft: FR ? FR.proxLeft : '', f_defect_L: FR ? FR.L : '', f_guide_pieces: FG ? FG.pieces : '', f_guide_seat_free: FG && FG.seat && FG.seat.ok ? FG.seat.free : '', f_guide_dirs: FG && FG.seat && FG.seat.ok ? FG.seat.ndirs : '', f_guide_contact: FG ? FG.contact : '',
    f_guide_wrap: F && F.guide ? F.guide.g.wrap : '', f_guide_fit_band_pct: fitF && fitF.mode === 'gap' ? Math.round(fitF.inBand * 100) : '', f_guide_screws_ok: FG ? FG.screwInfo.filter(s => s.ok && !s.crossesPlane).length + '/' + FG.screwInfo.length : '',
    f_crit: cnt(fchecks, 'crit'), f_warn: cnt(fchecks, 'warn'),
    crit_total: d.crit, qc_crit: qcCrit, pill: d.pill || '', approval_blocked: d.anchor ? (blocked ? 1 : 0) : '', approval_why: why.join('; '),
    checks: checks.filter(x => x[0] !== 'ok' && x[0] !== 'info').map(x => x[0] + ': ' + x[2]).join(' | '),
    t_load_m_s: r.t && r.t.loadM, t_plan_s: r.t && r.t.plan, t_load_f_s: r.t && r.t.loadF, t_fib_s: r.t && r.t.fib, t_total_s: r.t && r.t.total, shots: (r.shots || []).join(' '),
  };
}

// ---------- one run ----------
async function withTimeout(p, ms, what) { let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms); }); try { return await Promise.race([p, to]); } finally { clearTimeout(t); } }

async function runOne(run, idx) {
  const rec = { ...run, t: {}, console: [], shots: [] }, t0 = Date.now(), T = () => +((Date.now() - t0) / 1000).toFixed(1);
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=6144', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: false, locale: 'tr-TR' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async route => {
    const req = route.request(); if (req.method() !== 'GET') return route.continue();
    if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) return route.fulfill({ status: 200, body: '', contentType: 'text/css' });
    const r = cdnFetch(req.url()); if (!r) return route.abort();
    return route.fulfill({ status: 200, body: r.body, headers: { 'content-type': r.type, 'access-control-allow-origin': '*' } });
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) rec.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => rec.console.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('dialog', d => d.accept());
  const shot = async (name, clip) => { const f = `${run.id}_${name}.jpg`; await page.screenshot({ path: path.join(OUT, 'ekran', f), type: 'jpeg', quality: 60, clip: clip || undefined }); rec.shots.push(f); };
  try {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.Studio && window.Studio.S && window.Studio.S.red && window.Studio.parts.bone, null, { timeout: LOAD_TIMEOUT });
    await page.addScriptTag({ path: path.join(HERE, 'sweep_page.js') });
    await page.evaluate(() => SW.idle(1500));
    if (run.dataset === 'real') {
      const files = listDir(MAND_DIR);
      await page.setInputFiles('#dicomFiles', files);
      await page.waitForFunction(() => window.Studio.S.kind === 'dicom' && window.Studio.S.source && window.Studio.S.source.type === 'dicom', null, { timeout: LOAD_TIMEOUT });
      await page.evaluate(() => SW.idle(2500));
    }
    rec.t.loadM = T();
    rec.bone = await page.evaluate(() => ({ segMethod: Studio.S.segMethod, segInfo: Studio.S.segInfo && { status: Studio.S.segInfo.status, vol: Studio.S.segInfo.vol }, qc: (Studio.S.qc || []).map(q => q.slice(0, 3)) }));
    // planning budget starts once the data is in
    const tp = Date.now();
    rec.setup = await withTimeout(page.evaluate(([reg, side, len]) => SW.setRegion(reg, side, len), [run.region, run.side, run.len]), RUN_BUDGET, 'region + cuts + guide');
    rec.t.plan = +((Date.now() - tp) / 1000).toFixed(1);
    if (!rec.setup.ok) throw new Error('setup: ' + rec.setup.why);
    // fibula: sample leg or the real series; the app picks the segment count and builds the fibula guide on its own
    const tf = Date.now();
    if (run.dataset === 'real') await page.setInputFiles('#fibFiles', listDir(FIB_DIR)); else await page.evaluate(() => document.getElementById('fibSample').click());
    await page.waitForFunction(() => window.Fibula && Fibula.active(), null, { timeout: LOAD_TIMEOUT }).catch(e => { rec.fibNote = 'fibula not active: ' + e.message.slice(0, 120); });
    rec.t.loadF = +((Date.now() - tf) / 1000).toFixed(1);
    const tg = Date.now();
    await withTimeout(page.evaluate(() => SW.idle(3000)), RUN_BUDGET, 'fibula plan + guide').catch(e => { rec.fibNote = (rec.fibNote || '') + ' ' + e.message; });
    rec.t.fib = +((Date.now() - tg) / 1000).toFixed(1);
    rec.data = await page.evaluate(() => SW.extract());
    rec.status = 'done';
  } catch (e) {
    rec.status = /timeout/.test(e.message) ? 'timeout' : 'error'; rec.error = String(e.message || e).slice(0, 400);
    try { rec.data = await withTimeout(page.evaluate(() => SW.extract()), 20000, 'extract after error'); } catch (_) {}
  }
  // screenshots: every failing run, every SHOT_EVERY-th passing run
  try {
    const row = flatten(rec), failing = rec.status !== 'done' || row.approval_blocked === 1 || row.plan_ok !== 1;
    rec.failing = failing;
    if (failing || idx % SHOT_EVERY === 0) {
      const clip = await withTimeout(page.evaluate(() => SW.frameMandible()), 20000, 'frame'); await sleep(400); await shot('mand', clip);
      const fclip = await withTimeout(page.evaluate(() => SW.frameFibula()), 20000, 'frame fib'); if (fclip) { await sleep(400); await shot('fib', fclip); }
      if (failing) { await page.click('#tab-pChk').catch(() => {}); await sleep(300); await shot('ui'); }
    }
  } catch (e) { rec.shotError = String(e.message).slice(0, 200); }
  rec.t.total = T();
  try { await browser.close(); } catch (_) {}
  return rec;
}

(async () => {
  const grid = [];
  for (const dataset of DATASETS) for (const region of REGIONS) for (const len of LENGTHS) for (const side of SIDES) grid.push({ dataset, region, side, len, id: `${dataset}_${region}_${side}_${len}` });
  log(`sweep: ${grid.length} runs -> ${OUT}; BASE ${BASE}`);
  if (DATASETS.includes('real') && !(MAND_DIR && FIB_DIR)) { console.error('real dataset needs MAND_DIR and FIB_DIR'); process.exit(2); }
  let i = 0;
  for (const run of grid) {
    i++;
    const jf = path.join(OUT, 'runs', run.id + '.json');
    if (fs.existsSync(jf) && !process.env.FORCE) { log(`skip ${run.id} (done)`); continue; }
    log(`[${i}/${grid.length}] ${run.id}`);
    let rec;
    try { rec = await withTimeout(runOne(run, i), LOAD_TIMEOUT * 2 + RUN_BUDGET * 2, 'whole run'); }
    catch (e) { rec = { ...run, status: 'error', error: 'harness: ' + String(e.message).slice(0, 300), t: {} }; }
    fs.writeFileSync(jf, JSON.stringify(rec, null, 1));
    const row = flatten(rec); csvRow(row);
    log(`  ${rec.status} ${rec.error || ''} | cuts ${row.n_cuts} L=${row.g_L} pieces ${row.m_pieces} seat ${row.m_seat_free}/${row.m_seat_dirs} crit ${row.crit_total} | fib n=${row.f_n} segs ${JSON.stringify(row.f_seg_lens)} fg pieces ${row.f_guide_pieces} seat ${row.f_guide_seat_free} | ${row.t_total_s}s`);
  }
  log('sweep done');
})();
