// unzip.js (Unzip.expand / isZip): synthetic zips made with python zipfile and by hand: normal deflated, nested,
// junk entries, encrypted flag, declared-size bomb, too many entries, depth limit, truncated archive, unsupported method,
// path-traversal names. Run: node test_unzip.mjs
import { test, run, assert } from './lib/t.mjs';
import { plain } from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const P = plain(); P.load('unzip.js'); const U = P.eval('Unzip');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uz'));
// python writes the zip: spec = [[name, bytes-as-latin1-string or {zip: spec}], ...]
function pyzip(name, spec, method = 'ZIP_DEFLATED') {
  const f = path.join(TMP, name);
  const code = `
import zipfile, json, sys, io
def build(spec, method):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w', getattr(zipfile, method)) as z:
        for n, d in spec:
            z.writestr(n, build(d['zip'], method) if isinstance(d, dict) else d.encode('latin1'))
    return b.getvalue()
open(sys.argv[1], 'wb').write(build(json.loads(sys.stdin.read()), sys.argv[2]))`;
  // the spec goes on stdin: a large one passed as an argument passes Windows' 32 767-character command line limit
  execFileSync('python3', ['-I', '-c', code, f, method], { input: JSON.stringify(spec) });
  return f;
}
const asFile = (f, name) => new File([fs.readFileSync(f)], name || path.basename(f));
const names = r => Array.from(r.files, f => f.relPath || f.name);
const skipped = r => Array.from(r.skipped);

test('normal deflated zip: every file comes out with its bytes and a relPath under the zip name', async () => {
  const r = await U.expand([asFile(pyzip('a.zip', [['CT/1.dcm', 'abc'], ['CT/2.dcm', 'x'.repeat(5000)]]))]);
  assert.deepEqual(names(r), ['a/CT/1.dcm', 'a/CT/2.dcm']);
  assert.equal(await r.files[0].text(), 'abc'); assert.equal(r.files[1].size, 5000); assert.equal(r.skipped.length, 0);
});
test('stored (method 0) entries are read as-is', async () => {
  const r = await U.expand([asFile(pyzip('s.zip', [['x.bin', 'hello']], 'ZIP_STORED'))]);
  assert.equal(await r.files[0].text(), 'hello');
});
test('nested zip inside a zip is expanded; relPath keeps both levels', async () => {
  const r = await U.expand([asFile(pyzip('n.zip', [['inner/series.zip', { zip: [['a.dcm', '1'], ['b.dcm', '2']] }], ['top.dcm', '3']]))]);
  assert.deepEqual(names(r).sort(), ['n/inner/series/a.dcm', 'n/inner/series/b.dcm', 'n/top.dcm']);
});
test('junk entries (__MACOSX, .DS_Store, ._x, Thumbs.db, folders) are dropped silently', async () => {
  const r = await U.expand([asFile(pyzip('j.zip', [['__MACOSX/CT/._1.dcm', 'j'], ['CT/.DS_Store', 'j'], ['CT/._1.dcm', 'j'], ['CT/Thumbs.db', 'j'], ['CT/', ''], ['CT/1.dcm', 'ok']]))]);
  assert.deepEqual(names(r), ['j/CT/1.dcm']); assert.equal(r.skipped.length, 0);
});
test('depth limit: zips nested deeper than 3 levels are skipped and reported', async () => {
  let spec = [['d.dcm', 'deep']]; for (let i = 0; i < 4; i++) spec = [[`l${i}.zip`, { zip: spec }]];
  const r = await U.expand([asFile(pyzip('deep.zip', spec))]);
  assert.equal(r.files.length, 0); assert.equal(r.skipped.length, 1);
});
// hand-made archives: patch fields of a python zip
function patch(f, fn) { const b = fs.readFileSync(f); fn(b); const g = f.replace(/\.zip$/, '_p.zip'); fs.writeFileSync(g, b); return g; }
const eocd = b => b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const cdir = b => b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
test('encrypted entry (general flag bit 0) is skipped and listed', async () => {
  const f = patch(pyzip('e.zip', [['sec.dcm', 'secret'], ['ok.dcm', 'ok']]), b => { const c = cdir(b); b.writeUInt16LE(b.readUInt16LE(c + 8) | 1, c + 8); });
  const r = await U.expand([asFile(f, 'e.zip')]);
  assert.deepEqual(names(r), ['e/ok.dcm']); assert.deepEqual(skipped(r), ['sec.dcm']);
});
test('unsupported compression method (e.g. 12 bzip2) is skipped and listed', async () => {
  const f = patch(pyzip('m.zip', [['a.dcm', 'aaaa']]), b => { const c = cdir(b); b.writeUInt16LE(12, c + 10); });
  const r = await U.expand([asFile(f, 'm.zip')]); assert.equal(r.files.length, 0); assert.deepEqual(skipped(r), ['a.dcm']);
});
test('declared-size check: an entry whose declared size alone exceeds what is left of the 6 GB budget is refused before inflating', async () => {
  // first entry really inflates to 1 byte; the next two each declare 4.29 GB. The check is total(actual so far) + declared(this entry),
  // so each passes on its own (1 + 4.29e9 < 6e9): declared sizes are not summed. Harmless for honest archives (actual = declared);
  // documents that only the per-entry declaration and the post-inflation total are checked.
  const g = patch(pyzip('b2.zip', [['big1.dcm', 'x'], ['big2.dcm', 'y']]), b => { let c = cdir(b); b.writeUInt32LE(0xfffffff0, c + 24); c = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), c + 4); b.writeUInt32LE(0xfffffff0, c + 24); });
  const r = await U.expand([asFile(g, 'b2.zip')]);
  assert.equal(r.files.length, 2, 'two entries declaring 8.6 GB in total are accepted');
  assert.equal(r.files[0].size + r.files[1].size, 2, 'real sizes are what comes out');
});
test('declared size smaller than the real inflated data: inflating stops and the entry is refused', async () => {
  const f = patch(pyzip('l.zip', [['a.dcm', 'z'.repeat(100000)]]), b => { const c = cdir(b); b.writeUInt32LE(10, c + 24); });
  await assert.rejects(U.expand([asFile(f, 'l.zip')]), /çok büyük/);
});
test('zip bomb (lying declared size): a 50 MB entry declared as 10 bytes is cut off while inflating', async () => {
  const f = path.join(TMP, 'bomb.zip');
  execFileSync('python3', ['-I', '-c', "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED);z.writestr('b.dcm', bytes(50*1024*1024));z.close()", f]);
  const g = patch(f, b => { const c = cdir(b); b.writeUInt32LE(10, c + 24); });
  assert.ok(fs.statSync(g).size < 200000, 'compressed under 200 kB');
  await assert.rejects(U.expand([asFile(g, 'bomb.zip')]), /çok büyük/);
});
test('too many entries: end record claims 60000 entries -> refused', async () => {
  const f = patch(pyzip('t.zip', [['a', '1']]), b => { const e = eocd(b); b.writeUInt16LE(60000, e + 10); b.writeUInt16LE(60000, e + 8); });
  await assert.rejects(U.expand([asFile(f, 't.zip')]), /çok fazla dosya/);
});
test('truncated archive (central directory cut off) -> clear error, no hang', async () => {
  const f = pyzip('c.zip', [['a.dcm', 'q'.repeat(1000)]]), b = fs.readFileSync(f), g = path.join(TMP, 'cut.zip'); fs.writeFileSync(g, b.subarray(0, b.length - 30));
  await assert.rejects(U.expand([asFile(g, 'cut.zip')]), /zip/);
});
test('central directory offset beyond the file -> error', async () => {
  const f = patch(pyzip('o.zip', [['a', '1']]), b => { const e = eocd(b); b.writeUInt32LE(0x7fffffff, e + 16); });
  await assert.rejects(U.expand([asFile(f, 'o.zip')]), /bozuk/);
});
test('path traversal names (../../x) only end up in relPath strings (nothing is written to disk)', async () => {
  const r = await U.expand([asFile(pyzip('p.zip', [['../../etc/x.dcm', '1']]))]);
  assert.equal(r.files[0].name, 'x.dcm'); assert.equal(r.files[0].relPath, 'p/../../etc/x.dcm');
});
test('isZip: by name, by PK signature for a nameless blob, false for a short or non-zip file', async () => {
  assert.equal(await U.isZip(new File(['x'], 'A.ZIP')), true);
  assert.equal(await U.isZip(new File([fs.readFileSync(pyzip('sig.zip', [['a', 'b']]))], 'noext')), true);
  assert.equal(await U.isZip(new File(['PK'], 'x')), false);
  assert.equal(await U.isZip(new File(['DICM'.repeat(10)], 'x.dcm')), false);
});
test('a non-zip file with .zip name is reported as an error (not silently dropped)', async () => {
  await assert.rejects(U.expand([new File(['not a zip at all, just text '.repeat(3)], 'fake.zip')]), /zip dizini bulunamadı/);
});

await run('unzip.js');
