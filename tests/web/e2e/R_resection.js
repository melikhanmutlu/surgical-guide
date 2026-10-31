// Senaryo R · rezeksiyon ve guide önerisi (Melikhan 2026-10-31 "tüm adımları uygula"), gerçek BT örneğinde:
// R1 pay hekimden: seçilmemiş pay uyarı verir; lezyon tipi ana alanda; malign seçilince 10 mm; malignde 10 mm altı uyarı.
// R2 oturma testi: sürekli guide 0,5 mm / 2° sanal oynatmada her yönde kemiğe çarpar (serbest yön yok).
// R3 kesitler arası doldurma: 3 aksiyel kesitte boyanan lezyonun arası dolar.
// R4 "Tıkla bul": sentetik kapalı boşlukta öneri küre hacminde, kabuğa (kemiğe) tıklanınca öneri yok (uyarı).
// R5 pay kabuğu: kabuk 3B'de, kanala uzaklık durum satırında.
// R6 pedli guide: 4 ped, temas sürekliden küçük, oturma testi geçer; sunucu üretim STL'i su geçirmez, tek parça.
// R7 marjinal rezeksiyon: kanal işaretli, alt kenarda >= 10 mm kalır, rezeke parça segmentten küçük; üretim STL'i tek parça.
'use strict';
const H = require('./lib');

(async () => {
  const h = await H.start({ name: 'R_resection', dir: 'R', simple: true, dialog: 'dismiss' });
  const { page } = h; const alerts = []; page.on('dialog', d => alerts.push(d.message()));
  await h.goto(H.BASE + '/'); await h.idle(); await h.sleep(1500); await h.settle();
  // the sample's planning bone is joined to the upper jaw: split it first (as the surgeon does)
  await h.ev(() => UI.openStep('st2')); await h.sleep(800); await page.click('#mkJaw'); await h.idle(240000); await h.settle();
  await h.ev(() => Studio.autoPrep()); await h.sleep(500); await h.settle();
  const checks = () => h.ev(() => Studio.renderChecks ? [...document.querySelectorAll('#checks li')].map(li => li.className.split(' ')[0] + ': ' + li.textContent.trim()) : []);
  const R = () => h.ev(() => { const S = Studio.S, r = S.result; return r ? { fits: (r.fits || []).map(f => f && { ok: f.ok, free: f.free, freeScrewed: f.freeScrewed, total: f.total }), pads: (r.pads || []).length, contact: r.contact, pieces: r.pieces } : null; });

  await h.run('R1', 'Güvenlik payı', 'Otomatik plan, pay başlangıç değerinde; sonra lezyon tipi malign; sonra malignde pay 5 mm', 'Önce "hekim tarafından seçilmedi" uyarısı; tip ve pay ana alanda; malign 10 mm, uyarı yok; 5 mm\'de 10 mm altı uyarısı', async () => {
    const c0 = await checks();
    const main = await h.ev(() => ({ type: !document.getElementById('l_type').closest('details[data-adv]'), margin: !document.getElementById('l_margin').closest('details[data-adv]') }));
    await h.ev(() => UI.openStep('st3')); await h.sleep(400);
    const s0 = await h.shot('R1_pay_alani');
    await h.ev(() => { const e = document.getElementById('l_type'); e.value = 'malign'; e.dispatchEvent(new Event('change')); }); await h.sleep(500); await h.settle();
    const m1 = await h.ev(() => Studio.S.lesion.margin), c1 = await checks();
    await h.ev(() => { const e = document.getElementById('l_margin'); e.value = '5'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }); await h.sleep(500); await h.settle();
    const c2 = await checks();
    const a = c0.some(t => /hekim tarafından seçilmedi/.test(t)), b = !c1.some(t => /hekim tarafından seçilmedi|genellikle yaklaşık/.test(t)), c = c2.some(t => /Güvenlik payı 5,0 mm; malign/.test(t));
    // back to a benign type for the rest (margin 3 mm, no margin warning)
    await h.ev(() => { const e = document.getElementById('l_type'); e.value = 'benign'; e.dispatchEvent(new Event('change')); }); await h.sleep(500); await h.settle();
    return { pass: a && b && c && main.type && main.margin && m1 === 10, actual: JSON.stringify({ uyari0: a, malignTemiz: b, uyari5: c, anaAlan: main, malignPay: m1 }), evidence: s0 };
  });

  await h.run('R2', 'Oturma testi', 'Sürekli gövdeli mandibula guide\'ı', '0,5 mm / 2° sanal oynatmada serbest yön yok (vidasız ve vidalı)', async () => {
    const r = await R(); const f = r && r.fits && r.fits[0];
    return { pass: !!(f && f.ok && f.free === 0 && f.freeScrewed === 0 && f.total >= 14), actual: JSON.stringify(r) };
  });

  // a lesion: three axial discs 5 slices apart, under the crest at the anchor
  const pos = await h.ev(() => {
    const S = Studio.S, { u, v, n } = Studio.frameAxes(), up = v.z >= 0 ? v.clone() : v.clone().negate(), r = S.red, c = G.indexOf(r, S.anchor.p.toArray());
    let top = -1e9;
    for (let k = Math.round(c[2]) - 40; k <= Math.round(c[2]) + 40; k++) for (let j = Math.round(c[1]) - 25; j <= Math.round(c[1]) + 25; j++) for (let i = Math.round(c[0]) - 25; i <= Math.round(c[0]) + 25; i++) {
      if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz || !S.mask[i + r.nx * (j + r.ny * k)]) continue;
      const w = new THREE.Vector3(...G.worldOf(r, i, j, k)); if (Math.abs(w.clone().sub(S.anchor.p).dot(u)) > 3) continue; top = Math.max(top, w.dot(up));
    }
    const p = S.anchor.p.clone().add(up.clone().multiplyScalar(top - 7 - S.anchor.p.dot(up))).add(n.clone().multiplyScalar(-4));
    return p.toArray();
  });
  await h.run('R3', 'Kesitler arası doldurma', 'Aksiyel 3 kesitte (5 kesit arayla) boyama, "Kesitler arasını doldur"', 'Aradaki kesitler dolar (boyanan hacim artar), kesiler lezyondan önerilir', async () => {
    const before = await h.ev(p => {
      const S = Studio.S, r = S.red, k0 = G.indexOf(r, p)[2];
      Lesion.setTool('paint');
      [-5, 0, 5].forEach(dk => { const w = G.worldOf(r, ...G.indexOf(r, p).slice(0, 2), k0 + dk); Lesion.paint(w, 2, true); Lesion.strokeEnd(); });
      return Lesion.count();
    }, pos);
    await h.ev(() => Lesion.setTool('paint')); await h.sleep(500); await h.settle();
    await page.click('#lsFill'); await h.sleep(500); await h.settle();
    const after = await h.ev(() => Lesion.count()), mid = await h.ev(p => { const r = Studio.S.red, c = G.indexOf(r, p).map(Math.round), m = Lesion.mask(); return [-3, -1, 2, 4].map(dk => m[c[0] + r.nx * (c[1] + r.ny * (c[2] + dk))]); }, pos);
    const planes = await h.ev(() => Studio.S.planes.length);
    const s = await h.shot('R3_doldurma');
    return { pass: after > before * 1.8 && mid.every(x => x === 1) && planes >= 2, actual: `boyanan ${before} → ${after} voksel, ara kesitler ${mid.join('')}, kesi ${planes}`, evidence: s };
  });

  await h.run('R5', 'Pay kabuğu', 'Kanal önerisi kabul, pay 3 mm', 'Kabuk 3B\'de katman; durum satırında kanala uzaklık', async () => {
    await h.ev(() => { Canal.suggest(); Canal.acceptSuggest(); }); await h.sleep(500); await h.settle();
    const st = await h.ev(() => ({ part: !!(Studio.parts.lesionShell && Studio.parts.lesionShell.obj), stat: document.getElementById('lsStat').textContent, canals: Studio.S.canals.length, sh: Lesion.shellInfo() && { canal: Lesion.shellInfo().canal } }));
    const s = await h.shot('R5_kabuk');
    return { pass: st.part && st.canals > 0 && /Güvenlik payı kabuğu \(3,0 mm\): kanala \d/.test(st.stat), actual: JSON.stringify(st), evidence: s };
  });

  await h.run('R4', '"Tıkla bul" önerisi', 'Lezyon noktasına sentetik kapalı boşluk (2,5 mm yarıçap koyu, çevresi 2 mm kalın parlak kabuk); önce kabuğa, sonra boşluğa tıklama', 'Kabukta öneri yok ve "kemik yoğunluğunda" açıklaması; boşlukta öneri var, hacmi küreye yakın (0,04-0,10 cm³); "Öneriyi sil" kaldırır', async () => {
    const res = await h.ev(p => {
      const S = Studio.S, r = S.red, out = {}, c = G.indexOf(r, p).map(Math.round), saved = new Map();
      // carve: dark sphere (HU 20) inside a bright 2 mm shell (HU 1500), restored afterwards
      const R = r.sp.map(s => Math.ceil(5 / s));
      for (let k = -R[2]; k <= R[2]; k++) for (let j = -R[1]; j <= R[1]; j++) for (let i = -R[0]; i <= R[0]; i++) {
        const d = Math.hypot(i * r.sp[0], j * r.sp[1], k * r.sp[2]); if (d > 4.5) continue;
        const v = (c[0] + i) + r.nx * ((c[1] + j) + r.ny * (c[2] + k)); saved.set(v, r.hu[v]); r.hu[v] = d <= 2.5 ? 20 : 1500;
      }
      Lesion.setTool('grow');
      const sh = G.worldOf(r, c[0] + Math.round(3.5 / r.sp[0]), c[1], c[2]);
      Lesion.paint(sh, 2, true); out.bone = { sugg: Lesion.sugg(), msg: document.getElementById('lsSuggMsg').textContent };
      Lesion.paint(G.worldOf(r, ...c), 2, true); const n = Lesion.sugg();
      out.cav = { sugg: n, cm3: n * r.sp[0] * r.sp[1] * r.sp[2] / 1000, msg: document.getElementById('lsSuggMsg').textContent };
      for (const [v, x] of saved) r.hu[v] = x;
      return out;
    }, pos);
    await h.ev(() => UI.openStep('st3')); await h.sleep(300);
    const s = await h.shot('R4_tikla_bul');
    if (res.cav.sugg) await page.click('#lsSuggDrop', { timeout: 10000 }); await h.sleep(300);
    const gone = await h.ev(() => Lesion.sugg());
    return { pass: res.bone.sugg === 0 && /kemik yoğunluğunda/.test(res.bone.msg) && res.cav.sugg > 0 && res.cav.cm3 > 0.04 && res.cav.cm3 < 0.1 && gone === 0, actual: JSON.stringify(res) + ` silindi: ${gone === 0}`, evidence: s };
  });

  await h.run('R5', 'Pay kabuğu', 'Kanal önerisi kabul, pay 3 mm', 'Kabuk 3B\'de katman; durum satırında kanala uzaklık', async () => {
    await h.ev(() => { Canal.suggest(); Canal.acceptSuggest(); }); await h.sleep(500); await h.settle();
    const st = await h.ev(() => ({ part: !!(Studio.parts.lesionShell && Studio.parts.lesionShell.obj), stat: document.getElementById('lsStat').textContent, canals: Studio.S.canals.length, sh: Lesion.shellInfo() && { canal: Lesion.shellInfo().canal } }));
    const s = await h.shot('R5_kabuk');
    return { pass: st.part && st.canals > 0 && /Güvenlik payı kabuğu \(3,0 mm\): kanala \d/.test(st.stat), actual: JSON.stringify(st), evidence: s };
  });

  await h.run('R4', '"Tıkla bul" önerisi', 'Önce kemiğe, sonra kemik modelinin içindeki en koyu noktaya (kanal ya da ilik) tıklama', 'Kemikte öneri yok ve açıklama; koyu noktada öneri var, 6 cm³\'ten küçük, kemik kabuğunun içinde; "Öneriyi sil" kaldırır', async () => {
    const res = await h.ev(p => {
      const S = Studio.S, r = S.red, out = {};
      Lesion.setTool('grow');
      // a bone voxel: the brightest within 3 voxels of the lesion point
      const c = G.indexOf(r, p).map(Math.round); let best = null;
      for (let k = -3; k <= 3; k++) for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const v = (c[0] + i) + r.nx * ((c[1] + j) + r.ny * (c[2] + k)); if (!best || r.hu[v] > best[0]) best = [r.hu[v], [c[0] + i, c[1] + j, c[2] + k]]; }
      Lesion.paint(G.worldOf(r, ...best[1]), 2, true); out.bone = { sugg: Lesion.sugg(), msg: document.getElementById('lsSuggMsg').textContent };
      // a dark voxel inside the bone model (the model fills the canal and the marrow): the darkest within 10 voxels
      let dark = null;
      for (let k = -10; k <= 10; k++) for (let j = -10; j <= 10; j++) for (let i = -10; i <= 10; i++) { const v = (c[0] + i) + r.nx * ((c[1] + j) + r.ny * (c[2] + k)); if (S.mask[v] && (!dark || r.hu[v] < dark[0])) dark = [r.hu[v], [c[0] + i, c[1] + j, c[2] + k]]; }
      out.seedHu = dark && dark[0];
      Lesion.paint(G.worldOf(r, ...dark[1]), 2, true); const n = Lesion.sugg();
      out.canal = { sugg: n, cm3: n * r.sp[0] * r.sp[1] * r.sp[2] / 1000, msg: document.getElementById('lsSuggMsg').textContent };
      Lesion.setTool('grow');
      return out;
    }, pos);
    await h.ev(() => UI.openStep('st3')); await h.sleep(300);
    const s = await h.shot('R4_tikla_bul');
    if (res.canal.sugg) await page.click('#lsSuggDrop', { timeout: 10000 }); await h.sleep(300);
    const gone = await h.ev(() => Lesion.sugg());
    return { pass: res.bone.sugg === 0 && /kemik yoğunluğunda/.test(res.bone.msg) && res.canal.sugg > 0 && res.canal.cm3 < 6 && gone === 0, actual: JSON.stringify(res) + ` silindi: ${gone === 0}`, evidence: s };
  });

  const prod = async () => { await h.ev(() => Studio.productionSTL()); await h.idle(600000); await h.settle(); return h.ev(() => Studio.S.prod && { watertight: Studio.S.prod.watertight, bodies: Studio.S.prod.bodies, ok: Studio.S.prod.productionOk, issues: Studio.S.prod.issues }); };

  await h.run('R6', 'Pedli guide', '"Kemiğe temas: Pedler"', '4 ped, temas sürekli gövdeden küçük, oturma testi geçer, deneysel uyarısı; üretim STL\'i su geçirmez ve tek parça', async () => {
    await h.settle(); const r0 = await R();
    await h.ev(() => UI.openStep('st5')); await h.sleep(300);
    await h.ev(() => { const e = document.getElementById('g_pads'); e.value = '1'; e.dispatchEvent(new Event('change')); }); await h.sleep(500); await h.settle();
    const r1 = await R(), c = await checks(), p = await prod();
    const s = await h.shot('R6_pedli');
    await h.ev(() => { const e = document.getElementById('g_pads'); e.value = '0'; e.dispatchEvent(new Event('change')); }); await h.sleep(500); await h.settle();
    const f = r1 && r1.fits[0];
    return { pass: r1.pads === 4 && r1.contact < r0.contact && f && f.ok && f.free === 0 && c.some(t => /Pedli guide deneyseldir/.test(t)) && p && p.watertight && p.bodies === 1, actual: JSON.stringify({ r0, r1, prod: p }), evidence: s };
  });

  await h.run('R7', 'Marjinal rezeksiyon', 'Lezyon tipi benign, kanal işaretli, "Rezeksiyon tipi: Marjinal"', 'Alt kenarda >= 10 mm kalır, rezeke parça segmentten küçük, guide tek parça, marjinal kritik uyarısı yok; üretim STL\'i su geçirmez, tek parça', async () => {
    const v0 = await h.ev(() => Studio.S.resectedVolume);
    await h.ev(() => UI.openStep('st3')); await h.sleep(300);
    await h.ev(() => { const e = document.getElementById('resType'); e.value = 'M'; e.dispatchEvent(new Event('change')); }); await h.sleep(800); await h.settle();
    const st = await h.ev(() => ({ marginal: Studio.S.lesion.marginal, vol: Studio.S.resectedVolume, box: !document.getElementById('margBox').hidden }));
    const r = await R(), c = await checks(), p = await prod();
    const s1 = await h.shot('R7_marjinal_panel');
    await h.ev(() => { document.getElementById('vm3d') && document.getElementById('vm3d').click(); }); await h.sleep(600);
    await h.ev(() => Studio.fitTo(Studio.parts.guide.obj, 40)); await h.sleep(600);
    const s2 = await h.shot('R7_marjinal_guide');
    const bad = c.filter(t => /^crit/.test(t) && /[Mm]arjinal|yatay kesi/.test(t));
    return { pass: st.marginal >= 10 && st.box && st.vol < v0 * 0.9 && r.pieces === 1 && !bad.length && p && p.watertight && p.bodies === 1, actual: JSON.stringify({ v0, st, r, bad, prod: p, alerts }), evidence: [s1, s2].join(', ') };
  });

  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
