// Known-geometry phantoms (plan Faz 0.2, the jaw side): synthetic CT volumes in the app's sample format
// ({dims, spacing, origin, scale, offset, data (gzip base64 of uint8), meta}) or as plain {hu, nx, ny, nz, sp, origin,
// axes, meta} volumes, each with the values a test expects in `expect`. No patient data.
//   leg(opts)        lower leg: tibia + fibula (cortex shells around cancellous / marrow), muscle, optional
//                    contrast-filled peroneal artery beside the fibula, gantry tilt and a missing slice (in meta)
//   mandibleBar(o)   a mandible-like bar (cortex shell, cancellous core) with optional inferior alveolar canal (a
//                    low-HU tube between two foramina), tooth roots (dense cones from the crest), a metal implant
//                    (> 3000 HU) and its streak artefact (alternating bright / dark bands through the slices)
// Run directly to write the volumes as sample JSON files (node tests/phantoms/phantoms.mjs <out dir>).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const SCALE = 16, OFFSET = -1024;
// volume (Int16 HU) -> app sample format (uint8 = (HU - offset) / scale, clamped)
export function toSample(v, name) {
  const q = new Uint8Array(v.hu.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(255, Math.round((v.hu[i] - OFFSET) / SCALE)));
  return { name, dims: [v.nx, v.ny, v.nz], spacing: v.sp, origin: v.origin, axes: v.axes, scale: SCALE, offset: OFFSET, meta: v.meta, data: zlib.gzipSync(Buffer.from(q)).toString('base64'), expect: v.expect };
}
const grid = (nx, ny, nz, sp, origin, fill = -1000) => ({ hu: new Int16Array(nx * ny * nz).fill(fill), nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });

// a long bone: radius r, cortex thickness t (HU cortex), interior (HU core), along z over |z| < half
function bone(x, y, cx, cy, r, t, cortex, core) {
  const d = Math.hypot(x - cx, y - cy);
  return d <= r - t ? core : d <= r ? cortex : null;
}

export function leg(o = {}) {
  const sp = o.sp || [0.8, 0.8, 1.0], nx = 90, ny = 64, nz = o.nz || 300, origin = [-36, -26, -150];
  const v = grid(nx, ny, nz, sp, origin, -1000);
  const fibC = [16, 0], tibC = [-12, 0], art = [16, 12];             // the peroneal artery, 5 mm off the fibula surface
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2], id = i + nx * (j + ny * k);
    let h = Math.hypot(x / 34, y / 24) < 1 ? 45 : -1000;                // muscle / skin cylinder
    if (Math.abs(z) < 135) { const b = bone(x, y, fibC[0], fibC[1], 7, 2, 1400, 250); if (b != null) h = b; }
    if (Math.abs(z) < 140) { const b = bone(x, y, tibC[0], tibC[1], 14, 3, 1500, -60); if (b != null) h = b; }
    if (o.contrast && Math.abs(z) < 120 && Math.hypot(x - art[0], y - art[1]) < 1.6) h = o.contrast;
    v.hu[id] = h;
  }
  const dz = sp[2];
  v.meta = { modality: 'CT', thickness: o.thickness || dz, bits: 16, ...(o.tilt ? { tilt: o.tilt } : {}) };
  // a missing slice: one gap twice the spacing in the list of slice distances (the DICOM reader's dzList)
  if (o.missing) { v.meta.dzList = Array.from({ length: nz - 1 }, (_, i) => (i === Math.floor(nz / 2) ? 2 * dz : dz)); }
  // contrast in an artery of radius 1.6 mm over 240 mm: ~1.9 cm³ above the threshold away from the cortex
  v.expect = { contrastCm3: o.contrast ? Math.PI * 1.6 * 1.6 * 240 / 1000 : 0, tilt: o.tilt || 0, missing: !!o.missing, fibula: { r: 7, len: 270 } };
  return v;
}

// a mandible-like bar along x: elliptic cross-section (half widths 6 mm buccolingual, 12 mm high), cortex 2 mm
export function mandibleBar(o = {}) {
  const sp = o.sp || [0.5, 0.5, 0.5], half = o.half || 50, nx = Math.round((2 * half + 20) / sp[0]), ny = Math.round(32 / sp[1]), nz = Math.round(40 / sp[2]);
  const origin = [-half - 10, -16, -30], v = grid(nx, ny, nz, sp, origin, -1000);
  const cz = -12, ay = 6, az = 12, canal = o.canal ? { z: -16, y: 0, r: 1.4 } : null;       // canal 4 mm below the centre, inside the cancellous core
  const roots = o.roots ? o.roots.map(x => ({ x, r: 2.2, len: 11 })) : [];                  // root cones from the crest (z = cz + az) downwards
  const metal = o.metal ? { x: o.metal.x, y: 0, z: cz + az - 4, r: 2, len: 10 } : null;      // an implant: a vertical post from the crest
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2], id = i + nx * (j + ny * k);
    let h = -1000;
    if (Math.abs(x) < half) {
      const e = Math.hypot(y / ay, (z - cz) / az), ei = Math.hypot(y / (ay - 2), (z - cz) / (az - 2)), eg = Math.hypot(y / (ay + 3), (z - cz) / (az + 3));
      if (o.gum !== false && eg < 1) h = 40;                     // gingiva / periosteum: 3 mm of soft tissue over the bone
      if (e < 1) h = ei < 1 ? 350 : 1500;
      if (canal && Math.abs(x) < half - 5 && Math.hypot(y - canal.y, z - canal.z) < canal.r) h = 20;       // the canal: soft tissue in a thin cortical wall
      for (const r of roots) { const t = (cz + az - z) / r.len; if (t >= 0 && t <= 1 && Math.hypot(x - r.x, y) < r.r * (1 - 0.6 * t)) h = 1800; }
    }
    if (metal) {
      if (Math.hypot(x - metal.x, y - metal.y) < metal.r && z < metal.z + metal.len / 2 && z > metal.z - metal.len / 2) h = 3500;
      // streaks: bands at the crest's level spreading along x from the implant, alternating bright and dark (beam hardening)
      else if (o.metal.streak && Math.abs(z - (cz + az)) < 4 && Math.abs(x - metal.x) < 25 && h > -900) h += (Math.abs(Math.floor((x - metal.x) / 2)) % 2 ? 900 : -700);
    }
    v.hu[id] = h;
  }
  v.meta = { modality: 'CT', thickness: sp[2], bits: 16 };
  v.expect = { canal: canal ? { y: canal.y, z: canal.z, r: canal.r, x0: -half + 5, x1: half - 5 } : null, roots, metal, crest: cz + az, base: cz - az };
  return v;
}

if (process.argv[1] && process.argv[1].endsWith('phantoms.mjs') && process.argv[2]) {
  const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
  const all = { leg_clean: leg(), leg_tilt: leg({ tilt: 5 }), leg_missing: leg({ missing: true }), leg_contrast: leg({ contrast: 420 }),
    mandible_canal: mandibleBar({ canal: true, roots: [-30, -20, 20, 30] }), mandible_metal: mandibleBar({ metal: { x: 10, streak: true } }) };
  for (const [k, v] of Object.entries(all)) fs.writeFileSync(path.join(out, `phantom_${k}.json`), JSON.stringify(toSample(v, k)));
  console.log('wrote', Object.keys(all).length, 'phantoms to', out);
}
