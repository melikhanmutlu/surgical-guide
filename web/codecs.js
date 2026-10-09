/* DicomCodecs: pixel-data decoding for compressed and uncompressed DICOM transfer syntaxes.
 * Classic script (no modules, no bundler). Needs the global `dicomParser` (1.8.x).
 *
 *   DicomCodecs.supported(tsUID)            -> boolean
 *   await DicomCodecs.decode(dataSet, frame) -> Int16Array (PixelRepresentation 1) | Uint16Array (0), rows*cols stored values
 *   await DicomCodecs.parse(uint8Array)      -> dicomParser DataSet; same as dicomParser.parseDicom, but also inflates
 *                                              Deflated Explicit VR Little Endian (1.2.840.10008.1.2.1.99) files
 *   DicomCodecs.name(tsUID)                  -> human-readable transfer syntax name
 *   DicomCodecs.loaded()                     -> names of third-party codecs fetched so far
 *   DicomCodecs.cdn                          -> base URL the codecs are fetched from (default jsDelivr; set before first decode
 *                                              to self-host the same <package>@<version>/<path> tree)
 *
 * Own code: uncompressed LE/BE, deflate (DecompressionStream), RLE Lossless.
 * Third-party decoders are fetched lazily, each only when a frame needs it:
 *   JPEG Lossless (.57/.70)          jpeg-lossless-decoder-js 2.1.2 (MIT, pure JS, ES module via import())
 *   JPEG-LS (.80/.81)                @cornerstonejs/codec-charls 1.2.7 (CharLS, WASM)
 *   JPEG 2000 (.90/.91)              @cornerstonejs/codec-openjpeg 1.3.6 (OpenJPEG, WASM)
 *   JPEG Baseline 8-bit (.50/.51)    @cornerstonejs/codec-libjpeg-turbo-8bit 1.2.8 (WASM)
 *   JPEG Extended 12-bit (.51)       @cornerstonejs/codec-libjpeg-turbo-12bit 0.4.7 (WASM)
 */
(function () {
  'use strict';

  const TS = {
    '1.2.840.10008.1.2': 'Implicit VR Little Endian',
    '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
    '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
    '1.2.840.10008.1.2.2': 'Explicit VR Big Endian (retired)',
    '1.2.840.10008.1.2.5': 'RLE Lossless',
    '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)',
    '1.2.840.10008.1.2.4.51': 'JPEG Extended (Process 2 & 4)',
    '1.2.840.10008.1.2.4.57': 'JPEG Lossless, Non-Hierarchical (Process 14)',
    '1.2.840.10008.1.2.4.70': 'JPEG Lossless, First-Order Prediction (Process 14, SV1)',
    '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
    '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-Lossless',
    '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
    '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  };
  const KNOWN_UNSUPPORTED = {
    '1.2.840.10008.1.2.4.201': 'High-Throughput JPEG 2000 Lossless', '1.2.840.10008.1.2.4.202': 'High-Throughput JPEG 2000 RPCL Lossless',
    '1.2.840.10008.1.2.4.203': 'High-Throughput JPEG 2000', '1.2.840.10008.1.2.4.100': 'MPEG2', '1.2.840.10008.1.2.4.102': 'MPEG-4 AVC/H.264',
    '1.2.840.10008.1.2.4.92': 'JPEG 2000 Part 2 Multi-component Lossless', '1.2.840.10008.1.2.4.93': 'JPEG 2000 Part 2 Multi-component',
  };
  const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.2']);
  const DEFLATE = '1.2.840.10008.1.2.1.99';
  const clean = uid => String(uid || '1.2.840.10008.1.2').replace(/\0/g, '').trim();
  const name = uid => { uid = clean(uid); return TS[uid] || KNOWN_UNSUPPORTED[uid] || 'unknown'; };
  const fail = (uid, msg) => new Error(`DICOM ${name(uid)} (${clean(uid)}): ${msg}`);

  // ---------------- lazy third-party codec loading ----------------
  const CODECS = {
    jpegLossless: { pkg: 'jpeg-lossless-decoder-js@2.1.2', file: 'release/lossless-min.js', esm: true },
    charls: { pkg: '@cornerstonejs/codec-charls@1.2.7', file: 'dist/charlswasm_decode.js', wasm: 'dist/charlswasm_decode.wasm', global: 'CharLSWASM' },
    openjpeg: { pkg: '@cornerstonejs/codec-openjpeg@1.3.6', file: 'dist/openjpegwasm_decode.js', wasm: 'dist/openjpegwasm_decode.wasm', global: 'OpenJPEGWASM' },
    jpeg8: { pkg: '@cornerstonejs/codec-libjpeg-turbo-8bit@1.2.8', file: 'dist/libjpegturbowasm_decode.js', wasm: 'dist/libjpegturbowasm_decode.wasm', global: 'libjpegturbowasm_decode' },
    jpeg12: { pkg: '@cornerstonejs/codec-libjpeg-turbo-12bit@0.4.7', file: 'dist/libjpegturbo12wasm.js', wasm: 'dist/libjpegturbo12wasm.wasm', global: 'libjpegturbo12wasm' },
  };
  const pending = {};
  const loadedNames = [];
  const url = (c, f) => api.cdn.replace(/\/?$/, '/') + c.pkg + '/' + f;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => res(); s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function codec(key) {
    if (!pending[key]) {
      const c = CODECS[key];
      pending[key] = (async () => {
        let mod;
        if (c.esm) mod = await import(url(c, c.file));
        else {
          if (typeof window[c.global] !== 'function') await loadScript(url(c, c.file));
          const wasmUrl = url(c, c.wasm);
          mod = await window[c.global]({ print: () => {}, locateFile: f => (f.endsWith('.wasm') ? wasmUrl : url(c, 'dist/' + f)) });
        }
        loadedNames.push(c.pkg);
        return mod;
      })();
      pending[key].catch(() => { delete pending[key]; }); // allow a retry after a network error
    }
    return pending[key];
  }

  // ---------------- frame extraction ----------------
  function nFrames(ds) { return Math.max(1, ds.intString('x00280008') || 1); }
  function frameStarts(bytes, uid) {
    // Signature of the first fragment of a frame: JPEG/JPEG-LS SOI, J2K SOC+SIZ, or a JP2 signature box.
    if (uid.startsWith('1.2.840.10008.1.2.4.9')) return (bytes[0] === 0xff && bytes[1] === 0x4f && bytes[2] === 0xff && bytes[3] === 0x51) ||
      (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0x0c && bytes[4] === 0x6a && bytes[5] === 0x50);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  function encapsulatedFrame(ds, frame, uid) {
    const el = ds.elements.x7fe00010, frags = el.fragments, n = nFrames(ds), ba = ds.byteArray;
    if (!frags || !frags.length) throw fail(uid, 'encapsulated pixel data has no fragments');
    if (frame < 0 || frame >= n) throw fail(uid, `frame ${frame} out of range (0..${n - 1})`);
    const fragBytes = i => new Uint8Array(ba.buffer, ba.byteOffset + frags[i].position, frags[i].length);
    try {
      if (n === 1) return frags.length === 1 ? fragBytes(0) : dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, frags.length);
      const eot = ds.elements.x7fe00001; // Extended Offset Table: one fragment per frame, 64-bit offsets
      if (eot && eot.length >= 8 * n) {
        const off = new DataView(ba.buffer, ba.byteOffset + eot.dataOffset, eot.length).getBigUint64(8 * frame, true);
        const i = frags.findIndex(f => BigInt(f.offset) === off);
        if (i >= 0) return fragBytes(i);
      }
      if (el.basicOffsetTable && el.basicOffsetTable.length === n) return dicomParser.readEncapsulatedImageFrame(ds, el, frame);
      if (frags.length === n) return fragBytes(frame);
      // No usable offset table and several fragments per frame: find each frame's first fragment by its codestream signature.
      if (!ds._dcFrameBOT) {
        const bot = [];
        for (let i = 0; i < frags.length; i++) if (frameStarts(fragBytes(i), uid)) bot.push(frags[i].offset);
        if (bot.length !== n) throw fail(uid, `cannot locate frames: ${n} frames, ${frags.length} fragments, no offset table`);
        ds._dcFrameBOT = bot;
      }
      return dicomParser.readEncapsulatedImageFrame(ds, el, frame, ds._dcFrameBOT);
    } catch (e) {
      throw e instanceof Error ? e : fail(uid, String(e));
    }
  }

  // ---------------- own decoders ----------------
  function decodeRLE(src, rows, cols, bytesPerSample, uid) {
    const px = rows * cols, out = new Uint8Array(px * bytesPerSample);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const nseg = dv.getUint32(0, true);
    if (nseg !== bytesPerSample) throw fail(uid, `RLE frame has ${nseg} segments, expected ${bytesPerSample} (only 1-sample images are supported)`);
    for (let s = 0; s < nseg; s++) {
      let p = dv.getUint32(4 + 4 * s, true);
      const end = s + 1 < nseg ? dv.getUint32(8 + 4 * s, true) : src.length;
      // segment 0 holds the most significant byte; output is little endian
      let o = bytesPerSample - 1 - s, k = 0;
      while (p < end && k < px) {
        const n = (src[p++] << 24) >> 24;
        if (n >= 0) { for (let j = 0; j <= n && k < px; j++, k++, o += bytesPerSample) out[o] = src[p++]; }
        else if (n !== -128) { const b = src[p++]; for (let j = 0; j < 1 - n && k < px; j++, k++, o += bytesPerSample) out[o] = b; }
      }
      if (k < px) throw fail(uid, `RLE segment ${s} ended early (${k}/${px} bytes)`);
    }
    return out;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw fail(DEFLATE, 'this browser has no DecompressionStream');
    const run = b => new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    try { return new Uint8Array(await run(bytes)); } catch (e) {
      // Part 10 files are padded to even length; the pad byte after the deflate stream makes DecompressionStream reject it.
      if (bytes.length > 1 && bytes[bytes.length - 1] === 0) {
        try { return new Uint8Array(await run(bytes.subarray(0, bytes.length - 1))); } catch (e2) { /* report the original */ }
      }
      throw fail(DEFLATE, 'deflated data set could not be inflated (' + (e && e.message) + ')');
    }
  }

  // JPEG marker scan: the frame header tells us lossless vs DCT, and 8- vs 12-bit, regardless of the declared syntax.
  function jpegSOF(b) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if ((m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) || m === 0xf7) return { marker: m, precision: b[i + 4] };
      if (m === 0xda) break;
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }

  function wasmDecode(M, Cls, bytes) {
    const d = new M[Cls]();
    try {
      d.getEncodedBuffer(bytes.length).set(bytes);
      d.decode();
      const info = d.getFrameInfo();
      const v = d.getDecodedBuffer(); // Uint8Array, or Uint16Array/Int16Array in some builds: copy out of WASM memory as bytes
      return { info, data: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    } finally { d.delete(); }
  }

  // ---------------- public decode ----------------
  async function decode(ds, frameIndex = 0) {
    if (!ds || !ds.elements) throw new Error('DicomCodecs.decode: expected a dicomParser DataSet');
    const uid = clean(ds.string('x00020010'));
    const el = ds.elements.x7fe00010;
    if (!el) throw fail(uid, 'no Pixel Data (7FE0,0010)');
    if (!supported(uid)) throw fail(uid, 'transfer syntax not supported by this viewer');
    const rows = ds.uint16('x00280010'), cols = ds.uint16('x00280011');
    const ba = ds.uint16('x00280100') || 16, bs = ds.uint16('x00280101') || ba;
    const signed = ds.uint16('x00280103') === 1, spp = ds.uint16('x00280002') || 1;
    if (!rows || !cols) throw fail(uid, 'missing Rows/Columns');
    if (spp !== 1) throw fail(uid, `${spp} samples per pixel (colour) is not supported; expected a greyscale CT/MR series`);
    if (ba !== 8 && ba !== 16) throw fail(uid, `Bits Allocated ${ba} is not supported (8 or 16 only)`);
    const px = rows * cols, bpp = ba / 8;
    let bytes, sampleBits = ba, signExtend = false; // signExtend: decoder delivered `bs`-bit unsigned codes that are really two's complement

    if (UNCOMPRESSED.has(uid)) {
      if (el.encapsulatedPixelData) throw fail(uid, 'pixel data is encapsulated but the syntax is uncompressed');
      const n = nFrames(ds);
      if (frameIndex < 0 || frameIndex >= n) throw fail(uid, `frame ${frameIndex} out of range (0..${n - 1})`);
      const start = ds.byteArray.byteOffset + el.dataOffset + frameIndex * px * bpp;
      if (el.dataOffset + (frameIndex + 1) * px * bpp > ds.byteArray.length) throw fail(uid, 'pixel data shorter than Rows x Columns');
      bytes = new Uint8Array(ds.byteArray.buffer.slice(start, start + px * bpp));
      if (uid === '1.2.840.10008.1.2.2' && bpp === 2) for (let i = 0; i < bytes.length; i += 2) { const t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t; }
    } else {
      const src = encapsulatedFrame(ds, frameIndex, uid);
      if (uid === '1.2.840.10008.1.2.5') bytes = decodeRLE(src, rows, cols, bpp, uid);
      else if (uid.startsWith('1.2.840.10008.1.2.4.9')) {
        const { info, data } = wasmDecode(await codec('openjpeg'), 'J2KDecoder', src);
        bytes = data; sampleBits = info.bitsPerSample > 8 ? 16 : 8; signExtend = !info.isSigned && signed;
        if (info.width !== cols || info.height !== rows) throw fail(uid, `codestream is ${info.width}x${info.height}, header says ${cols}x${rows}`);
      } else {
        const sof = jpegSOF(src);
        if (!sof) throw fail(uid, 'no JPEG frame header (SOF) found in the frame');
        if (sof.marker === 0xf7 || sof.marker === 0xf8) {
          const { info, data } = wasmDecode(await codec('charls'), 'JpegLSDecoder', src);
          bytes = data; sampleBits = info.bitsPerSample > 8 ? 16 : 8; signExtend = signed;
        } else if (sof.marker === 0xc3 || sof.marker === 0xc7) {
          const L = await codec('jpegLossless');
          const out = new L.Decoder().decode(src.buffer, src.byteOffset, src.length, sof.precision > 8 ? 2 : 1);
          bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength); sampleBits = sof.precision > 8 ? 16 : 8; signExtend = signed;
        } else if (sof.marker === 0xc0 || sof.marker === 0xc1 || sof.marker === 0xc2) {
          const { info, data } = wasmDecode(await codec(sof.precision > 8 ? 'jpeg12' : 'jpeg8'), 'JPEGDecoder', src);
          bytes = data; sampleBits = sof.precision > 8 ? 16 : 8; signExtend = signed;
          if (info.componentCount && info.componentCount !== 1) throw fail(uid, `JPEG has ${info.componentCount} components; expected greyscale`);
        } else throw fail(uid, `JPEG process with SOF marker 0xFF${sof.marker.toString(16).toUpperCase()} (e.g. arithmetic or hierarchical coding) is not supported`);
      }
    }

    // widen / reinterpret into 16-bit stored values
    let out;
    if (sampleBits === 16) {
      if (bytes.length < px * 2) throw fail(uid, `decoded ${bytes.length} bytes, expected ${px * 2}`);
      const buf = bytes.byteOffset % 2 || bytes.length !== px * 2 ? bytes.slice(0, px * 2).buffer : bytes.buffer;
      out = signed ? new Int16Array(buf) : new Uint16Array(buf);
    } else {
      if (bytes.length < px) throw fail(uid, `decoded ${bytes.length} bytes, expected ${px}`);
      out = signed ? new Int16Array(px) : new Uint16Array(px);
      const nbits = signed && ba === 8 ? 8 : 0;
      for (let i = 0; i < px; i++) out[i] = nbits ? (bytes[i] << 24) >> 24 : bytes[i];
    }
    const sbits = Math.min(bs, sampleBits);
    if (signed && signExtend && sbits < 16 && sampleBits === 16) {
      const sh = 32 - sbits;
      for (let i = 0; i < px; i++) out[i] = (out[i] << sh) >> sh;
    }
    return out;
  }

  function supported(uid) { return !!TS[clean(uid)]; }

  async function parse(bytes, options) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    let meta;
    try { meta = dicomParser.readPart10Header(bytes, options); } catch (e) { meta = null; }
    const uid = meta && meta.string ? clean(meta.string('x00020010')) : '';
    if (uid !== DEFLATE) return dicomParser.parseDicom(bytes, options);
    const pos = meta.position, inflated = await inflateRaw(bytes.subarray(pos));
    const full = new Uint8Array(pos + inflated.length);
    full.set(bytes.subarray(0, pos)); full.set(inflated, pos);
    return dicomParser.parseDicom(bytes, Object.assign({}, options, { inflater: () => full }));
  }

  const api = {
    cdn: 'https://cdn.jsdelivr.net/npm/',
    supported, decode, parse, name,
    loaded: () => loadedNames.slice(),
    transferSyntaxes: () => Object.keys(TS),
    codecs: CODECS,
  };
  window.DicomCodecs = api;
})();
