/* Clinical thresholds in one place (plan C4). Every check that compares a plan with a clinical limit reads it from
   here: the saw slot play, the distance to the nerve canal, the guide wall, the metal near the guide, the safety
   margin to start from. The values are SAMPLE values chosen while building the software; the clinical team sets the
   real ones. A deployment can override them before the scripts load (window.ClinicalProfile = { key: value }); the
   values are read once at start, so all modules use the same numbers, and the report lists them.
   (The fibula segment rules stay in the fibula plan, where the surgeon can change them per case: fibula.js RULES.) */
'use strict';
window.Clinical = (function () {
  // key: [value, Turkish label, unit, min, max]
  const DEF = {
    slotPlayMax: [3, 'Yuvada testere eğilmesi (en çok)', '°', 0.5, 10],
    slotTol: [0.2, 'Yuva toleransı (bıçağa ek)', 'mm', 0, 0.8],
    canalSafe: [2, 'Vida ile sinir kanalı arası (en az)', 'mm', 0.5, 6],
    wall: [2.5, 'Guide duvarı (varsayılan)', 'mm', 1, 5],
    minWall: [2.0, 'Guide duvarı (en az, malzeme profili yoksa)', 'mm', 0.8, 4],
    metalHu: [2500, 'Metal eşiği', 'HU', 1500, 4000],
    metalBand: [1.5, 'Guide altında metal arama bandı', 'mm', 0.5, 5],
    margin: [3, 'Güvenlik payı (başlangıç)', 'mm', 0, 15],
  };
  const over = (window.ClinicalProfile && typeof window.ClinicalProfile === 'object') ? window.ClinicalProfile : {};
  const P = {};
  for (const [k, [v, , , lo, hi]] of Object.entries(DEF)) {
    const o = Number(over[k]);
    P[k] = Object.prototype.hasOwnProperty.call(over, k) && Number.isFinite(o) && o >= lo && o <= hi ? o : v;
  }
  Object.freeze(P);
  const changed = Object.keys(DEF).filter(k => P[k] !== DEF[k][0]);
  return {
    v: k => { if (!(k in P)) throw new Error('clinical key ' + k); return P[k]; },
    values: () => Object.assign({}, P),
    // rows for the report: [label, value, unit, changed from the sample value]
    list: () => Object.entries(DEF).map(([k, [v, t, u]]) => [t, P[k], u, P[k] !== v]),
    changed: () => changed.slice(),
    DEF,
  };
})();
