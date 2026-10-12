// Regression: "Kemik etrafında kaydır" (roll) — at every angle each screw must have bone under its entry and a drill path in bone.
'use strict';
const H = require('./lib');
(async () => {
  const h = await H.start({ name: 'E_roll', dir: 'E' });
  const { page } = h;
  await h.goto();
  await h.run('E.1', 'Guide etrafta kaydırılınca vidalar', 'Örnek vaka, otomatik planla, kaydırıcı -180..180 (15° adım)', 'Her açıda her vida kemikte ≥4 mm ilerler ve guide gövdesi altında', async () => {
    await h.openStep(1); await page.click('#sampleM'); await h.idle();
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    const rows = [];
    for (let r = -180; r <= 180; r += 15) {
      const ok = await h.ev(r => Studio.setGuideRoll(r), r); await h.sleep(500); await h.idle(120000, 400);
      const m = await h.ev(() => {
        const { S, V, boneAt } = Studio, scr = S.screws.map((sc, i) => {
          const w = Studio.screwWorld(sc); if (!w.entry) return { entry: false };
          let inb = 0; for (let t = 0; t <= sc.len; t += 0.25) if (boneAt(w.entry.clone().addScaledVector(w.dir, t))) inb += 0.25;
          const si = (Studio.S.result && Studio.S.result.screwInfo || [])[i];
          return { entry: true, inBone: +inb.toFixed(1), len: sc.len, noBody: !!(si && si.noBody) };
        });
        const R = S.result;
        return { n: S.screws.length, scr, split: S.g.split, pieces: R && R.pieces, free: R && R.seat && R.seat.free, crit: S.crit, drops: (S.screwDrops || []).length, noBody: R && R.screws ? R.screws.filter(x => x.no_body || x.noBody).length : null };
      });
      await page.screenshot({ path: require('path').join(h.outDir, `E1_roll_${r}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
      rows.push({ r, moved: ok, ...m });
    }
    const bad = rows.filter(x => x.scr.some(q => !q.entry || q.inBone < 4 || q.noBody));
    require('fs').writeFileSync(require('path').join(h.outDir, 'E1_rows.json'), JSON.stringify(rows, null, 1));
    return { pass: bad.length === 0, actual: `${bad.length}/${rows.length} açıda kemiksiz vida: ` + bad.map(x => x.r + '°[' + x.scr.map(q => q.entry ? q.inBone : 'yok').join(',') + ']').join(' ') };
  });
  await h.done();
})();
