/* .zip reading in the browser, so a CT export can be opened without extracting it first.
   Reads the central directory from the end of the file, then inflates each entry from its own slice of the
   file (DecompressionStream 'deflate-raw'), so the whole archive is never held in memory at once.
   Handles stored and deflated entries, ZIP64 sizes and offsets, nested folders and zips inside the zip.
   Encrypted entries are skipped. Everything stays in the browser. */
'use strict';
window.Unzip = (function () {
  const LIMIT = { bytes: 6e9, entries: 50000, depth: 3 };
  const isZipName = n => /\.zip$/i.test(n);
  const junk = p => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(p) || /(^|\/)\._/.test(p);
  const u16 = (d, o) => d.getUint16(o, true), u32 = (d, o) => d.getUint32(o, true);
  const u64 = (d, o) => d.getUint32(o, true) + d.getUint32(o + 4, true) * 4294967296;
  const view = async blob => new DataView(await blob.arrayBuffer());
  async function isZip(f) {
    if (isZipName(f.name || '')) return true;
    if (!f.size || f.size < 22) return false;
    const d = await view(f.slice(0, 4)); return u32(d, 0) === 0x04034b50;
  }

  // central directory -> [{ name, method, csize, size, off, flags }]
  async function entries(file) {
    const tail = Math.min(file.size, 65557), base = file.size - tail, d = await view(file.slice(base));
    let e = -1; for (let i = tail - 22; i >= 0; i--) if (u32(d, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('zip dizini bulunamadı (dosya eksik ya da bozuk)');
    let n = u16(d, e + 10), cdSize = u32(d, e + 12), cdOff = u32(d, e + 16);
    if (n === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64: locator just before the end record points at the ZIP64 end record
      const l = e - 20; if (l < 0 || u32(d, l) !== 0x07064b50) throw new Error('ZIP64 dizini okunamadı');
      const z = await view(file.slice(u64(d, l + 8), u64(d, l + 8) + 56)); if (u32(z, 0) !== 0x06064b50) throw new Error('ZIP64 dizini okunamadı');
      n = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
    }
    if (n > LIMIT.entries) throw new Error(`zip içinde çok fazla dosya (${n})`);
    const c = await view(file.slice(cdOff, cdOff + cdSize)), out = [], dec = new TextDecoder();
    for (let p = 0, k = 0; k < n && p + 46 <= c.byteLength; k++) {
      if (u32(c, p) !== 0x02014b50) throw new Error('zip dizini bozuk');
      const flags = u16(c, p + 8), method = u16(c, p + 10), nl = u16(c, p + 28), xl = u16(c, p + 30), cl = u16(c, p + 32);
      let csize = u32(c, p + 20), size = u32(c, p + 24), off = u32(c, p + 42);
      const name = dec.decode(new Uint8Array(c.buffer, c.byteOffset + p + 46, nl));
      // ZIP64 extra field: only the values that overflowed are present, in this order
      for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
        const id = u16(c, x), len = u16(c, x + 2); let q = x + 4;
        if (id === 1) { if (size === 0xffffffff) { size = u64(c, q); q += 8; } if (csize === 0xffffffff) { csize = u64(c, q); q += 8; } if (off === 0xffffffff) { off = u64(c, q); } }
        x += 4 + len;
      }
      out.push({ name, method, csize, size, off, flags });
      p += 46 + nl + xl + cl;
    }
    return out;
  }
  async function data(file, en) {
    const h = await view(file.slice(en.off, en.off + 30)); if (u32(h, 0) !== 0x04034b50) throw new Error('zip kaydı bozuk');
    const start = en.off + 30 + u16(h, 26) + u16(h, 28), raw = file.slice(start, start + en.csize);
    if (en.method === 0) return raw;
    if (en.method !== 8) throw new Error(`desteklenmeyen sıkıştırma (${en.method})`);
    return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  }

  // files (File or zip) -> files, with every zip replaced by its contents; each item has name and relPath
  async function expand(files, onProgress) {
    const out = [], skipped = []; let total = 0;
    async function walk(f, prefix, depth) {
      if (!(await isZip(f).catch(() => false))) { out.push(f); return; }
      if (depth >= LIMIT.depth) { skipped.push(prefix + f.name); return; }
      if (typeof DecompressionStream === 'undefined') throw new Error('Bu tarayıcı zip açamıyor; zip\'i masaüstünde açıp klasörü seçin.');
      const list = await entries(f), root = (prefix + (f.name || 'arsiv.zip')).replace(/\.zip$/i, '');
      let i = 0;
      for (const en of list) {
        i++; if (en.name.endsWith('/') || junk(en.name)) continue;
        if (en.flags & 1) { skipped.push(en.name); continue; }   // encrypted
        total += en.size; if (total > LIMIT.bytes) throw new Error('zip açıldığında çok büyük (6 GB üstü)');
        const blob = await data(f, en), base = en.name.split('/').pop();
        const file = new File([blob], base), rel = root + '/' + en.name;
        Object.defineProperty(file, 'relPath', { value: rel });
        if (isZipName(base)) await walk(file, root + '/' + en.name.slice(0, -base.length), depth + 1); else out.push(file);
        if (onProgress) await onProgress(i, list.length, f.name);
      }
    }
    for (const f of files) await walk(f, '', 0);
    return { files: out, skipped };
  }

  // drag and drop: walk dropped folders (dataTransfer.files alone does not enter them)
  async function fromDrop(dt) {
    const items = [...(dt.items || [])].map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return [...dt.files];
    const out = [];
    const fileOf = en => new Promise((res, rej) => en.file(res, rej));
    const readAll = dir => new Promise((res, rej) => { const r = dir.createReader(), all = []; const next = () => r.readEntries(b => { if (!b.length) res(all); else { all.push(...b); next(); } }, rej); next(); });
    async function walk(en) {
      if (en.isFile) { const f = await fileOf(en); Object.defineProperty(f, 'relPath', { value: en.fullPath.replace(/^\//, '') }); out.push(f); }
      else if (en.isDirectory) for (const c of await readAll(en)) await walk(c);
    }
    for (const en of items) await walk(en);
    return out;
  }
  return { expand, fromDrop, isZip };
})();
