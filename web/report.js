/* Surgical PDF report, drawn page by page on a canvas and packed into a PDF of JPEG pages by a small writer below.
   Every line of text drawn on a page is also written into the PDF as invisible text (render mode 3) at the same place,
   so the report can be searched, copied and read aloud (D1); the picture stays what the canvas drew. That text uses
   the standard Helvetica font (no font file) in Windows-1254 order, which holds the Turkish letters; a /ToUnicode map
   gives extractors the exact characters. Contents: case and version, 3D views, cut table, screws, fibula segments,
   assembly order, automatic checks, and signature fields for the surgeon and the engineer. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
// canvas text bypasses the DOM translator: a whole string, else line by line
const xt = s => { s = String(s); const w = xl(s); return w !== s ? w : s.split('\n').map(xl).join('\n'); };
window.Report = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt } = St, $ = id => document.getElementById(id);
  const W = 1240, H = 1754, M = 90, FONT = '"IBM Plex Sans", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
  const C = { ink: '#14181c', muted: '#5b646e', line: '#d5dadf', accent: '#0b6782', ok: '#1d7a50', warn: '#9a5a00', crit: '#b42318', soft: '#f3f5f7' };

  // ---------- 3D snapshots from fixed directions ----------
  function snapshot(dir, w = 1000, h = 640, layer = 0, focus = null, margin = 1.02, hide = null) {
    const r = St.renderer, cam = St.camera, ctl = St.controls, keep = { pos: cam.position.clone(), tgt: ctl.target.clone(), aspect: cam.aspect, layers: cam.layers.mask };
    const size = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio(), split = S.split;
    S.split = false; r.setPixelRatio(1); r.setSize(w, h, false); cam.aspect = w / h; cam.layers.set(layer);
    const objs = layer === 0 ? Object.values(St.parts).filter(p => p.visible && (focus || /^(bone|guide|resected|screw\d*|plate)$/).test(p.id)).map(p => p.obj) : [];
    // tissue layers and other context surfaces would cover the plan: hidden for the picture
    const hid = Object.values(St.parts).filter(p => p.obj.visible && (/^(layer_|ctx_|mirror)/.test(p.id) || (hide && hide.test(p.id)))); hid.forEach(p => { p.obj.visible = false; });
    const box = new THREE.Box3(); objs.forEach(o => box.expandByObject(o));
    if (layer === 1) St.scene.traverse(o => { if (o.isMesh && o.layers.mask === 2 && (o.userData.guide || o.userData.disc)) box.expandByObject(o); });
    if (!box.isEmpty()) {
      const c = box.getCenter(V()), rad = box.getSize(V()).length() / 2, d = V(...dir).normalize();
      const vf = THREE.MathUtils.degToRad(cam.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
      ctl.target.copy(c); cam.position.copy(c).add(d.multiplyScalar(rad / Math.sin(Math.min(vf, hf) / 2) * margin));
    }
    cam.updateProjectionMatrix(); cam.lookAt(ctl.target);
    const bg = St.scene.background; St.scene.background = new THREE.Color(0xeef1f4);
    r.render(St.scene, cam); const url = r.domElement.toDataURL('image/jpeg', 0.9);
    St.scene.background = bg; hid.forEach(p => { p.obj.visible = true; });
    cam.position.copy(keep.pos); ctl.target.copy(keep.tgt); cam.aspect = keep.aspect; cam.layers.mask = keep.layers; cam.updateProjectionMatrix();
    r.setPixelRatio(pr); r.setSize(size.x, size.y, false); S.split = split; St.resize(); ctl.update();
    return url;
  }
  const loadImg = url => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });

  // ---------- page layout on canvas ----------
  function Doc(meta) {
    const pages = []; let g, y;
    function page() {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; g = cv.getContext('2d'); pages.push(cv);
      textLayer(cv, g);
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); y = M;
      g.fillStyle = C.muted; g.font = `22px ${FONT}`; g.textBaseline = 'alphabetic';
      g.fillText(`Yolmed · ${xt(meta.title)}`, M, 50); g.textAlign = 'right'; g.fillText(meta.version, W - M, 50); g.textAlign = 'left';
      g.strokeStyle = C.line; g.lineWidth = 2; g.beginPath(); g.moveTo(M, 64); g.lineTo(W - M, 64); g.stroke();
    }
    const room = h => { if (y + h > H - 110) page(); };
    function wrap(t, maxW, font) { g.font = font; const out = []; String(t).split('\n').forEach(par => { let line = ''; par.split(' ').forEach(w => { const tr = line ? line + ' ' + w : w; if (g.measureText(tr).width > maxW && line) { out.push(line); line = w; } else line = tr; }); out.push(line); }); return out; }
    function text(t, o = {}) {
      const size = o.size || 24, font = `${o.weight || 400} ${size}px ${o.mono ? MONO : FONT}`, lh = Math.round(size * 1.45), x = o.x || M, mw = o.w || W - M - x;
      const lines = wrap(xt(t), mw, font); room(lines.length * lh);
      g.font = font; g.fillStyle = o.color || C.ink; lines.forEach(l => { g.fillText(l, x, y + size); y += lh; }); y += o.after ?? 6;
    }
    function h2(t) { room(90); y += 18; g.fillStyle = C.accent; g.font = `600 30px ${FONT}`; g.fillText(xt(t), M, y + 30); y += 46; g.strokeStyle = C.line; g.beginPath(); g.moveTo(M, y); g.lineTo(W - M, y); g.stroke(); y += 14; }
    function table(head, rows, widths) {
      const rh = 40, x0 = M, tw = W - 2 * M, ws = widths.map(f => f * tw);
      const row = (cells, hd) => {
        room(rh); let x = x0;
        if (hd) { g.fillStyle = C.soft; g.fillRect(x0, y, tw, rh); }
        cells.forEach((c, i) => { g.font = `${hd ? 600 : 400} 21px ${hd || i === 0 ? FONT : MONO}`; g.fillStyle = hd ? C.muted : C.ink; let t = xt(c); while (g.measureText(t).width > ws[i] - 14 && t.length > 2) t = t.slice(0, -2) + '…'; g.fillText(t, x + 8, y + 27); x += ws[i]; });
        y += rh; g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + tw, y); g.stroke();
      };
      row(head, true); rows.forEach(r => row(r)); y += 14;
    }
    function images(list) {      // list: [{img, cap}] two per row
      const gap = 24, iw = (W - 2 * M - gap) / 2;
      for (let i = 0; i < list.length; i += 2) {
        const ih = list[i].img ? iw * list[i].img.height / list[i].img.width : iw * 0.64; room(ih + 50);
        list.slice(i, i + 2).forEach((it, k) => { const x = M + k * (iw + gap); if (it.img) g.drawImage(it.img, x, y, iw, ih); g.strokeStyle = C.line; g.strokeRect(x, y, iw, ih); g.fillStyle = C.muted; g.font = `20px ${FONT}`; g.fillText(xt(it.cap), x, y + ih + 28); });
        y += ih + 48;
      }
    }
    function status(label, cls) { label = xt(label); room(60); g.font = `600 24px ${FONT}`; const w = g.measureText(label).width + 40; g.fillStyle = cls === 'ok' ? '#e8f4ee' : '#fbf1e1'; g.fillRect(M, y, w, 46); g.fillStyle = cls === 'ok' ? C.ok : C.warn; g.fillText(label, M + 20, y + 31); y += 62; }
    function signature(rows) {
      room(220); y += 10;
      const cw = (W - 2 * M - 40) / 2;
      rows.forEach((r, i) => { const x = M + i * (cw + 40); g.fillStyle = C.muted; g.font = `600 22px ${FONT}`; g.fillText(xt(r.role), x, y + 24); g.fillStyle = C.ink; g.font = `22px ${FONT}`; g.fillText(r.name || xt('Ad Soyad: ________________'), x, y + 62); g.fillText(r.date || xt('Tarih: ____ / ____ / ________'), x, y + 100); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y + 170); g.lineTo(x + cw, y + 170); g.stroke(); g.fillStyle = C.muted; g.font = `20px ${FONT}`; g.fillText('İmza', x, y + 196); });
      y += 220;
    }
    page();
    return { keep: room, text, h2, table, images, status, signature, pages, get y() { return y; }, footer() {
      pages.forEach((cv, i) => { const c = cv.getContext('2d'); c.fillStyle = C.muted; c.font = `19px ${FONT}`; c.textAlign = 'left'; c.fillText(xt('Araştırma prototipi çıktısıdır; klinik kullanım için doğrulanmamıştır.'), M, H - 50); c.textAlign = 'right'; c.fillText(xt(`Sayfa ${i + 1} / ${pages.length}`), W - M, H - 50); c.textAlign = 'left'; });
    } };
  }

  // ---------- text layer: what fillText draws is kept with its place, size and drawn width ----------
  function textLayer(cv, g) {
    const fill = g.fillText, list = cv.textLayer = [];
    g.fillText = function (t, x, y, ...r) {
      t = String(t); fill.call(this, t, x, y, ...r);
      if (!t.trim() || !isFinite(x) || !isFinite(y)) return;   // (nothing was drawn either)
      const px = +(/(\d+(?:\.\d+)?)px/.exec(this.font) || [0, 20])[1], w = this.measureText(t).width;
      const x0 = this.textAlign === 'right' || this.textAlign === 'end' ? x - w : this.textAlign === 'center' ? x - w / 2 : x;
      list.push({ t, x: x0, y, px, w });
    };
  }
  // Windows-1254 (WinAnsi with Ğ İ Ş ğ ı ş in place of Ð Ý Þ ð ý þ) and the glyph names the font gets for those six
  const TR = { 0xD0: ['Ğ', 'Gbreve'], 0xDD: ['İ', 'Idotaccent'], 0xDE: ['Ş', 'Scedilla'], 0xF0: ['ğ', 'gbreve'], 0xFD: ['ı', 'dotlessi'], 0xFE: ['ş', 'scedilla'] };
  const CP = (() => {
    const hi = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0\0\0\0‘’“”•–—˜™š›œ\0\0Ÿ', m = new Map();
    for (let c = 32; c < 127; c++) m.set(String.fromCharCode(c), c);
    [...hi].forEach((ch, i) => { if (ch !== '\0') m.set(ch, 0x80 + i); });
    for (let c = 0xA0; c < 0x100; c++) m.set(TR[c] ? TR[c][0] : String.fromCharCode(c), c);
    return m;
  })();
  const UNI = new Map([...CP].map(([ch, c]) => [c, ch]));
  const NEAR = { '≤': '<=', '≥': '>=', '−': '-', '→': '->', '←': '<-', '≈': '~', '✓': 'v', '×': 'x', ' ': ' ' };
  function cp1254(t) {
    const out = [];
    for (const ch of String(t)) {
      if (CP.has(ch)) { out.push(CP.get(ch)); continue; }
      const alt = NEAR[ch] || ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (const a of (alt && [...alt].every(x => CP.has(x)) ? alt : '?')) out.push(CP.get(a));
    }
    return out;
  }
  // Helvetica advance widths (1/1000 em), ASCII 32–126; other letters by their nearest Latin shape
  const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const hw = c => c >= 32 && c < 127 ? HW[c - 32] : c === 0xFD || c === 0xDD ? 278 : c === 0x85 || c === 0x97 ? 1000 : c === 0xB0 ? 400 : c === 0xB7 ? 278 : c >= 0xC0 && c < 0xE0 ? 722 : 556;
  const pdfStr = bytes => '(' + bytes.map(c => c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : c >= 32 && c < 127 ? String.fromCharCode(c) : '\\' + c.toString(8).padStart(3, '0')).join('') + ')';
  const n2 = x => (Math.round(x * 100) / 100).toString();
  function textOps(list, sx, sy, ph) {
    let out = 'BT 3 Tr\n';
    list.forEach(o => {
      const b = cp1254(o.t), pt = o.px * sy, adv = b.reduce((a, c) => a + hw(c), 0) / 1000 * pt;
      const tz = adv > 0 ? Math.max(30, Math.min(300, 100 * o.w * sx / adv)) : 100;   // stretch to the drawn width: selection covers the picture's words
      out += `/F1 ${n2(pt)} Tf ${n2(tz)} Tz 1 0 0 1 ${n2(o.x * sx)} ${n2(ph - o.y * sy)} Tm ${pdfStr(b)} Tj\n`;
    });
    return out + 'ET';
  }
  function toUnicode() {
    const rows = [...UNI].filter(([c]) => c >= 32).map(([c, ch]) => `<${c.toString(16).toUpperCase().padStart(2, '0')}> <${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
    let body = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Yolmed-cp1254 def /CMapType 2 def\n1 begincodespacerange <00> <FF> endcodespacerange\n';
    for (let i = 0; i < rows.length; i += 100) { const r = rows.slice(i, i + 100); body += `${r.length} beginbfchar\n${r.join('\n')}\nendbfchar\n`; }
    return body + 'endcmap CMapName currentdict /CMap defineresource pop end end';
  }

  // ---------- minimal PDF: one JPEG image per A4 page, with its invisible text ----------
  function pdfOf(jpegs) {
    const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
    const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offs[n] = len; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const n = jpegs.length, pageIds = jpegs.map((_, i) => 3 + i * 3), fid = 3 + n * 3, tuid = fid + 1;
    obj(1, () => put('<< /Type /Catalog /Pages 2 0 R /Lang (tr-TR) >>'));
    obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] >>`));
    jpegs.forEach((j, i) => {
      const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2, pw = 595.28, ph = 841.89;
      obj(pid, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${iid} 0 R >> /Font << /F1 ${fid} 0 R >> >> /Contents ${cid} 0 R >>`));
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q` + (j.text && j.text.length ? '\n' + textOps(j.text, pw / j.w, ph / j.h, ph) : '');   // (ASCII only: /Length counts bytes)
      obj(cid, () => put(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
      obj(iid, () => { put(`<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`); put(j.bytes); put('\nendstream'); });
    });
    obj(fid, () => put(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${Object.entries(TR).map(([c, [, g]]) => `${c} /${g}`).join(' ')}] >> /ToUnicode ${tuid} 0 R >>`));
    const cm = toUnicode();
    obj(tuid, () => put(`<< /Length ${cm.length} >>\nstream\n${cm}\nendstream`));
    const xref = len, total = tuid + 1;
    put(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let k = 1; k < total; k++) put(String(offs[k]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  const jpegOf = cv => { const b = atob(cv.toDataURL('image/jpeg', 0.88).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return { bytes: u, w: cv.width, h: cv.height, text: cv.textLayer || [] }; };

  // ---------- assembly order from the plan ----------
  function assembly() {
    const out = [], R = S.result, seat = R && R.seat && R.seat.ok ? (R.seat.best.tilt ? `${R.seat.best.tilt}° eğik` : 'dik') : 'dik';
    const fib = window.Fibula && Fibula.active() ? Fibula.summary() : null, plate = window.Plate && Plate.summary ? Plate.summary() : null;
    const guides = S.g.split && S.planes.length >= 2 ? 2 : 1;
    out.push(guides > 1 ? xl(`Mandibula guide'larını (${guides}) kemiğe ${seat} yönde oturtun; oturmanın tam olduğunu kontrol edin.`) : xl(`Mandibula guide'ını kemiğe ${seat} yönde oturtun; oturmanın tam olduğunu kontrol edin.`));
    if (S.screws.length) out.push(`${xl("Vida yuvalarını sırayla delin ve guide'ı sabitleyin:")} ${S.screws.map((s, i) => xl(`Vida ${i + 1} (${fmt(s.d)} mm matkap, ${fmt(s.len, 0)} mm)`)).join(', ')}.`);
    if (S.planes.length) out.push(`${xl('Osteotomileri yuvalardan yapın:')} ${S.planes.map((p, i) => xl(`Kesi ${i + 1}`)).join(', ')} ${xl(`(yuva ${fmt(Math.max(...S.planes.map(p => p.w)))} mm).`)}`);
    out.push(xl('Guide\'ı çıkarın ve rezeke parçayı alın; parçayı rezeke model ile karşılaştırın.'));
    if (fib) {
      out.push(xl(`Fibula guide'ını bacağa oturtun ve vidalayın. Distal ${fmt(fib.distal_korunan_mm, 0)} mm korunur.`));
      out.push(`${xl('Fibula osteotomilerini yapın:')} ${fib.segmentler.map(g => xl(`segment ${g.no} ${fmt(g.boy_mm)} mm`)).join(', ')}.`);
      out.push(xl('Segmentleri numara sırasıyla defekte yerleştirin; rotasyonları plandaki gibi ayarlayın.'));
    }
    out.push(!plate ? xl('Rekonstrüksiyonu plakla sabitleyin.') : plate.guide_ile_eslesen ? xl(`Ön bükülmüş plağı (${plate.holes} delik) guide vida delikleriyle eşleşen ${plate.guide_ile_eslesen} delikten başlayarak sabitleyin.`) : xl(`Ön bükülmüş plağı (${plate.holes} delik) plandaki konumunda sabitleyin; guide vida delikleriyle eşleşen delik yok.`));
    return out;
  }

  // production STL state in one sentence (made on the server and sound, or only the 0.4 mm voxel preview)
  function prodLine(p, file) {
    if (!p) return `${xl("Üretim STL'i alınmadı; pakette yalnız 0,4 mm voksel önizleme var:")} ${file}_onizleme_BASMAYIN.stl. ${xl('Baskı için değildir.')}`;
    return `${xl("Üretim STL'i sunucuda yüzey tabanlı boolean ile üretildi")} (${file}_uretim.stl): ${xl(p.watertight ? 'su geçirmez' : 'su geçirmez değil')}, ${xl(`${p.bodies} parça`)}, ${fmt(p.volume / 1000, 2)} cm³${p.resolution ? xl(`, ızgara ${fmt(p.resolution, 2)} mm`) : ''}.${p.ok ? '' : ' ' + xl("Sunucu bu STL'i basılabilir bulmadı.")}${p.src && St.printLine ? St.printLine(p.src).replace(/<[^>]+>/g, '') : ''}`;
  }
  async function build() {
    const name = (window.CaseStore && CaseStore.caseName()) || ($('caseInfo').querySelector('dd') || {}).textContent || 'Vaka';
    const version = window.CaseStore ? CaseStore.versionLabel() : 'Taslak', when = window.DateFmt ? DateFmt.dateTime(Date.now()) : new Date().toLocaleString('tr-TR');   // dates.js: EN spells the month
    const miss = St.pendingList(), draft = miss.length || S.crit, surgeon = $('surgeon').value.trim();
    St.busy(true, 'Rapor görüntüleri hazırlanıyor…'); await St.sleep();
    const shots = [];
    if (S.anchor) {
      shots.push({ img: await loadImg(snapshot([0, -1, 0.15])), cap: 'Önden' });
      shots.push({ img: await loadImg(snapshot([-1, -0.25, 0.2])), cap: 'Sağdan' });
      shots.push({ img: await loadImg(snapshot([1, -0.25, 0.2])), cap: 'Soldan' });
      shots.push({ img: await loadImg(snapshot([0, -0.05, 1])), cap: 'Üstten' });
      const has = id => St.parts[id] && St.parts[id].visible, n = S.anchor.n;
      // close views of what the surgeon builds: the guide on the bone, the plate, the implants on the grafts
      if (has('guide')) shots.push({ img: await loadImg(snapshot([n.x, n.y, n.z], 1000, 640, 0, /^(guide|screw\d*)$/, 1.5)), cap: 'Guide yakın görünüm (kemiğe bakış)' });
      if (has('plate')) shots.push({ img: await loadImg(snapshot([n.x, n.y, n.z], 1000, 640, 0, /^plate$/, 1.15)), cap: 'Plak ve vida delikleri' });
      if (has('implants') && window.Fibula && Fibula.active() && Fibula.state().last) { const up = Fibula.state().last.D.vup; shots.push({ img: await loadImg(snapshot([up.x, up.y, up.z], 1000, 640, 0, /^implants$/, 2.2, /^(guide|screw|plate|lesion|resected)/)), cap: 'İmplantlar (oklüzal bakış)' }); }
      if (window.Fibula && Fibula.active()) { St.scene.traverse(o => { if (o.isLight) o.layers.enableAll(); }); shots.push({ img: await loadImg(snapshot([0, -1, 0.3], 1000, 640, 1)), cap: 'Fibula ve fibula guide\'ı' }); }
    }
    // CT slices through the resection centre and through each cut, with the plan drawn on them
    const slices = [];
    if (S.anchor && window.MPR && MPR.capture) {
      const at = (id, w, cap) => { const u = MPR.capture(id, w); if (u) slices.push({ url: u, cap }); };
      at('ax', S.anchor.p, 'Aksiyel · rezeksiyon merkezi'); at('co', S.anchor.p, 'Koronal · rezeksiyon merkezi'); at('sa', S.anchor.p, 'Sagittal · rezeksiyon merkezi');
      St.planesWorld().forEach((pw, i) => at('ax', pw.p, `Aksiyel · Kesi ${i + 1}`));
      for (const s of slices) s.img = await loadImg(s.url);
    }
    St.busy(true, 'Rapor sayfaları çiziliyor…'); await St.sleep();
    const d = Doc({ title: name, version });
    d.text('Hastaya özel cerrahi plan raporu', { size: 40, weight: 600, after: 4 });
    d.text(`${name} · ${when}`, { size: 24, color: C.muted, after: 14 });
    d.status(draft ? 'TASLAK' : 'ONAYLI PLAN', draft ? 'warn' : 'ok');
    d.text(`${xl('Sürüm:')} ${version}${surgeon ? ' · ' + xl('Onaylayan:') + ' ' + surgeon : ''}`, { size: 22 });
    if (draft) d.text(`${xl('Onay bekleyen:')} ${miss.map(xl).join(', ') || '–'}${S.crit ? ` · ${xl(`${S.crit} kritik kontrol`)}` : ''}`, { size: 22, color: C.warn });
    d.text(`${xl('Görüntü:')} ${St.caseLine()} · ${xl('Segmentasyon:')} ${S.segMethod || '–'}`, { size: 20, color: C.muted, after: St.swLine ? 4 : 10 });
    if (St.swLine) d.text(St.swLine(), { size: 18, color: C.muted, after: 10 });
    if (shots.length) { d.h2('Görünümler'); d.images(shots); }
    if (slices.length) { d.h2('BT kesitleri'); d.images(slices); }
    d.h2('Kesim tablosu');
    const sorted = S.planes.slice().sort((a, b) => a.off - b.off);
    d.table(['Kesi', 'Konum (eksen)', 'Yatay açı', 'Dikey açı', 'Yuva', 'Onay'], S.planes.map((p, i) => [`Kesi ${i + 1}`, `${fmt(p.off)} mm`, `${fmt(p.yaw)}°`, `${fmt(p.pitch)}°`, `${fmt(p.w)} mm`, p.ok ? (p.by || 'onaylı') : 'bekliyor']), [0.16, 0.2, 0.15, 0.15, 0.12, 0.22]);
    d.text(`${xl(`Rezeksiyon: lezyon ${fmt(S.lesion.from)} – ${fmt(S.lesion.to)} mm, güvenlik payı ${fmt(S.lesion.margin)} mm`)}${S.lesion.condyle ? xl(`, kondil dahil (${S.lesion.condyle === 'R' ? 'sağ' : 'sol'}) rezeksiyon`) : ''}${S.g.split ? xl(', iki ayrı guide') : ''}${!S.lesion.condyle && sorted.length >= 2 ? xl(`, kesiler arası ${fmt(sorted.at(-1).off - sorted[0].off)} mm`) : ''}${S.resectedVolume ? xl(`, rezeke hacim ${fmt(S.resectedVolume / 1000, 2)} cm³`) : ''}.`, { size: 22 });
    const P = S.prod && St.prodKey && S.prod.key === St.prodKey() ? S.prod : null;
    d.text(prodLine(P && { watertight: P.watertight, bodies: P.bodies, volume: P.volume, resolution: P.resolution || null, ok: P.productionOk !== false, src: P }, 'guide'), { size: 21, color: P && P.watertight && P.productionOk !== false ? C.ink : C.warn });
    if (S.screws.length) {
      d.h2('Vidalar');
      d.table(['Vida', 'Konum (eksen, yanal)', 'Eğim', 'Matkap / kovan', 'Boy', 'Kemikte'], S.screws.map((s, i) => { const si = S.result && S.result.screwInfo[i]; return [`Vida ${i + 1}`, `${fmt(s.u)}, ${fmt(s.v)} mm`, `${fmt(s.tiltU, 0)}°, ${fmt(s.tiltV, 0)}°`, `${fmt(s.d)} / ${fmt(s.D)} mm`, `${fmt(s.len, 0)} mm`, si && si.ok ? `${fmt(si.inBone)} mm` : '–']; }), [0.13, 0.24, 0.16, 0.19, 0.12, 0.16]);
    }
    const fib = window.Fibula && Fibula.active() ? Fibula.summary() : null;
    if (fib) {
      d.h2('Fibula segmentleri');
      d.table(['Segment', 'Boy', 'Distal uçtan', 'Uç açıları', 'Rotasyon'], fib.segmentler.map(g => [`Segment ${g.no}`, `${fmt(g.boy_mm)} mm`, `${fmt(g.distal_uctan_mm)} mm`, `${fmt(g.kesi_acilari_deg[0])}° / ${fmt(g.kesi_acilari_deg[1])}°`, `${g.rotasyon_deg}°`]), [0.2, 0.18, 0.2, 0.24, 0.18]);
      d.text(`${fib.fibula_serisi} · ${xl(`testere payı ${fmt(fib.testere_payi_mm)} mm · distal korunan ${fmt(fib.distal_korunan_mm, 0)} mm · proksimalde kalan ${fib.proksimalde_kalan_mm ?? '–'} mm · hattan sapma ${fmt(fib.sapma_mm, 2)} mm`)}`, { size: 21 });
      const fgr = Fibula.guideReport ? Fibula.guideReport() : null;
      if (fgr) {
        d.h2("Fibula guide'ı");
        if (fgr.stale) d.text("Fibula guide'ı güncelleniyor; rapor son üretilen guide'ı gösteriyor.", { size: 21, color: C.warn });
        d.table(['Uzunluk', 'Genişlik', 'Sarma', 'Duvar', 'Kemik boşluğu', 'Temas', 'Hacim'], [[`${fmt(fgr.L)} mm`, `${fmt(fgr.W)} mm`, `${fmt(fgr.wrap)} mm`, `${fmt(fgr.wall)} mm`, `${fmt(fgr.clear)} mm`, `${fmt(fgr.contact, 0)} mm²`, `${fmt(fgr.volume / 1000, 2)} cm³`]], [0.14, 0.14, 0.13, 0.13, 0.16, 0.15, 0.15]);
        if (fgr.screws.length) d.table(['Vida', 'Segment', 'Matkap / kovan', 'Boy', 'Kemikte'], fgr.screws.map(x => [`Vida ${x.no}`, `${x.seg}`, `${fmt(x.d)} / ${fmt(x.D)} mm`, `${fmt(x.len, 0)} mm`, x.inBone != null ? `${fmt(x.inBone)} mm` : '–']), [0.18, 0.16, 0.26, 0.18, 0.22]);
        d.text(prodLine(fgr.prod, 'fibula_guide'), { size: 21, color: fgr.prod && fgr.prod.watertight && fgr.prod.ok ? C.ink : C.warn });
      }
    }
    (window.ReportSections || []).forEach(f => { try { f(d, C); } catch (e) { /* optional section */ } });
    d.h2('Montaj sırası');
    assembly().forEach((t, i) => d.text(`${i + 1}. ${xt(t)}`, { size: 23 }));
    d.h2('Otomatik kontroller');
    const ck = S.checkList || [];
    if (!ck.length) d.text('Tüm kontroller geçti.', { size: 22, color: C.ok });
    ck.forEach(([c, t, m]) => d.text(`${xl(t)}: ${xt(m)}`, { size: 21, color: c === 'crit' ? C.crit : c === 'warn' ? C.warn : C.ink }));
    d.keep(330); d.h2('Onay');
    // names and dates from the plan approvals (Audit): the engineer who gave the technical approval is printed, not left blank
    const ap = r => { const s = window.Audit && Audit.status ? Audit.status(r) : null; return s && s.ok ? s.e : null; }, eng = ap('eng'), sur = ap('sur');
    const day = iso => (window.DateFmt ? DateFmt.dateTime(iso) : new Date(iso).toLocaleString('tr-TR'));
    d.signature([{ role: 'Cerrah', name: surgeon ? `${xl('Ad Soyad:')} ${surgeon}` : '', date: sur ? `${xl('Klinik onay:')} ${day(sur.at)}` : '' },
      { role: 'Biyomedikal mühendis', name: eng ? `${xl('Ad Soyad:')} ${eng.name}` : '', date: eng ? `${xl('Teknik onay:')} ${day(eng.at)}` : '' }]);
    d.footer();
    const blob = pdfOf(d.pages.map(jpegOf));
    St.busy(false);
    return blob;
  }
  async function download() {
    if (!S.anchor) return;
    try { const blob = await build(); await St.offer('cerrahi_rapor.pdf', blob); }
    catch (e) { St.busy(false); $('expMsg').textContent = 'PDF rapor oluşturulamadı: ' + e.message; }
  }
  $('expPdf').addEventListener('click', download);
  return { build, download, pdfOf };
})();
