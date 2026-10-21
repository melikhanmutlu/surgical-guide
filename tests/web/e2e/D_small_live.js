// Senaryo D · 1024×768 geçişi (anahtar ekranlar) ve yayındaki sitede tek, salt okunur duman testi
// D_LIVE=0 ile canlı test atlanır.
'use strict';
const H = require('./lib');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const layout = () => {
  const de = document.documentElement, out = { hScroll: de.scrollWidth > de.clientWidth + 1, vw: innerWidth, sw: de.scrollWidth };
  // controls cut off at the right edge of their panel, header items wrapping onto two lines
  const cut = [];
  document.querySelectorAll('#leftPanel button, #leftPanel input, #leftPanel select, header button, #rightPanel button').forEach(e => {
    const r = e.getBoundingClientRect(); if (!r.width || !e.offsetParent) return;
    const p = e.closest('aside, header'); if (!p) return; const pr = p.getBoundingClientRect();
    if (r.right > pr.right + 1 || r.left < pr.left - 1) cut.push((e.id || e.textContent.trim().slice(0, 20)) + `(${Math.round(r.left)}-${Math.round(r.right)} / ${Math.round(pr.right)})`);
  });
  const wrap = [...document.querySelectorAll('header button, header .pill, #readyPill')].filter(e => e.offsetParent && e.getBoundingClientRect().height > 44).map(e => e.textContent.trim().slice(0, 20) + ` h=${Math.round(e.getBoundingClientRect().height)}`);
  const stage = document.getElementById('stage').getBoundingClientRect();
  const title = document.getElementById('caseTitle'); const tTrunc = title && title.scrollWidth > title.clientWidth;
  return Object.assign(out, { cut: cut.slice(0, 15), wrap, stage: [Math.round(stage.width), Math.round(stage.height)], titleTruncated: tTrunc });
};

(async () => {
  {
    const h = await H.start({ name: 'D_1024', dir: 'D', viewport: { width: 1024, height: 768 } });
    const { page } = h;
    await h.goto();
    await h.run('D1.0', '1024×768', 'Açılış, örnek fibula, Otomatik planla', 'Yatay kaydırma yok, düğmeler panelde, 3B görünüm kullanılabilir boyutta', async () => {
      await h.openStep(1); await page.click('#fibSample'); await h.idle(); await page.click('#scM'); await h.idle();
      await h.openStep(3); await page.click('#autoPrep'); await h.idle();
      const L = await page.evaluate(layout);
      return { pass: !L.hScroll && !L.cut.length && L.stage[0] >= 300, actual: JSON.stringify(L), evidence: await h.shot('D1.0_1024_adim3') };
    });
    for (const n of [1, 2, 4, 5, 6, 7, 8]) {
      await h.run('D1.' + n, '1024×768', `Adım ${n} ekranı`, 'Taşma / kesilme yok', async () => {
        await h.openStep(n); await h.idle();
        const L = await page.evaluate(layout);
        return { pass: !L.hScroll && !L.cut.length, actual: JSON.stringify(L), evidence: await h.shot(`D1.${n}_1024_adim${n}`) };
      });
    }
    await h.run('D1.9', '1024×768', 'Sol / sağ panel aç-kapa, odak modu (Yalnız model), ayarlar diyaloğu', 'Düzen bozulmaz, diyalog ekrana sığar', async () => {
      await page.click('#tLeft'); await h.sleep(400); const a = await page.evaluate(layout); await h.shot('D1.9_sol_kapali'); await page.click('#tLeft'); await h.sleep(300);
      await page.click('#tFocus'); await h.sleep(400); const b = await page.evaluate(layout); await h.shot('D1.9_odak'); await page.click('#tFocus'); await h.sleep(300);
      await page.click('#tSettings'); await h.sleep(300);
      const d = await page.$eval('#dlgSet', e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scroll: e.scrollHeight > e.clientHeight }; });
      await h.shot('D1.9_ayarlar'); await page.keyboard.press('Escape');
      return { pass: !a.hScroll && !b.hScroll && d.bottom <= d.h, actual: `sol kapalı stage ${a.stage}; odak stage ${b.stage}; ayarlar ${JSON.stringify(d)}` };
    });
    await h.done();
  }
  {
    const h = await H.start({ name: 'D_1440_header', dir: 'D' });
    const { page } = h;
    await h.goto();
    await h.run('D2.0', '1440×900', 'Uzun vaka adıyla üst çubuk (gerçek BT etiketi uzunluğunda)', 'Üst çubuk öğeleri tek satırda', async () => {
      await page.evaluate(() => { document.getElementById('caseTitle').textContent = 'mandibula_anon · 0.625mm Bone · 417 kesit'; });
      await h.sleep(300);
      const L = await page.evaluate(layout);
      return { pass: !L.wrap.length, actual: JSON.stringify({ wrap: L.wrap, titleTruncated: L.titleTruncated }), evidence: await h.shot('D2.0_ust_cubuk') };
    });
    await h.done();
  }
  if (process.env.D_LIVE === '0') return;
  {
    // read-only smoke test of the deployed site: GETs only (fetched through curl), every POST/PUT/DELETE is blocked
    const LIVE = 'https://sguide.up.railway.app/?ornek=sentetik';
    const h = await H.start({ name: 'D_live', dir: 'D', external: 'live' });
    const { page, context } = h;
    const blocked = [];
    await context.unroute(/^https?:\/\/(?!127\.0\.0\.1|localhost)/);
    await context.route(/^https?:\/\//, async route => {
      const req = route.request();
      if (req.method() !== 'GET') { blocked.push(`${req.method()} ${req.url()}`); return route.abort(); }
      try {
        const f = path.join(h.SCRATCH, 'live_tmp'); const hdr = execFileSync('curl', ['-sS', '-L', '--max-time', '60', '-D', '-', '-o', f, req.url()]).toString();
        const st = +(([...hdr.matchAll(/^HTTP\/[\d.]+ (\d+)/gm)].pop() || [])[1] || 200), ct = ([...hdr.matchAll(/content-type:\s*([^\r\n]+)/ig)].pop() || [])[1] || 'application/octet-stream';
        return route.fulfill({ status: st, body: fs.readFileSync(f), headers: { 'content-type': ct } });
      } catch (e) { return route.abort(); }
    });
    await page.addInitScript(() => { try { localStorage.setItem('yolmed.autosave', '0'); } catch (e) {} });
    await h.run('D3.0', 'Canlı site', 'sguide.up.railway.app aç (salt okunur; POST/PUT engelli), örnek mandibula yüklenir, konsol', 'Sayfa açılır, örnek vaka görünür, konsol hatası yok, hiçbir yazma isteği gönderilmez', async () => {
      const t = Date.now();
      await page.goto(LIVE, { waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(2000);
      const s = await h.state(), hl = execFileSync('curl', ['-sS', '--max-time', '30', LIVE + 'health']).toString().slice(0, 200);
      const cfg = execFileSync('curl', ['-sS', '--max-time', '30', LIVE + 'config.js']).toString().slice(0, 200);
      const ver = await page.evaluate(() => [...document.scripts].map(s => s.src).filter(Boolean).length);
      const ev = await h.shot('D3.0_canli');
      const errs = h.errors.filter(e => e.scenario === 'D3.0');
      return { pass: s.kind === 'mandible' && !errs.length && !blocked.length, actual: `${Date.now() - t} ms; kind=${s.kind}; /health ${hl}; config.js "${cfg}"; script ${ver}; engellenen yazma istekleri ${blocked.length}: ${blocked.join(', ')}; konsol hata ${errs.length}`, evidence: ev };
    });
    await h.run('D3.1', 'Canlı site', 'Yerel ile aynı sürüm mü: index.html ve app.js karşılaştırması (curl)', 'Canlı = main@d8ccbfc', async () => {
      const crypto = require('crypto'), md5 = b => crypto.createHash('md5').update(b).digest('hex');
      const out = [];
      for (const f of ['index.html', 'app.js', 'i18n_en.js', 'fibula.js']) {
        const live = execFileSync('curl', ['-sS', '--max-time', '30', LIVE + (f === 'index.html' ? '' : f)]);
        const loc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', f));
        out.push(`${f}: ${md5(live) === md5(loc) ? 'aynı' : 'FARKLI'} (${live.length}/${loc.length} B)`);
      }
      return { pass: !out.some(x => /FARKLI/.test(x)), actual: out.join('; ') };
    });
    await h.done();
  }
})();
