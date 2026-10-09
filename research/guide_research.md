# Hastaya Özel Cerrahi Kılavuz (PSI) Tasarımı — Literatür ve Teknoloji Araştırması

Tarih: 2026-10-08 · Hedef: İÜ-Cerrahpaşa ortopedi/cerrahi için web tabanlı "DICOM → AI segmentasyon → kılavuz yerleşimi → otomatik kılavuz üretimi → düzenleme → exploded view" uygulamasında hangi manuel adımların otomatikleştirileceğine karar vermek.

**Doğrulama notu:** "Sources" bölümündeki her URL bu çalışmada açıldı (WebFetch). PMC (pmc.ncbi.nlm.nih.gov) sayfaları reCAPTCHA, Europe PMC REST API ise HTTP 429 (rate limit) nedeniyle okunamadı. Bu nedenle bazı PMC makaleleri yalnızca yayıncı sayfasından okundu, bazıları ise hiç okunamadı. `[DOĞRULANMADI]` etiketi, açılan kaynaklarda görülmeyen ve genel bilgiden gelen ifadeleri gösterir.

---

## 1. Vaka / teknik not tablosu

| # | Kaynak | Endikasyon | Görüntüleme | Yazılım | Manuel adımlar (mühendis/cerrah) | Tasarım süresi / teslim | Kılavuz parametreleri | Doğruluk |
|---|---|---|---|---|---|---|---|---|
| 1 | Pu et al. 2022, *Front Oncol* 11:743389 | Fibula serbest flep ile onkolojik çene rekonstrüksiyonu (n=10+10) | Bildirilmemiş | ProPlan CMF 2.0 + 3-matic 13.0 | Segmentasyon → protez odaklı implant yerleşimi ve sanal rekonstrüksiyon → 3-matic'te fibula harvest guide → lateral malleol "cap" (distal stopper, bağlantı çubukları) | Bildirilmemiş | Cap kalınlığı 3 mm; deri için iç yüzeyde 0,5 mm relief; 5 mm distal stopper; Ø10 mm bağlantı çubukları; 8 mm vidalar kemiğe dik; MED610 (Stratasys) veya NextDent SG, otoklavlanabilir | Distal fibula osteotomisi 4,1±2,7 mm / 8,7±5,0° (kontrol 9,5 mm / 25,3°); implant platformu 1,3±0,8 mm |
| 2 | Vollmer et al. 2023, *Front Surg* 10:1321217 | Fibula flep, kurum içi (in-house) "24 saatte" planlama (n=8) | Bildirilmemiş | 3D Slicer 5.2.2 (segmentasyon) + Blender 2.83 (yarı otomatik algoritma) | Segmentasyon/STL Slicer'da; plan algoritmayla üretilir; yalnızca connector set-up gibi küçük adımlar elle yapılır; metal artefaktları elle temizlenir | Planlama ortalama ~1 saat (diğer merkezlerde 3–5 saat ile 2–3 gün arası bildiriliyor) | Form 3+ yazıcı, Formlabs Surgical Guide Resin V1 | Hausdorff 1,22±0,40 mm, Dice 0,77±0,07 (plan ile postop karşılaştırması) |
| 3 | Lohn et al. 2025, *IJCARS* (in vitro) | Fibula flep (3 segment, LCL defekt), slot tasarımları | Sentetik kemik CT'si | AC-Seg (AI segmentasyon) + AC-Plan (Python + Blender 3.5) | Plan otomatik üretilir, kılavuz STL olarak dışa aktarılır | Bildirilmemiş | Slot çalışma genişliği 1 mm; açıklık **testere için 0,3 mm, piezo için 0,45 mm**; kılavuz kalınlığı 2 mm; slot yüksekliği 1/2/3 mm; flanşlı ve anatomik slot; olağan 2 mm kılavuz–kemik offset'i bu çalışmada uygulanmamış; PA12 SLS | Slot tipi ve yüksekliği doğrusal ve açısal sapmayı anlamlı etkiliyor; flanş ve anatomik slot öneriliyor; literatürde toplam doğrusal sapma 1,3–1,9 mm |
| 4 | Monsalve-Iglesias et al. 2020, *FOMM* (derleme) | Fibula flep VSP iş akışı | Angio-CT, 1 mm kesit (yüz + alt ekstremite); en fazla 3 hafta, ideal 2 hafta önce | Firma (yazılım adı verilmemiş) | Mühendis ve cerrahlarla web toplantısı: rezeksiyon, fibula tarafı/oryantasyonu, segmentler, plak ve implant | **Firma teslimi 7–10 gün**; maliyet 3.000–12.000 USD/vaka | Slotlar "genelde testereden geniş", bu açılanma hatasını kümülatif hale getiriyor; unikortikal vida delikleri plak için tekrar kullanılıyor; akrilik kırılgan | Sayısal değer yok |
| 5 | Roner et al. 2018, *BMC Musculoskelet Disord* 19:374 | Distal radius malunion, açık kama osteotomi (ramp-guide, n=8 vs 7) | Philips Brilliance 40 (kesit kalınlığı bildirilmemiş) | Kurum içi CASPA (Balgrist) | Sağlam karşı taraf segmente edilip **aynalanır** → plak sanal olarak düzeltilmiş kemiğe yerleştirilir → geri transform → pre-reduksiyon kılavuzu (kesme slotu + vida yönleri) → ramp-guide → kıdemli cerrah onayı | Bildirilmemiş ("daha zor ve zaman alıcı") | Parametreler bildirilmemiş; angular-stable drill sleeve'ler; K-tel ile vida deliklerinin önceden tanımlanması | Rotasyon 2,0°±2,2°, translasyon 0,6±0,2 mm (kontrol 4,2° / 1,0 mm) |
| 6 | Zou et al. 2024, *Front Pediatr* 12:1342980 | Pediatrik cubitus varus | Bilateral CT (kesit kalınlığı bildirilmemiş) | Amira 3.1 | Proksimal osteotomi düzlemi ve kapama kaması açısı; karşı taraf taşıma açısı referans alınıyor | Bildirilmemiş | Uyum yüzeyi + osteotomi düzlemi + K-tel kılavuz borusu; 2 K-tel ile sabitleme; SLA; sterilize | Ameliyat süresi 26,7 vs 43,2 dk; skopi 5,3 vs 8,0 çekim |
| 7 | Donnez et al. 2018, *JOSR* 13:171 (kadavra) | Medial açık kama HTO (n=10) | GE Discovery 710, 120 kV, 400 mA, **0,625 mm** | Mimics 17 + kurum içi planlayıcı | Landmark ve referans düzlemleri → mMPTA/PTS ölçümü → kesme düzlemi ve düzeltme simülasyonu → plak (ActivMotion) yerleşimi → kılavuz tasarımı | Bildirilmemiş | Bildirilmemiş | mMPTA farkı 0,2°±0,3°, PTS farkı −0,1°±0,5° |
| 8 | Fayard et al. 2024, *J Exp Orthop* (klinik, n=49 vs 38) | HTO (varus + medial OA) | 0,625 mm diz; kalça/ayak bileği 2 mm | NewClip Technics (firma) | Cerrah sipariş formu → mühendis tasarımı → cerrah onayı → baskı | Bildirilmemiş | Naylon (3D baskı); 2 adet 2,0 mm K-tel + 2,0 mm lateral menteşe koruma pini; plak delikleri 3,2 mm ile önceden delinir; arka korteks pegleri; testere yaklaşık 1,2 mm | HKA ±2° içinde: %90 (kontrol %65) |
| 9 | Rosso et al. 2023, *J Exp Orthop* 10:80 (kadavra) | Açık kama HTO (n=12) | Preop CT | Bildirilmemiş | Preop CT planı; düzeltme miktarına göre keski uzunluğu | Bildirilmemiş | 1 mm testere bıçağı; 2 adet 3,2 mm pin; slottan K-tel ile yön kontrolü; hizalama çubuğu | MPTA hatası 1,2°±0,6° |
| 10 | Pelvik tümör PSI, kadavra; *Bone Joint Res* 2017 6(10) (yazarlar: Sallent et al. olarak biliniyor **[yazar listesi açılan sayfada görülmedi]**) | Pelvis tümör rezeksiyonu simülasyonu (sakroiliak, supra-asetabular, iliopubik, iskiyal kesiler) | Toshiba Aquilion, **0,5 mm** | Mimics + 3-matic | Ölçü ve landmark'lara göre rezeksiyon düzlemleri → kortikal yüzeye uyan kılavuz | **4–5 gün** (tasarım + üretim) | Poliamid, EOS Formiga P110 (SLS); kılavuz başına 3 adet 1,5 mm K-tel; 2 cm genişliğinde düz kesme yüzeyi (kapalı slot yok); kemik–kılavuz boşluğu <1 mm olarak doğrulanıyor | Ortalama maksimum sapma: PSI 0,8–5 mm, serbest el 3–14,6 mm; >5 mm sapma oranı %10 (serbest el %53) |
| 11 | Scorianz et al. 2024, *Cancers* 16:4185 (klinik, n=13) | Diz çevresi eklem koruyucu tümör rezeksiyonu + allogreft | Kontrastlı MR + CT (füzyon) | Mimics 24 + Geomagic Design X | Tümör segmentasyonu ve CT/MR füzyonu → cerrah düzlemleri belirler → mühendis multiplanar kılavuzu tasarlar → ayrı allogreft şekillendirme kılavuzu | **Ortalama 12 gün (7–15)** | Ti-6Al-4V (polimerden ince); kılavuz başına 2–6 slot (ortalama 4 düzlem); otoklav 134 °C, 5 dk, 3 bar; ucu salınan testere | Kesi hatası ortalama 1,5 mm (medyan 2,3 mm); %63'ü <2 mm; tüm hastalarda R0 sınır; 10–15 mm sınır öneriliyor |
| 12 | Wang et al. 2024, *3D Print Med* 10:15 (sentetik model) | Diz çevresi tümör rezeksiyonu, skopi ile kalibre edilen PSI | 0,625 mm | Mimics 21 | Konvansiyonel PSI'ya ek olarak AP/OP metal tel işaretleri; ameliyatta C-kollu skopi ile hizalama | Konvansiyonel PSI ile benzer | Naylon, SLS | Ortalama mesafe 1,27 mm (konvansiyonel PSI 2,11 mm, serbest el 2,99 mm); açı 2,16° (5,54° / 8,50°) |
| 13 | Cool et al. 2021, *Eur Spine J* 30:3216 | Torakolomber deformite, pedikül vidası (5 hasta, 99 vida) | **0,6 mm** düşük doz CT (0,26–0,74 mSv) | Medacta MySpine (firma) | Firma segmentasyon yapıp giriş noktası ve trajektuar önerir → cerrah web platformunda düzeltir ve onaylar | Firma **2–3 hafta** | Lamina, spinöz çıkıntı ve faset temaslı; vertebra başına bir kılavuz; 2,7 mm pilot delikler; kurumda otoklav | 0,92 mm / 2,92°; Gertzbein-Robbins %100 güvenli |
| 14 | Safahieh et al. 2024, *Front Bioeng Biotechnol* 12:1416872 (in vitro) | Servikal pedikül vidası, "non-covering" şablon | 0,7 mm | Açık kaynak platform (adı verilmemiş) | HU 226–3071 eşikleme + piksel bazında düzeltme → en dar pedikül kesitine iç teğet çember → vida çapı = çember − 1–2 mm, uzunluk ≤ gövde uzunluğunun %90'ı → cerrah onayı | Bildirilmemiş ("zaman alıcı") | Sleeve iç çapı = vida (4,5 mm), dış çap +3 mm; 3 temas noktası (2 giriş noktası + spinöz çıkıntıda R5–8 mm konkav küre); PLA FDM, %100 doluluk | Giriş noktası 0,29 mm, 3D açı 6,38° (serbest el 3,02 mm / 19,2°) |
| 15 | León-Muñoz et al. 2021, *J Clin Med* 10:1439 | PSI ile TKA (MyKnee, n=35) | CT | Firma | Firma planı + cerrah onayı | Bildirilmemiş | Firma kılavuzu | HKA sapması 1,64°±1,3°; meta-analizlerde PSI, robot/navigasyondan üstün değil |
| 16 | Aguado-Maestro et al. 2019, CAOS (EPiC 3) | Hastane içi kılavuz: rezeksiyon, küretaj, osteotomi (n=3) | CT (kernel 30) | Horos + **Meshmixer** | Segmentasyon Horos'ta → kortikal yüzey şablon alınarak Meshmixer'da tasarım | **Tasarım ortalama 6,3 saat**, baskı 5,2 saat, filament <10 USD | SmartFil Medical (ABS), Ultimaker 2+, 0,6 mm nozul, 0,1 mm katman; 75° üstü çıkıntılarda support | Yalnızca nitel ("mükemmel oturdu") |
| 17 | Leclerc et al. (IJCARS 2025, LIRMM PDF) | Fibula flep, interaktif pipeline (robotik kılavuz) | Ham CT | Kurum içi | Bounding box + tek voksel tıklaması → otomatik fibula segmentasyonu; ghost plane'ler hill-climbing ile; cerrah slider'larla düzeltir | **Hasta başına 8–13 dk** (Materialise ile planlamadan kılavuza ≥1 hafta) | Basılı kılavuz yok (robot) | Hausdorff 3,8–4,1 mm (postop vidalı taramaya göre); segmentler arası boşluk 1,0–1,5 mm |

Açık kaynak referans: **SlicerBoneReconstructionPlanner** (BSD-3, 3D Slicer eklentisi). Fibula ve mandibula VSP, miter box'lı fibula kılavuzu ve mandibula kılavuzu sunuyor. Parametreler: `sawBoxWidth = sawBladeWidth`, `clearanceFitPrintingTolerance` SLA için 0,25 mm, FDM için 0,4 mm, kılavuz tabanı kabuk kalınlığı 3–6 mm, önerilen CT kesiti 0,65 mm (en fazla 1 mm), eşik değeri 200 HU. Slicer forumunda tutorial süresi ~15 dk, segmentasyon hazırsa ~5 dk olarak veriliyor.

---

## 2. Tipik manuel iş akışı (Mimics/3-matic veya Slicer/Blender/Meshmixer)

| # | Adım | Mimics/3-matic | Açık kaynak karşılığı | Zaman / uzmanlık yükü |
|---|---|---|---|---|
| 1 | CT protokolü ve DICOM import | Mimics import | Slicer DICOM | Düşük. Protokol hatası (≥2 mm kesit, gantry tilt, metal) tüm zinciri bozar |
| 2 | Kemik segmentasyonu (eşik, region growing, maske düzenleme, artefakt temizliği, eklem ayırma) | Threshold, Region grow, Edit mask, Split | Segment Editor, TotalSegmentator eklentisi | **Yüksek**: manuel durumda en uzun adım (saatler); metal artefaktı ve eklem aralıkları uzmanlık ister |
| 3 | 3D mesh, wrap/smooth, remesh | Calculate part, Wrap, Smooth | Wrap Solidify, Surface toolbox | Orta. Yüzey sadakati ile pürüzsüzlük dengesi kurulmalı |
| 4 | Deformite analizi / karşı tarafın aynalanması / landmark'lar | Mirror + global registration, landmark analizi | Fiducial + ICP (ALPACA vb.) | **Yüksek uzmanlık**: hangi segmentle register edileceği sonucu belirler (Hoch 2022: kesite göre 0–9,3° fark) |
| 5 | Sanal osteotomi, düzeltme / rezeksiyon düzlemleri, fragman yer değiştirme | Cut, Reposition, ProPlan (CMF) | Plane widget, Blender | **Yüksek** (cerrah kararı): çok iterasyonlu ve toplantı gerektiriyor (fibula için web toplantısı) |
| 6 | Plak/vida/implant simülasyonu | CAD import, cylinder | Model import | Orta–yüksek |
| 7 | Kılavuz temas yüzeyi seçimi (footprint) | Mark surface → Offset → Extrude, Create Guide | Meshmixer select + extrude, BRP guide base | **Yüksek**: yerleşim belirsizliği, yumuşak doku ve undercut kararları deneyime dayanıyor |
| 8 | Slot, sleeve, flanş, köprü ve fiksasyon delikleri ekleme ve Boolean | Mimics Design: Create Base, Guiding Tube, Cut Slot, Flange, Guide Bridge | BRP miter box + Boolean; Meshmixer | Orta–yüksek. Boolean hataları ve non-manifold mesh sık görülüyor (BRP'de bilinen sorun) |
| 9 | Kontrol: çakışma, yerleştirme yönü, kılavuz–kemik boşluğu, etiketleme | Collision/Wall thickness analizi | Manuel | Orta |
| 10 | Cerrah onayı (web toplantısı veya PDF) | Firma platformu | — | Takvim yükü (günler) |
| 11 | Baskı, son işlem, sterilizasyon | — | — | 5–24 saat baskı + sterilizasyon döngüsü |

**En çok zaman alan ve uzmanlık gerektiren adımlar:** (2) segmentasyon, (4)–(5) planlama ve deformite analizi, (7)–(8) kılavuz geometrisi. Bildirilen süreler: Meshmixer ile tasarım ortalama 6,3 saat (Aguado-Maestro), firma teslimi 4–5 gün (pelvis), 7–10 gün (fibula), 12 gün (Ti tümör), 2–3 hafta (spine). Algoritmik akışla bu süre ~1 saate (Vollmer) ve 8–13 dk'ya (Leclerc) iniyor.

---

## 3. Tasarım kuralları, parametre aralıkları ve hata modları

### 3.1 Parametre aralıkları (kaynaklı)

| Parametre | Bildirilen değer / aralık | Kaynak |
|---|---|---|
| CT kesit kalınlığı | 0,5–0,7 mm tipik; ≤1 mm önerilir; HKA için uzun bacak 2 mm | Pelvis 0,5; Donnez/Fayard/Wang 0,625; Cool 0,6; Safahieh 0,7; BRP 0,65 (en fazla 1); Monsalve 1 mm |
| Kılavuz duvar / taban kalınlığı | 2–6 mm (polimer); cap 3 mm; Ti daha ince | Lohn 2 mm; BRP 3–6 mm; Pu 3 mm; Formlabs SG resin min. 2,0 mm |
| Baskı uyum toleransı (kılavuz–kemik veya parça–parça) | SLA 0,25 mm, FDM 0,4 mm | BRP README |
| Kemik–kılavuz kabul edilebilir boşluk | < 1 mm (intraop kontrol) | Pelvis PSI |
| Yumuşak doku / deri relief | 0,5 mm (deri üstü cap) | Pu 2022 |
| "Olağan" kılavuz–kemik offset | 2 mm (Lohn bu değeri "usual" olarak anıp uygulamamış). **[Kemik üstü offset için standart değer bulunamadı; kurumsal SOP gerekir]** | Lohn 2025 |
| Slot genişliği | bıçak kalınlığı + 0,3 mm (testere) / + 0,45 mm (piezo); BRP'de slot = bıçak + tolerans; "slotlar genelde testereden geniş, açılanma hatası" | Lohn; BRP; Monsalve |
| Slot derinliği (yönlendirme uzunluğu) | 10/15/20 mm arasında anlamlı genel fark yok; 10 mm yeterli (tümör, proksimal tibia) | Owyang et al. 2017 (EORS) |
| Açık kesme yüzeyi | 2 cm genişlikte düz yüzey (kapalı slot yerine) | Pelvis PSI |
| Sleeve iç çapı / boşluğu | 0,01 mm boşluk 2,1°, 0,03 mm boşluk 3,9° açısal sapma (zirkonya, 4 mm sleeve, diş); Formlabs sleeve offset 0–0,04 mm | Chen 2021; Formlabs |
| Pilot / K-tel çapları | 1,5 mm (pelvis), 2,0 mm (HTO), 2,7 mm (pedikül pilot), 3,2 mm (HTO pin/plak) | ilgili vakalar |
| Sleeve dış çapı | iç çap + 3 mm | Safahieh |
| Fiksasyon sayısı | 2–3 K-tel/vida | Pelvis 3; Fayard 2+1; Zou 2; Lohn segment başına 2 |
| Malzeme | PA12/poliamid SLS, naylon, MED610, NextDent SG, Formlabs Surgical Guide, PLA/ABS FDM, Ti-6Al-4V | çeşitli |
| Sterilizasyon | Otoklav 134 °C 5 dk, 3 bar (Ti); polimerlerde "otoklav" dendi ama döngü verilmedi. **[Polimer döngü değerleri doğrulanmadı]** | Scorianz; Cool; Pu |
| Kenar boşluğu (tümör) | 10–15 mm planlanan sınır | Scorianz |

### 3.2 Hata modları ve tasarım kuralları
- **Oturma belirsizliği (seating ambiguity):** Diafiz gibi silindirik ve özelliksiz yüzeylerde kılavuz döner veya kayar. Caiti 2017 (radius) mid-shaft yerleşimin distal/proksimale göre anlamlı daha hatalı olduğunu, lateral uzantılı (≈%50 kesit saran) kılavuzun translasyon hatasını azalttığını buldu. Kural: belirgin anatomik çıkıntıları (metafiz, kondil, malleol, spinöz çıkıntı) kullanmak ve 3+ ayrık temas bölgesi kurmak (Safahieh: 2 giriş noktası + spinöz küre). Pu'daki malleol cap'i ve distal stopper bu sorunu çözüyor.
- **Yumuşak doku / kıkırdak / periost:** CT kıkırdağı ve periostu göstermez. Kılavuz, kemiğin üzerinde kalan doku yüzünden "yüzer". Pratik çözümler: relief (Pu 0,5 mm), temas alanını sıyrılabilecek bölgelere sınırlamak, sınırlı flep diseksiyonu. Diş literatürü kemik destekli kılavuzların geniş flep gerektirdiğini vurguluyor (ROE).
- **Undercut / yerleştirme yönü:** Footprint, yerleştirme yönünde undercut içermemeli. Caiti'deki "seçilen kutu yönünde projeksiyon ve erozyon" yöntemi bunu algoritmik olarak çözüyor.
- **Kerf ve slot boşluğu:** Fazla boşluk açısal hatayı büyütür ve çok segmentli fibulada kümülatif hale gelir (Monsalve). Slot genişliği bıçağa göre parametrik olmalı (Lohn; El-Mahallawy 2024 RCT preprint: yönlendirici slot ile 0,3–0,5 mm sapma, kenar kesme kılavuzu ile ~2 mm). Bıçak kalınlığı kadar kemik kaybı (≈1–1,2 mm) planlanan uzunlukta telafi edilmelidir (Fayard).
- **Bıçak sapması (deflection):** Doğrudan ölçen açık erişimli bir çalışma bulunamadı **[DOĞRULANMADI]**. Slot yüksekliği ve flanş, açısal hatayı anlamlı etkiliyor (Lohn).
- **Sleeve yönlendirme uzunluğu / boşluk:** Boşluk arttıkça açısal sapma artıyor (Chen 2021). Uzunluk etkisine dair ortopedik bir çalışma açılamadı **[DOĞRULANMADI]**.
- **Mekanik dayanım:** Akrilik kılavuzlar vida sıkarken kırılıyor (Monsalve). İnce köprülerden kaçınmak ya da Ti kullanmak gerekiyor.
- **Görüntü ile ameliyat arasındaki süre:** Tümör büyümesi riski nedeniyle CT ameliyattan en fazla 3 hafta önce çekilmeli (Monsalve).
- **Boolean / mesh hataları:** BRP'de bilinen sorun. Çözümü nokta yoğunluğunu artırmak ve "Initial space" değerini 0,1 mm kaydırmak. Robust boolean (Manifold) gerekli.
- **Metal artefaktı:** Postop değerlendirmede ve revizyonlarda manuel temizlik gerekiyor (Vollmer).

---

## 4. Adım bazında otomasyon tablosu

Olgunluk ölçeği: **Y** = rutin ve yayımlanmış, **O** = araştırma prototipi ve sınırlı validasyon, **D** = deneysel.

| Adım | Bugün manuel mi? | Zaman / uzmanlık yükü | Otomasyon yaklaşımı | Olgunluk | Not / kaynak |
|---|---|---|---|---|---|
| DICOM yükleme, seri seçimi, kalite kontrol | Kısmen | Düşük | Kesit kalınlığı, tilt ve spacing kontrolü ile otomatik uyarı (≤1 mm) | Y | Basit kurallar |
| Kemik segmentasyonu | Evet (eşik + düzenleme) | **Yüksek** | TotalSegmentator `total` (femur, kalça, humerus; Apache-2.0); `craniofacial_structures` (mandibula, açık); **tibia/fibula/radius/ulna yalnızca lisanslı `appendicular_bones` görevinde**; alternatif: kendi nnU-Net'iniz veya eşik + connected components + watershed (Leclerc) | Y (femur, mandibula) / O (tibia, fibula: lisans veya eğitim gerekir) | GPU'da ~30 sn, CPU'da ~70 sn (örnek, `-f` ile) |
| Mesh çıkarma ve yumuşatma | Yarı otomatik | Orta | Marching cubes / flying edges, smoothing, decimation | Y | |
| Landmark / anatomik eksen | Evet | Orta–yüksek | Atlas veya şablon registration, DL landmark | O | Leclerc: şablon eğri + birkaç landmark ile registration |
| Karşı taraf aynalama + deformite ölçümü | Evet | **Yüksek** | Aynalama + segment bazlı ICP; proksimal ve distal ayrı register edilerek 3D düzeltme matrisi hesaplanır | O–Y (Balgrist rutin kullanıyor) | Roner 2018; Hoch 2022 (segment seçimi kritik) |
| Osteotomi / rezeksiyon düzlemi optimizasyonu | Evet (cerrah) | **Yüksek** | Genetik algoritma (Carrillo 2019: okuyucular %55 algoritmayı tercih etti); PSO ile tümör sınırı + minimum kemik kaybı (Hill: %32 daha az kemik kaybı, ~55 dk); fibula segment yerleşimi (Vollmer, Leclerc, BRP) | O | Öneri üretip cerrah onayına sunmak gerçekçi |
| Kılavuz temas yüzeyi (footprint) | Evet | **Yüksek** | Kullanıcı seed/fırça ile işaretler → yerleştirme yönünde görünürlük, undercut filtresi ve erozyon ile otomatik footprint (Caiti 2017) → offset + extrude | O (algoritma yayımlanmış, basit) | Bizim uygulamada "mark where guide goes" adımına karşılık geliyor |
| Slot, sleeve, flanş, köprü üretimi | Yarı otomatik (Mimics Design "Create Base, Guiding Tube, Cut Slot, Flange, Guide Bridge") | Orta | Parametrik primitifler (bıçak + tolerans, sleeve ID/OD/uzunluk) + robust Boolean (Manifold) | Y (ticari) / O (açık kaynak BRP) | |
| Doğrulama (çakışma, min. duvar, oturma stabilitesi) | Manuel | Orta | Signed distance ile boşluk haritası, duvar kalınlığı analizi, yerleştirme yönü simülasyonu, temas alanı ve stabilite skoru | O | Otomatik ve görece kolay |
| Plak ön bükme / vida trajektuarı | Manuel | Orta–yüksek | Pedikül: en dar kesit + iç teğet çember (Safahieh) gibi kural tabanlı trajektuar | O | |
| Rapor ve onay, STL export | Manuel | Orta (takvim) | Otomatik PDF/HTML rapor, parametre kaydı, versiyonlama | Y | |

---

## 5. Tarayıcı fizibilitesi

| Bileşen | Kütüphane | Tarayıcıda gerçekçi mi? | Not |
|---|---|---|---|
| DICOM parse | dcmjs (MIT; Part10 ↔ JSON, SEG "geliştirmede"), Cornerstone DICOM Image Loader, ITK-Wasm | **Evet** | VolView, DICOM'u ITK-Wasm ile tarayıcıda okuyor |
| 2D/MPR/volume render | Cornerstone3D (MIT; stack ve volume viewport, MPR, MIP, labelmap → yüzey), vtk.js (BSD-3, WebGL + WebGPU), OHIF (Cornerstone tabanlı viewer) **[OHIF sayfası açılmadı]** | **Evet** | |
| Segmentasyon düzenleme | Cornerstone3D tools (threshold, scissors) | **Evet** | |
| Labelmap → mesh | Cornerstone polySeg (Web Worker, WASM), vtk.js / ITK-Wasm | **Evet** (512³ hacimde saniyeler mertebesinde **[süre doğrulanmadı]**) | |
| AI segmentasyon | TotalSegmentator / nnU-Net | **Sunucu tarafı önerilir** (GPU, Docker `wasserth/totalsegmentator`) | Brainchop: TF.js/WebGL ile 256³ beyin MR'ı tarayıcıda segmente ediyor ama başarı ~%82, hata nedeni GPU belleği; nnU-Net boyutundaki modeller için uygun değil. VolView + NVIDIA Clara de "görüntüleme tarayıcıda, inference GPU servisinde" mimarisini kullanıyor |
| Boolean / CSG | **manifold-3d** (Apache-2.0, WASM, garantili manifold çıktı); three-bvh-csg (MIT, hızlı ama deneysel, manifold çıktı garanti değil, README CAD için Manifold'u öneriyor) | **Evet**: kılavuz ölçeğindeki (10⁵–10⁶ üçgen) meshlerde tarayıcıda yapılabilir | Offset/kabuk için Manifold level-set (SDF) özelliği kullanılabilir |
| Offset / footprint extrude | Kendi kodu (normal boyunca extrude) veya SDF + level set (Manifold) | Evet | |
| 3D etkileşim, exploded view, gizmo | three.js (+ TransformControls), vtk.js widgets | Evet | |
| STL/3MF export | three.js exporters, Manifold | Evet | |

**Önerilen mimari:** Tarayıcıda görüntüleme, düzlem/sleeve düzenleme, parametrik kılavuz üretimi (Manifold WASM) ve exploded view; hastane içi sunucuda (on-prem GPU, KVKK) TotalSegmentator/nnU-Net, ağır remesh ve gerekirse yedek Boolean (Python: manifold3d, trimesh).

---

## 6. Demo için açık / de-identify CT veri setleri

| Veri seti | İçerik | Lisans / erişim | Uygunluk |
|---|---|---|---|
| TotalSegmentator dataset v2 (Zenodo 8367088 / 10047292) | 1228 klinik CT, 117 yapı etiketi, 23,6 GB | **CC BY 4.0** | Gövde ve femur için iyi. Bacak/fibula içeren CT'ler olabilir ama etiket listesi açılan sayfada görülmedi **[fibula içeren vaka oranı doğrulanmadı]** |
| Wallner et al. 2019 mandibula (Sci Data, figshare) | 10 mandibula CT'si, 20 ground-truth model (.nrrd, STL) | **CC BY 4.0** | Mandibula demosu için en uygun ve en temiz lisans |
| PDDCA v1.4.1 (TCIA Head-Neck Cetuximab türevi; HF "PDDCA-Lite") | 48 baş-boyun CT'si, mandibula etiketi | Public domain / **CC BY 3.0** | Mandibula, iyi |
| HaN-Seg (Zenodo 7442914) | 42 hasta CT + MR, 30 OAR | **CC BY-NC-ND** | Ticari olmayan demoda kullanılabilir, türev dağıtılamaz |
| TCIA Soft-Tissue-Sarcoma | 51 hasta, ekstremite FDG-PET/CT + MR | **CC BY 3.0**, açık (Data Retriever) | Alt ekstremite/fibula görünebilir ama CT kesit kalınlığı (PET-CT) kalın olabilir **[doğrulanmadı]** |
| TCIA HNSCC, Head-Neck-PET-CT | Baş-boyun CT | Görüntüler **NIH Controlled Access** (yüz rekonstrüksiyon riski) | Demo için zahmetli |
| NMDID (New Mexico) | >15.000 tüm vücut postmortem CT, 1 mm kesit / 0,5 mm overlap | Ücretsiz, kurumsal hesap + araştırma talebi + DUA gerekli; yeniden dağıtım şartları DUA'da **[DUA metni okunmadı]** | Fibula + mandibula aynı hastada; VSP demosu için ideal ama başvuru gerekiyor |

---

## 7. Önerilen otomasyon kapsamı (MVP → v2)

1. **MVP'de otomatik:** DICOM kalite kontrolü; AI kemik segmentasyonu (sunucuda; femur/pelvis/mandibula açık modellerle, tibia/fibula için lisans veya kendi nnU-Net'iniz, ya da eşik + CC + watershed); mesh üretimi; kullanıcının fırça/seed ile işaretlediği bölgeden **otomatik footprint** (yerleştirme yönü, undercut filtresi, erozyon, offset/relief, extrude); parametrik slot/sleeve/flanş/köprü üretimi ve Manifold Boolean; otomatik doğrulama (boşluk haritası, min. duvar, yerleştirme yönü, stabilite); exploded view ve STL/rapor çıktısı.
2. **MVP'de cerrah kontrolünde kalacaklar:** osteotomi/rezeksiyon düzlemlerinin son konumu, sınır mesafesi, vida trajektuarı onayı. Sistem başlangıç önerisi verir (landmark/şablon tabanlı), cerrah gizmo ile düzeltir.
3. **v2:** karşı taraf aynalama + segmental ICP ile 3D deformite analizi ve düzeltme önerisi (radius, HTO, cubitus varus); fibula segment planlama algoritması (Vollmer/Leclerc/BRP benzeri); tümör için PSO tabanlı düzlem önerisi; pedikül için kural tabanlı trajektuar.
4. **Önerilmeyen:** tarayıcıda nnU-Net sınıfı 3D inference (bellek ve başarı oranı sorunlu); tamamen otomatik "onaysız" plan.

---

## Sources (bu çalışmada açılan URL'ler)

Vakalar / teknik notlar
- Pu et al. 2022, Fibula malleolus cap — https://www.frontiersin.org/journals/oncology/articles/10.3389/fonc.2021.743389/full
- Vollmer et al. 2023, in-house fibula 24 h — https://www.frontiersin.org/journals/surgery/articles/10.3389/fsurg.2023.1321217/full
- Lohn et al. 2025, slot properties fibula guides — https://link.springer.com/article/10.1007/s11548-025-03474-2 (ayrıca https://publications.rwth-aachen.de/record/1016933)
- Monsalve-Iglesias et al. 2020, VSP review — https://fomm.amegroups.org/article/view/42414/html
- Roner et al. 2018, distal radius ramp-guide — https://link.springer.com/article/10.1186/s12891-018-2279-0
- Zou et al. 2024, cubitus varus template — https://www.frontiersin.org/journals/pediatrics/articles/10.3389/fped.2024.1342980/full
- Donnez et al. 2018, HTO in vitro — https://link.springer.com/article/10.1186/s13018-018-0872-4
- Fayard et al. 2024, HTO PSCG clinical — https://pmc.ncbi.nlm.nih.gov/articles/PMC10949175
- Rosso et al. 2023, HTO in vitro — https://link.springer.com/article/10.1186/s40634-023-00647-3
- Pelvic tumour PSI cadaver, Bone Joint Res 2017 — https://boneandjoint.org.uk/Article/10.1302/2046-3758.610.BJR-2017-0094.R1/pdf
- Scorianz et al. 2024, Ti cutting guides knee tumours — https://flore.unifi.it/retrieve/ce8f8dab-9d20-42b7-ae97-ac420b36c588/Cutting%20guides.%20Cancers%202024.pdf
- Wang et al. 2024, fluoroscopically calibrated PSI — https://threedmedprint.biomedcentral.com/articles/10.1186/s41205-024-00216-z
- Cool et al. 2021, pedicle screw guides — https://link.springer.com/article/10.1007/s00586-021-06951-9
- Safahieh et al. 2024, cervical templates — https://www.frontiersin.org/journals/bioengineering-and-biotechnology/articles/10.3389/fbioe.2024.1416872/full
- León-Muñoz et al. 2021, TKA PSI — https://digitum.um.es/digitum/bitstream/10201/154290/1/jcm-10-01439.pdf
- Aguado-Maestro et al. 2019, in-hospital guides — https://easychair.org/publications/open/pT1s
- Leclerc et al., interactive fibula pipeline — https://www.lirmm.fr/~nfaraj/publications/med_max/Leclerc_et_al_IJCARS2025.pdf

Tasarım kuralları
- Caiti et al. 2018, guide positioning error radius — https://link.springer.com/article/10.1007/s11548-017-1682-6
- Owyang et al. 2017, slot depth — https://boneandjoint.org.uk/Article/10.1302/1358-992X.99BSUPP_1.EORS2016-036
- El-Mahallawy et al. 2024 (preprint), directional slot RCT — https://www.researchsquare.com/article/rs-4055792/latest
- Chen et al. 2021, sleeve clearance — https://www.mdpi.com/2076-3417/11/19/9035
- Formlabs Surgical Guide Resin — https://formlabs.com/support/Using-Surgical-Guide-Resin/
- ROE bone-supported guides — https://www.roedentallab.com/knowledge-base/what-clinical-considerations-and-troubleshooting-tips-should-i-keep-in-mind-for-bone-supported-surgical-guides
- Materialise automatic guide design tools — https://www.materialise.com/en/academy/healthcare/mimics-innovation-suite/tutorials/automatic-guide-design-tools
- Materialise surgical guide design webinar — https://www.materialise.com/en/inspiration/webinars/surgical-guide-design-mimics-innovation-suite

Otomasyon
- SlicerBoneReconstructionPlanner — https://github.com/SlicerIGT/SlicerBoneReconstructionPlanner ; https://discourse.slicer.org/t/new-3d-slicer-extension-for-planning-and-surgical-guide-generation-for-mandibular-bone-reconstruction/17638
- TotalSegmentator — https://github.com/wasserth/TotalSegmentator
- Carrillo et al. 2019, GA osteotomy planning — https://export.arxiv.org/abs/1909.09612
- Hill et al., automated resection planning — https://discovery.ucl.ac.uk/id/eprint/10134734/1/2021_08_18%20automated%20resection%20planning%20rev_2.pdf
- Hoch et al. 2022, contralateral registration femur — https://link.springer.com/article/10.1186/s12891-022-05941-2

Tarayıcı
- Cornerstone3D — https://www.cornerstonejs.org/docs/getting-started/overview ; polySeg — https://www.cornerstonejs.org/coverage/polymorphic-segmentation/src/Surface/convertLabelmapToSurface.ts
- ITK-Wasm — https://docs.itk.org/projects/wasm/en/latest/
- vtk.js — https://github.com/Kitware/vtk-js
- dcmjs — https://github.com/dcmjs-org/dcmjs
- Manifold — https://github.com/elalish/manifold
- three-bvh-csg — https://github.com/gkjohnson/three-bvh-csg
- Brainchop — https://ar5iv.labs.arxiv.org/html/2310.16162
- VolView + NVIDIA Clara — https://www.kitware.com/integrating-nvidia-clara-models-into-volview-a-technical-deep-dive/

Veri setleri
- TotalSegmentator dataset — https://zenodo.org/records/8367088 ; https://zenodo.org/records/10047292
- Wallner mandible dataset — https://www.nature.com/articles/sdata20193 ; https://arxiv.org/abs/1902.05255
- PDDCA-Lite — https://huggingface.co/datasets/YongchengYAO/PDDCA-Lite
- HaN-Seg — https://lit.fe.uni-lj.si/en/research/resources/HaN-Seg/
- TCIA Soft-Tissue-Sarcoma — https://www.cancerimagingarchive.net/collection/soft-tissue-sarcoma/
- TCIA HNSCC — https://www.cancerimagingarchive.net/collection/hnscc/
- TCIA Head-Neck-PET-CT — https://www.cancerimagingarchive.net/collection/head-neck-pet-ct/
- NMDID — https://nmdid.unm.edu/

Açılamayanlar: PMC5945234, PMC6190568 (Roner'in PMC sürümü; yayıncı sürümü okundu), PMC6885147, PMC8152442, PMC11317891 (sistematik derleme), PMC10905807 (reCAPTCHA); Europe PMC REST API (HTTP 429); Emerald RPJ "lessons learned" makalesi (bot doğrulaması).
