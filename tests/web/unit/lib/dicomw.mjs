// Tiny synthetic DICOM Part 10 writer for tests (explicit VR LE / BE, deflated, RLE). No patient data: fixed dummy UIDs.
import zlib from 'node:zlib';
const LONG = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);
function el(g, e, vr, val, be = false) {
  let b;
  if (val instanceof Uint8Array) b = val;
  else if (vr === 'US') { b = new Uint8Array(2 * [].concat(val).length); const d = new DataView(b.buffer); [].concat(val).forEach((x, i) => d.setUint16(2 * i, x, !be)); }
  else if (vr === 'UL') { b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, val, !be); }
  else { b = Buffer.from(String(val), 'latin1'); if (b.length % 2) b = Buffer.concat([b, Buffer.from(vr === 'UI' ? [0] : [0x20])]); b = new Uint8Array(b); }
  const long = LONG.has(vr), h = new DataView(new ArrayBuffer(long ? 12 : 8));
  h.setUint16(0, g, !be); h.setUint16(2, e, !be); h.setUint8(4, vr.charCodeAt(0)); h.setUint8(5, vr.charCodeAt(1));
  if (long) h.setUint32(8, b.length, !be); else h.setUint16(6, b.length, !be);
  return Buffer.concat([Buffer.from(h.buffer), Buffer.from(b)]);
}
// encapsulated pixel data: empty basic offset table + one fragment per frame
function encap(frames) {
  const parts = [], h = (g, e, len) => { const d = Buffer.alloc(8); d.writeUInt16LE(g, 0); d.writeUInt16LE(e, 2); d.writeUInt32LE(len, 4); return d; };
  const head = Buffer.alloc(12); head.writeUInt16LE(0x7fe0, 0); head.writeUInt16LE(0x0010, 2); head.write('OB', 4, 'latin1'); head.writeUInt32LE(0xffffffff, 8);
  parts.push(head, h(0xfffe, 0xe000, 0));
  frames.forEach(f => { let b = Buffer.from(f); if (b.length % 2) b = Buffer.concat([b, Buffer.alloc(1)]); parts.push(h(0xfffe, 0xe000, b.length), b); });
  parts.push(h(0xfffe, 0xe0dd, 0));
  return Buffer.concat(parts);
}
// RLE Lossless frame of 16-bit samples (two segments, literal runs only)
export function rle16(values) {
  const seg = bytes => { const out = []; for (let i = 0; i < bytes.length; i += 128) { const run = bytes.slice(i, i + 128); out.push(run.length - 1, ...run); } if (out.length % 2) out.push(0x80); return Buffer.from(out); };
  const hi = [], lo = []; values.forEach(v => { const u = v & 0xffff; hi.push(u >> 8); lo.push(u & 255); });
  const s0 = seg(hi), s1 = seg(lo), head = Buffer.alloc(64); head.writeUInt32LE(2, 0); head.writeUInt32LE(64, 4); head.writeUInt32LE(64 + s0.length, 8);
  return Buffer.concat([head, s0, s1]);
}
/* opts: { ts, rows, cols, pixels (array of stored values), bits:16|8, signed, slope, icpt, ipp:[x,y,z], iop:[6], ps:[row,col], series, sop, modality,
          kernel, thickness, frames (for multi-frame NumberOfFrames), spp, encapsulated:[Buffer…] } */
export function dicom(o) {
  const ts = o.ts || '1.2.840.10008.1.2.1', be = ts === '1.2.840.10008.1.2.2', bits = o.bits || 16, signed = o.signed ?? true;
  const meta = [el(2, 1, 'OB', new Uint8Array([0, 1])), el(2, 2, 'UI', '1.2.840.10008.5.1.4.1.1.2'), el(2, 3, 'UI', o.sop || '1.2.3.4.5'), el(2, 0x10, 'UI', ts), el(2, 0x12, 'UI', '1.2.3.4')];
  const ml = Buffer.concat(meta), gl = el(2, 0, 'UL', ml.length);
  const E = (g, e, vr, v) => el(g, e, vr, v, be), ds = [];
  ds.push(E(8, 0x16, 'UI', '1.2.840.10008.5.1.4.1.1.2'), E(8, 0x18, 'UI', o.sop || '1.2.3.4.5'), E(8, 0x60, 'CS', o.modality || 'CT'));
  if (o.thickness != null) ds.push(E(0x18, 0x50, 'DS', String(o.thickness)));
  if (o.kernel != null) ds.push(E(0x18, 0x1210, 'SH', o.kernel));
  ds.push(E(0x20, 0x0d, 'UI', '1.2.3.9'), E(0x20, 0x0e, 'UI', o.series || '1.2.3.7'), E(0x20, 0x32, 'DS', (o.ipp || [0, 0, 0]).join('\\')), E(0x20, 0x37, 'DS', (o.iop || [1, 0, 0, 0, 1, 0]).join('\\')), E(0x20, 0x52, 'UI', '1.2.3.8'));
  ds.push(E(0x28, 2, 'US', o.spp || 1), E(0x28, 4, 'CS', 'MONOCHROME2'));
  if (o.frames) ds.push(E(0x28, 8, 'IS', String(o.frames)));
  ds.push(E(0x28, 0x10, 'US', o.rows), E(0x28, 0x11, 'US', o.cols), E(0x28, 0x30, 'DS', (o.ps || [1, 1]).join('\\')), E(0x28, 0x100, 'US', bits), E(0x28, 0x101, 'US', o.stored || bits), E(0x28, 0x102, 'US', (o.stored || bits) - 1), E(0x28, 0x103, 'US', signed ? 1 : 0));
  if (o.icpt != null) ds.push(E(0x28, 0x1052, 'DS', String(o.icpt)));
  if (o.slope != null) ds.push(E(0x28, 0x1053, 'DS', String(o.slope)));
  if (o.encapsulated) ds.push(encap(o.encapsulated));
  else if (o.pixels) {
    const n = o.pixels.length, b = new Uint8Array(n * bits / 8), d = new DataView(b.buffer);
    o.pixels.forEach((v, i) => { if (bits === 16) signed ? d.setInt16(2 * i, v, !be) : d.setUint16(2 * i, v, !be); else b[i] = v & 255; });
    ds.push(E(0x7fe0, 0x10, bits === 16 ? 'OW' : 'OB', b));
  }
  let body = Buffer.concat(ds);
  if (ts === '1.2.840.10008.1.2.1.99') body = zlib.deflateRawSync(body);
  return new Uint8Array(Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), gl, ml, body]));
}
