/* Metal artefact under the guide (plan 1.5). The image quality check counted metal (> 2500 HU) over the whole volume:
   a filling or an implant far from the guide raised the same warning as one under it, and streaks across the bone the
   guide sits on went unnoticed. Here the CT is read where the guide meets the bone: the band of the guide grid within
   a millimetre and a half of the guide body and two of the bone. Metal in that band is critical (the bone model there
   is the artefact's, the guide will not seat); streaks (a soft-tissue band whose values jump far above and below
   their neighbours, or reach the bone threshold) are a warning. Thresholds are sample values; the clinical team sets
   them. The result is cached per guide grid. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.MetalQC = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, G, fmt } = St;
  const METAL_HU = 2500, METAL_MM3 = 1, BAND_GUIDE = 1.5, BAND_BONE = 2, STREAK_SD = 250, STREAK_HI = 0.05;
  let memo = { grid: null, out: null };

  // one guide grid (S.grid or one of its parts): the HU of the contact band, from the full-resolution CT
  function measure(gr, vol, thr) {
    const { nx, ny, nz, h, lo, P, u, v, n, Gm, B } = gr, N = nx * ny * nz;
    if (!Gm || !B || !vol) return null;
    const Dg = G.edt(Gm, nx, ny, nz), Db = G.edt(B, nx, ny, nz);
    let metal = 0, soft = 0, sum = 0, sq = 0, hiN = 0, band = 0;
    const metalAt = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (Gm[id]) continue;
      const dg = Dg[id] * h, db = B[id] ? 0 : Db[id] * h;
      if (dg > BAND_GUIDE + (B[id] ? BAND_BONE - BAND_GUIDE : 0) || db > BAND_BONE) continue;
      band++;
      const x = lo[0] + i * h, y = lo[1] + j * h, z = lo[2] + k * h;
      const w = [P.x + u.x * x + v.x * y + n.x * z, P.y + u.y * x + v.y * y + n.y * z, P.z + u.z * x + v.z * y + n.z * z];
      const ix = G.indexOf(vol, w).map(Math.round);
      if (ix[0] < 0 || ix[1] < 0 || ix[2] < 0 || ix[0] >= vol.nx || ix[1] >= vol.ny || ix[2] >= vol.nz) continue;
      const hu = vol.hu[ix[0] + vol.nx * (ix[1] + vol.ny * ix[2])];
      if (hu > METAL_HU) { metal++; if (metalAt.length < 64) metalAt.push(w); }
      // the soft tissue between the guide and the bone (more than a voxel off the bone): its spread and its share at
      // the bone threshold
      if (!B[id] && db > h) { soft++; sum += hu; sq += hu * hu; if (thr != null && hu >= thr) hiN++; }
    }
    const sd = soft > 1 ? Math.sqrt(Math.max(0, sq / soft - (sum / soft) ** 2)) : 0;
    return { metalMm3: metal * h * h * h, metalAt, softN: soft, sd, hiShare: soft ? hiN / soft : 0, band };
  }
  function measureAll() {
    if (!S.grid || !S.vol) return null;
    if (memo.grid === S.grid) return memo.out;
    const thr = St.segThr ? St.segThr() : null, grids = S.grid.parts && S.grid.parts.length ? S.grid.parts : [S.grid];
    const rs = grids.map(g => measure(g, S.vol, thr != null ? thr : +(document.getElementById('thr') || {}).value || 250)).filter(Boolean);
    const out = rs.length ? { metalMm3: rs.reduce((a, r) => a + r.metalMm3, 0), sd: Math.max(...rs.map(r => r.sd)), hiShare: Math.max(...rs.map(r => r.hiShare)), softN: rs.reduce((a, r) => a + r.softN, 0), metalAt: [].concat(...rs.map(r => r.metalAt)) } : null;
    memo = { grid: S.grid, out };
    return out;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [], m = S.anchor && S.result ? measureAll() : null; if (!m) return out;
    if (m.metalMm3 >= METAL_MM3) out.push(['crit', 'Kritik', xl(`Guide'ın kemiğe oturduğu yüzeyde metal var (${fmt(m.metalMm3, 1)} mm³, ${METAL_HU} HU üstü).`) + ' ' + xl('Kemik modeli orada metal artefaktından gelir, guide oturmayabilir. Guide\'ı metalden uzaklaştırın ya da kemik modelini kesitlerde düzeltin.'), 'guide']);
    else if (m.softN >= 20 && (m.sd > STREAK_SD || m.hiShare > STREAK_HI)) out.push(['warn', 'Uyarı', xl(`Guide ile kemik arasında çizgi artefaktı olabilir (yumuşak doku yayılımı ${fmt(m.sd, 0)} HU, kemik eşiğine ulaşan %${fmt(100 * m.hiShare, 0)}).`) + ' ' + xl('Guide\'ın altındaki kemik yüzeyini kesitlerde kontrol edin.'), 'guide']);
    return out;
  });
  return { measure, measureAll, METAL_HU, METAL_MM3, STREAK_SD, STREAK_HI };
})();
