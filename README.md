# surgiguide: fibula serbest flep için otomatik cerrahi kesim guide'ı (prototip)

> **Araştırma prototipidir, tıbbi cihaz değildir.** Klinik kullanım için bir cerrah ve mühendisin her
> çıktıyı gözden geçirmesi, doğrulama çalışması ve yürürlükteki mevzuata (AB MDR / TİTCK, ISO 13485,
> IEC 62304, ISO 14971) uygunluk gerekir.

Šimić ve ark. (Eur Radiol Exp 2021;5:30) makalesindeki iş akışı, Blender'da yarı manuel ilerliyor:
3D Slicer'da segmentasyon, STL dışa aktarma, Blender'da elle hizalama, segment sayısını kullanıcının
seçmesi, greftleri elle konumlandırma, ardından eklentinin Boolean işlemleriyle guide üretmesi.
Bu prototip aynı zinciri DICOM'dan STL'e kadar tek komutla, elle konumlandırma olmadan çalıştırır.

## Makaledeki adımlar ve burada ne yapıldığı

| Makaledeki adım | Makalede | Bu prototipte |
|---|---|---|
| CT/CTA'dan kemik segmentasyonu | 3D Slicer, yaşlı hastada yarı otomatik | `threshold` (HU eşik + morfoloji + bileşen seçimi) veya `totalseg` (TotalSegmentator, yapay zeka) |
| STL içe aktarma, birim ve yön düzeltme | Elle | Gerek yok: DICOM hasta koordinatları (LPS, mm) korunuyor, fibula ekseni PCA ile bulunuyor |
| Segment sayısı | Kullanıcı seçiyor | Otomatik: arkı hedef sapmayla takip eden en az sayıda segment (min. 20 mm, hedef sapma ≤ 2.5 mm) ya da `--segments N` |
| Greft konumlandırma | Kontrol nesneleriyle elle | Kırılma noktaları ark eğrisine en az sapmayla optimize ediliyor (Nelder-Mead) |
| Osteotomi düzlemleri ve testere kalınlığı telafisi | Otomatik | Otomatik: mandibula kesileri ark teğetine dik, segment arası kama kesiler açıortay düzlem, kerf greft dışına kaydırılıyor, fibulada komşu kesilerin kemik içinde kesişmemesi garanti |
| Guide modelleme | Önceden tanımlı nesneler + Boolean | Voksel CSG: kemiğe oturan kabuk, kesim yuvaları, bağlantı rayı, vida delikleri, tek marching cubes ile su geçirmez STL |
| Sanal cerrahi görselleştirme | Blender | Rezeke mandibula + yerine taşınmış greftler (STL/GLB/PNG) |

## Çalıştırma

```bash
python3 -m pip install -r requirements.txt

# Sentetik fantom (hasta verisi gerekmez): DICOM üretir, uçtan uca çalışır (~20 sn, CPU)
python3 run_pipeline.py --demo --out outputs/demo

# Gerçek veri (--resect-from/--resect-to: ark üzerinde orta hattan mm, + = hastanın solu)
python3 run_pipeline.py \
  --mandible-dicom /veri/boyun_BT --fibula-dicom /veri/bacak_BTA \
  --resect-from -10 --resect-to 45 \
  --side right --segmenter totalseg \
  --kerf 1.0 --clearance 0.3 --wall 2.5 \
  --out outputs/vaka01
```

Çıktılar: `mandible.stl`, `fibula.stl`, `guide_mandible_a.stl`, `guide_mandible_b.stl`,
`guide_fibula.stl`, `mandible_resected.stl`, `grafts_in_mandible.stl`, `grafts_in_fibula.stl`,
`plan.json` (segment boyları, fibula üzerindeki yerleri, kesim açıları), `scene_*.glb` ve PNG önizlemeler.

## Kod yapısı

```
surgiguide/volume.py    DICOM okuma/yazma, fiziksel koordinatlar
surgiguide/phantom.py   sentetik mandibula ve bacak BT fantomları
surgiguide/segment.py   eşik tabanlı ve TotalSegmentator segmentasyon
surgiguide/meshing.py   maske -> mesh, yönlendirilmiş yerel ızgara
surgiguide/plan.py      ark merkez hattı, fibula ekseni, segment optimizasyonu, kesim düzlemleri
surgiguide/guides.py    fibula ve mandibula guide'ları, rezeksiyon, greft transferi
surgiguide/render.py    PNG önizleme
run_pipeline.py         uçtan uca komut
```

## Önerilen ürün mimarisi

1. **Giriş**: PACS/DICOM yükleme, anonimleştirme, seri seçimi (ince kesit, kemik kerneli).
2. **Segmentasyon (yapay zeka)**: nnU-Net / TotalSegmentator ile mandibula, dişler, fibula, peroneal arter.
   Kendi kurum verisiyle ince ayar (özellikle osteopeni, metal artefakt, tümör invazyonu için).
   Kullanıcı düzeltmesi için 3D Slicer tabanlı veya web tabanlı bir maske editörü.
3. **Planlama motoru** (bu prototipin çekirdeği): rezeksiyon sınırları (cerrah 2 nokta seçer veya tümör
   segmentasyonundan + güvenlik sınırı), segment optimizasyonu, perforatör/damar pedikülü konumu,
   ayna simetri ile kontur (tümör ark şeklini bozduysa sağlam taraftan ayna görüntü).
4. **Guide üretimi**: kesim yuvaları, vida delikleri, plak ön-bükme modeli, implant/diş planı.
5. **Gözden geçirme arayüzü**: web 3D görüntüleyici, cerrahın onayı, versiyonlu plan raporu.
6. **Üretim**: STL/3MF, biyouyumlu reçine (ör. MED610/MED620), sterilizasyon notları.

## Bilinen sınırlamalar (prototip)

- Sadece sentetik fantomla test edildi; gerçek hastada eşik segmentasyonu kontrastlı damarları ve
  dişleri kemiğe katabilir, TotalSegmentator önerilir (bazı görevleri lisans anahtarı ister; lisans
  koşullarını kontrol edin).
- Ark merkez hattı açısal bölmeyle çıkarılıyor; ileri ramus/kondil rezeksiyonları için uygun değil.
- Greft ekseni mandibula merkez hattına hizalanıyor; alt kenar hizalaması, dikey konum (implant
  için) ve çift namlu (double-barrel) henüz yok.
- Perforatör damar konumu plana girmiyor (BTA'dan damar segmentasyonu eklenmeli).
- Guide'lar yarım kabuk; diş/alveol üzerine oturma, kenar yuvarlatma ve baskı toleransı ayarı yok.

## Guide stüdyosu ve hastane sunucusu (web/ + yolmed_server.py)

- `web/`: tarayıcı stüdyosu (statik dosyalar; herhangi bir web sunucusundan açılır). Vaka kaydı, sürüm geçmişi,
  geri alma, aksiyel/koronal/sagittal kesitler, oturma analizi, sıkıştırılmış DICOM (codecs.js), fibula akışı (fibula.js).
- `python3 yolmed_server.py --backend threshold --port 8800 --db ./yolmed_cases.sqlite`: segmentasyon,
  vaka kaydı (`/cases`, yalnız plan JSON'u, görüntü saklanmaz) ve Manifold ile su geçirmez üretim STL'i (`/guide`).
  Test: `python3 test_yolmed_server.py`.
- Stüdyo sunucuya ulaşırsa vakaları sunucuya, ulaşamazsa yayınlanan sayfanın kendi veritabanına ya da tarayıcıya kaydeder.

## Railway'e yayın

Depo Dockerfile ile tek servis olarak çalışır: stüdyo `/` adresinde, vaka kaydı `/cases`, segmentasyon `/segment`,
üretim STL'i `/guide`. Stüdyo aynı adresteki sunucuyu kendiliğinden kullanır.

1. Railway'de **New Project → Deploy from GitHub repo** ile bu depoyu seçin (Dockerfile otomatik bulunur).
2. Servise bir **Volume** ekleyip `/data` yoluna bağlayın; vakalar `/data/yolmed_cases.sqlite` dosyasında tutulur
   (volume olmadan her yeniden yayında silinir).
3. **Settings → Networking → Generate Domain** ile adres alın.

Not: Sunucu kimlik doğrulaması içermez; adresi bilen herkes vakaları görebilir. Gerçek hasta verisi
(özellikle `/segment`'e giden BT hacmi) için KVKK kapsamında hastane içi kurulum ya da erişim kısıtlaması gerekir.
