// Senaryo T · panel turu ve lezyondan otomatik kesi (Melikhan 2026-10-29)
// Varsayılan gerçek BT örneğiyle, sade panelde (Gelişmiş kapalı, kullanıcının gördüğü gibi):
// T1: her numaralı adımın, sekmenin ve Gelişmiş bölümünün ekran görüntüsü (sol panel kaydırılarak baştan sona).
// T2 (sonda, plan varken): her adımda görünen her düğmeye tıklanır (dışa aktarma, silme, yükleme gibi geri alınamayanlar atlanır);
//     her tıklamada konsol/sayfa hatası, meşgul çubuğunun takılması ve panel taşması kaydedilir.
// T3: lezyon 3B modelde boyanır → kesiler lezyondan otomatik oluşur; kesiler lezyonu güvenlik payıyla dışarıda bırakır,
//     ikisi de kemiği keser; yan yana görünümde mandibula guide'ı görünür büyüklükte (2026-10-29: köşede küçük kalıyordu).
// T4: aynı lezyon kesitte (aksiyel) boyanır → aynı denetimler.
// T5: üst çene kutusu kemik modeli adımının ana alanında, kapanış düzlemi 3B'de ve kesitte görünür, ayırma çalışır.
// Ekran kaydı (webm) kanıt klasörüne yazılır (opt.video).
'use strict';
const H = require('./lib');
const SKIP = /indir|İndir|PDF|HTML|ZIP|STL|Paket|paket|Yükle|yükle|Sil\b|sil$|Temizle|Sıfırla|Yeni vaka|Kaldır|Kapat|Dışa|Kaydet|Sürüm|Geri yükle|Onayla|onayla|Fibula BT|Klasör|Dosya|DICOM|Aç…|Örnek/;

(async () => {
  const h = await H.start({ name: 'T_tour', dir: 'T', simple: true, video: true, dialog: 'dismiss' });
  const { page } = h;
  await h.goto(H.BASE + '/'); await h.idle(); await h.sleep(1500);

  const rows = () => h.ev(() => [...document.querySelectorAll('details.step[name="flow"]')].filter(d => !d.hidden && getComputedStyle(d).display !== 'none').map(d => d.id));
  const overflow = () => h.ev(() => { const p = document.getElementById('leftPanel'); return p.scrollWidth - p.clientWidth; });
  // the left panel shot from top to bottom (it scrolls)
  async function panelShots(tag) {
    const n = await h.ev(() => { const p = document.querySelector('#leftPanel .scroll') || document.getElementById('leftPanel'); p.scrollTop = 0; return Math.max(1, Math.ceil(p.scrollHeight / Math.max(1, p.clientHeight - 60))); });
    const out = [];
    for (let i = 0; i < Math.min(n, 6); i++) {
      await h.ev(i => { const p = document.querySelector('#leftPanel .scroll') || document.getElementById('leftPanel'); p.scrollTop = i * (p.clientHeight - 60); }, i); await h.sleep(150);
      out.push(await h.shot(`${tag}_${i + 1}`));
    }
    await h.ev(() => { const p = document.querySelector('#leftPanel .scroll') || document.getElementById('leftPanel'); p.scrollTop = 0; });
    return out;
  }

  // ---------- T1: screenshots of every step, tab and "Gelişmiş" ----------
  const ids = await rows();
  await h.run('T1.0', 'Adımlar', 'Sol paneldeki numaralı adımlar', 'Vaka ve BT ile Kemik modeli ayrı numaralı adımlar', async () => {
    const r = await h.ev(() => [...document.querySelectorAll('details.step[name="flow"]')].filter(d => !d.hidden && getComputedStyle(d).display !== 'none').map(d => d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim()));
    return { pass: /^1 ?Vaka ve BT/.test(r[0]) && /^2 ?Kemik modeli/.test(r[1] || ''), actual: JSON.stringify(r), evidence: await h.shot('T1_0_adimlar') };
  });
  const all = await h.ev(() => [...document.querySelectorAll('details.step[name="flow"]')].filter(d => !d.hidden).map(d => d.id));
  for (const id of all) {
    await h.run(`T1.${id}`, 'Ekran', `${id} açık, Gelişmiş kapalı ve açık`, 'Panel yatay taşmaz', async () => {
      await h.ev(id => UI.openStep(id), id); await h.sleep(600);
      const ev = await panelShots(`T1_${id}_sade`);
      await h.ev(id => document.querySelectorAll(`#${id} details[data-adv]`).forEach(d => { d.open = true; }), id); await h.sleep(400);
      const ev2 = await panelShots(`T1_${id}_gelismis`);
      await h.ev(id => document.querySelectorAll(`#${id} details[data-adv]`).forEach(d => { d.open = false; }), id);
      const of = await overflow();
      return { pass: of <= 1, actual: `taşma ${of}px`, evidence: ev.concat(ev2).join(', ') };
    });
  }

  // ---------- T5: the upper jaw box (2026-10-29: "o düzlem belli olmuyor") ----------
  await h.run('T5', 'Üst çene', 'Kemik modeli adımı, gerçek BT (üst çene dişlerden bağlı)', '"Üst çeneyi ayır" kutusu ana alanda; düzlem önerilir, 3B\'de turuncu levha ve yan kesitte çizgi; "Düzleme bak" yandan gösterir; ayırınca üst çene ayrı katman olur', async () => {
    await h.ev(() => UI.openStep('st2')); await h.sleep(800);
    const a = await h.ev(() => ({ box: !document.getElementById('jawBox').hidden && !document.getElementById('jawBox').closest('details[data-adv]'), occ: Masks.occ(), sheet: !!(Studio.scene.children.find(o => o.name === 'occlusalPlane') || {}).visible }));
    const s0 = await h.shot('T5_1_kutu');
    await page.click('#mkOccShow'); await h.sleep(1200);
    const s1 = await h.shot('T5_2_duzleme_bak');
    await page.click('#mkJaw'); await h.idle(240000); await h.sleep(1000);
    const b = await h.ev(() => ({ layers: Masks.layers().map(L => L.name), stat: document.getElementById('jawStat').textContent, sheet: !!(Studio.scene.children.find(o => o.name === 'occlusalPlane') || {}).visible, vol: Studio.S.comps.map(c => c.label) }));
    const s2 = await h.shot('T5_3_ayrildi');
    const ok = a.box && a.occ > 0 && a.sheet && /Üst çene ayrıldı/.test(b.stat) && !b.sheet && b.layers.includes('Üst çene');
    return { pass: ok, actual: JSON.stringify({ a, b }), evidence: [s0, s1, s2].join(', ') };
  });

  // ---------- T3/T4: lesion painted in 3D / on a slice → cuts from the lesion ----------
  // a lesion on the left mandibular body: bone points below the middle of the body height, 25-40 mm left of the midline
  async function lesionTarget() {
    return h.ev(() => {
      const S = Studio.S, pos = Studio.parts.bone.obj.geometry.attributes.position, m = Studio.parts.bone.obj.matrixWorld, v = new THREE.Vector3();
      let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; const P = [];
      for (let i = 0; i < pos.count; i += 7) { v.fromBufferAttribute(pos, i).applyMatrix4(m); P.push([v.x, v.y, v.z]); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P.at(-1)[a]); hi[a] = Math.max(hi[a], P.at(-1)[a]); } }
      const cx = (lo[0] + hi[0]) / 2;
      // body: low (bottom 35 % of the height), towards the front half
      const zc = lo[2] + 0.25 * (hi[2] - lo[2]);
      const c = P.filter(p => p[2] < lo[2] + 0.35 * (hi[2] - lo[2]) && Math.abs(p[0] - cx) > 25 && Math.abs(p[0] - cx) < 40 && p[0] > cx);
      if (!c.length) return null;
      const s = c.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map(x => x / c.length);
      return { c: s, zc, n: c.length };
    });
  }
  async function cutCheck(tag) {
    return h.ev(() => {
      const S = Studio.S, L = window.Lesion ? Lesion.points() : [];
      const d = Studio.planesWorld().map(pl => { const N = pl.N, p = pl.p; let mn = 1e9; for (const q of L) mn = Math.min(mn, Math.abs(N.x * (q.x - p.x) + N.y * (q.y - p.y) + N.z * (q.z - p.z))); return mn; });
      return { planes: S.planes.length, lesion: L.length, minDist: d, resected: !!(Studio.parts.resected && Studio.parts.resected.obj), crit: S.crit, guide: !!Studio.parts.guide };
    });
  }

  await h.run('T3', 'Lezyon 3B', 'Rezeksiyon adımında lezyon fırçası, 3B modelde sol gövdede sürükleme, fırça bırakılır', 'İki kesi oluşur, ikisi de lezyonun dışında (≥ güvenlik payının yarısı), rezeke parça ve guide kurulur', async () => {
    await h.ev(() => { UI.openStep('st3'); }); await h.sleep(400);
    await page.click('#rxMode button[data-m="paint"]'); await h.sleep(300);
    // the 3D view alone, so the bone fills it
    if (await page.$('#vm3d')) { await page.click('#vm3d'); await h.sleep(600); }
    const tg = await lesionTarget(); if (!tg) return { pass: false, actual: 'hedef bulunamadı' };
    await h.ev(c => { const St = Studio; St.controls.target.set(...c); St.camera.position.set(c[0] + 160, c[1] - 60, c[2] + 20); St.camera.lookAt(...c); St.controls.update(); St.render(); }, tg.c);
    await h.sleep(500);
    await page.click('#lsTools [data-t="paint"]'); await h.sleep(500);
    if (await page.$('#vm3d')) { await page.click('#vm3d'); await h.sleep(600); }
    const a = await h.proj(tg.c);
    const s0 = await h.shot('T3_1_fırca');
    await h.drag3d({ x: a.x - 18, y: a.y }, { x: a.x + 18, y: a.y }, 14);
    await h.drag3d({ x: a.x - 18, y: a.y + 8 }, { x: a.x + 18, y: a.y + 8 }, 14);
    const s1 = await h.shot('T3_2_boyandi');
    await page.keyboard.press('Escape'); await h.sleep(800); await h.idle(240000); await h.sleep(1500); await h.idle(240000);
    const r = await cutCheck();
    const s2 = await h.shot('T3_3_kesiler');
    const ok = r.planes === 2 && r.lesion > 0 && r.minDist.every(x => x >= 2) && r.resected;
    return { pass: ok, actual: JSON.stringify(r), evidence: [s0, s1, s2].join(', ') };
  });

  await h.run('T4', 'Lezyon kesit', 'Lezyon temizlenir, aksiyel kesitte aynı yer boyanır, fırça bırakılır', 'İki kesi oluşur, lezyonun dışında; rezeke parça kurulur', async () => {
    await h.ev(() => { const c = window.confirm; window.confirm = () => true; document.getElementById('planReset').click(); setTimeout(() => { window.confirm = c; }, 0); }); await h.idle(); await h.sleep(500);
    await h.ev(() => UI.openStep('st3')); await h.sleep(300);
    if (await page.$('#vmStrip')) { await page.click('#vmStrip'); await h.sleep(800); }
    const tg = await lesionTarget(); if (!tg) return { pass: false, actual: 'hedef bulunamadı' };
    await h.ev(c => MPR.jumpTo({ x: c[0], y: c[1], z: c[2] }), tg.c); await h.sleep(600);
    await page.click('#lsTools [data-t="paint"]'); await h.sleep(500);
    const at = await h.ev(c => {
      const v = MPR.views.find(x => x.id === 'ax'); if (v.cell.hidden) return null;
      const T = MPR.xf(v), im = MPR.idxToImg(v, MPR.toIdx(c)), r = v.canvas.getBoundingClientRect(), dpr = v.canvas.width / r.width;
      return { x: r.left + T.fx(im[0]) / dpr, y: r.top + T.fy(im[1]) / dpr, mm: T.s / dpr };
    }, tg.c);
    if (!at) return { pass: false, actual: 'aksiyel kesit görünmüyor', evidence: await h.shot('T4_kesit_yok') };
    const s0 = await h.shot('T4_1_kesit');
    const d = 6 * at.mm;
    await h.drag3d({ x: at.x - d, y: at.y }, { x: at.x + d, y: at.y }, 12);
    // a few slices up and down: the lesion has a height
    for (const dk of [3, 6, -3, -6]) {
      await h.ev(([c, dk]) => MPR.jumpTo({ x: c[0], y: c[1], z: c[2] + dk }), [tg.c, dk]); await h.sleep(200);
      await h.drag3d({ x: at.x - d, y: at.y }, { x: at.x + d, y: at.y }, 8);
    }
    const s1 = await h.shot('T4_2_boyandi');
    await page.keyboard.press('Escape'); await h.sleep(800); await h.idle(240000); await h.sleep(1500); await h.idle(240000);
    const r = await cutCheck();
    const s2 = await h.shot('T4_3_kesiler');
    // side by side: the mandible pane shows the guide large enough to see (not the whole skull in a corner)
    const fr = await h.ev(() => { const St = Studio, g = St.parts.guide; if (!g) return null; const b = new THREE.Box3().setFromObject(g.obj), r = St.renderer.domElement.getBoundingClientRect(), rw = St.S.split ? r.width / 2 : r.width;
      const xs = [], ys = []; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const p = new THREE.Vector3(x, y, z).project(St.camera); xs.push(p.x); ys.push(p.y); }
      return { w: (Math.max(...xs) - Math.min(...xs)) / 2, h: (Math.max(...ys) - Math.min(...ys)) / 2, inside: Math.min(...xs) > -1 && Math.max(...xs) < 1 && Math.min(...ys) > -1 && Math.max(...ys) < 1, split: St.S.split }; });
    r.frame = fr;
    const ok = fr && fr.inside && Math.max(fr.w, fr.h) > 0.3 && r.planes === 2 && r.lesion > 0 && r.minDist.every(x => x >= 2) && r.resected;
    return { pass: ok, actual: JSON.stringify(r), evidence: [s0, s1, s2].join(', ') };
  });
  // ---------- T2: click every visible button of every step ----------
  const clicks = [];
  for (const id of all) {
    if (id === 'st3') continue;   // the plan the buttons act on stays (Rezeksiyon buttons re-plan it; T3/T4 drive them)
    await h.ev(id => UI.openStep(id), id); await h.sleep(400);
    await h.ev(id => document.querySelectorAll(`#${id} details[data-adv], #${id} details.sec`).forEach(d => { d.open = true; }), id); await h.sleep(300);
    const btns = await h.ev(id => [...document.querySelectorAll(`#${id} .body button`)].filter(b => b.offsetParent && !b.disabled && !b.closest('[hidden]') && !b.closest('.part-tabs'))
      .map((b, i) => { b.dataset.tour = id + '_' + i; return { k: b.dataset.tour, t: (b.textContent || b.title || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60), danger: b.classList.contains('danger') || b.classList.contains('next') }; }), id);
    for (const b of btns) {
      if (b.danger || !b.t || SKIP.test(b.t)) { clicks.push({ step: id, btn: b.t, skipped: true }); continue; }
      const e0 = h.errors.length;
      const el = await page.$(`[data-tour="${b.k}"]`); if (!el || !(await el.isVisible())) { clicks.push({ step: id, btn: b.t, gone: true }); continue; }
      h.scenario = `T2.${id}`;
      const t0 = Date.now();
      try { await el.click({ timeout: 5000 }); } catch (e) { clicks.push({ step: id, btn: b.t, err: 'tıklanamadı: ' + e.message.slice(0, 80) }); continue; }
      const idle = await h.idle(120000, 500);
      await h.sleep(250);
      const st = await h.ev(() => ({ badge: (document.getElementById('modeBadge') || {}).hidden === false ? document.getElementById('modeBadge').textContent : '', busy: !document.getElementById('busy').hidden }));
      const errs = h.errors.slice(e0).map(e => e.text.slice(0, 160));
      const shot = await h.shot(`T2_${b.k}`);
      clicks.push({ step: id, btn: b.t, ms: Date.now() - t0, idle, badge: st.badge, errs, of: await overflow(), shot });
      // a tool the button switched on is switched off again (Esc), an open dialog is closed
      await page.keyboard.press('Escape'); await h.sleep(150);
      await h.ev(id => UI.openStep(id), id); await h.sleep(150);
      await h.ev(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    }
  }
  h.saveJSON('T2_tiklamalar.json', clicks);
  await h.run('T2', 'Düğmeler', `${clicks.filter(c => !c.skipped).length} düğme tıklandı (${clicks.filter(c => c.skipped).length} atlandı)`, 'Hiçbirinde konsol/sayfa hatası yok, meşgul çubuğu takılmıyor, panel taşmıyor', async () => {
    const bad = clicks.filter(c => !c.skipped && ((c.errs && c.errs.length) || c.idle === false || c.of > 1 || c.err));
    return { pass: !bad.length, actual: bad.length ? JSON.stringify(bad.map(c => ({ s: c.step, b: c.btn, e: c.errs, idle: c.idle, of: c.of, err: c.err }))).slice(0, 1500) : 'sorun yok' };
  });

  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
