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
| CT/CTA'dan kemik segmentasyonu | 3D Slicer, yaşlı hastada yarı otomatik | `threshold` (HU eşik + morfoloji + bileşen seçimi; birleşik kemikler ince boyunlarından ayrılır: kafatası/üst çene/omurga mandibuladan, tibia/ayak/masa fibuladan; ayrılamazsa uyarı verilir, `--fibula-component N` eski boyut sıralı seçimi korur) veya `totalseg` (TotalSegmentator, yapay zeka) |
| STL içe aktarma, birim ve yön düzeltme | Elle | Gerek yok: DICOM hasta koordinatları (LPS, mm) korunuyor, fibula ekseni PCA ile bulunuyor |
| Segment sayısı | Kullanıcı seçiyor | Otomatik: arkı hedef sapmayla takip eden en az sayıda segment (min. 20 mm, hedef sapma ≤ 2.5 mm) ya da `--segments N` |
| Greft konumlandırma | Kontrol nesneleriyle elle | Kırılma noktaları ark eğrisine en az sapmayla optimize ediliyor (Nelder-Mead) |
| Osteotomi düzlemleri ve testere kalınlığı telafisi | Otomatik | Otomatik: mandibula kesileri ark teğetine dik, segment arası kama kesiler açıortay düzlem, kerf greft dışına kaydırılıyor, fibulada komşu kesilerin kemik içinde kesişmemesi garanti |
| Guide modelleme | Önceden tanımlı nesneler + Boolean | Hat (`run_pipeline.py`, `surgiguide/guides.py`): voksel CSG ile kemiğe oturan kabuk, kesim yuvaları, bağlantı rayı, vida delikleri, tek marching cubes ile su geçirmez STL. Stüdyonun guide'ı ayrı bir tasarımdır (aşağıda "İki guide ailesi") |
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
`plan.json` (segment boyları, fibula üzerindeki yerleri, kesim açıları, `warnings`), `scene_*.glb` ve PNG önizlemeler.
Bir klasörde birden çok seri varsa `--mandible-series Bone` / `--fibula-series 1.25mm` (seri açıklaması ya da UID) seriyi seçer.
Kemik seçimi tarayıcıyla aynı 0,8 mm çalışma ızgarasında yapılır (aynı mandibula / fibula).
`--side right|left` (varsayılan `right`) donör bacağı söyler: fibula, kendi tibiasının lateralinde aranır ve istenen bacakta
fibula bulunamazsa hat **durur** (çıkış kodu 2, sebep ekranda ve `plan.json` `error` alanında); diğer bacağın kemiği hiçbir
zaman döndürülmez. `--side auto` tek bacaklı serilerde bacağı tibiaya göre kendisi bulur. Bacak tibiayla doğrulanamazsa
(tibia görüntüde yok) seçim yapılır ama uyarı verilir.
Plan tolerans dışına çıkarsa (sapma, kısa segment, dik kesi, kısa fibula), guide parçası düşerse, bir guide parçası yalnız
ince duvarla tutunuyorsa (< 1,5 mm) ya da guide oturma yönünde kemikten çıkarılamıyorsa uyarı hemen yazdırılır, sonda
yeniden listelenir ve `plan.json`a girer. Planlama hatasında `run_pipeline.py` 2 ile çıkar; `plan.json` yine yazılır.
`plan.json` ve sunucu yanıtları yazılım sürümünü (`software` / `version`) taşır.

## Kod yapısı

```
surgiguide/volume.py    DICOM okuma/yazma, fiziksel koordinatlar
surgiguide/phantom.py   sentetik mandibula ve (sağ) bacak BT fantomları
surgiguide/segment.py   eşik tabanlı ve TotalSegmentator segmentasyon
surgiguide/bones.py     birleşik kemikleri ayırma, mandibula / fibula seçimi (tarayıcıdaki web/bones.js ile aynı kurallar)
surgiguide/meshing.py   maske -> mesh, yönlendirilmiş yerel ızgara
surgiguide/plan.py      ark merkez hattı (kondilden kondile), fibula ekseni, segment optimizasyonu, kesim düzlemleri
surgiguide/guides.py    hattın fibula ve mandibula guide'ları, duvar ve oturma kontrolü, rezeksiyon, greft transferi
surgiguide/render.py    PNG önizleme
surgiguide/version.py   sürüm damgası (/health, yanıtlar, STL başlığı, plan.json)
run_pipeline.py         uçtan uca komut
seg_server.py           segmentasyon servisi ve ortak HTTP katmanı (kimlik, CORS, güvenlik başlıkları, gövde okuma)
yolmed_server.py        stüdyonun sunucusu: vaka kaydı, üretim STL'i (/guide), segmentasyon, statik dosyalar
web/                    tarayıcı stüdyosu
tests/                  testler (aşağıda "Testler")
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

- Otomatik testler yalnız sentetik fantom ve örnek vakayla çalışır; anonim gerçek BT ile yalnız denetimlerde (elle)
  denendi, klinik doğrulama yapılmadı. Gerçek hastada eşik segmentasyonu kontrastlı damarları ve dişleri kemiğe
  katabilir, TotalSegmentator önerilir (bazı görevleri lisans anahtarı ister; lisans koşullarını kontrol edin).
- Ark merkez hattı gövdede açısal bölmeyle, ramuslarda dilim merkezleriyle kondile kadar çıkarılıyor; ramus/kondil
  rezeksiyonu planlanabilir ama gerçek vakalarla doğrulanmadı.
- Greft ekseni mandibula merkez hattına hizalanıyor; alt kenar hizalaması, dikey konum (implant
  için) ve çift namlu (double-barrel) henüz yok.
- Perforatör damar konumu plana girmiyor (BTA'dan damar segmentasyonu eklenmeli).
- Guide'lar yarım kabuk; diş/alveol üzerine oturma, kenar yuvarlatma ve baskı toleransı ayarı yok.

## Guide stüdyosu ve sunucu (web/ + yolmed_server.py)

- `web/`: tarayıcı stüdyosu (statik dosyalar; herhangi bir web sunucusundan açılır). Vaka kaydı, sürüm geçmişi,
  geri alma, aksiyel/koronal/sagittal kesitler, oturma analizi, sıkıştırılmış DICOM (codecs.js), fibula akışı (fibula.js).
- `python3 yolmed_server.py --backend threshold --port 8800 --db ./yolmed_cases.sqlite --web ./web`: segmentasyon
  (`/segment`), vaka kaydı (`/cases`, yalnız plan JSON'u, görüntü saklanmaz), su geçirmez üretim STL'i (`/guide`) ve
  stüdyonun kendisi (`/`). Uç noktaların listesi `yolmed_server.py` başındadır.
- Stüdyo sunucuya ulaşırsa vakaları sunucuya, ulaşamazsa yayınlanan sayfanın kendi veritabanına ya da tarayıcıya kaydeder.

### İki guide ailesi

- **Stüdyo / sunucu guide'ı** (`web/app.js buildGuide` önizlemesi, `yolmed_server.py build_guide` üretimi): takma
  yönüne göre zarf üzerinde gövde, konuma göre sarma, kesi yuvaları, zarftan uzak vida kılıfları ve delikler. Önizleme
  tarayıcıda 0,4 mm, üretim sunucuda 0,2 mm ızgarada aynı tasarımı yeniden hesaplar; aynı istek her zaman aynı STL'i verir.
  İkisinin farkı `tests/test_server_preview.py` ile ölçülür (yüzey uzaklığı p95 / p99 / en büyük, hacim oranı).
  Cerrahın onayladığı ve basılan guide budur.
- **Hat guide'ı** (`run_pipeline.py`, `surgiguide/guides.py`): komut satırı hattının basit voksel CSG guide'ları
  (yarım kabuk, yuvalar, ray). Stüdyonun tasarımıyla aynı değildir; araştırma ve karşılaştırma içindir.

### Üretim yanıtı

`/guide` yanıtındaki `production_ok` false ise STL olduğu gibi basılmamalıdır; `issues` sebebi söyler:
`screw_no_body` (bir vida ne kılıf ne delik aldı; `screws_missing` hangi vidalar), `resolution_coarsened` (ızgara
`MAX_GRID` yüzünden istenenden kaba; `coarser_than_preview` önizlemeden de kaba ise), `not_manifold` (onarımdan sonra da
kapalı değil). STL başlığında ve yanıtta sürüm (`version`) ve ızgara yazılıdır; `repair` onarılan yüzleri sayar.

### Ortam değişkenleri

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8800` | dinlenen adres (Docker'da `0.0.0.0`; Railway `PORT`'u kendisi verir) |
| `YOLMED_DB` | `./yolmed_cases.sqlite` | vaka veritabanı (Docker: `/data/yolmed_cases.sqlite`) |
| `YOLMED_WEB` | yok | stüdyonun klasörü (Docker: `/app/web`) |
| `YOLMED_TOKEN` | yok | verilirse `/cases*`, `/guide`, `/segment` `Authorization: Bearer <token>` ister (yoksa 401); `/health` ve statik dosyalar açık |
| `YOLMED_ALLOWED_ORIGINS` | yok (yalnız aynı köken) | başka adresten açılan stüdyolar, virgülle (`https://a.example,http://localhost:8000`); `*` herkese açar |
| `YOLMED_ALLOW_PRIVATE_NETWORK` | kapalı | `1`: izinli kökenlere `Access-Control-Allow-Private-Network` (kamuya açık sayfadan yerel ağdaki sunucuya) |
| `YOLMED_CSP_CONNECT` | yok | CSP `connect-src`'ye eklenecek adresler (stüdyo başka bir sunucuya bağlanıyorsa) |
| `YOLMED_GUIDE_JOBS`, `YOLMED_SEG_JOBS` | `1`, `1` | aynı anda çalışan guide / segmentasyon işi |
| `YOLMED_UPLOADS` | `6` | aynı anda okunan istek gövdesi |
| `YOLMED_BODY_MAX_S` | `600` | bir istek gövdesinin en uzun okunma süresi (s) |
| `YOLMED_VERSION` | git commit'i | sürüm damgasını elle verir (yoksa `RAILWAY_GIT_COMMIT_SHA`, Docker `GIT_SHA`, `git describe`) |

### Sınırlar

- `/guide` gövdesi en çok ~179 MB (`MAX_BODY`: 128 M voksellik kırpma maskesi base64 + plan), vaka istekleri 4 MB,
  `/segment` 256 MiB (int16). Vaka adı ve sürüm yazarı en çok 200 karakter.
- Gövde, iş sırasına girmeden önce tümüyle okunur. Her 10 saniyede en az 256 kB gelmeli (yaklaşık 26 kB/s; daha
  yavaş istemci 408 alır) ve gövde `YOLMED_BODY_MAX_S` içinde bitmeli. Okunan istek iş için en çok 120 s bekler (503).
- Guide ızgarası en çok 40 M hücre (`MAX_GRID`); daha büyük guide daha kaba ızgarada üretilir ve yanıtta
  `resolution_coarsened` olarak bildirilir (sessiz değil).
- JSON'da `NaN` / `Infinity` kabul edilmez (400); yanıtlar da standart JSON'dur.

### Güvenlik

- Kamuya açık her kurulumda `YOLMED_TOKEN` verin. Token yoksa ve sunucu yerel olmayan bir adreste dinliyorsa açılışta uyarı
  yazılır. Token sabit zamanlı karşılaştırılır; stüdyo `config.js`'teki `YOLMED_AUTH` ile token gerektiğini öğrenir.
- CORS varsayılan olarak kapalıdır (yalnız aynı köken). Her yanıtta `Content-Security-Policy` (self + `cdn.jsdelivr.net`
  + Google Fonts; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff` ve sürüm başlığı (`X-Yolmed-Version`); `X-Forwarded-Proto: https` arkasında HSTS.
- Hatalar istemciye genel bir mesajla döner, ayrıntı (traceback) sunucu günlüğüne yazılır. Erişim günlüğü stdout'a gider.
- `/health` veritabanına gerçekten yazılabildiğini de denetler; yazılamıyorsa 503 döner (Railway sağlık denetimi).
- Docker imajı sunucuyu yetkisiz `yolmed` kullanıcısıyla çalıştırır (`docker-entrypoint.sh` `/data`'yı ona verir).

## Testler

Yalnız sentetik veri ve örnek vaka kullanılır; hasta verisi depoya girmez. Python 3.12+ (`pip install -r requirements.txt`)
ve Node 22 gerekir.

```bash
sh tests/run_all.sh          # hızlı takımlar (~5 dk; CI bunları her push'ta çalıştırır: .github/workflows/tests.yml)
sh tests/run_all.sh slow     # yavaş takımlar: yavaş istemci, guide kalitesi, önizleme-üretim farkı, tarayıcı birim testleri
sh tests/web/unit/run_all.sh # yalnız tarayıcı birim testleri (bir takım başarısızsa 1 ile çıkar)
```

- `tests/server/`: sunucu regresyon testleri (kimlik, CORS, başlıklar, gövde sınırları, yavaş istemci, STL onarımı).
- `tests/test_bones.py`, `tests/test_pipeline.py`: kemik seçimi ve hat; `tests/test_server_preview.py`: üretim ↔ önizleme.
- `tests/web/unit/`: tarayıcı modülleri Node'da (`lib/t.mjs`; her test `T_TIMEOUT` ms, varsayılan 300000, içinde bitmeli).
- `tests/web/e2e/`: Playwright senaryoları (elle; `tests/web/e2e/README.md`).

## Üçüncü taraf yazılım (SOUP)

Sürümler sabittir (`requirements-server.txt`, `requirements.txt`, `web/index.html`, `web/codecs.js`); bir sürüm ancak
tüm testler (`sh tests/run_all.sh all`) geçtikten sonra değiştirilir.

| Bileşen | Sürüm | Nerede / amaç | Hata olursa etkisi |
|---|---|---|---|
| numpy | 2.5.3 | her yerde, dizi hesabı | geometri hatası |
| scipy | 1.18.1 | mesafe dönüşümü, morfoloji, interpolasyon | yanlış kabuk / boşluk |
| scikit-image | 0.26.0 | marching cubes | STL yüzeyi |
| manifold3d | 3.5.4 | üretim STL'inde mesh sadeleştirme | STL yüzeyi |
| trimesh | 5.1.1 | mesh kontrolü (su geçirmezlik, hacim), hat STL'leri | yanlış "su geçirmez" raporu |
| SimpleITK | 2.5.6 | DICOM serisi okuma (hat) | yanlış hacim / aralık |
| pydicom | 3.0.2 | DICOM etiketleri (hat) | yanlış seri / yön |
| fast-simplification, shapely, matplotlib | 0.2.0, 2.2.0, 3.11.2 | hat: sadeleştirme, kesitler, PNG | yalnız hat çıktıları |
| three.js | 0.147.0 | stüdyo 3B görünüm, önizleme mesh'i | ekranda yanlış görüntü |
| dicom-parser | 1.8.21 | stüdyoda DICOM okuma | yanlış hacim / aralık |
| cornerstone codec'leri (charls 1.2.7, openjpeg 1.3.6, libjpeg-turbo 1.2.8 / 0.4.7), jpeg-lossless-decoder-js 2.1.2 | | sıkıştırılmış DICOM | yanlış HU |
| TotalSegmentator | sabit değil, isteğe bağlı | yapay zeka segmentasyonu (hat, `seg_server --backend totalseg`) | yanlış kemik maskesi |

## Railway'e yayın

Depo Dockerfile ile tek servis olarak çalışır: stüdyo `/` adresinde, vaka kaydı `/cases`, segmentasyon `/segment`,
üretim STL'i `/guide`. Stüdyo aynı adresteki sunucuyu kendiliğinden kullanır.

1. Railway'de **New Project → Deploy from GitHub repo** ile bu depoyu seçin (Dockerfile otomatik bulunur).
2. Servise bir **Volume** ekleyip `/data` yoluna bağlayın; vakalar `/data/yolmed_cases.sqlite` dosyasında tutulur
   (volume olmadan her yeniden yayında silinir).
3. **Settings → Networking → Generate Domain** ile adres alın.
4. **Variables** altında `YOLMED_TOKEN` verin (uzun, rastgele bir değer; ekibe ayrı kanaldan iletilir). Token olmadan
   adresi bilen herkes kayıtlı vakaları görebilir. Stüdyo başka bir adresten açılacaksa `YOLMED_ALLOWED_ORIGINS`.

Railway her yayında commit'i `RAILWAY_GIT_COMMIT_SHA` ile verir; `/health` ve her STL hangi kodla üretildiğini gösterir.
