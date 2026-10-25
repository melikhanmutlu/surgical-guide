/* Metal artefact under the guide (plan 1.5). The image quality check counted metal (> 2500 HU) over the whole volume:
   a filling or an implant far from the guide raised the same warning as one under it, and streaks across the bone the
   guide sits on went unnoticed. Here the CT is read where the guide meets the bone: the band of the guide grid within
   a millimetre and a half of the guide body and two of the bone. Metal in that band is critical (the bone model there
   is the artefact's, the guide will not seat); streaks (a soft-tissue band whose values jump far above and below
   their neighbours, or reach the bone threshold) are a warning. Thresholds are sample values; the clinical team sets
   them. The result is cached per guide grid.
   Tooth enamel reaches the same HU as metal (2500-3071 on a 12-bit CT, where metal saturates at the scanner's ceiling
   too), so the HU alone counted every crown the guide touched as metal. Enamel is a thin shell (1-2 mm) over dentin;
   a filling, a crown's bloom or an implant is solid. A voxel above the threshold counts as metal only when it lies in
   a solid core: inside a ball of metalCore mm radius that is above the threshold throughout (a morphological
   opening). The thin rest is reported as enamel, for information. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.MetalQC = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, G, fmt } = St;
  const CV = (k, d) => (window.Clinical ? Clinical.v(k) : d);   // clinical.js (C4)
  const METAL_HU = CV('metalHu', 2500), METAL_CORE = CV('metalCore', 1.25), METAL_MM3 = 1, BAND_GUIDE = CV('metalBand', 1.5), BAND_BONE = 2, STREAK_SD = 250, STREAK_HI = 0.05;
  let memo = { grid: null, out: null };

  // is CT voxel (i, j, k) inside a solid run above METAL_HU (a ball of METAL_CORE mm around some voxel within
  // METAL_CORE mm of it lies entirely above the threshold)? Results are cached per volume.
  let solidMemo = { vol: null, core: null, open: null };
  function solidAt(vol, i, j, k) {
    if (!(METAL_CORE > 0)) return true;
    if (solidMemo.vol !== vol) {
      const sp = vol.sp || [1, 1, 1], r = METAL_CORE, ball = [];
      const m = sp.map(s => Math.floor(r / s + 1e-9));
      for (let c = -m[2]; c <= m[2]; c++) for (let b = -m[1]; b <= m[1]; b++) for (let a = -m[0]; a <= m[0]; a++)
        if ((a * sp[0]) ** 2 + (b * sp[1]) ** 2 + (c * sp[2]) ** 2 <= r * r + 1e-9) ball.push([a, b, c]);
      solidMemo = { vol, ball, core: new Map(), open: new Map() };
    }
    const { nx, ny, nz, hu } = vol, { ball, core, open } = solidMemo, id0 = i + nx * (j + ny * k);
    if (open.has(id0)) return open.get(id0);
    const isCore = (x, y, z) => {
      const id = x + nx * (y + ny * z); let c = core.get(id);
      if (c === undefined) {
        c = true;
        for (const [a, b, d] of ball) {
          const X = x + a, Y = y + b, Z = z + d;
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || !(hu[X + nx * (Y + ny * Z)] > METAL_HU)) { c = false; break; }
        }
        core.set(id, c);
      }
      return c;
    };
    let ok = false;
    for (const [a, b, d] of ball) {
      const X = i + a, Y = j + b, Z = k + d;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || !(hu[X + nx * (Y + ny * Z)] > METAL_HU)) continue;
      if (isCore(X, Y, Z)) { ok = true; break; }
    }
    open.set(id0, ok);
    return ok;
  }

  // one guide grid (S.grid or one of its parts): the HU of the contact band, from the full-resolution CT
  function measure(gr, vol, thr) {
    const { nx, ny, nz, h, lo, P, u, v, n, Gm, B } = gr, N = nx * ny * nz;
    if (!Gm || !B || !vol) return null;
    const Dg = G.edt(Gm, nx, ny, nz), Db = G.edt(B, nx, ny, nz);
    let metal = 0, enamel = 0, soft = 0, sum = 0, sq = 0, hiN = 0, band = 0;
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
      if (hu > METAL_HU) {
        if (solidAt(vol, ix[0], ix[1], ix[2])) { metal++; if (metalAt.length < 64) metalAt.push(w); } else enamel++;
      }
      // the soft tissue between the guide and the bone (more than a voxel off the bone): its spread and its share at
      // the bone threshold
      if (!B[id] && db > h) { soft++; sum += hu; sq += hu * hu; if (thr != null && hu >= thr) hiN++; }
    }
    const sd = soft > 1 ? Math.sqrt(Math.max(0, sq / soft - (sum / soft) ** 2)) : 0;
    return { metalMm3: metal * h * h * h, enamelMm3: enamel * h * h * h, metalAt, softN: soft, sd, hiShare: soft ? hiN / soft : 0, band };
  }
  function measureAll() {
    if (!S.grid || !S.vol) return null;
    if (memo.grid === S.grid) return memo.out;
    const thr = St.segThr ? St.segThr() : null, grids = S.grid.parts && S.grid.parts.length ? S.grid.parts : [S.grid];
    const rs = grids.map(g => measure(g, S.vol, thr != null ? thr : +(document.getElementById('thr') || {}).value || 250)).filter(Boolean);
    const out = rs.length ? { metalMm3: rs.reduce((a, r) => a + r.metalMm3, 0), enamelMm3: rs.reduce((a, r) => a + r.enamelMm3, 0), sd: Math.max(...rs.map(r => r.sd)), hiShare: Math.max(...rs.map(r => r.hiShare)), softN: rs.reduce((a, r) => a + r.softN, 0), metalAt: [].concat(...rs.map(r => r.metalAt)) } : null;
    memo = { grid: S.grid, out };
    return out;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [], m = S.anchor && S.result ? measureAll() : null; if (!m) return out;
    if (m.metalMm3 >= METAL_MM3) out.push(['crit', 'Kritik', xl(`Guide'ın kemiğe oturduğu yüzeyde metal var (${fmt(m.metalMm3, 1)} mm³, ${METAL_HU} HU üstü).`) + ' ' + xl('Kemik modeli orada metal artefaktından gelir, guide oturmayabilir. Genişliği, sarma derinliğini ya da uzunluğu azaltarak ya da guide\'ı kaydırarak metalden uzaklaştırın; kesitlerde kemik modelini düzeltmek bu uyarıyı kaldırmaz (BT değeri okunur).'), 'guide']);
    else if (m.softN >= 20 && (m.sd > STREAK_SD || m.hiShare > STREAK_HI)) out.push(['warn', 'Uyarı', xl(`Guide ile kemik arasında çizgi artefaktı olabilir (yumuşak doku yayılımı ${fmt(m.sd, 0)} HU, kemik eşiğine ulaşan %${fmt(100 * m.hiShare, 0)}).`) + ' ' + xl('Guide\'ın altındaki kemik yüzeyini kesitlerde kontrol edin.'), 'guide']);
    if (m.enamelMm3 >= METAL_MM3) out.push(['info', 'Bilgi', xl(`Guide diş minesine değiyor (${fmt(m.enamelMm3, 1)} mm³, ${METAL_HU} HU üstü ince kabuk); metal sayılmadı.`) + ' ' + xl('Dişler guide\'ın oturma yüzeyine giriyorsa ağızda kronların konumunu kontrol edin.'), 'guide']);
    return out;
  });
  return { measure, solidAt, METAL_CORE, measureAll, METAL_HU, METAL_MM3, BAND_GUIDE, STREAK_SD, STREAK_HI };
})();
