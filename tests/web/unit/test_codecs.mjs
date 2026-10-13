// codecs.js (DicomCodecs) and app.js readDicom (series sorting, spacing, axes, rescale) on synthetic DICOM files.
// Third-party WASM/ESM codecs (JPEG, JPEG-LS, JPEG 2000) are fetched from a CDN at run time and are not tested here.
// Run: node test_codecs.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { plain, withDicomParser, studio, ready } from './lib/harness.mjs';
import { dicom, rle16 } from './lib/dicomw.mjs';

const P = withDicomParser(plain()); P.load('codecs.js'); const DC = P.eval('DicomCodecs');
const parse = async u8 => DC.parse(u8);
const px = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('supported / name for the declared transfer syntaxes; HTJ2K and MPEG are known but unsupported', () => {
  assert.equal(DC.supported('1.2.840.10008.1.2.1'), true);
  assert.equal(DC.supported('1.2.840.10008.1.2.5\0'), true, 'trailing NUL pad is cleaned');
  assert.equal(DC.supported('1.2.840.10008.1.2.4.201'), false);
  assert.equal(DC.name('1.2.840.10008.1.2.4.201'), 'High-Throughput JPEG 2000 Lossless');
  assert.equal(DC.name('9.9'), 'unknown');
  assert.equal(DC.supported(''), true, 'empty UID defaults to Implicit VR LE');
});

test('explicit VR LE, signed 16-bit: values come back unchanged (Int16Array)', async () => {
  const v = px(12, i => i * 100 - 600), ds = await parse(dicom({ rows: 3, cols: 4, pixels: v }));
  const out = await DC.decode(ds); assert.equal(out.constructor.name, 'Int16Array'); assert.deepEqual([...out], v);
});
test('explicit VR LE, unsigned 16-bit: Uint16Array, values above 32767 kept', async () => {
  const v = px(4, i => 40000 + i), out = await DC.decode(await parse(dicom({ rows: 2, cols: 2, pixels: v, signed: false })));
  assert.equal(out.constructor.name, 'Uint16Array'); assert.deepEqual([...out], v);
});
test('8-bit signed is sign-extended, 8-bit unsigned is not', async () => {
  const s = await DC.decode(await parse(dicom({ rows: 1, cols: 3, pixels: [0, 127, 200], bits: 8, signed: true })));
  assert.deepEqual([...s], [0, 127, -56]);
  const u = await DC.decode(await parse(dicom({ rows: 1, cols: 3, pixels: [0, 127, 200], bits: 8, signed: false })));
  assert.deepEqual([...u], [0, 127, 200]);
});
test('explicit VR big endian (retired) is byte-swapped', async () => {
  const v = [1, -2, 300, -32768], out = await DC.decode(await parse(dicom({ ts: '1.2.840.10008.1.2.2', rows: 2, cols: 2, pixels: v })));
  assert.deepEqual([...out], v);
});
test('deflated explicit VR LE (.1.2.1.99) is inflated before parsing', async () => {
  const v = px(16, i => i - 8), out = await DC.decode(await parse(dicom({ ts: '1.2.840.10008.1.2.1.99', rows: 4, cols: 4, pixels: v })));
  assert.deepEqual([...out], v);
});
test('RLE lossless 16-bit signed frame decodes to the same values', async () => {
  const v = px(20, i => (i * 37) % 2000 - 1000), out = await DC.decode(await parse(dicom({ ts: '1.2.840.10008.1.2.5', rows: 4, cols: 5, encapsulated: [rle16(v)] })));
  assert.deepEqual([...out], v);
});
test('RLE frame with too few segments for 16-bit is rejected with a clear error', async () => {
  const bad = Buffer.alloc(70); bad.writeUInt32LE(1, 0); bad.writeUInt32LE(64, 4);
  await assert.rejects(DC.decode(await parse(dicom({ ts: '1.2.840.10008.1.2.5', rows: 2, cols: 2, encapsulated: [bad] }))), /segments/);
});
test('errors: colour (3 samples), missing pixel data, short pixel data, frame out of range, unsupported syntax', async () => {
  await assert.rejects(DC.decode(await parse(dicom({ rows: 2, cols: 2, pixels: [1, 2, 3, 4], spp: 3 }))), /samples per pixel/);
  await assert.rejects(DC.decode(await parse(dicom({ rows: 2, cols: 2 }))), /no Pixel Data/);
  await assert.rejects(DC.decode(await parse(dicom({ rows: 4, cols: 4, pixels: [1, 2] }))), /shorter/);
  await assert.rejects(DC.decode(await parse(dicom({ rows: 2, cols: 2, pixels: [1, 2, 3, 4] })), 1), /out of range/);
  await assert.rejects(DC.decode(await parse(dicom({ ts: '1.2.840.10008.1.2.4.201', rows: 1, cols: 1, encapsulated: [Buffer.alloc(4)] }))), /not supported/);
});
test('decode(): rejects a non-DataSet argument', async () => { await assert.rejects(DC.decode(null), /expected a dicomParser DataSet/); });

// ---------- readDicom (app.js) ----------
const SP = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'] }); const St = await ready(SP);
const file = (u8, name) => new File([u8], name);
// a 3-slice series: IOP rows along +x, cols along +y, slices listed in reverse z order, PixelSpacing row 0.5 / col 0.7
function series({ n = 3, z0 = 10, dz = 1.25, series = '1.2.3.7', slope = 1, icpt = -1024, iop = [1, 0, 0, 0, 1, 0], extra = {} } = {}) {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const nrm = [iop[1] * iop[5] - iop[2] * iop[4], iop[2] * iop[3] - iop[0] * iop[5], iop[0] * iop[4] - iop[1] * iop[3]];
    const ipp = [5 + nrm[0] * (z0 + k * dz), -3 + nrm[1] * (z0 + k * dz), nrm[2] * (z0 + k * dz)];
    out.push(file(dicom(Object.assign({ rows: 2, cols: 3, pixels: px(6, i => 1000 + 10 * k + i), ipp, iop, ps: [0.5, 0.7], series, sop: `1.2.3.${k + 100}`, slope, icpt, thickness: 1, kernel: 'BONE' }, extra)), `s${k}.dcm`));
  }
  return out;
}
test('readDicom: slices sorted along the normal, spacing [col, row, dz] in mm, origin = first slice, HU = px*slope+icpt', async () => {
  const r = await St.readDicom(series({ slope: 2, icpt: -1000 }));
  assert.ok(!r.error, r.error);
  const v = r.vol; assert.deepEqual([v.nx, v.ny, v.nz], [3, 2, 3]);
  assert.deepEqual([...v.sp].map(x => +x.toFixed(6)), [0.7, 0.5, 1.25]);
  assert.deepEqual([...v.origin], [5, -3, 10]);
  assert.equal(v.hu[0], 1000 * 2 - 1000, 'slice 0, pixel 0');
  assert.equal(v.hu[2 * 3 * 2], (1000 + 20) * 2 - 1000, 'slice 2 is the one at the largest z');
  assert.equal(JSON.stringify(v.axes), "[[1,0,0],[0,1,0],[0,0,1]]");
});
test('readDicom: oblique IOP (30° about z) gives a right-handed frame and the same physical slice spacing', async () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6), r = await St.readDicom(series({ iop: [c, s, 0, -s, c, 0] }));
  assert.ok(!r.error, r.error); near(r.vol.sp[2], 1.25, 1e-9);
  const [a, b, n] = r.vol.axes; near(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], 0, 1e-12); near(n[2], 1, 1e-12);
});
test('readDicom: a duplicated slice position is dropped and reported; irregular gaps are recorded in meta.dzList', async () => {
  const f = series({ n: 4 }); f.push(series({ n: 1 })[0]);   // a second copy of z0
  const r = await St.readDicom(f); assert.ok(!r.error, r.error); assert.equal(r.vol.nz, 4);
  const g = series({ n: 3 }).concat(series({ n: 1, z0: 10 + 5 * 1.25, series: '1.2.3.7' }));
  const r2 = await St.readDicom(g); assert.ok(r2.vol.meta.dzList.some(d => Math.abs(d - 1.25) > 0.1), 'gap recorded');
});
test('readDicom: two series -> the larger one opens; scout-like small series is not chosen', async () => {
  const r = await St.readDicom(series({ n: 2, series: '9.9.1' }).concat(series({ n: 5, series: '9.9.2' })));
  assert.equal(r.vol.nz, 5); assert.equal(r.scan.groups.length, 2);
});
test('readDicom: junk files are skipped, an unsupported syntax is named in the error', async () => {
  const junk = file(new Uint8Array([1, 2, 3, 4, 5]), 'readme.txt');
  const r = await St.readDicom([junk]); assert.match(r.error, /DICOM bulunamadı/);
  const u = await St.readDicom([file(dicom({ ts: '1.2.840.10008.1.2.4.201', rows: 1, cols: 1, encapsulated: [Buffer.alloc(4)], ipp: [0, 0, 0] }), 'a.dcm')]);
  assert.match(u.error, /High-Throughput JPEG 2000/);
});
test('readDicom: a series packed in a .zip (stored) opens like a folder', async () => {
  const files = series({ n: 3 }), parts = await Promise.all(files.map(async f => ({ name: 'CT/' + f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  const z = new File([St.zipBytes(parts)], 'case.zip');
  const r = await St.readDicom([z]); assert.ok(!r.error, r.error); assert.equal(r.vol.nz, 3); assert.match(r.label, /^case/);
});
test('readDicom: modality / kernel strings from the header reach the quality list unescaped (see XSS finding)', async () => {
  const r = await St.readDicom(series({ extra: { kernel: '<img src=x onerror=1>' } }));
  assert.equal(r.vol.meta.kernel, '<img src=x onerror=1>');
});

await run('codecs.js + readDicom');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
