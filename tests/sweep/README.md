# Rezeksiyon tarama düzeneği (sweep)

Guide Studio'nun varsayılan akışını bir **rezeksiyon bölgesi × boy × taraf** ızgarası üzerinde koşturur ve her koşuda
uygulamanın kendi raporladığı her şeyi kaydeder: plan, kesiler, rezeke hacim, mandibula guide'ı (parça, alttan kesik, takma
yönleri, aralık bandı, vidalar, L/W/sarma, iki guide), fibula planı (segment sayısı ve boyları, kesi açıları, sapma), fibula
guide'ı, tüm kontrol mesajları, onay engeli ve süreler. Aynı ızgara Python hattında (`run_pipeline.py`) da koşulur.
Uygulama kodu değiştirilmez; sayfa yalnız okunur yardımcılarla (`sweep_page.js`, `window.SW`) sürülür.

## Tek komut

```bash
SG_REPO=/home/user/surgical-guide \
DATA=<scratch>/ct \                      # m_bone/ ve f_125/ (her biri tek DICOM serisi) burada; yoksa VERI'den açılır
VERI=/mnt/.../denetim3/veri \            # mandibula_anon.zip + fibula_anon.zip (yalnız seri çıkarmak için)
OUT=<scratch>/tarama_out \
bash tests/sweep/run_sweep.sh            # sunucu + tarayıcı taraması + pipeline taraması + özet
```

Adım seçimi: `ONLY="app"` (yalnız tarayıcı), `ONLY="pipe"`, `ONLY="sum"`. Izgara filtreleri: `REGIONS=body,angle`
`LENGTHS=20,45` `SIDES=L` `DATASETS=sample` `PIPE_DATASETS=demo` `PIPE_LENGTHS=20,45,80`. Sunucu `PORT=8870`
(`BASE` ile çalışan bir sunucu da verilebilir). Bitmiş koşular (`OUT/runs/<id>.json`) atlanır; `FORCE=1` yeniden koşturur.

Gereksinimler: Node 22, Playwright (`PW_MODULE`, varsayılan `/opt/node-tools/node_modules/playwright`), Chromium
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, SwiftShader ile başsız), Python 3 + depo bağımlılıkları (yolmed_server,
SimpleITK, trimesh, pydicom, Pillow), `curl` (CDN betikleri bir kez indirilip `CDN_CACHE` altından sunulur; tarayıcı
internete çıkmaz).

## Izgara

| bölge | yer (ark modeli, s = orta hattan ark boyu mm, + = hasta solu) |
|---|---|
| symphysis | s = ±4 (orta hattın hemen yanı; taraf anlamlı olsun diye) |
| parasymphysis | s = ±0,30 · yarım ark |
| body (lateral gövde) | s = ±0,62 · yarım ark |
| angle (angulus) | s = ark ucu − 6 mm (gövde bandının arka ucu) |
| ramus | angulus → kondil doğrusunun %45'i (Ref kondili; yoksa o taraftaki en yüksek kemik) |
| condyle (kondil dahil) | aynı doğruda, lezyon üst ucu kondile gelecek şekilde; `Rezeksiyon tipi = Kondil dahil` seçilir |

Boylar 20, 30, 45, 60, 80 mm (lezyon `from = −L/2`, `to = +L/2`, pay 3 mm; kesiler guide ekseni boyunca ±(L/2+3)),
taraflar sol / sağ. Ark modeli `surgiguide/plan.py Arch` ile aynı fikir: mandibulanın en alt 24 mm'lik bandı, merkez
etrafında 2°'lik kutupsal dilimler, dilim merkezlerinden ark boyu.

Her koşu (taze tarayıcı): sayfa → (gerçek veri: mandibula serisi yükle) → `SW.setRegion`: `Studio.anchorFromLesion` ile
bölge merkezinin üstündeki bukkal yüzeye guide merkezi, `Rezeksiyon sınırı` kaydırıcıları, (kondil) `#resType`,
`Kesileri sınıra göre koy`, `Otomatik planla` (rezeke parça gizlenir, guide + vidalar, sarma/iki guide denemesi) → fibula
(örnek bacak ya da gerçek seri; segment sayısını ve fibula guide'ını uygulama kendisi seçer) → `SW.extract`.
Planlama bütçesi veri yüklendikten sonra `RUN_BUDGET_MS` (120 sn); aşılırsa `timeout` olarak kaydedilir.

## Çıktılar (`OUT/`)

| dosya | içerik |
|---|---|
| `runs/<id>.json` | koşunun tüm ham verisi (setup, ark, anchor, plan, guide sonucu, fibula, kontroller, konsol hataları, süreler) |
| `tarama_app.csv` | koşu başına bir satır (tarayıcı) |
| `pipe/runs/<id>.json`, `pipe/<id>/plan.json`, `pipe/tarama_pipe.csv` | pipeline koşuları (STL'ler ölçülüp silinir) |
| `ekran/*.jpg` | başarısız her koşu (mandibula 3B, fibula 3B, Kontroller sekmesi) ve her 5. geçen koşu; pipeline uyarılı/başarısız koşuların önizlemeleri |
| `tarama.csv`, `matris.md` | `summarize.py`: birleşik tablo + OK / warn / fail hükümleri, bölge × boy × taraf matrisleri, en sık mesajlar |

Hüküm kuralları `summarize.py` başındadır (mandibula guide'ı: parça sayısı, takma yönü, guide/kesi/vida kritikleri; fibula
planı: segment < 20 mm, fibula yetmiyor, distal; fibula guide'ı: parça, takma yönü, vida kritikleri; onay: herhangi bir
kritik kontrol = engelli).

## Pipeline taraması

`pipeline_sweep.py` bölgeleri hattın kendi ark koordinatına çevirir (`--resect-from/--resect-to`); ark uzunluğu veri
başına bir kez `segment.mandible_bone + plan.Arch` ile ölçülür (`pipe/arch_<veri>.json`: `sMin/sMax` kondilden kondile,
`bodyMin/bodyMax` angulustan angulusa). Gövde bölgeleri gövde arkına, angulus gövde ucuna, ramus angulus→kondil yolunun
%45'ine, kondil hücresi ark ucunun 2 mm altına (kondile açık) yerleşir; eski ark dosyalarında (`body*` yok) ark ucu kullanılır. `--side` (verici bacak) rezeksiyon tarafına
eşitlenir. Gerçek BT koşusu ~2 dk ve ~5 GB bellek ister; varsayılan boylar 20, 45, 80.

## Dosyalar

`sweep.js` (tarayıcı sürücüsü, CSV), `sweep_page.js` (sayfaya enjekte edilen ark modeli / bölge / çıkarım),
`pipeline_sweep.py`, `summarize.py`, `extract_series.py` (zip'ten tek seri), `run_sweep.sh`.
