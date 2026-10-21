# Malleol kırığı vaka tipi · tasarım (2026-10-21)

Durum: taslak. Melikhan soruları atlayıp doğrudan başlamamı istedi ("atla", 2026-10-21); aşağıdaki kapsam kararlarının hepsi **benim kararım**, onun onayından geçmedi. Araştırma prototipi, tıbbi cihaz değil etiketi aynen korunur.

## 1. Amaç ve neden

Guide Studio'nun BT yükleme, segmentasyon, guide çekirdeği, onay zinciri ve teslim paketi altyapısını ayak bileği travmasına açmak: malleol kırığında (lateral, medial, posterior malleol; bi/trimalleoler; sindesmoz) cerrahın

1. kırık parçalarını BT'den ayırıp görmesi ve ölçmesi,
2. parçaları sanal olarak yerine koyması (redüksiyon),
3. vida yollarını eklem ve korteks kontrolleriyle planlaması,
4. bu vidalar için kemiğe oturan bir matkap guide'ı ve redükte modelin STL'ini (plak ön bükme için baskı) alması.

Neden bu sıra: redükte modelin basılıp plağın ameliyattan önce bükülmesi literatürde en yaygın, en düşük riskli kullanım; matkap guide'ı onun üstüne gelir.

## 2. Hedefler / hedef olmayanlar / anti-hedefler

Hedefler
- Yeni vaka tipi "Malleol kırığı" (`ankle`), mevcut tek sayfa stüdyoda, mevcut vaka tipi altyapısıyla (`web/casetype.js`).
- Çene rekonstrüksiyonu akışı hiç değişmez; varsayılan vaka tipi `mandible` kalır.
- Her aşama tek başına kullanılabilir çıktı verir (aşağıdaki kilometre taşları).

Hedef olmayanlar (v1)
- Otomatik kırık tespiti / sınıflama (AO/Weber, Haraguchi, Bartoníček). Sınıf cerrahın elle seçtiği bir alan olur.
- Yapay zeka ile kırık parçası segmentasyonu. Sunucudaki model mandibula/fibula için; v1 yalnız eşik + mevcut "Bitişik kemikleri ayır".
- Plak tasarımı / plak kütüphanesi. Plak yalnız redükte model üzerinde fiziksel olarak bükülür.
- Yumuşak doku, sinir/damar (sural sinir, safen ven) modeli.

Anti-hedefler (çalışsa bile başarısızlık sayılır)
- Çene akışında herhangi bir davranış ya da üretim STL farkı.
- Redüksiyonun "doğru" olduğunu iddia eden metin. Redüksiyon cerrahın kararıdır; araç yalnız ölçer.
- Doğrulanmamış hassasiyet iddiası (rapor ve arayüzde).

## 3. Kısıtlar

- Düz JS + Three.js, derleme yok; ağır hesap ana iş parçacığında yapılmaz (worker).
- Her yeni arayüz metninin `i18n_en.js` çevirisi; i18n testleri eksik çeviriyi yakalar.
- Plan içeriğini değiştiren her düzenleme ilgili onayı düşürür (`St.unapprove`); görünüm/ad değişiklikleri düşürmez.
- Gerçek BT yalnız anonim kopyalar. Elimizde kırıklı ayak bileği BT'si **yok**: testler sağlam bacak BT'sinden (`fibula_anon.zip`, distal tibia/fibula dahilse) sanal kırık üretir. Bu, klinik doğrulama sayılmaz.
- Her düzeltme/özellik eski kodda kırılan bir test ile gelir.

## 4. Akış (adımlar)

Vaka tipi altyapısı mevcut adım kimliklerini (st1…st8) sıralar ve gizler; yeni adımlar `index.html`'e yeni `<details class="step">` olarak eklenir ve çene tipinde listede olmadıkları için gizli kalır.

| # | Adım | Kaynak | Not |
|---|---|---|---|
| 1 | Vaka ve görüntüler | st1 aynen | Fibula yükleme kutusu gizli (`#upFib`), başlık "Ayak bileği BT'si". Kırık sınıfı ve taraf (sağ/sol) seçimi eklenir. |
| 2 | Anatomi | st2 aynen | Eşik + "Bitişik kemikleri ayır". Varsayılan etiketler: Tibia, Fibula, Talus, Parça 1… (katman sınırı 6 → 8). |
| 3 | Redüksiyon | **yeni** `stRed` | Her parça ayrı mesh; parça seç, gizmo ile taşı/döndür (W/E), "başlangıca dön". Ölçüm: parça hacmi, parça yer değiştirmesi (mm, °), posterior parçanın tibia eklem yüzeyindeki payı (%), eklem basamağı ve aralığı. |
| 4 | Vidalar | **yeni** `stScrAnk` | Serbest vida: giriş noktası 3B'de tıklanır, yön gizmo/açı kaydırıcıları; boy karşı kortekse göre önerilir. Kontroller: eklem yüzeyine girme, korteksten çıkma, vidalar arası mesafe, kırık hattını geçme. Şablonlar: medial malleol 2 × paralel, posterior malleol AP/PA, sindesmoz. |
| 5 | Guide | **yeni** `stGuideAnk` | Seçilen vidalar için matkap guide'ı: kemik yüzeyine oturan yama + kovanlar. Mevcut guide çekirdeği (`gkernel.js`, sunucu `/guide`, kesi düzlemi olmadan) kullanılır. Guide hangi parçanın (redükte konumda) yüzeyine oturuyorsa o parça seçilir. |
| 6 | İnceleme ve onay | st7 | Onay öğeleri: redüksiyon, her vida, guide. SHA-256 zinciri aynen. |
| 7 | Çıktılar | st8 | Redükte model STL'i (her zaman), guide STL'i (onaydan sonra), paket .zip, PDF rapor (malleol bölümleriyle). |

## 5. Kilometre taşları

- **M1 · Vaka tipi + redüksiyon + redükte model.** Adım 1, 2, 3, 6, 7. Çıktı: redükte model STL, ölçümler, rapor. Tek başına işe yarar (plak ön bükme).
- **M2 · Vida planı.** Adım 4 ve kontroller.
- **M3 · Matkap guide'ı.** Adım 5, önizleme + sunucuda su geçirmez üretim STL'i.
- **M4 · Karşı taraf aynası.** Bilateral BT'de sağlam tarafın aynası redüksiyon hedefi olarak gösterilir, parçalar ona hizalanabilir (ICP).

Her taş ayrı commit dizisi; testler geçince main'e.

## 6. Mevcut altyapıdan yeniden kullanım

| Parça | Durum |
|---|---|
| DICOM/zip yükleme, seri seçimi, kalite kontrolü (`app.js`, `codecs.js`, `unzip.js`) | aynen |
| Eşik segmentasyonu, bileşenler, katmanlara ayırma (`masks.js`, `segedit.js`) | aynen, varsayılan etiket adları vaka tipine göre |
| Kesit görünümleri, ölçüm, katmanlar, geçmiş/geri al (`mpr.js`, `measure.js`, `layers.js`, `store.js`) | aynen |
| Guide çekirdeği ve sunucu üretimi (`gkernel.js`, `seat.js`, `yolmed_server.py /guide`) | kesi düzlemi olmadan, kovanlı yama olarak |
| Onay, denetim zinciri, vaka kaydı (`audit.js`, `/cases`) | aynen; yeni öğeler PlanExt ile |
| Rapor, dışa aktarma (`report.js`, `export.js`, `mfg.js`) | yeni bölümler eklenir |
| Kesiler, rezeksiyon, fibula grefti, mandibula plağı, implant, kondil, damar, köprü | kullanılmaz (gizli) |

## 7. Plan verisi

Yeni modüller planı `PlanExt` ile saklar (mevcut desen):
- `PlanExt.ankle`: `{ side: 'R'|'L', cls: string, frags: [{ label, name, T: [16 sayı, satır sırası] }] }` – her parçanın rijit dönüşümü.
- M2'de `PlanExt.ankScrews`, M3'te `PlanExt.ankGuide`.
Onay: her öğe `{ ok, by, at, sig }`; içerik değişince düşer.

## 8. Builder'a bırakılanlar

Gizmo etkileşiminin ayrıntısı, ölçümlerin örnekleme ızgarası, eşik değerleri (hepsi "örnek eşik, klinik ekip belirler" diye işaretli), rapor sayfa düzeni.

## 9. Açık sorular (Melikhan'ın)

- Hedef kullanım: plak ön bükme mi, matkap guide'ı mı öncelikli? (Varsayımım: ikisi, bu sırayla.)
- Kırıklı ayak bileği BT'si (anonim) sağlanabilir mi? Olmadan yalnız sanal kırıkla test edilir.
- Genişleme sırası: daha önce DCIA/skapula, sonra ortopedik onkoloji önerilmişti; malleol bunun önüne mi geçiyor?
