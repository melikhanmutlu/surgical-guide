/* Surgical PDF report, drawn page by page on a canvas (so Turkish text needs no embedded PDF font) and packed into a
   PDF of JPEG pages by a small writer below. Contents: case and version, 3D views, cut table, screws, fibula segments,
   assembly order, automatic checks, and signature fields for the surgeon and the engineer. */
'use strict';
window.Report = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt } = St, $ = id => document.getElementById(id);
  const W = 1240, H = 1754, M = 90, FONT = '"IBM Plex Sans", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
  const C = { ink: '#14181c', muted: '#5b646e', line: '#d5dadf', accent: '#0b6782', ok: '#1d7a50', warn: '#9a5a00', crit: '#b42318', soft: '#f3f5f7' };

  // ---------- 3D snapshots from fixed directions ----------
  function snapshot(dir, w = 1000, h = 640, layer = 0) {
    const r = St.renderer, cam = St.camera, ctl = St.controls, keep = { pos: cam.position.clone(), tgt: ctl.target.clone(), aspect: cam.aspect, layers: cam.layers.mask };
    const size = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio(), split = S.split;
    S.split = false; r.setPixelRatio(1); r.setSize(w, h, false); cam.aspect = w / h; cam.layers.set(layer);
    const objs = layer === 0 ? Object.values(St.parts).filter(p => p.visible && /^(bone|guide|resected|screw|plate)/.test(p.id)).map(p => p.obj) : [];
    const box = new THREE.Box3(); objs.forEach(o => box.expandByObject(o));
    if (layer === 1) St.scene.traverse(o => { if (o.isMesh && o.layers.mask === 2 && (o.userData.guide || o.userData.disc)) box.expandByObject(o); });
    if (!box.isEmpty()) {
      const c = box.getCenter(V()), rad = box.getSize(V()).length() / 2, d = V(...dir).normalize();
      const vf = THREE.MathUtils.degToRad(cam.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
      ctl.target.copy(c); cam.position.copy(c).add(d.multiplyScalar(rad / Math.sin(Math.min(vf, hf) / 2) * 1.02));
    }
    cam.updateProjectionMatrix(); cam.lookAt(ctl.target);
    const bg = St.scene.background; St.scene.background = new THREE.Color(0xeef1f4);
    r.render(St.scene, cam); const url = r.domElement.toDataURL('image/jpeg', 0.9);
    St.scene.background = bg;
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
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); y = M;
      g.fillStyle = C.muted; g.font = `22px ${FONT}`; g.textBaseline = 'alphabetic';
      g.fillText(`Yolmed · ${meta.title}`, M, 50); g.textAlign = 'right'; g.fillText(meta.version, W - M, 50); g.textAlign = 'left';
      g.strokeStyle = C.line; g.lineWidth = 2; g.beginPath(); g.moveTo(M, 64); g.lineTo(W - M, 64); g.stroke();
    }
    const room = h => { if (y + h > H - 110) page(); };
    function wrap(t, maxW, font) { g.font = font; const out = []; String(t).split('\n').forEach(par => { let line = ''; par.split(' ').forEach(w => { const tr = line ? line + ' ' + w : w; if (g.measureText(tr).width > maxW && line) { out.push(line); line = w; } else line = tr; }); out.push(line); }); return out; }
    function text(t, o = {}) {
      const size = o.size || 24, font = `${o.weight || 400} ${size}px ${o.mono ? MONO : FONT}`, lh = Math.round(size * 1.45), x = o.x || M, mw = o.w || W - M - x;
      const lines = wrap(t, mw, font); room(lines.length * lh);
      g.font = font; g.fillStyle = o.color || C.ink; lines.forEach(l => { g.fillText(l, x, y + size); y += lh; }); y += o.after ?? 6;
    }
    function h2(t) { room(90); y += 18; g.fillStyle = C.accent; g.font = `600 30px ${FONT}`; g.fillText(t, M, y + 30); y += 46; g.strokeStyle = C.line; g.beginPath(); g.moveTo(M, y); g.lineTo(W - M, y); g.stroke(); y += 14; }
    function table(head, rows, widths) {
      const rh = 40, x0 = M, tw = W - 2 * M, ws = widths.map(f => f * tw);
      const row = (cells, hd) => {
        room(rh); let x = x0;
        if (hd) { g.fillStyle = C.soft; g.fillRect(x0, y, tw, rh); }
        cells.forEach((c, i) => { g.font = `${hd ? 600 : 400} 21px ${hd || i === 0 ? FONT : MONO}`; g.fillStyle = hd ? C.muted : C.ink; let t = String(c); while (g.measureText(t).width > ws[i] - 14 && t.length > 2) t = t.slice(0, -2) + '…'; g.fillText(t, x + 8, y + 27); x += ws[i]; });
        y += rh; g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + tw, y); g.stroke();
      };
      row(head, true); rows.forEach(r => row(r)); y += 14;
    }
    function images(list) {      // list: [{img, cap}] two per row
      const gap = 24, iw = (W - 2 * M - gap) / 2;
      for (let i = 0; i < list.length; i += 2) {
        const ih = list[i].img ? iw * list[i].img.height / list[i].img.width : iw * 0.64; room(ih + 50);
        list.slice(i, i + 2).forEach((it, k) => { const x = M + k * (iw + gap); if (it.img) g.drawImage(it.img, x, y, iw, ih); g.strokeStyle = C.line; g.strokeRect(x, y, iw, ih); g.fillStyle = C.muted; g.font = `20px ${FONT}`; g.fillText(it.cap, x, y + ih + 28); });
        y += ih + 48;
      }
    }
    function status(label, cls) { room(60); g.font = `600 24px ${FONT}`; const w = g.measureText(label).width + 40; g.fillStyle = cls === 'ok' ? '#e8f4ee' : '#fbf1e1'; g.fillRect(M, y, w, 46); g.fillStyle = cls === 'ok' ? C.ok : C.warn; g.fillText(label, M + 20, y + 31); y += 62; }
    function signature(rows) {
      room(220); y += 10;
      const cw = (W - 2 * M - 40) / 2;
      rows.forEach((r, i) => { const x = M + i * (cw + 40); g.fillStyle = C.muted; g.font = `600 22px ${FONT}`; g.fillText(r.role, x, y + 24); g.fillStyle = C.ink; g.font = `22px ${FONT}`; g.fillText(r.name || 'Ad Soyad: ________________', x, y + 62); g.fillText(r.date || 'Tarih: ____ / ____ / ________', x, y + 100); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y + 170); g.lineTo(x + cw, y + 170); g.stroke(); g.fillStyle = C.muted; g.font = `20px ${FONT}`; g.fillText('İmza', x, y + 196); });
      y += 220;
    }
    page();
    return { keep: room, text, h2, table, images, status, signature, pages, get y() { return y; }, footer() {
      pages.forEach((cv, i) => { const c = cv.getContext('2d'); c.fillStyle = C.muted; c.font = `19px ${FONT}`; c.textAlign = 'left'; c.fillText('Araştırma prototipi çıktısıdır; klinik kullanım için doğrulanmamıştır.', M, H - 50); c.textAlign = 'right'; c.fillText(`Sayfa ${i + 1} / ${pages.length}`, W - M, H - 50); c.textAlign = 'left'; });
    } };
  }

  // ---------- minimal PDF: one JPEG image per A4 page ----------
  function pdfOf(jpegs) {
    const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
    const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offs[n] = len; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const n = jpegs.length, pageIds = jpegs.map((_, i) => 3 + i * 3);
    obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] >>`));
    jpegs.forEach((j, i) => {
      const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2, pw = 595.28, ph = 841.89;
      obj(pid, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`));
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
      obj(cid, () => put(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
      obj(iid, () => { put(`<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`); put(j.bytes); put('\nendstream'); });
    });
    const xref = len, total = 3 + n * 3;
    put(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let k = 1; k < total; k++) put(String(offs[k]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  const jpegOf = cv => { const b = atob(cv.toDataURL('image/jpeg', 0.88).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return { bytes: u, w: cv.width, h: cv.height }; };

  // ---------- assembly order from the plan ----------
  function assembly() {
    const out = [], R = S.result, seat = R && R.seat && R.seat.ok ? (R.seat.best.tilt ? `${R.seat.best.tilt}° eğik` : 'dik') : 'dik';
    const fib = window.Fibula && Fibula.active() ? Fibula.summary() : null, plate = window.Plate && Plate.summary ? Plate.summary() : null;
    const guides = S.g.split && S.planes.length >= 2 ? 2 : 1;
    out.push(`Mandibula guide${guides > 1 ? `'larını (${guides})` : "'ını"} kemiğe ${seat} yönde oturtun; oturmanın tam olduğunu kontrol edin.`);
    if (S.screws.length) out.push(`Vida yuvalarını sırayla delin ve guide'ı sabitleyin: ${S.screws.map((s, i) => `Vida ${i + 1} (${fmt(s.d)} mm matkap, ${fmt(s.len, 0)} mm)`).join(', ')}.`);
    if (S.planes.length) out.push(`Osteotomileri yuvalardan yapın: ${S.planes.map((p, i) => `Kesi ${i + 1}`).join(', ')} (yuva ${fmt(Math.max(...S.planes.map(p => p.w)))} mm).`);
    out.push('Guide\'ı çıkarın ve rezeke parçayı alın; parçayı rezeke model ile karşılaştırın.');
    if (fib) {
      out.push(`Fibula guide'ını bacağa oturtun ve vidalayın. Distal ${fmt(fib.distal_korunan_mm, 0)} mm korunur.`);
      out.push(`Fibula osteotomilerini yapın: ${fib.segmentler.map(g => `segment ${g.no} ${fmt(g.boy_mm)} mm`).join(', ')}.`);
      out.push('Segmentleri numara sırasıyla defekte yerleştirin; rotasyonları plandaki gibi ayarlayın.');
    }
    out.push(!plate ? 'Rekonstrüksiyonu plakla sabitleyin.' : plate.guide_ile_eslesen ? `Ön bükülmüş plağı (${plate.holes} delik) guide vida delikleriyle eşleşen ${plate.guide_ile_eslesen} delikten başlayarak sabitleyin.` : `Ön bükülmüş plağı (${plate.holes} delik) plandaki konumunda sabitleyin; guide vida delikleriyle eşleşen delik yok.`);
    return out;
  }

  async function build() {
    const name = (window.CaseStore && CaseStore.caseName()) || ($('caseInfo').querySelector('dd') || {}).textContent || 'Vaka';
    const version = window.CaseStore ? CaseStore.versionLabel() : 'Taslak', when = new Date().toLocaleString('tr-TR');
    const miss = St.pendingList(), draft = miss.length || S.crit, surgeon = $('surgeon').value.trim();
    St.busy(true, 'Rapor görüntüleri hazırlanıyor…'); await St.sleep();
    const shots = [];
    if (S.anchor) {
      shots.push({ img: await loadImg(snapshot([0, -1, 0.15])), cap: 'Önden' });
      shots.push({ img: await loadImg(snapshot([-1, -0.25, 0.2])), cap: 'Sağdan' });
      shots.push({ img: await loadImg(snapshot([1, -0.25, 0.2])), cap: 'Soldan' });
      shots.push({ img: await loadImg(snapshot([0, -0.05, 1])), cap: 'Üstten' });
      if (window.Fibula && Fibula.active()) { St.scene.traverse(o => { if (o.isLight) o.layers.enableAll(); }); shots.push({ img: await loadImg(snapshot([0, -1, 0.3], 1000, 640, 1)), cap: 'Fibula ve fibula guide\'ı' }); }
    }
    St.busy(true, 'Rapor sayfaları çiziliyor…'); await St.sleep();
    const d = Doc({ title: name, version });
    d.text('Hastaya özel cerrahi plan raporu', { size: 40, weight: 600, after: 4 });
    d.text(`${name} · ${when}`, { size: 24, color: C.muted, after: 14 });
    d.status(draft ? 'TASLAK' : 'ONAYLI PLAN', draft ? 'warn' : 'ok');
    d.text(`Sürüm: ${version}${surgeon ? ' · Onaylayan: ' + surgeon : ''}`, { size: 22 });
    if (draft) d.text(`Onay bekleyen: ${miss.join(', ') || '–'}${S.crit ? ` · ${S.crit} kritik kontrol` : ''}`, { size: 22, color: C.warn });
    d.text(`Görüntü: ${St.caseLine()} · Segmentasyon: ${S.segMethod || '–'}`, { size: 20, color: C.muted, after: 10 });
    if (shots.length) { d.h2('Görünümler'); d.images(shots); }
    d.h2('Kesim tablosu');
    const sorted = S.planes.slice().sort((a, b) => a.off - b.off);
    d.table(['Kesi', 'Konum (eksen)', 'Yatay açı', 'Dikey açı', 'Yuva', 'Onay'], S.planes.map((p, i) => [`Kesi ${i + 1}`, `${fmt(p.off)} mm`, `${fmt(p.yaw)}°`, `${fmt(p.pitch)}°`, `${fmt(p.w)} mm`, p.ok ? (p.by || 'onaylı') : 'bekliyor']), [0.16, 0.2, 0.15, 0.15, 0.12, 0.22]);
    d.text(`Rezeksiyon: lezyon ${fmt(S.lesion.from)} – ${fmt(S.lesion.to)} mm, güvenlik payı ${fmt(S.lesion.margin)} mm${S.lesion.condyle ? `, kondil dahil (${S.lesion.condyle === 'R' ? 'sağ' : 'sol'}) rezeksiyon` : ''}${S.g.split ? ', iki ayrı guide' : ''}${!S.lesion.condyle && sorted.length >= 2 ? `, kesiler arası ${fmt(sorted.at(-1).off - sorted[0].off)} mm` : ''}${S.resectedVolume ? `, rezeke hacim ${fmt(S.resectedVolume / 1000, 2)} cm³` : ''}.`, { size: 22 });
    if (S.screws.length) {
      d.h2('Vidalar');
      d.table(['Vida', 'Konum (eksen, yanal)', 'Eğim', 'Matkap / kovan', 'Boy', 'Kemikte'], S.screws.map((s, i) => { const si = S.result && S.result.screwInfo[i]; return [`Vida ${i + 1}`, `${fmt(s.u)}, ${fmt(s.v)} mm`, `${fmt(s.tiltU, 0)}°, ${fmt(s.tiltV, 0)}°`, `${fmt(s.d)} / ${fmt(s.D)} mm`, `${fmt(s.len, 0)} mm`, si && si.ok ? `${fmt(si.inBone)} mm` : '–']; }), [0.13, 0.24, 0.16, 0.19, 0.12, 0.16]);
    }
    const fib = window.Fibula && Fibula.active() ? Fibula.summary() : null;
    if (fib) {
      d.h2('Fibula segmentleri');
      d.table(['Segment', 'Boy', 'Distal uçtan', 'Uç açıları', 'Rotasyon'], fib.segmentler.map(g => [`Segment ${g.no}`, `${fmt(g.boy_mm)} mm`, `${fmt(g.distal_uctan_mm)} mm`, `${fmt(g.kesi_acilari_deg[0])}° / ${fmt(g.kesi_acilari_deg[1])}°`, `${g.rotasyon_deg}°`]), [0.2, 0.18, 0.2, 0.24, 0.18]);
      d.text(`${fib.fibula_serisi} · testere payı ${fmt(fib.testere_payi_mm)} mm · distal korunan ${fmt(fib.distal_korunan_mm, 0)} mm · proksimalde kalan ${fib.proksimalde_kalan_mm ?? '–'} mm · hattan sapma ${fmt(fib.sapma_mm, 2)} mm`, { size: 21 });
    }
    (window.ReportSections || []).forEach(f => { try { f(d, C); } catch (e) { /* optional section */ } });
    d.h2('Montaj sırası');
    assembly().forEach((t, i) => d.text(`${i + 1}. ${t}`, { size: 23 }));
    d.h2('Otomatik kontroller');
    const ck = S.checkList || [];
    if (!ck.length) d.text('Tüm kontroller geçti.', { size: 22, color: C.ok });
    ck.forEach(([c, t, m]) => d.text(`${t}: ${m}`, { size: 21, color: c === 'crit' ? C.crit : c === 'warn' ? C.warn : C.ink }));
    d.keep(330); d.h2('Onay');
    d.signature([{ role: 'Cerrah', name: surgeon ? `Ad Soyad: ${surgeon}` : '' }, { role: 'Biyomedikal mühendis' }]);
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
