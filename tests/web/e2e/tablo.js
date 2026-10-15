// kanit/*/results.json → kanit/tablo.md (senaryo tablosu + konsol hata özeti)
'use strict';
const fs = require('fs'), path = require('path');
const K = process.env.KANIT || path.resolve(__dirname, '..', 'kanit');   // same folder lib.js writes to
const files = [];
for (const d of fs.readdirSync(K)) { const dd = path.join(K, d); if (!fs.statSync(dd).isDirectory()) continue; for (const f of fs.readdirSync(dd)) if (/^results.*\.json$/.test(f)) files.push(path.join(dd, f)); }
let rows = [], errs = [];
const order = ['A1_flow', 'A2_persist', 'A3_i18n_ui', 'B_real', 'C_edge', 'D_1024', 'D_1440_header', 'D_live', 'F_1024x768', 'F_1280x720', 'E_roll', 'Y3_plate_undo'];
const runs = files.map(f => JSON.parse(fs.readFileSync(f))).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
// several runs write into the same folder: results.json is per run, so keep a copy per run name
for (const r of runs) { rows.push(...r.results.map(x => Object.assign({ run: r.name }, x))); errs.push(...r.errors.map(e => Object.assign({ run: r.name }, e))); }
const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 700);
const mark = p => p === true ? '✅ geçti' : p === false ? '❌ kaldı' : 'ℹ️ bilgi';
let md = `| ID | Adım | Ne yapıldı | Beklenen | Gerçekleşen | Sonuç | Kanıt |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.id} | ${esc(r.step)} | ${esc(r.what)} | ${esc(r.expected)} | ${esc(r.actual)} | ${mark(r.pass)} | ${esc(r.evidence || '')} |\n`;
const p = rows.filter(r => r.pass === true).length, f = rows.filter(r => r.pass === false).length;
md = `Toplam ${rows.length} senaryo: ${p} geçti, ${f} kaldı, ${rows.length - p - f} bilgi.\n\n` + md;
const csp = errs.filter(e => e.kind === 'csp').length;
md += `\n\nCSP ihlali: ${csp}.\n\n### Konsol / sayfa hataları (${errs.length})\n\n`;
const g = {}; errs.forEach(e => { const k = `${e.kind}: ${e.text.split('\n')[0].slice(0, 200)}`; (g[k] = g[k] || []).push(`${e.run}/${e.scenario}`); });
md += Object.keys(g).length ? Object.entries(g).map(([k, v]) => `- ${esc(k)} — ${v.length}× (${[...new Set(v)].slice(0, 8).join(', ')})`).join('\n') : '- Yok';
fs.writeFileSync(path.join(K, 'tablo.md'), md + '\n');
console.log(`tablo.md (${K}): ${rows.length} satır, ${p} geçti, ${f} kaldı; ${errs.length} hata, ${csp} CSP ihlali`);
