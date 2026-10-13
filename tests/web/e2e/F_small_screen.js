// Senaryo F · küçük ekran düzeni (1024×768 ve 1280×720)
// Örnek vaka, fibula ve mandibula adımlarında: yatay kaydırma yok, panel/ekran çakışması yok, hiçbir öğe pencere dışına taşmıyor,
// anahtar düğmeler görünür, 3B görünüm kullanılabilir boyutta. Ekran görüntüleri kanit/F altına yazılır (depoya girmez).
'use strict';
const H = require('./lib');

const VIEWPORTS = [{ width: 1024, height: 768 }, { width: 1280, height: 720 }];
const KEY = ['#tLeft', '#tRight', '#tFocus', '#tSettings', '#undo', '#readyPill'];

const check = (key) => {
  const R = e => e.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const vis = e => { const r = R(e); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const out = { hScroll: de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1, overflow: [], overlap: [], hidden: [] };
  // a side panel scrolls vertically, so elements below its fold are fine; nothing may leave the window sideways
  const scroller = e => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll') return p; } return null; };
  document.querySelectorAll('header *, aside *, .stagewrap *').forEach(e => {
    if (e.closest('svg, [hidden], dialog:not([open])') || !vis(e) || !e.offsetParent) return;
    const r = R(e), s = scroller(e);
    if (r.right > vw + 1 || r.left < -1 || (!s && (r.bottom > vh + 1 || r.top < -1))) out.overflow.push(`${e.id || e.className || e.tagName}(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`);
  });
  const boxes = ['#leftPanel', '#rightPanel', '.stagewrap'].map(s => { const e = document.querySelector(s); return e && vis(e) ? [s, R(e)] : null; }).filter(Boolean);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i][1], b = boxes[j][1];
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.overlap.push(boxes[i][0] + ' x ' + boxes[j][0]);
  }
  const hd = document.querySelector('header.top');
  out.header = Math.round(R(hd).height);
  if (hd.scrollWidth > hd.clientWidth + 1) out.overflow.push('header scrollWidth ' + hd.scrollWidth + '>' + hd.clientWidth);
  key.forEach(s => { const e = document.querySelector(s); if (!e || !vis(e)) { out.hidden.push(s + ' (yok/gizli)'); return; } const r = R(e); if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh) out.hidden.push(s + ' (pencere dışı)'); });
  // controls of the open panels stay inside the panel width
  ['#leftPanel', '#rightPanel'].forEach(ps => {
    const p = document.querySelector(ps); if (!p || !vis(p)) return; const pr = R(p);
    p.querySelectorAll('button, select, input:not([type=file]):not([type=hidden])').forEach(e => {
      if (!vis(e) || !e.offsetParent || e.closest('[hidden]')) return; const r = R(e);
      if (r.right > pr.right + 1 || r.left < pr.left - 1) out.overflow.push(ps + ' ' + (e.id || e.textContent.trim().slice(0, 18)) + `(${Math.round(r.left)}-${Math.round(r.right)}/${Math.round(pr.right)})`);
    });
  });
  const st = R(document.querySelector('.stagewrap')); out.stage = [Math.round(st.width), Math.round(st.height)];
  out.left = Math.round(R(document.getElementById('leftPanel')).width); out.right = Math.round(R(document.getElementById('rightPanel')).width);
  out.overflow = out.overflow.slice(0, 12);
  return out;
};

const verdict = (L, minW, minH) => {
  const probs = [];
  if (L.hScroll) probs.push('yatay kaydırma');
  if (L.overflow.length) probs.push('taşan: ' + L.overflow.join('; '));
  if (L.overlap.length) probs.push('çakışma: ' + L.overlap.join('; '));
  if (L.hidden.length) probs.push('görünmeyen: ' + L.hidden.join('; '));
  if (L.header > 60) probs.push('üst çubuk ' + L.header + 'px');
  if (L.stage[0] < minW || L.stage[1] < minH) probs.push(`3B alan küçük ${L.stage}`);
  return probs;
};

(async () => {
  for (const vp of VIEWPORTS) {
    const tag = `${vp.width}x${vp.height}`;
    const h = await H.start({ name: 'F_' + tag, dir: 'F', viewport: vp });
    const { page } = h;
    await h.goto();
    const screen = (id, what, shot, minW = 380, minH = 380) => h.run(id, tag, what, 'Taşma/çakışma yok, düğmeler görünür, 3B görünüm kullanılabilir', async () => {
      const L = await page.evaluate(check, KEY); const probs = verdict(L, minW, minH);
      const info = JSON.stringify({ stage: L.stage, left: L.left, right: L.right });
      return { pass: !probs.length, actual: probs.length ? probs.join(' | ') + ' ' + info : info, evidence: await h.shot(shot + '_' + tag) };
    });
    await h.openStep(1); await h.idle();
    await screen('F1.' + tag, 'Örnek vaka yüklü, adım 1', 'F1_adim1');
    for (const n of [2, 3, 4, 5]) { await h.openStep(n); await h.idle(); await screen(`F2.${n}.${tag}`, `Mandibula adım ${n}`, `F2_mandibula_adim${n}`); }
    await h.openStep(1); await page.click('#fibSample'); await h.idle();
    await page.click('#scF').catch(() => {}); await h.idle();
    for (const n of [1, 3, 4, 5, 6, 8]) { await h.openStep(n); await h.idle(); await screen(`F3.${n}.${tag}`, `Fibula adım ${n}`, `F3_fibula_adim${n}`); }
    await h.run('F4.' + tag, tag, 'Sol/sağ panel kapat, odak modu', 'Kapatılınca 3B alan genişler, düzen bozulmaz', async () => {
      // the columns animate (.18s) and the page is busy rendering in software GL, so wait until the stage width stops changing
      const settle = async () => { let last = -1, n = 0; for (let i = 0; i < 40 && n < 4; i++) { await h.sleep(150); const w = await page.evaluate(() => document.querySelector('.stagewrap').getBoundingClientRect().width); n = w === last ? n + 1 : 0; last = w; } };
      await settle(); const base = await page.evaluate(check, KEY);
      await page.click('#tLeft'); await settle(); const a = await page.evaluate(check, KEY);
      await page.click('#tRight'); await settle(); const b = await page.evaluate(check, KEY); await h.shot('F4_odak_' + tag);
      await page.click('#tLeft'); await page.click('#tRight'); await settle();
      const probs = [...verdict(a, 380, 380), ...verdict(b, 600, 380)];
      if (!(b.stage[0] > a.stage[0] && a.stage[0] > base.stage[0])) probs.push(`3B alan genişlemedi ${base.stage} ${a.stage} ${b.stage}`);
      return { pass: !probs.length, actual: probs.join(' | ') || `stage ${base.stage} -> ${a.stage} -> ${b.stage}` };
    });
    await h.run('F5.' + tag, tag, 'Ayarlar diyaloğu', 'Diyalog pencereye sığar', async () => {
      await page.click('#tSettings'); await h.sleep(300);
      const d = await page.$eval('#dlgSet', e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: innerWidth, h: innerHeight }; });
      await h.shot('F5_ayarlar_' + tag); await page.keyboard.press('Escape');
      return { pass: d.l >= 0 && d.t >= 0 && d.r <= d.w && d.b <= d.h, actual: JSON.stringify(d) };
    });
    const r = await h.done();
    if (r.fail) process.exitCode = 1;
  }
})();
