/* Long resections: two guides joined by a connecting bar (plan-4 A1, A2).
   app.js proposes the layout (fitWrap: lesion >= LONG_MM mm, the straight axis leaving the bone, a ramus segment) and
   builds the bar (barPlan / buildBarMesh, server build_bar). Here: the checks that say why the layout was proposed and
   what the bar is (route, length, clearance from the bone, removed after the cuts, a separate STL), and the report rows. */
'use strict';
window.Bridge = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt } = St;
  const ROUTE = { direct: 'düz', inferior: 'alttan', lingual: 'lingualden', side: 'yandan', superior: 'üstten', buccal: 'bukkalden' };
  const why = lc => (lc.why === 'len' ? `lezyon ${fmt(lc.len, 0)} mm (${St.LONG_MM} mm ve üstü)` : lc.why === 'ramus' ? 'rezeksiyon ramusa uzanıyor' : `düz guide ekseni kesi hattının ${fmt(lc.at, 0)} mm'sinde kemiğin dışına çıkıyor`);
  const bar = () => (S.result && S.result.bar) || null;

  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [];
    if (!S.anchor || !S.guideOn) return out;
    const lc = St.longCase(), two = S.g.split === 2;
    if (lc) {
      if (two && S.g.bar) out.push(['info', 'Bilgi', `Uzun rezeksiyon: ${why(lc)}. Tek düz guide yerine iki guide ve aralarında bağlantı köprüsü kullanılıyor.`, 'guide']);
      else out.push(['warn', 'Uyarı', `Uzun rezeksiyon: ${why(lc)}. İki guide ve aralarında bağlantı köprüsü önerilir (Düzen: iki parça, her kesi kendi ekseninde; Bağlantı köprüsü).`, 'guide']);
    }
    if (!S.g.bar) return out;
    if (!two) { out.push(['info', 'Bilgi', "Bağlantı köprüsü yalnız iki guide'lı düzende (her kesi kendi ekseninde) kurulur.", 'guide']); return out; }
    const b = bar(); if (!b) return out;
    if (b.ok) {
      out.push(['info', 'Bilgi', `Bağlantı köprüsü: ${ROUTE[b.route] || b.route} geçiyor, ${fmt(b.len, 0)} mm, kemiğe en yakın ${fmt(b.clear)} mm. Ayrı bir STL olarak basılır, kesilerden önce iki guide'daki kulaklara takılır ve kesilerden sonra çıkarılır.`, 'guide']);
      if (b.route === 'buccal') out.push(['warn', 'Uyarı', 'Bağlantı köprüsü bukkal taraftan geçiyor (lingual ve alt taraf kapalı); yumuşak doku diseksiyonunu ve testere erişimini kontrol edin.', 'guide']);
    } else {
      const msg = b.why === 'lug' ? "Bağlantı köprüsü kurulamadı: guide'lardan birinde köprü kulağı için kemik üstünde yer yok." : b.why === 'route' ? 'Bağlantı köprüsü kurulamadı: iki kulak arasında kemiğe ve guidelara değmeyen bir yol bulunamadı.' : "Bağlantı köprüsü kurulamadı: iki ayrı guide parçası yok.";
      out.push(['warn', 'Uyarı', msg, 'guide']);
    }
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const b = S.anchor && S.guideOn && S.g.bar && S.g.split === 2 ? bar() : null;
    if (!b || !b.ok) return;
    if (d.keep) d.keep(160); d.h2('Bağlantı köprüsü');
    d.table(['Ölçü', 'Değer'], [['Yol', ROUTE[b.route] || b.route], ['Uzunluk', `${fmt(b.len, 0)} mm`], ['Kemiğe en yakın', `${fmt(b.clear)} mm`], ['Kullanım', 'ayrı parça; kesilerden sonra çıkarılır']], [0.5, 0.5]);
  });
  return { route: () => { const b = bar(); return b && b.ok ? b.route : null; } };
})();
