/* Two-stage plan approval: the engineer's technical approval, then the surgeon's clinical approval, each with name,
   time and comment. Every approval, withdrawal and note is appended to a log kept in the plan; each entry carries
   the SHA-256 of the previous entry and of the plan content it refers to, so any later edit of the log or of the
   plan shows up (tamper-evident, not tamper-proof: whoever holds the file can rebuild a whole new chain; the last
   hash printed in the signed report is what anchors it). Undo never removes log entries. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Audit = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus, esc } = St, $ = id => document.getElementById(id);
  const ROLE = { eng: 'Mühendis', sur: 'Cerrah' }, ACT = { onay: 'onay verdi', geri: 'onayı geri çekti', not: 'not ekledi' };
  const LABEL = { eng: 'Mühendis teknik onayı', sur: 'Cerrah klinik onayı' };
  let log = [], chain = { ok: true, bad: -1 }, engName = '', note = '';
  // the engineer's name is kept on this computer, so it is typed once (the approval itself is still given per plan)
  try { engName = localStorage.getItem('yolmed.engName') || ''; } catch (e) { /* private window */ }
  const keepEng = n => { engName = n; try { localStorage.setItem('yolmed.engName', n); } catch (e) { /* private window */ } };
  // W21: roles whose approval was already stale when the plan was opened. The plan hash covers every field of planOf(),
  // so a plan approved in an older version (before a setting was added) or changed outside the app no longer matches.
  // Nothing is migrated: which fields were added cannot be told apart from an edit, so the approval is never carried
  // over; the user is told why and that both approvals must be given again.
  let staleOnOpen = new Set(), checkOnApply = false;
  // a plan to approve: a mandible plan (its guide frame) or an ankle reduction (ankle.js)
  const planned = () => !!S.anchor || !!(window.Ankle && Ankle.planned());

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
    const p = St.planOf();
    // the frame's unit vectors are hashed to 1e-3 as before (plan files keep them at full precision, web/app.js planOf)
    if (p.anchor) ['n', 'axis'].forEach(k => { if (p.anchor[k]) p.anchor[k] = p.anchor[k].map(x => Math.round(x * 1000) / 1000); });
    if (p.anchor && p.anchor.base && p.anchor.base.n) p.anchor.base.n = p.anchor.base.n.map(x => Math.round(x * 1000) / 1000);
    delete p.surgeon; delete p.measures; delete p.software; if (p.ext) { delete p.ext.audit; delete p.ext.names; }   // (a new software version or a layer renamed does not undo an approval)
    const t = canon(p); if (t !== hashMemo.t) hashMemo = { t, h: sha256(t) };   // (asked many times per edit for the same plan)
    return hashMemo.h;
  }
  let hashMemo = { t: null, h: null };
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
    if (!S.result && !(window.Ankle && Ankle.planned())) return 'Guide üretilmeden onay verilemez.';
    if (S.crit || qcCrit()) return 'Kritik kontrol varken onay verilemez.';
    if (role === 'sur') {
      if (!status('eng').ok) return 'Önce mühendis teknik onayı gerekli.';
      const miss = others(); if (miss.length) return xl('Önce öğe onayları tamamlanmalı:') + ' ' + miss.map(xl).join(', ') + '.';
    }
    return '';
  }
  (window.PendingHooks = window.PendingHooks || []).push(() => {
    if (!planned()) return [];
    const h = planHash(), out = [];
    if (!status('eng', h).ok) out.push(LABEL.eng);
    if (!status('sur', h).ok) out.push(LABEL.sur);
    return out;
  });
  (window.ExtraChecks = window.ExtraChecks || []).push(() => chain.ok ? [] : [['crit', 'Kritik', `Onay kaydı zinciri ${chain.bad + 1}. kayıtta bozulmuş; kayıt sonradan değiştirilmiş olabilir. Onaylar geçersiz sayılır.`, 'data']]);

  // ---------- panel ----------
  // English spells the month out: 10/14 vs 14.10 must not be guessed on an approval record
  const when = iso => (window.DateFmt ? DateFmt.dateTime(iso) : new Date(iso).toLocaleString('tr-TR'));   // dates.js
  function stTxt(role, h) {
    const s = status(role, h);
    return s.state === 'valid' ? `<span class="tag ok">Onaylı</span> ${esc(s.e.name)} · ${esc(when(s.e.at))}`
      : s.state === 'stale' && staleOnOpen.has(role) ? `<span class="tag warn">Plan değişti</span> ${esc(s.e.name)} ${xl('onayı plan açılırken eşleşmedi: plan onaydan sonra değiştirilmiş ya da uygulamanın eski bir sürümünde onaylanmış (yeni sürüm plana yeni ayarlar ekler). Onaylar aktarılmaz; planı inceleyip yeniden onaylayın.')}`
      : s.state === 'stale' ? `<span class="tag warn">Plan değişti</span> ${esc(s.e.name)} ${xl('onayından sonra plan değişti; yeniden onay gerekli.')}`
      : s.state === 'broken' ? '<span class="tag crit">Geçersiz</span> Kayıt zinciri bozuk.' : '<span class="tag">Bekliyor</span>';
  }
  function block(role, h) {
    const s = status(role, h), name = role === 'sur' ? $('surgeon').value.trim() : engName;
    return `<div class="audit-b"><b>${role === 'eng' ? '1 · Teknik onay (mühendis)' : '2 · Klinik onay (cerrah)'}</b><p class="hint">${stTxt(role, h)}</p>
      ${role === 'eng' ? `<div class="ctl"><label for="au_eng_n" class="lbl2">Mühendis</label><input id="au_eng_n" type="text" placeholder="Ad Soyad" autocomplete="off" value="${esc(name)}"></div>` : `<p class="hint">Cerrah: ${name ? `<b>${esc(name)}</b>` : 'adı girilmedi (adımın başında)'}</p>`}
      <div class="ctl"><label for="au_${role}_c" class="lbl2">Yorum</label><textarea id="au_${role}_c" rows="2" placeholder="${role === 'eng' ? 'Üretilebilirlik, tolerans, malzeme' : 'Klinik değerlendirme'}"></textarea></div>
      <div class="btns">${s.ok ? `<button data-a="geri" data-r="${role}">Onayı geri çek</button>` : `<button class="primary" data-a="onay" data-r="${role}"><svg class="i"><use href="#i-check"/></svg>${role === 'eng' ? 'Teknik onay ver' : 'Klinik onay ver'}</button>`}<button data-a="not" data-r="${role}">Not ekle</button></div></div>`;
  }
  function render() {
    const box = $('auditBox'); if (!box) return;
    if (box.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!planned()) { box.innerHTML = ''; return; }
    const h = planHash(), lastH = log.length ? log[log.length - 1].hash : '';
    box.innerHTML = `<h3 class="sub">Plan onayı</h3>
      <p class="hint more">Önce mühendis teknik onayı, sonra cerrah klinik onayı verilir. Planda sonradan yapılan her değişiklik iki onayı da geçersiz kılar. Üretim paketi iki onay da geçerliyken alınır.</p>
      ${block('eng', h)}${block('sur', h)}
      <p class="hint" id="auMsg">${esc(note)}</p>
      <details class="sub-d"><summary>Onay geçmişi (${log.length})</summary>
        <p class="hint">${chain.ok ? `${xl('Zincir doğrulandı')}${log.length ? ` · <span>${esc(String(lastH).slice(0, 8))}</span>` : ''}` : `<b style="color:var(--crit)">Zincir ${chain.bad + 1}. kayıtta bozuk.</b>`} · plan <span>${h.slice(0, 8)}</span></p>
        <ol class="aulog">${log.slice().reverse().map(e => `<li>${esc(when(e.at))} · ${esc(ROLE[e.role] || '')} ${esc(e.name)} ${esc(ACT[e.action] || '')}${e.comment ? `: “${esc(e.comment)}”` : ''}<small>#${Number(e.n) || 0} ${esc(String(e.hash || '').slice(0, 12))} · plan ${esc(String(e.plan || '').slice(0, 8))}</small></li>`).join('') || '<li>Kayıt yok.</li>'}</ol>
      </details>`;
    box.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act(b.dataset.r, b.dataset.a)));
    $('au_eng_n').addEventListener('input', e => keepEng(e.target.value));
  }
  function act(role, action) {
    const nameEl = role === 'sur' ? $('surgeon') : $('au_eng_n'), name = nameEl.value.trim(), comment = $(`au_${role}_c`).value.trim(), msg = t => { note = t; $('auMsg').textContent = t; };
    note = '';
    if (!name) { msg('Önce adınızı yazın.'); nameEl.focus(); return; }
    if (!chain.ok) { msg('Kayıt zinciri bozuk; yeni onay eklenemez. Planın kayıtlı bir sürümünü açın.'); return; }
    if (action === 'onay') { const why = can(role); if (why) { msg(why); return; } }
    if (action === 'not' && !comment) { msg('Not için yorum yazın.'); return; }
    if (role === 'eng') keepEng(name);
    if (action !== 'not') staleOnOpen.delete(role);
    append(role, action, name, comment);
    // withdrawing the technical approval withdraws the clinical one that rested on it
    if (role === 'eng' && action === 'geri' && status('sur').ok) append('sur', 'geri', $('surgeon').value.trim() || 'cerrah', 'Teknik onay geri çekildiği için');
    render(); St.renderAppr(); St.renderChecks(); St.emit('changed');
  }

  // ---------- report, export, plan ----------
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!planned()) return;
    const h = planHash();
    if (d.keep) d.keep(360); d.h2('İki aşamalı onay');
    d.table(['Aşama', 'Durum', 'Ad', 'Zaman'], ['eng', 'sur'].map(r => { const s = status(r, h); return [r === 'eng' ? 'Mühendis (teknik)' : 'Cerrah (klinik)', s.state === 'valid' ? 'Onaylı' : s.state === 'stale' ? 'Plan değişti' : s.state === 'broken' ? 'Geçersiz' : 'Bekliyor', s.e ? s.e.name : '–', s.e ? when(s.e.at) : '–']; }), [0.25, 0.2, 0.3, 0.25]);
    log.filter(e => e.comment).slice(-6).forEach(e => d.text(`${ROLE[e.role]} ${e.name} (${when(e.at)}): ${e.comment}`, { size: 20 }));
    d.text(`Plan özeti (SHA-256): ${h}`, { size: 18, mono: true, color: '#5b646e' });
    d.text(xl(`Onay kaydı: ${log.length} kayıt, zincir ${chain.ok ? 'doğrulandı' : 'BOZUK'}`) + (log.length ? `, ${xl('son özet')} ${log[log.length - 1].hash}` : ''), { size: 18, mono: true, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { if (planned()) files.push({ name: 'onay_kaydi.json', data: JSON.stringify(Object.assign({ plan_ozeti: planHash(), zincir_dogru: chain.ok, kayitlar: log }, St.prodRecord && St.prodRecord() ? { uretim_dosyalari: St.prodRecord() } : {}), null, 2) }); });
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y), isPrefix = (a, b) => a.length <= b.length && a.every((e, i) => same(e, b[i]));
  (window.PlanExt = window.PlanExt || {}).audit = {
    label: 'Onay kaydı',
    get: () => (log.length ? { log: log.map(e => Object.assign({}, e)) } : null),
    // undo and redo bring back older plans; the log only grows, so a shorter copy of the same chain is ignored
    // a log that replaces the current one is an opened plan (file, saved case, version): its approvals are checked once
    // the whole plan is in place (planApplied)
    set(x) { const inc = x && Array.isArray(x.log) ? x.log.map(e => Object.assign({}, e)) : []; if (!(log.length && isPrefix(inc, log))) { log = inc; staleOnOpen = new Set(); checkOnApply = log.length > 0; } verify(); render(); },
  };
  bus.addEventListener('planApplied', () => {
    if (!checkOnApply) return; checkOnApply = false;
    const h = planHash(), st = ['eng', 'sur'].filter(r => status(r, h).state === 'stale');
    staleOnOpen = new Set(st);
    if (st.length) { note = 'Kayıtlı onaylar bu planla eşleşmiyor; iki onayı yeniden verin.'; const t = $('toast'), was = t && !t.hidden ? t.textContent : '';   // keep the item-approval notice of the same opening
      St.alertMsg((was ? was + ' ' : '') + xl(`Plan dosyasındaki ${st.length} plan onayı (mühendis / cerrah) açılan planla eşleşmiyor: plan onaydan sonra değiştirilmiş ya da uygulamanın eski bir sürümünde onaylanmış. Onaylar aktarılmaz; planı inceleyip yeniden onaylayın.`)); render(); }
  });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { log = []; chain = { ok: true, bad: -1 }; staleOnOpen = new Set(); render(); } });
  let t = null;
  ['changed', 'parts', 'planApplied'].forEach(ev => bus.addEventListener(ev, () => { clearTimeout(t); t = setTimeout(render, 200); }));
  render();
  // a note written by another part of the studio (C5: an item approved in spite of a warning); never on a broken chain
  function noteBy(role, name, comment) { if (!chain.ok || !name || !comment) return false; append(role, 'not', name, comment); render(); return true; }
  return { log: () => log, verify, planHash, status, sha256, chain: () => chain, staleOnOpen: () => [...staleOnOpen], note: noteBy };
})();
