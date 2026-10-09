/* Two-stage plan approval: the engineer's technical approval, then the surgeon's clinical approval, each with name,
   time and comment. Every approval, withdrawal and note is appended to a log kept in the plan; each entry carries
   the SHA-256 of the previous entry and of the plan content it refers to, so any later edit of the log or of the
   plan shows up (tamper-evident, not tamper-proof: whoever holds the file can rebuild a whole new chain; the last
   hash printed in the signed report is what anchors it). Undo never removes log entries. */
'use strict';
window.Audit = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus, esc } = St, $ = id => document.getElementById(id);
  const ROLE = { eng: 'Mühendis', sur: 'Cerrah' }, ACT = { onay: 'onay verdi', geri: 'onayı geri çekti', not: 'not ekledi' };
  const LABEL = { eng: 'Mühendis teknik onayı', sur: 'Cerrah klinik onayı' };
  let log = [], chain = { ok: true, bad: -1 }, engName = '', note = '';

  // ---------- SHA-256 (synchronous, so hashing never waits on crypto.subtle) ----------
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(str) {
    const msg = new TextEncoder().encode(str), l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(nb);
    b.set(msg); b[l] = 0x80; const dv = new DataView(b.buffer); dv.setUint32(nb - 4, l * 8 >>> 0); dv.setUint32(nb - 8, Math.floor(l / 0x20000000));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) { const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
  }

  // ---------- plan content hash: the design only (no approval stamps, approver names, log or measurements) ----------
  function canon(x) {
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).filter(k => !['ok', 'by', 'at', 'sig'].includes(k) && x[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
    return JSON.stringify(x === undefined ? null : x);
  }
  function planHash() {
    const p = St.planOf(); delete p.surgeon; delete p.measures; if (p.ext) delete p.ext.audit;
    return sha256(canon(p));
  }
  const entryHash = e => sha256([e.prev, e.n, e.at, e.role, e.name, e.action, e.comment, e.plan].join('|'));
  function verify() {
    chain = { ok: true, bad: -1 };
    for (let i = 0; i < log.length; i++) {
      const e = log[i], prev = i ? log[i - 1].hash : '0'.repeat(64);
      if (e.n !== i + 1 || e.prev !== prev || entryHash(e) !== e.hash) { chain = { ok: false, bad: i }; break; }
    }
    return chain.ok;
  }
  function append(role, action, name, comment) {
    const prev = log.length ? log[log.length - 1].hash : '0'.repeat(64);
    const e = { n: log.length + 1, at: new Date().toISOString(), role, name, action, comment: comment || '', plan: planHash(), prev };
    e.hash = entryHash(e); log.push(e); verify();
  }

  // a role's approval stands when its last approve/withdraw entry is an approval of the current plan content
  function status(role, cur) {
    const e = [...log].reverse().find(x => x.role === role && x.action !== 'not');
    if (!e || e.action !== 'onay') return { ok: false, state: 'none' };
    if (!chain.ok) return { ok: false, state: 'broken', e };
    return (cur || planHash()) === e.plan ? { ok: true, state: 'valid', e } : { ok: false, state: 'stale', e };
  }
  const others = () => St.pendingList().filter(x => x !== LABEL.eng && x !== LABEL.sur);
  const qcCrit = () => (S.qc || []).some(q => q[0] === 'crit');
  function can(role) {
    if (!S.result) return 'Guide üretilmeden onay verilemez.';
    if (S.crit || qcCrit()) return 'Kritik kontrol varken onay verilemez.';
    if (role === 'sur') {
      if (!status('eng').ok) return 'Önce mühendis teknik onayı gerekli.';
      const miss = others(); if (miss.length) return `Önce öğe onayları tamamlanmalı: ${miss.join(', ')}.`;
    }
    return '';
  }
  (window.PendingHooks = window.PendingHooks || []).push(() => {
    if (!S.anchor) return [];
    const h = planHash(), out = [];
    if (!status('eng', h).ok) out.push(LABEL.eng);
    if (!status('sur', h).ok) out.push(LABEL.sur);
    return out;
  });
  (window.ExtraChecks = window.ExtraChecks || []).push(() => chain.ok ? [] : [['crit', 'Kritik', `Onay kaydı zinciri ${chain.bad + 1}. kayıtta bozulmuş; kayıt sonradan değiştirilmiş olabilir. Onaylar geçersiz sayılır.`, 'data']]);

  // ---------- panel ----------
  const when = iso => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function stTxt(role, h) {
    const s = status(role, h);
    return s.state === 'valid' ? `<span class="tag ok">Onaylı</span> ${esc(s.e.name)} · ${esc(when(s.e.at))}` : s.state === 'stale' ? `<span class="tag warn">Plan değişti</span> ${esc(s.e.name)} onayından sonra plan değişti; yeniden onay gerekli.`
      : s.state === 'broken' ? '<span class="tag crit">Geçersiz</span> Kayıt zinciri bozuk.' : '<span class="tag">Bekliyor</span>';
  }
  function block(role, h) {
    const s = status(role, h), name = role === 'sur' ? $('surgeon').value.trim() : engName;
    return `<div class="audit-b"><b>${role === 'eng' ? '1. Mühendis (teknik) onayı' : '2. Cerrah (klinik) onayı'}</b><p class="hint">${stTxt(role, h)}</p>
      <div class="ctl"><label for="au_${role}_n" class="lbl2">${role === 'eng' ? 'Biyomedikal mühendis' : 'Cerrah'}</label><input id="au_${role}_n" type="text" placeholder="Ad Soyad" autocomplete="off" value="${esc(name)}"></div>
      <div class="ctl"><label for="au_${role}_c" class="lbl2">Yorum</label><textarea id="au_${role}_c" rows="2" placeholder="${role === 'eng' ? 'Üretilebilirlik, tolerans, malzeme' : 'Klinik değerlendirme'}"></textarea></div>
      <div class="btns">${s.ok ? `<button data-a="geri" data-r="${role}">Onayı geri çek</button>` : `<button class="primary" data-a="onay" data-r="${role}"><svg class="i"><use href="#i-check"/></svg>${role === 'eng' ? 'Teknik onay ver' : 'Klinik onay ver'}</button>`}<button data-a="not" data-r="${role}">Not ekle</button></div></div>`;
  }
  function render() {
    const box = $('auditBox'); if (!box) return;
    if (box.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!S.anchor) { box.innerHTML = ''; return; }
    const h = planHash(), lastH = log.length ? log[log.length - 1].hash : '';
    box.innerHTML = `<h3 class="sub">İki aşamalı plan onayı</h3>
      <p class="hint">Önce mühendis teknik onayı, sonra cerrah klinik onayı verilir. Planda sonradan yapılan her değişiklik iki onayı da geçersiz kılar. Üretim paketi iki onay da geçerliyken alınır.</p>
      ${block('eng', h)}${block('sur', h)}
      <p class="hint" id="auMsg">${esc(note)}</p>
      <details class="sub-d"><summary>Onay kaydı (${log.length})</summary>
        <p class="hint">${chain.ok ? `Zincir doğrulandı${log.length ? ` · son özet ${esc(String(lastH).slice(0, 16))}` : ''}.` : `<b style="color:var(--crit)">Zincir ${chain.bad + 1}. kayıtta bozuk.</b>`} Plan özeti ${h.slice(0, 16)}.</p>
        <ol class="aulog">${log.slice().reverse().map(e => `<li>${esc(when(e.at))} · ${esc(ROLE[e.role] || '')} ${esc(e.name)} ${esc(ACT[e.action] || '')}${e.comment ? `: “${esc(e.comment)}”` : ''}<small>#${Number(e.n) || 0} ${esc(String(e.hash || '').slice(0, 12))} · plan ${esc(String(e.plan || '').slice(0, 8))}</small></li>`).join('') || '<li>Kayıt yok.</li>'}</ol>
      </details>`;
    box.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act(b.dataset.r, b.dataset.a)));
    $('au_eng_n').addEventListener('input', e => { engName = e.target.value; });
    $('au_sur_n').addEventListener('input', e => { $('surgeon').value = e.target.value; $('surgeon').dispatchEvent(new Event('input')); });
  }
  function act(role, action) {
    const name = $(`au_${role}_n`).value.trim(), comment = $(`au_${role}_c`).value.trim(), msg = t => { note = t; $('auMsg').textContent = t; };
    note = '';
    if (!name) { msg('Önce adınızı yazın.'); $(`au_${role}_n`).focus(); return; }
    if (!chain.ok) { msg('Kayıt zinciri bozuk; yeni onay eklenemez. Planın kayıtlı bir checkpoint\'ini açın.'); return; }
    if (action === 'onay') { const why = can(role); if (why) { msg(why); return; } }
    if (action === 'not' && !comment) { msg('Not için yorum yazın.'); return; }
    if (role === 'eng') engName = name;
    append(role, action, name, comment);
    // withdrawing the technical approval withdraws the clinical one that rested on it
    if (role === 'eng' && action === 'geri' && status('sur').ok) append('sur', 'geri', $('surgeon').value.trim() || 'cerrah', 'Teknik onay geri çekildiği için');
    render(); St.renderAppr(); St.renderChecks(); St.emit('changed');
  }

  // ---------- report, export, plan ----------
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!S.anchor) return;
    const h = planHash();
    if (d.keep) d.keep(360); d.h2('İki aşamalı onay');
    d.table(['Aşama', 'Durum', 'Ad', 'Zaman'], ['eng', 'sur'].map(r => { const s = status(r, h); return [r === 'eng' ? 'Mühendis (teknik)' : 'Cerrah (klinik)', s.state === 'valid' ? 'Onaylı' : s.state === 'stale' ? 'Plan değişti' : s.state === 'broken' ? 'Geçersiz' : 'Bekliyor', s.e ? s.e.name : '–', s.e ? when(s.e.at) : '–']; }), [0.25, 0.2, 0.3, 0.25]);
    log.filter(e => e.comment).slice(-6).forEach(e => d.text(`${ROLE[e.role]} ${e.name} (${when(e.at)}): ${e.comment}`, { size: 20 }));
    d.text(`Plan özeti (SHA-256): ${h}`, { size: 18, mono: true, color: '#5b646e' });
    d.text(`Onay kaydı: ${log.length} kayıt, zincir ${chain.ok ? 'doğrulandı' : 'BOZUK'}${log.length ? `, son özet ${log[log.length - 1].hash}` : ''}`, { size: 18, mono: true, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { if (S.anchor) files.push({ name: 'onay_kaydi.json', data: JSON.stringify({ plan_ozeti: planHash(), zincir_dogru: chain.ok, kayitlar: log }, null, 2) }); });
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y), isPrefix = (a, b) => a.length <= b.length && a.every((e, i) => same(e, b[i]));
  (window.PlanExt = window.PlanExt || {}).audit = {
    label: 'Onay kaydı',
    get: () => (log.length ? { log: log.map(e => Object.assign({}, e)) } : null),
    // undo and redo bring back older plans; the log only grows, so a shorter copy of the same chain is ignored
    set(x) { const inc = x && Array.isArray(x.log) ? x.log.map(e => Object.assign({}, e)) : []; if (!(log.length && isPrefix(inc, log))) log = inc; verify(); render(); },
  };
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { log = []; chain = { ok: true, bad: -1 }; render(); } });
  let t = null;
  ['changed', 'parts', 'planApplied'].forEach(ev => bus.addEventListener(ev, () => { clearTimeout(t); t = setTimeout(render, 200); }));
  render();
  return { log: () => log, verify, planHash, status, sha256, chain: () => chain };
})();
