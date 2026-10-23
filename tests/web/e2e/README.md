# Denetim 3 · e2e test düzeni (Playwright + SwiftShader)

Tek komut (yerel sunucuyu kendisi başlatır, tüm senaryoları sırayla tek tarayıcıyla çalıştırır, sonunda `../kanit/tablo.md` üretir):

```bash
REPO=/home/user/surgical-guide PORT=8840 bash run_all.sh       # A1 A2 A3 K C D F G H E Y3 B (gerçek BT dahil ~60-90 dk)
ONLY="A1 A2 A3 C D F E Y3" bash run_all.sh                       # gerçek BT olmadan (~45 dk)
D_LIVE=0 bash run_all.sh                                          # canlı site duman testi olmadan
KANIT=/scratch/kanit E2E_SCRATCH=/scratch/e2e bash run_all.sh     # kanıt ve geçici dosyalar depo dışında
YOLMED_TOKEN=gizli ONLY=A1 bash run_all.sh                        # erişim anahtarlı sunucu: tarayıcı anahtarı diyaloğa yazar
```

Her senaryo CSP ihlallerini (`securitypolicyviolation`) ayrı hata türü (`csp`) olarak sayar; `tablo.md` toplamı verir.

Gereksinimler (kurulum yapmaz): Node 22, Playwright `/opt/node-tools/node_modules/playwright` (`PW_MODULE` ile değiştirilebilir),
Chromium `PLAYWRIGHT_BROWSERS_PATH` altında, Python 3 + depo bağımlılıkları (`yolmed_server.py`, manifold3d, trimesh), `unzip`, `pdfinfo`/`pdftotext`, `curl`.
Gerçek BT zip'leri `VERI` (varsayılan `../../veri/`) altında: `mandibula_anon.zip`, `fibula_anon.zip`.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `lib.js` | Tarayıcı açma (`--use-angle=swiftshader --enable-unsafe-swiftshader`, 1440×900), konsol/pageerror/requestfailed kaydı, CDN dosyalarını curl ile önbellekten sunma, `idle()` (meşgul katman kapanana kadar bekle), 3B yardımcılar (`proj` dünya→ekran, `hits` ekranda kemik/guide noktaları, `drag3d`), çevrilmemiş metin taraması, senaryo kaydı (`run`) |
| `A1_flow.js` | Örnek vaka, 8 adım sırayla: yükleme, eşik, seg düzeltme (fırça/silgi), katman, Otomatik planla, kesiyi 3B'de fareyle sürükleme (Kemik boyunca / Guide ekseni), geri al/ileri al, tek/iki guide, vida ekle/taşı/sil, fibula 3/2/1 segment, implant, plak, onaylar, üretim STL'i, paket zip içeriği, PDF, HTML, 3MF, tek STL'ler |
| `A2_persist.js` | Kaydet → yenile → yeniden aç, vaka listesi, geri al/ileri al ×3, geçmiş paneli, sürüm yükleme, yeni vaka temizliği, onaylı planın yeniden açılması / geri alınması |
| `A3_i18n_ui.js` | Ayarlar, yardım, TR→EN her adım + sağ panel + diyaloglar (görünür Türkçe metin taraması), EN'de dinamik metinler, EN→TR, dil tercihinin kalıcılığı |
| `B_real.js` | Gerçek anonim BT: bozuk zip / rastgele zip / .txt / sahte .dcm, mandibula zip (6 seri), seri seçici (0.625mm Bone), Kontroller sekmesi QC, fibula zip, gerçek veride lateral gövde rezeksiyonu, fibula 1-3 segment, plak, onay, sunucuda üretim STL'i, paket; guide STL'leri + plan → `kanit/real/` |
| `K_default_real.js` | Varsayılan gerçek BT akışı, kutudan çıktığı gibi: parametresiz açılış (anonim gerçek BT mandibula), Otomatik planla, gerçek BT fibula örneği + fibula guide, onaylar, sunucuda üretim STL'i (ilerleme çubuğu geri gitmez), paket (3MF üçgen sayısı = üretim STL'leri), tek STL indirme |
| `C_edge.js` | Yükleme sırasında iptal / ikinci dosya / sayfa yenileme, fibula görünümünde mandibula etkileşimi, farklı eşikle eski planı açma, ramusa yakın 46 mm rezeksiyon, kondil dahil rezeksiyon + yeniden açma, çok kısa segment, önceki denetim bulgularının yeniden kontrolü, sunucu kapalıyken üretim STL'i |
| `E_roll.js` | Guide kemik etrafında −180…180° kaydırılınca her vida kemikte ≥ 4 mm ve gövde altında |
| `Y3_plate_undo.js` | Guide 50 mm + plak + "Vidaları plağa hizala" + onaylar → kesi değişikliği → geri al: plate bayrakları, onaylar ve paketteki plak dosyaları geri gelir |
| `D_small_live.js` | 1024×768 anahtar ekranlar (taşma/kesilme ölçümü), üst çubuk, canlı sitede salt okunur duman testi (yalnız GET; POST/PUT engelli, otomatik kayıt kapalı) |
| `tablo.js` | `kanit/*/results_*.json` → `kanit/tablo.md` |

Her senaryo `kanit/<grup>/` altına ekran görüntüsü (jpg), `console_<koşu>.log` ve `results_<koşu>.json` yazar.
Tek bir senaryo dosyası da doğrudan çalışır: `BASE=http://127.0.0.1:8840 node A1_flow.js` (sunucu açık olmalı).
