// Denetim 3 · e2e harness ortak kitaplığı (Playwright + SwiftShader)
// Kullanım: const H = require('./lib'); const h = await H.start({ name: 'A' }); ... await h.done();
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const PW = process.env.PW_MODULE || '/opt/node-tools/node_modules/playwright';
const { chromium } = require(PW);

const E2E = path.resolve(__dirname, '..');
const KANIT = process.env.KANIT || path.join(E2E, 'kanit');
const SCRATCH = process.env.E2E_SCRATCH || path.join(require('os').tmpdir(), 'yolmed-e2e');
const TOKEN = process.env.E2E_TOKEN || '';   // server started with YOLMED_TOKEN: typed into the access-token dialog on every page load
const BASE = process.env.BASE || 'http://127.0.0.1:8840';
const CDN_CACHE = path.join(SCRATCH, 'cdn');
fs.mkdirSync(CDN_CACHE, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// external (CDN, fonts) requests are fetched once with curl (it honours the agent proxy) and served from a cache,
// so runs are reproducible and the browser needs no proxy setup
function cdnFetch(url) {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const f = path.join(CDN_CACHE, key), meta = f + '.type';
  if (!fs.existsSync(f)) {
    try {
      const hdr = execFileSync('curl', ['-sS', '-L', '--retry', '2', '-A', 'Mozilla/5.0 Chrome/120', '-D', '-', '-o', f, url], { timeout: 180000 }).toString();
      const m = [...hdr.matchAll(/content-type:\s*([^\r\n]+)/ig)].pop();
      fs.writeFileSync(meta, m ? m[1] : 'application/octet-stream');
    } catch (e) { try { fs.unlinkSync(f); } catch (_) {} return null; }
  }
  return { body: fs.readFileSync(f), type: fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8') : 'application/octet-stream' };
}

async function start(opt = {}) {
  const name = opt.name || 'run';
  const outDir = path.join(KANIT, opt.dir || name);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist',
      '--enable-precise-memory-info', '--js-flags=--max-old-space-size=6144', '--no-sandbox'],
  });
  const viewport = opt.viewport || { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'tr-TR', deviceScaleFactor: 1 });
  if (opt.storageState) await context.addCookies([]);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async route => {
    const req = route.request();
    if (opt.external === 'live' || req.method() !== 'GET') return route.continue();
    const r = cdnFetch(req.url());
    if (!r) return route.abort();
    return route.fulfill({ status: 200, body: r.body, headers: { 'content-type': r.type, 'access-control-allow-origin': '*' } });
  });
  // CSP violations (the server pins the CDN to exact package paths) are console errors of their own kind, so a blocked
  // script, codec or worker shows up in every scenario's error count and in tablo.md
  await context.addInitScript(() => {
    addEventListener('securitypolicyviolation', e => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI || ''} (${e.sourceFile || ''}:${e.lineNumber || ''})`));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(opt.timeout || 120000);
  const log = [];          // every console line
  const errors = [];       // console.error + pageerror + failed requests
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
  let scenario = '-';
  page.on('console', m => {
    const line = `[${stamp()}s][${scenario}][${m.type()}] ${m.text()}`;
    log.push(line);
    if (m.type() === 'error') errors.push({ scenario, kind: /^CSP violation|Content Security Policy/.test(m.text()) ? 'csp' : 'console.error', text: m.text().slice(0, 600) });
  });
  page.on('pageerror', e => { const t = (e.stack || e.message || String(e)).slice(0, 1200); log.push(`[${stamp()}s][${scenario}][pageerror] ${t}`); errors.push({ scenario, kind: 'pageerror', text: t }); });
  page.on('requestfailed', r => { const t = `${r.method()} ${r.url()} ${r.failure() && r.failure().errorText}`; log.push(`[${stamp()}s][${scenario}][requestfailed] ${t}`); if (!/fonts\.g/.test(r.url())) errors.push({ scenario, kind: 'requestfailed', text: t }); });
  page.on('dialog', async d => { log.push(`[${stamp()}s][${scenario}][dialog:${d.type()}] ${d.message()}`); try { await (opt.dialog === 'dismiss' ? d.dismiss() : d.accept()); } catch (_) {} });

  const results = [];
  const h = {
    browser, context, page, outDir, log, errors, results, BASE, KANIT, SCRATCH, sleep,
    set scenario(s) { scenario = s; }, get scenario() { return scenario; },
    // wait until the busy overlay has been hidden for `quiet` ms
    async idle(timeout = 180000, quiet = 700) {
      const end = Date.now() + timeout; let since = 0;
      while (Date.now() < end) {
        const b = await page.evaluate(() => { const e = document.getElementById('busy'); return !!(e && !e.hidden); }).catch(() => true);
        if (!b) { if (!since) since = Date.now(); if (Date.now() - since >= quiet) return true; } else since = 0;
        await sleep(150);
      }
      return false;
    },
    async shot(file, o = {}) {
      const p = path.join(outDir, file.replace(/\.(png|jpg)$/, '') + (o.png ? '.png' : '.jpg'));
      await page.screenshot({ path: p, type: o.png ? 'png' : 'jpeg', quality: o.png ? undefined : 70, fullPage: false });
      return path.relative(E2E, p);
    },
    async ev(fn, arg) { return page.evaluate(fn, arg); },
    // record one scenario row
    rec(row) {
      row.errors = errors.filter(e => e.scenario === row.id).length;
      row.pass = row.pass === undefined ? null : row.pass;
      results.push(row);
      console.log(`${row.pass === true ? 'PASS' : row.pass === false ? 'FAIL' : 'INFO'} ${row.id} ${row.step || ''} :: ${row.actual || ''}`);
    },
    // run a scenario body: catches harness exceptions, records a FAIL with a screenshot
    async run(id, step, what, expected, fn) {
      scenario = id; const before = errors.length; const t = Date.now();
      let row = { id, step, what, expected };
      try {
        const r = await fn() || {};
        Object.assign(row, r);
      } catch (e) {
        row.pass = false; row.actual = 'HARNESS/EXC: ' + (e.message || e).toString().slice(0, 300);
        try { row.evidence = (row.evidence ? row.evidence + ', ' : '') + await h.shot(id.replace(/[^\w.-]/g, '_') + '_exc'); } catch (_) {}
      }
      row.ms = Date.now() - t;
      const errs = errors.slice(before).filter(e => e.scenario === id);
      if (errs.some(e => e.kind === 'pageerror') && row.pass === true && !row.allowErrors) { row.pass = false; row.actual = (row.actual || '') + ' [pageerror]'; }
      h.rec(row);
      return row;
    },
    async openStep(n) {
      await page.evaluate(n => { const d = document.getElementById('st' + n); if (d && !d.open) d.querySelector('summary').click(); }, n);
      await sleep(250);
    },
    async clickText(selector, text) { await page.locator(selector, { hasText: text }).first().click(); },
    async setRange(sel, value) {
      // dispatch input + change like a user releasing the slider
      await page.evaluate(([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, String(value)]);
    },
    async mem() { return page.evaluate(() => performance.memory ? { used: Math.round(performance.memory.usedJSHeapSize / 1048576), total: Math.round(performance.memory.totalJSHeapSize / 1048576), limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null); },
    async state() {
      return page.evaluate(() => {
        const S = window.Studio && Studio.S; if (!S) return null;
        const R = S.result;
        return {
          kind: S.kind, src: S.source && S.source.name, planes: S.planes.map(p => ({ off: +(+p.off).toFixed(2), yaw: p.yaw, pitch: p.pitch })), screws: S.screws.length,
          nullScrews: S.screws.filter(s => !s).length, guideOn: S.guideOn, split: S.g.split, L: S.g.L, crit: S.crit,
          pieces: R && R.pieces, critList: [...document.querySelectorAll('#checks li')].filter(li => /crit/.test(li.className)).map(li => li.textContent.trim()).slice(0, 8),
          pill: (document.getElementById('readyPill') || {}).textContent, condyle: S.lesion && S.lesion.condyle,
          fib: window.Fibula && Fibula.plan ? (() => { try { const p = Fibula.plan(); return p && p.segs ? p.segs.length : null; } catch (e) { return 'err'; } })() : null,
        };
      });
    },
    // no load being built (setVolume) and no guide / resection rebuild pending or running: a measurement taken
    // right after the busy bar hides can otherwise read a value the next rebuild still changes
    async settle(timeout = 240000) {
      await page.waitForFunction(() => window.Studio && !(Studio.loadBusy && Studio.loadBusy()), null, { timeout });
      await page.evaluate(() => Studio.settled && Studio.settled()); await h.idle(timeout, 400);
    },
    // the plan has been written to the case store: settled, then "Kaydedildi …" shown for longer than the autosave
    // debounce (1 s, store.js queueSave), so no save is still queued behind it
    async saved(timeout = 60000) {
      await h.settle(); const end = Date.now() + timeout; let since = 0;
      while (Date.now() < end) {
        const ok = await page.evaluate(() => /^Kaydedildi/.test((document.getElementById('saveState') || {}).textContent || '')).catch(() => false);
        if (ok) { if (!since) since = Date.now(); if (Date.now() - since >= 1500) return true; } else since = 0;
        await sleep(150);
      }
      return false;
    },
    // the fibula CT is loaded and separated (Fibula.active, the busy layer gone); no fibula plan is needed for this, so it
    // is the wait after a fibula load while the mandible has no resection yet (Denetim 6: C7 and C5 waited for a plan there)
    async fibLoaded(timeout = 240000) {
      await page.waitForFunction(() => window.Fibula && Fibula.active() && Studio.S.fib && !(Studio.loadBusy && Studio.loadBusy()), null, { timeout }); await h.idle(timeout);
    },
    // the fibula plan has been computed (segments exist) and every rebuild has settled
    async fibReady(timeout = 240000) {
      await page.waitForFunction(() => window.Fibula && Fibula.state().last, null, { timeout }); await h.settle(timeout);
    },
    async waitReady(timeout = 240000) {
      await page.waitForFunction(() => window.Studio && Studio.S && Studio.S.vol && Studio.parts && Studio.parts.bone, null, { timeout });
      await h.idle(timeout);
    },
    async goto(url = BASE + '/?ornek=sentetik', o = {}) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (TOKEN) await h.token();
      if (o.ready !== false) await h.waitReady();
    },
    // access-token dialog (#dlgTok) of a server started with YOLMED_TOKEN: wait for it, type the token, connect
    tokenAsked: 0,
    async token(timeout = 60000) {
      await page.waitForSelector('#dlgTok[open]', { timeout });
      await page.fill('#tokIn', TOKEN); await page.press('#tokIn', 'Enter');
      await page.waitForSelector('#dlgTok[open]', { state: 'detached', timeout: 10000 }).catch(() => page.waitForFunction(() => !document.getElementById('dlgTok').open, null, { timeout: 10000 }));
      h.tokenAsked++;
    },
    // world point (array or {x,y,z}) -> page pixel coordinates in the 3D view
    async proj(w) {
      return page.evaluate(w => {
        const St = Studio, v = Array.isArray(w) ? new THREE.Vector3(...w) : new THREE.Vector3(w.x, w.y, w.z);
        const r = St.renderer.domElement.getBoundingClientRect(), rw = St.S.split ? r.width / 2 : r.width;
        const p = v.clone().project(St.camera);
        return { x: r.left + (p.x + 1) / 2 * rw, y: r.top + (1 - p.y) / 2 * r.height, z: p.z };
      }, w);
    },
    // screen points whose ray hits a part (default: bone), scanned on a grid over the 3D view
    async hits(partId = 'bone', step = 14) {
      return page.evaluate(([id, step]) => {
        const St = Studio, el = St.renderer.domElement, r = el.getBoundingClientRect(), pt = St.parts[id];
        if (!pt) return [];
        const rc = new THREE.Raycaster(), m = new THREE.Vector2(), out = [];
        const rw = St.S.split ? r.width / 2 : r.width;
        for (let y = r.top + 20; y < r.bottom - 80; y += step) for (let x = r.left + 20; x < r.left + rw - 20; x += step) {
          const top = document.elementFromPoint(x, y); if (top !== el) continue;   // covered by a toolbar or label
          m.set(((x - r.left) / rw) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); rc.setFromCamera(m, St.camera);
          const hit = rc.intersectObject(pt.obj, true)[0];
          if (hit) out.push({ x, y, p: [hit.point.x, hit.point.y, hit.point.z] });
        }
        return out;
      }, [partId, step]);
    },
    // world point under a pixel on a part (null when the ray misses)
    async pick(x, y, partId = 'bone') {
      return page.evaluate(([x, y, id]) => {
        const St = Studio, el = St.renderer.domElement, r = el.getBoundingClientRect(), pt = St.parts[id]; if (!pt) return null;
        const rw = St.S.split ? r.width / 2 : r.width, m = new THREE.Vector2(((x - r.left) / rw) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), rc = new THREE.Raycaster();
        rc.setFromCamera(m, St.camera); const hit = rc.intersectObject(pt.obj, true)[0];
        return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
      }, [x, y, partId]);
    },
    async click3d(x, y) { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); },
    async drag3d(a, b, steps = 12) {
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(60); }
      await page.mouse.up();
    },
    // text nodes still in Turkish while the interface is English (visible only)
    async untranslated(root = 'body') {
      return page.evaluate(root => {
        const TR = /[çğıöşüÇĞİÖŞÜ]|\b(ve|ile|için|veya|yok|var|seç|onay|kesi|vida|kemik|guide'ı|adım|kaydet|yükle|sil|göster|gizle|değil|olarak|bekliyor|hazır|parça|ayarlar|yardım)\b/i;
        const out = new Set(), base = document.querySelector(root); if (!base) return [];
        const tw = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          const t = n.data.trim(); if (!t || t.length < 2) continue;
          const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|OPTION)$/.test(p.tagName)) continue;
          if (p.closest('#caseTitle,#caseName,#caseList,#json,#histList,#verList,.ini')) continue;
          const cs = p.getClientRects(); if (!cs.length) continue;
          const st = getComputedStyle(p); if (st.visibility === 'hidden' || st.display === 'none') continue;
          if (TR.test(t) && !/^Türkçe$/.test(t)) out.add(t.slice(0, 120));
        }
        // attributes the user sees on hover
        base.querySelectorAll('[title],[placeholder],[aria-label]').forEach(e => { if (!e.getClientRects().length) return; ['title', 'placeholder', 'aria-label'].forEach(a => { const v = e.getAttribute(a); if (v && TR.test(v) && !/^Türkçe$/.test(v)) out.add('@' + a + ': ' + v.slice(0, 120)); }); });
        return [...out];
      }, root);
    },
    saveJSON(file, obj) { const p = path.join(outDir, file); fs.writeFileSync(p, JSON.stringify(obj, null, 1)); return path.relative(E2E, p); },
    async done() {
      fs.writeFileSync(path.join(outDir, `console_${name}.log`), log.join('\n'));
      fs.writeFileSync(path.join(outDir, `results_${name}.json`), JSON.stringify({ name, base: BASE, viewport, results, errors }, null, 1));
      try { await browser.close(); } catch (_) {}
      const p = results.filter(r => r.pass === true).length, f = results.filter(r => r.pass === false).length;
      console.log(`== ${name}: ${p} pass, ${f} fail, ${results.length - p - f} info, ${errors.length} console/page errors, ${errors.filter(e => e.kind === 'csp').length} CSP violations${TOKEN ? `, token dialog ${h.tokenAsked}×` : ''}`);
      return { pass: p, fail: f, results, errors };
    },
  };
  return h;
}

// zip contents through Python's zipfile (no external unzip binary, so the suites also run on Windows)
const ZPY = "import zipfile, sys\nz = zipfile.ZipFile(sys.argv[2])\nif sys.argv[1] == 'list': print('\\n'.join(z.namelist()))\nelif sys.argv[1] == 'read': sys.stdout.buffer.write(z.read(sys.argv[3]))\nelse: [z.extract(n, sys.argv[3]) for n in sys.argv[4:]]";
const py = args => require('child_process').execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', ZPY, ...args], { maxBuffer: 256 * 1024 * 1024 });   // a production STL is well over the 1 MB default
const zipList = p => py(['list', p]).toString().trim().split(/\r?\n/);
const zipRead = (p, name) => py(['read', p, name]);
const zipExtract = (p, names, dir) => py(['extract', p, dir, ...names]);
module.exports = { start, sleep, E2E, KANIT, SCRATCH, BASE, TOKEN, zipList, zipRead, zipExtract };
