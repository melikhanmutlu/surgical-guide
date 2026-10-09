/* Extra exports for the delivery step and the package:
   - 3MF (3D Manufacturing Format, core spec, millimetres): guides in one file, anatomical models in another.
   - DICOM Segmentation (SEG, binary, Explicit VR Little Endian) of the remaining bone and the resected piece on the
     source CT grid, in the source Frame of Reference, referencing the source images. Only when the source is DICOM.
     Limits: the mask comes from the 0.8 mm working grid resampled to the source grid (not re-segmented at full
     resolution); patient module attributes are written empty (Type 2) so no patient identity leaves the browser,
     and PACS matches it to the study by Study Instance UID.
   - Navigation: landmarks, cut planes, screw and implant axes as JSON and CSV in DICOM patient coordinates (LPS, mm). */
'use strict';
window.Exports = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt } = St, $ = id => document.getElementById(id);
  const msg = t => { $('xMsg').textContent = t; };

  // ---------- 3MF ----------
  const xmlEsc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function objectXML(id, name, meshes) {
    // vertices are welded by position (cylinder seams and caps repeat them) so every edge is shared
    const vs = [], ts = [], q = V(), seen = new Map();
    meshes.forEach(o => {
      const g = o.geometry, P = g.attributes.position.array, I = g.index ? g.index.array : null;
      if (o.matrixAutoUpdate) o.updateMatrix();
      const M = o.parent && o.parent.isGroup ? o.matrix : null, map = new Int32Array(P.length / 3);
      for (let i = 0; i < P.length; i += 3) {
        q.set(P[i], P[i + 1], P[i + 2]); if (M) q.applyMatrix4(M);
        const key = `${Math.round(q.x * 1e4)},${Math.round(q.y * 1e4)},${Math.round(q.z * 1e4)}`;
        let id = seen.get(key); if (id === undefined) { id = vs.length / 3; seen.set(key, id); vs.push(q.x, q.y, q.z); }
        map[i / 3] = id;
      }
      const nt = I ? I.length / 3 : P.length / 9;
      for (let t = 0; t < nt; t++) {
        const a = map[I ? I[3 * t] : 3 * t], b = map[I ? I[3 * t + 1] : 3 * t + 1], c = map[I ? I[3 * t + 2] : 3 * t + 2];
        if (a === b || b === c || a === c) continue;   // 3MF forbids degenerate triangles
        ts.push(a, b, c);
      }
    });
    let s = `<object id="${id}" type="model" name="${xmlEsc(name)}"><mesh><vertices>`;
    const parts = [s];
    for (let i = 0; i < vs.length; i += 3) parts.push(`<vertex x="${vs[i].toFixed(4)}" y="${vs[i + 1].toFixed(4)}" z="${vs[i + 2].toFixed(4)}"/>`);
    parts.push('</vertices><triangles>');
    for (let i = 0; i < ts.length; i += 3) parts.push(`<triangle v1="${ts[i]}" v2="${ts[i + 1]}" v3="${ts[i + 2]}"/>`);
    parts.push('</triangles></mesh></object>');
    return { xml: parts.join(''), tris: ts.length / 3 };
  }
  function threeMF(items, title) {
    const objs = items.map((it, i) => objectXML(i + 1, it.name, it.meshes)).filter(o => o.tris > 0);
    const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="tr-TR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${xmlEsc(title)}</metadata><metadata name="Application">Yolmed Guide Stüdyosu</metadata><metadata name="Description">DICOM hasta koordinatları (LPS, mm)</metadata><resources>${objs.map(o => o.xml).join('')}</resources><build>${objs.map((o, i) => `<item objectid="${(o.xml.match(/^<object id="(\d+)"/) || [])[1]}"/>`).join('')}</build></model>`;
    const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
    return St.zipBytes([{ name: '[Content_Types].xml', data: types }, { name: '_rels/.rels', data: rels }, { name: '3D/3dmodel.model', data: model }]);
  }
  function guideItems() {
    const out = [], pt = St.parts;
    if (pt.guide) out.push({ name: 'Mandibula guide', meshes: [pt.guide.obj] });
    if (S.fib && S.fib.guide) out.push({ name: 'Fibula guide (fibula BT koordinatı)', meshes: [S.fib.guide.mesh] });
    return out;
  }
  function modelItems() {
    const out = [], pt = St.parts;
    if (pt.bone) out.push({ name: 'Kalan kemik', meshes: [pt.bone.obj] });
    if (pt.resected) out.push({ name: 'Rezeke parça', meshes: [pt.resected.obj] });
    const pb = pt.plate && pt.plate.obj.getObjectByName('plateBody'); if (pb) out.push({ name: 'Plak şablonu', meshes: [pb] });
    if (pt.implants) out.push({ name: 'İmplantlar', meshes: pt.implants.obj.children.filter(c => c.isMesh) });
    return out;
  }
  const guides3MF = () => threeMF(guideItems(), 'Guide\'lar');
  const models3MF = () => threeMF(modelItems(), 'Anatomik modeller');

  // ---------- DICOM SEG ----------
  // explicit VR little endian element encoder; a dataset is a list of [tag, vr, value], sorted on write
  const enc = new TextEncoder(), LONG = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UC', 'UR', 'UT', 'UN']);
  function bytesOf(vr, v) {
    if (vr === 'SQ') { const items = v.map(ds => { const body = dataset(ds), h = new DataView(new ArrayBuffer(8)); h.setUint16(0, 0xfffe, true); h.setUint16(2, 0xe000, true); h.setUint32(4, body.length, true); return cat([new Uint8Array(h.buffer), body]); }); return cat(items); }
    if (vr === 'OB') return v.length % 2 ? cat([v, new Uint8Array(1)]) : v;
    if (vr === 'US') { const a = [].concat(v), d = new DataView(new ArrayBuffer(2 * a.length)); a.forEach((x, i) => d.setUint16(2 * i, x, true)); return new Uint8Array(d.buffer); }
    if (vr === 'UL') { const a = [].concat(v), d = new DataView(new ArrayBuffer(4 * a.length)); a.forEach((x, i) => d.setUint32(4 * i, x, true)); return new Uint8Array(d.buffer); }
    if (vr === 'AT') { const a = [].concat(v), d = new DataView(new ArrayBuffer(4 * a.length)); a.forEach((t, i) => { d.setUint16(4 * i, t >>> 16, true); d.setUint16(4 * i + 2, t & 0xffff, true); }); return new Uint8Array(d.buffer); }
    let s = [].concat(v).join('\\'), b = enc.encode(s);
    if (b.length % 2) b = cat([b, new Uint8Array([vr === 'UI' ? 0 : 0x20])]);
    return b;
  }
  function cat(arrs) { const n = arrs.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let k = 0; arrs.forEach(a => { o.set(a, k); k += a.length; }); return o; }
  function element(tag, vr, v) {
    const val = bytesOf(vr, v), long = LONG.has(vr), h = new DataView(new ArrayBuffer(long ? 12 : 8));
    h.setUint16(0, tag >>> 16, true); h.setUint16(2, tag & 0xffff, true); h.setUint8(4, vr.charCodeAt(0)); h.setUint8(5, vr.charCodeAt(1));
    if (long) h.setUint32(8, val.length, true); else { if (val.length > 0xffff) throw new Error('değer çok uzun: ' + tag.toString(16)); h.setUint16(6, val.length, true); }
    return cat([new Uint8Array(h.buffer), val]);
  }
  const dataset = els => cat(els.slice().sort((a, b) => (a[0] >>> 0) - (b[0] >>> 0)).map(([t, vr, v]) => element(t >>> 0, vr, v)));
  // UID from 128 random bits under the 2.25 root (ISO/IEC 9834-8 UUID form)
  function uid() { const b = crypto.getRandomValues(new Uint8Array(16)); let x = 0n; b.forEach(v => { x = (x << 8n) | BigInt(v); }); return '2.25.' + x.toString(); }
  const T = (g, e) => ((g << 16) | e) >>> 0;
  const code = (v, s, m) => [[T(0x0008, 0x0100), 'SH', v], [T(0x0008, 0x0102), 'SH', s], [T(0x0008, 0x0104), 'LO', m]];
  const ds2 = x => +x.toFixed(6);

  // remaining bone and resected piece on the full source grid, cropped to the bone's slices
  function segMasks() {
    const r = S.red, vol = S.vol, nr = r.nx * r.ny * r.nz, keep = new Uint8Array(nr), res = new Uint8Array(nr);
    for (let v = 0; v < nr; v++) { if (S.mask[v]) { if (S.resMask && S.resMask[v]) res[v] = 1; else keep[v] = 1; } }
    const FK = G.blur(keep, r.nx, r.ny, r.nz), FR = S.resMask ? G.blur(res, r.nx, r.ny, r.nz) : null;
    const nxy = vol.nx * vol.ny, segs = [{ F: FK, slices: new Map() }].concat(FR ? [{ F: FR, slices: new Map() }] : []);
    for (let k = 0; k < vol.nz; k++) for (const sg of segs) {
      let fr = null;
      for (let j = 0; j < vol.ny; j++) for (let i = 0; i < vol.nx; i++) {
        if (St.fieldAt(r, sg.F, G.worldOf(vol, i, j, k)) > 0.5) { if (!fr) fr = new Uint8Array(nxy); fr[i + vol.nx * j] = 1; }
      }
      if (fr) sg.slices.set(k, fr);
    }
    return segs;
  }
  function segDICOM() {
    const vol = S.vol, m = vol.meta || {}, U = m.uids;
    if (!S.source || S.source.type !== 'dicom' || !U || !U.study || !U.frame) throw new Error('DICOM SEG yalnız DICOM kaynaklı vakada ve kaynak UID\'leri okunduğunda üretilir.');
    const segs = segMasks(), frames = [];
    segs.forEach((sg, si) => [...sg.slices.keys()].sort((a, b) => a - b).forEach(k => frames.push({ seg: si + 1, k, px: sg.slices.get(k) })));
    if (!frames.length) throw new Error('Maske boş.');
    const R = vol.ny, C = vol.nx, nPix = R * C, bits = new Uint8Array(Math.ceil(frames.length * nPix / 8));
    frames.forEach((f, fi) => { const o = fi * nPix; for (let p = 0; p < nPix; p++) if (f.px[p]) { const b = o + p; bits[b >> 3] |= 1 << (b & 7); } });
    const now = new Date(), da = now.toISOString().slice(0, 10).replace(/-/g, ''), tm = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const sopUID = uid(), seriesUID = uid(), dimUID = uid(), SEG_CLASS = '1.2.840.10008.5.1.4.1.1.66.4';
    const ax = vol.axes, iop = [...ax[0], ...ax[1]].map(ds2), srcClass = U.sopClass || '1.2.840.10008.5.1.4.1.1.2';
    const segment = (n, label, lab) => [[T(0x0062, 0x0003), 'SQ', [code('91723000', 'SCT', 'Anatomical Structure')]], [T(0x0062, 0x0004), 'US', n], [T(0x0062, 0x0005), 'LO', label],
      [T(0x0062, 0x0006), 'ST', lab.desc], [T(0x0062, 0x0008), 'CS', 'SEMIAUTOMATIC'], [T(0x0062, 0x0009), 'LO', 'Yolmed esik ve duzeltme'], [T(0x0062, 0x000d), 'US', lab.cie], [T(0x0062, 0x000f), 'SQ', [code('91609006', 'SCT', 'Mandible')]]];
    const perFrame = frames.map(f => {
      const sop = U.sops && U.sops[f.k];
      return [
        ...(sop ? [[T(0x0008, 0x9124), 'SQ', [[[T(0x0008, 0x2112), 'SQ', [[[T(0x0008, 0x1150), 'UI', srcClass], [T(0x0008, 0x1155), 'UI', sop], [T(0x0040, 0xa170), 'SQ', [code('121322', 'DCM', 'Source image for image processing operation')]]]]], [T(0x0008, 0x9215), 'SQ', [code('113076', 'DCM', 'Segmentation')]]]]]] : []),
        [T(0x0020, 0x9111), 'SQ', [[[T(0x0020, 0x9157), 'UL', [f.seg, f.k + 1]]]]],
        [T(0x0020, 0x9113), 'SQ', [[[T(0x0020, 0x0032), 'DS', G.worldOf(vol, 0, 0, f.k).map(ds2)]]]],
        [T(0x0062, 0x000a), 'SQ', [[[T(0x0062, 0x000b), 'US', f.seg]]]],
      ];
    });
    const labels = [{ name: 'Kalan kemik', desc: 'Rezeksiyon sonrasi kalan mandibula', cie: [53636, 34315, 41237] }, { name: 'Rezeke parca', desc: 'Planlanan rezeksiyon', cie: [41975, 49152, 48896] }];
    const els = [
      [T(0x0008, 0x0005), 'CS', 'ISO_IR 192'], [T(0x0008, 0x0008), 'CS', ['DERIVED', 'PRIMARY']], [T(0x0008, 0x0016), 'UI', SEG_CLASS], [T(0x0008, 0x0018), 'UI', sopUID],
      [T(0x0008, 0x0020), 'DA', m.studyDate || ''], [T(0x0008, 0x0021), 'DA', da], [T(0x0008, 0x0023), 'DA', da], [T(0x0008, 0x0030), 'TM', ''], [T(0x0008, 0x0031), 'TM', tm], [T(0x0008, 0x0033), 'TM', tm],
      [T(0x0008, 0x0050), 'SH', ''], [T(0x0008, 0x0060), 'CS', 'SEG'], [T(0x0008, 0x0070), 'LO', 'Yolmed'], [T(0x0008, 0x0090), 'PN', ''], [T(0x0008, 0x103e), 'LO', 'Guide plani segmentasyon'], [T(0x0008, 0x1090), 'LO', 'Guide Studyosu'],
      [T(0x0008, 0x1115), 'SQ', [[[T(0x0008, 0x114a), 'SQ', (U.sops || []).filter(Boolean).map(s => [[T(0x0008, 0x1150), 'UI', srcClass], [T(0x0008, 0x1155), 'UI', s]])], [T(0x0020, 0x000e), 'UI', U.series]]]],
      [T(0x0010, 0x0010), 'PN', ''], [T(0x0010, 0x0020), 'LO', ''], [T(0x0010, 0x0030), 'DA', ''], [T(0x0010, 0x0040), 'CS', ''],
      [T(0x0018, 0x1000), 'LO', '0'], [T(0x0018, 0x1020), 'LO', '1.0'],
      [T(0x0020, 0x000d), 'UI', U.study], [T(0x0020, 0x000e), 'UI', seriesUID], [T(0x0020, 0x0010), 'SH', ''], [T(0x0020, 0x0011), 'IS', '300'], [T(0x0020, 0x0013), 'IS', '1'],
      [T(0x0020, 0x0052), 'UI', U.frame], [T(0x0020, 0x1040), 'LO', ''],
      [T(0x0020, 0x9221), 'SQ', [[[T(0x0020, 0x9164), 'UI', dimUID]]]],
      [T(0x0020, 0x9222), 'SQ', [[[T(0x0020, 0x9164), 'UI', dimUID], [T(0x0020, 0x9165), 'AT', T(0x0062, 0x000b)], [T(0x0020, 0x9167), 'AT', T(0x0062, 0x000a)], [T(0x0020, 0x9421), 'LO', 'Segment Number']],
        [[T(0x0020, 0x9164), 'UI', dimUID], [T(0x0020, 0x9165), 'AT', T(0x0020, 0x0032)], [T(0x0020, 0x9167), 'AT', T(0x0020, 0x9113)], [T(0x0020, 0x9421), 'LO', 'Image Position Patient']]]],
      [T(0x0028, 0x0002), 'US', 1], [T(0x0028, 0x0004), 'CS', 'MONOCHROME2'], [T(0x0028, 0x0008), 'IS', String(frames.length)], [T(0x0028, 0x0010), 'US', R], [T(0x0028, 0x0011), 'US', C],
      [T(0x0028, 0x0100), 'US', 1], [T(0x0028, 0x0101), 'US', 1], [T(0x0028, 0x0102), 'US', 0], [T(0x0028, 0x0103), 'US', 0], [T(0x0028, 0x2110), 'CS', '00'],
      [T(0x0062, 0x0001), 'CS', 'BINARY'], [T(0x0062, 0x0002), 'SQ', segs.map((_, i) => segment(i + 1, labels[i].name, labels[i]))], [T(0x0062, 0x0013), 'CS', 'NO'],
      [T(0x0070, 0x0080), 'CS', 'GUIDE_PLAN'], [T(0x0070, 0x0081), 'LO', 'Kalan kemik ve rezeke parca'], [T(0x0070, 0x0084), 'PN', 'Yolmed^Studyo'],
      [T(0x5200, 0x9229), 'SQ', [[[T(0x0020, 0x9116), 'SQ', [[[T(0x0020, 0x0037), 'DS', iop]]]], [T(0x0028, 0x9110), 'SQ', [[[T(0x0018, 0x0050), 'DS', ds2(vol.sp[2])], [T(0x0028, 0x0030), 'DS', [ds2(vol.sp[1]), ds2(vol.sp[0])]]]]]]]],
      [T(0x5200, 0x9230), 'SQ', perFrame],
      [T(0x7fe0, 0x0010), 'OB', bits],
    ];
    const body = dataset(els);
    const metaEls = [[T(0x0002, 0x0001), 'OB', new Uint8Array([0, 1])], [T(0x0002, 0x0002), 'UI', SEG_CLASS], [T(0x0002, 0x0003), 'UI', sopUID], [T(0x0002, 0x0010), 'UI', '1.2.840.10008.1.2.1'], [T(0x0002, 0x0012), 'UI', '2.25.302208735227004126330468430390914393186'], [T(0x0002, 0x0013), 'SH', 'YOLMED_GS_1']];
    const meta = dataset(metaEls), glen = element(T(0x0002, 0x0000), 'UL', meta.length);
    const pre = new Uint8Array(132); pre.set(enc.encode('DICM'), 128);
    return { bytes: cat([pre, glen, meta, body]), frames: frames.length, segs: segs.length };
  }

  // ---------- navigation ----------
  function navigation() {
    const rows = [], vec = q => q.toArray().map(x => +x.toFixed(3)), push = (o) => rows.push(o);
    const frame = S.source && S.source.type === 'dicom' ? 'BT (LPS)' : 'Örnek hacim (LPS)';
    if (S.anchor) push({ tur: 'nokta', ad: 'Guide merkezi', sistem: frame, p: vec(S.anchor.p), yon: vec(S.anchor.n), not: 'oturma yönü' });
    const ref = window.Ref && Ref.get();
    if (ref) {
      ['R', 'L'].forEach(k => { if (ref.cond[k]) push({ tur: 'nokta', ad: `Kondil ${k === 'R' ? 'sağ' : 'sol'}`, sistem: frame, p: ref.cond[k] }); });
      const n = V(...ref.n); push({ tur: 'düzlem', ad: 'Orta sagittal düzlem', sistem: frame, p: vec(n.clone().multiplyScalar(ref.d)), yon: vec(n) });
    }
    if (S.anchor) St.planesWorld().forEach((pw, i) => push({ tur: 'düzlem', ad: `Kesi ${i + 1}`, sistem: frame, p: vec(pw.p), yon: vec(pw.N), d1: pw.w, not: 'yuva genişliği mm' }));
    const si = S.result ? S.result.screwInfo : [];
    si.forEach((x, i) => { if (x.ok) push({ tur: 'eksen', ad: `Vida ${i + 1}`, sistem: frame, p: vec(x.s.entry), yon: vec(x.s.dir), d1: x.s.sc.d, d2: x.s.sc.len, not: 'giriş noktası, yön; çap ve boy mm' }); });
    if (window.Implants) (Implants.summary() || []).forEach(x => { if (x.platform_lps_mm) push({ tur: 'eksen', ad: `İmplant ${x.no}`, sistem: frame, p: x.platform_lps_mm, yon: x.eksen.map(v => -v), d1: x.cap_mm, d2: x.boy_mm, not: 'platform, apekse yön; çap ve boy mm' }); });
    const st = window.Fibula && Fibula.active() ? Fibula.state() : null;
    if (st && st.last) {
      st.last.segs.forEach(g => { push({ tur: 'nokta', ad: `Greft ${g.i + 1} başı`, sistem: frame, p: vec(g.P0), yon: vec(g.N0) }); push({ tur: 'nokta', ad: `Greft ${g.i + 1} sonu`, sistem: frame, p: vec(g.P1), yon: vec(g.N1) }); });
      if (S.fib.guide) S.fib.guide.ctx.pls.forEach((pl, i) => push({ tur: 'düzlem', ad: `Fibula kesisi ${i + 1}`, sistem: 'Fibula BT (LPS)', p: vec(pl.p), yon: vec(pl.N), d1: pl.w, not: 'yuva genişliği mm' }));
    }
    const U = S.vol && S.vol.meta && S.vol.meta.uids;
    const json = { koordinat: 'DICOM hasta koordinatı (LPS: +x sol, +y arka, +z üst), mm', frame_of_reference_uid: U && U.frame || null, study_instance_uid: U && U.study || null, olusturma: new Date().toISOString(), ogeler: rows };
    const head = 'tur;ad;sistem;x;y;z;nx;ny;nz;deger1;deger2;not';
    const csv = [head].concat(rows.map(r => [r.tur, r.ad, r.sistem, ...(r.p || ['', '', '']), ...(r.yon || ['', '', '']), r.d1 ?? '', r.d2 ?? '', r.not || ''].map(x => typeof x === 'number' ? String(x) : `"${String(x).replace(/"/g, '""')}"`).join(';'))).join('\r\n');
    return { json, csv: '﻿' + csv };
  }

  // ---------- wiring ----------
  async function save(name, data, type) { await St.offer(name, new Blob([data], { type })); }
  $('x3mf').addEventListener('click', async () => {
    if (!St.parts.guide) { msg('Önce guide üretilmeli.'); return; }
    St.busy(true, '3MF hazırlanıyor…'); await St.sleep();
    try { await save('guideler.3mf', guides3MF(), 'model/3mf'); await save('modeller.3mf', models3MF(), 'model/3mf'); msg('guideler.3mf ve modeller.3mf hazır.'); } catch (e) { msg('3MF oluşturulamadı: ' + e.message); }
    St.busy(false);
  });
  $('xSeg').addEventListener('click', async () => {
    St.busy(true, 'DICOM SEG hazırlanıyor…'); await St.sleep();
    try { const r = segDICOM(); await save('segmentasyon_seg.dcm', r.bytes, 'application/dicom'); msg(`DICOM SEG hazır: ${r.segs} segment, ${r.frames} kesit.`); } catch (e) { msg(e.message); }
    St.busy(false);
  });
  $('xNav').addEventListener('click', async () => { const n = navigation(); await save('navigasyon.json', JSON.stringify(n.json, null, 2), 'application/json'); await save('navigasyon.csv', n.csv, 'text/csv'); msg('Navigasyon dosyaları hazır (JSON ve CSV, LPS mm).'); });
  const syncSeg = () => { const ok = !!(S.source && S.source.type === 'dicom' && S.vol && S.vol.meta && S.vol.meta.uids && S.vol.meta.uids.frame); $('xSeg').disabled = !ok; $('xSeg').title = ok ? 'Kalan kemik ve rezeke parça, kaynak BT ile aynı koordinatta' : 'Kaynak DICOM olmadığı için kullanılamaz'; };
  St.bus.addEventListener('volume', syncSeg); syncSeg();
  (window.ExportHooks = window.ExportHooks || []).push(files => {
    if (St.parts.guide) files.push({ name: 'guideler.3mf', data: guides3MF() }, { name: 'modeller.3mf', data: models3MF() });
    const n = navigation(); files.push({ name: 'navigasyon.json', data: JSON.stringify(n.json, null, 2) }, { name: 'navigasyon.csv', data: n.csv });
    if (!$('xSeg').disabled) try { files.push({ name: 'segmentasyon_seg.dcm', data: segDICOM().bytes }); } catch (e) { /* SEG is optional in the package */ }
  });
  return { guides3MF, models3MF, segDICOM, navigation };
})();
