// Malleolar fracture, plan M0.2: gathers the accuracies the ankle tests measured (tests/web/unit/lib/acc.mjs) into one
// JSON with the plan's example acceptance limits (örnek eşik: research values, not clinical decisions).
// Run: node tools/ankle_accuracy.mjs [out.json]   (after tests/web/unit/run_all.sh or the ankle suites)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = process.env.ANKLE_ACC_DIR || path.join(os.tmpdir(), 'ankle_acc');
const read = n => { try { return JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')); } catch { return null; } };
const lm = read('anklm'), mi = read('ankmirror'), sc = read('ankscrew'), gd = read('ankguide'), rc = read('refcmp');
const vals = (o, re) => o ? Object.entries(o).filter(([k]) => re.test(k)).map(([, v]) => v) : [];
const maxAbs = a => a.length ? Math.max(...a.map(Math.abs)) : null;
// [name, measured, limit, unit, how compared]
const rows = [
  ['Arka basamak, redükte (sentetik)', lm && lm.step0, 0.3, 'mm', 'abs'],
  ['2 mm basamak ölçümü hatası', lm && lm.step_2mm != null ? lm.step_2mm - 2 : null, 0.3, 'mm', 'abs'],
  ['2 mm MCS açılması ölçüm hatası', lm && lm.mcs_2mm != null ? lm.mcs_2mm - 2 : null, 0.3, 'mm', 'abs'],
  ['2 mm TFCS açılması ölçüm hatası', lm && lm.tfcs_2mm != null ? lm.tfcs_2mm - 2 : null, 0.3, 'mm', 'abs'],
  ['Ayna şablonu RMS', mi && mi.mirror_rms, 0.5, 'mm', 'max'],
  ['Aynaya hizalama, parça yüzeyi', maxAbs(vals(mi, /^align_(Medial|Posterior)/).map(e => e.mm)), 0.5, 'mm', 'max'],
  ['Aynaya hizalama, lateral malleol merkezi', mi && mi['align_Lateral malleol'] ? mi['align_Lateral malleol'].c : null, 0.5, 'mm', 'max'],
  ['Vida boyu, karşı korteks farkı', maxAbs(vals(sc, /^mm_exit_diff_/)), 1, 'mm', 'abs'],
  ['Matkap guide deliği ekseni', maxAbs(vals(sc, /^hole_deg_/)), 0.5, '°', 'max'],
  ['Tibia ekseni', gd && gd.axis_deg, 3, '°', 'max'],
  ['Guide oturma yüzü p50', gd && gd.seat ? gd.seat.p50 : null, 0.3, 'mm', 'max'],
  ['Kama açısı (8°) STL\'de', gd && gd.wedge8 != null ? gd.wedge8 - 8 : null, 0.2, '°', 'abs'],
  ['Kama açısı (14°) STL\'de', gd && gd.wedge14 != null ? gd.wedge14 - 14 : null, 0.2, '°', 'abs'],
  ['Referans guide hizalaması (2 mm kalkık, 5° eğik)', rc && rc.ref_fit_mm, 1, 'mm', 'max'],
].map(([ad, olcum, esik, birim]) => ({ ad, olcum: olcum == null ? null : +(+olcum).toFixed(3), esik, birim, gecti: olcum == null ? null : Math.abs(olcum) <= esik }));
const out = { not: 'Örnek eşikler (araştırma değeri, klinik karar değil). Sentetik fantomlarda ölçüldü.', tarih: new Date().toISOString().slice(0, 10), satirlar: rows };
const file = process.argv[2] || path.join(DIR, 'ankle_accuracy.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
rows.forEach(r => console.log(`${r.gecti == null ? '  -  ' : r.gecti ? '  ok ' : ' FAIL'} ${r.ad}: ${r.olcum == null ? 'ölçülmedi' : r.olcum + ' ' + r.birim} (eşik ${r.esik} ${r.birim})`));
console.log('->', file);
