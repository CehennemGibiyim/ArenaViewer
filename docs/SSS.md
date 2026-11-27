# S.S.S. — Sık Sorulan Sorular (kurulum, çalıştırma, yapay zekâ)

> Bu dosya, ATIKVIEWER'ı ilk kez kullananların en çok sorduğu soruları ve dürüst cevaplarını toplar.
> Arayüzün karşılığı uygulama içindeki **`/yardim`** sayfasıdır — ikisi **aynı soruları** taşır;
> biri güncellenirse diğeri de **aynı PR** içinde güncellenir (kural: [KILAVUZ_BAKIMI.md](KILAVUZ_BAKIMI.md)).
> Son güncelleme: 2026-11-26.

## 1. Yapay zekâ analizi için AI worker'ı ayrıca başlatmam gerekiyor mu?

**Evet — gereklidir.** Görüntüleyici (Node.js/Next.js) yapay zekâ modellerini kendi içinde
çalıştırmaz. Gerçek çıkarım, ayrı bir **yerel** süreçte çalışır:

```
python ai-worker/server.py     # 127.0.0.1:8787 — yalnız bu makinede dinler
```

Windows'ta tek tuş: `windows\Baslat.bat` (AI worker + görüntüleyici + tarayıcı birden).
Linux/macOS: `bash packaging/linux/install.sh` veya `packaging/macos/install.sh` kurulumu tamamlar;
ai-worker'ı elle başlatmanız gerekir. Docker: `docker compose --profile ai up -d`.

Worker kapalıysa:

| Sonuç | Davranış |
|---|---|
| BT analizi | **Kural tabanlı** (heuristic) motora düşer; ekranda `worker: kapalı` uyarısı çıkar |
| CXR (göğüs grafi) skoru | Çalışmaz (yerel ONNX, worker üzerinden koşar) |
| Beyin kanama (ICH) | Çalışmaz (147 MB ağırlık gerekir) |
| Diz MR segmentasyonu | Çalışmaz (ayrı ~1,6 GB kurulum: `setup_knee_model.py`) |

## 2. Peki bir görüntüyü nasıl analiz ederim — "otomatik" algılar mı?

**Kendiliğinden çalışmaz; siz başlatırsınız.** Görüntüyü açmak AI'ı tetiklemez (bu bilinçli bir tasarımdır —
research etiketli çıktılar, karar desteği değil). Adımlar:

1. DICOM'i açın (klasör/dosya/ZIP sürükle-bırak veya çalışma listesinden seçin).
2. Sağ panelde **Vision AI** sekmesine geçin.
3. **Analiz protokolünü** seçin: `Otomatik` · `Tüm karelerde görüntü ölçümü` · `BT Beyin — kanama adayı` · `BT Toraks — nodül adayı` · `İncelemeyi kapat`.
4. **▶ Analizi başlat** (kaç kare/kesit işleneceği düğmede yazar).
5. Sonuçlar **TASLAK** olarak rapora girer; "KLİNİK KARAR İÇİN KULLANILAMAZ" etiketiyle işaretli olan
   adayları **radyoloji uzmanı** gözden geçirir; onay onun sorumluluğundadır.

İsteğe bağlı: **Tüm yüklenen serileri birlikte AI ile analiz et** düğmesi, birden çok seriyi sırayla işler.
Gölge mod açıkken (`NEXT_PUBLIC_AI_SHADOW_MODE=true`) AI adayları rapora/ekrana **hiç girmez**, yalnız
`shadow_findings` tablosuna yazılır — doğrulama süreci için kullanılır.

## 3. Worker'ın gerçekten çalıştığını nasıl anlarım?

- Terminalde `ATIKVIEWER AI worker: http://127.0.0.1:8787` satırı + `Model yüklendi.`
- `curl http://127.0.0.1:8787/health` → `{"ok": true, ...}`
- Ya da tarayıcıda **📦 Kurulum** sayfası (`/paketler`) → AI durumu kartı (model dosyaları + erişim).
- Ana ekranın alt şeridindeki `HAZIR / ANALİZ: …` ifadesi görüntüleyicinin durumudur, worker'ın değil.

## 4. Web demosunda (GitHub Pages) AI çalışır mı?

**Hayır.** Statik demoda `/api/*` uçları yoktur; AI düğmeleri çalışmaz, `/ayna` demo etiketlidir.
Arayüzü ve iş akışını görmek içindir; gerçek görüntüyle çalışmak için yerel/kurum kurulumu gerekir.
Adres: `https://cehennemgibiyim.github.io/ArenaViewer/` (hem kurulum hem arayüz tanıma).

## 5. GPU şart mı? Kaç GB indirme var?

GPU **şart değil**; CPU'da da çalışır ama yavaştır (diz MR'da ~80 sn/hacim). İndirmeler:

| Bileşen | Boyut |
|---|---|
| CXR modeli (depoda) | 28 MB |
| MONAI BT toraks | ≈ 84 MB |
| Beyin kanama (ICH) | ≈ 147 MB |
| Diz MR (nnU-Net, opsiyonel) | ≈ 1,6 GB (`Kurulum.bat -Knee` veya `setup_knee_model.py`) |

## 6. PostgreSQL kurmadan çalışır mı?

**Görüntüleyici + ölçüm + AI için evet.** DB yoksa yalnız **kalıcı** özellikler çalışmaz:
çalışma listesi, sunucuya kaydetme, kayıtlı raporlar, denetim kaydı, STOW-RS geri yazma.
Denemek için yeterli; kurumsal kullanım için PostgreSQL 16+ önerilir (Docker yolunda otomatik).

## 7. Verilerim dışarı çıkar mı?

Hayır. Worker yalnız `127.0.0.1`'de dinler; görüntü/hasta verisi makinenizden ayrılmaz.
İsteğe bağlı LLM taslak izlenim özelliği açıkken bile yalnız hekimin onayladığı bulgu metinleri
(hasta kimliği **olmadan**) yapılandırılan servise gider; varsayılan kapalıdır.

## 8. AI raporu neden "TASLAK" ve kırmızı uyarıyla geliyor?

ATIKVIEWER bir **tıbbi cihaz değildir** ve tanı koymaz. Tüm çıktılar araştırma taslağıdır;
rapor onayı, içeriğin sorumluluğu radyoloji uzmanındadır. Bu etiket kaldırılamaz.

## 9. Kırmızı "ConnectionResetError / WinError 10054" traceback'i görüyorum. Arıza mı?

Hayır. Keep-alive bağlantısını istemci aniden kapattığında worker yığın izi basardı; **2026-11-26**
güncellemesiyle tek satır loga indi (`istemci bağlantıyı kapattı (istek yok, yoksayıldı)`).
`git pull` ile alın; worker çalışmaya devam eder, `/health` 200 dönmüştür.

## 10. Kurulum adımlarını ve menülerin ne işe yaradığını nereden öğrenirim?

- Kurulum (tüm işletim sistemleri, görsel + videolu): [KURULUM_VE_KULLANIM.md](KURULUM_VE_KULLANIM.md)
- Her düğme/menü: [MENU_KILAVUZU.md](MENU_KILAVUZU.md) (numaralı ekran haritasıyla)
- Windows ayrıntı: [WINDOWS_KURULUM.md](WINDOWS_KURULUM.md)
- Bu SSS'nin uygulama içi karşılığı: **`/yardim`** sayfasıdır (adres Türkçe karaktersizdir).

## 11. Görüntü açılmıyor / DICOM hatası alıyorum.

Dosyanın gerçekten DICOM olduğundan emin olun (`.dcm`, `.ima`; JPEG/TIFF değilse). Şifreli/bozuk
dosyalar desteklenmez. Sık karşılaşılan hatalar ve Windows özel durumlar: [WINDOWS_KURULUM.md §6](WINDOWS_KURULUM.md).

## 12. Raporu nasıl onaylarım / PDF alırım?

Vision AI sonuçları **TASLAK** rapora düşer → sağ panel **Rapor** sekmesi → **📄 Raporu aç** →
içerik/anahtar kesitler düzenlenir → **Onayla** (kilitlenir) → **🖨 Aç / yazdır** veya DICOM SR dışa aktarım.
Onaylanan sürümler `Geçmiş` sekmesinde listelenir.

## 13. Yeni bir AI modülü eklenecek mi? "BT kolon polip", "kalça kırığı"?

Adaylar `/kiyaslama` sayfasında **"Önerilen aday modüller — henüz kod yok"** listesinde durur
(BT kolongrafi polip, DX kalça kırığı, CXR RSNA pnömoni 2. skor). Her biri ancak
**açık kaynak model + yerelde çalışma + research etiketi + kurum doğrulaması** çerçevesinden geçince eklenir;
doktor talepleriniz öncelik sırasını belirler. Ayrıntı: [KURULUM_VE_KULLANIM.md §7](KURULUM_VE_KULLANIM.md).

## 14. Tema seçiyordum ama renkler değişmiyordu — düzeldi mi?

Evet (2026-11-26). Seçici her zaman çalışıyordu; ancak arayüzün yüzey/kenar renkleri sabit hex olduğundan
hiçbir şey değişmiyor gibi görünüyordu. Tüm yapısal renkler artık `globals.css` değişkenlerine bağlıdır;
`Koyu (Varsayılan)` eski görünümle birebir, `Klinik Mavi`, `Açık Tema` (kontrast ≈18:1) ve
`Yüksek Kontrast` artık gerçekten uygulanır. Seçim `atik-theme` anahtarında saklanır.
Ayrıntı: [GORSEL_ANLATIM.md §7.1](GORSEL_ANLATIM.md).

## 15. Dili nasıl değiştiririm? Kaç dil destekliyorsunuz?

Üst çubuktaki **🌐 Dil seç** düğmesinden seçebilirsiniz (arama kutusuna yazmak yeterli). İki katman vardır:

1. **Çevirisi hazır 83 dil** — `tr en es fr de it pt nl pl ru uk cs sv ro hu bg ar he hi zh ja ko id th bn ur fa ta te mr gu kn ml pa or vi ms fil ceb da fi el sk sl et lv lt sr hr bs mk sq hy ka az kk ky uz mn sw ha yo ig zu af am ne si my km lo rw so mg ht ca eu gl tuk tat uig bak crh`. Seçtiğiniz dil paketi **anında ve yalnız o dil** indirilir; yedek İngilizce.
2. **ISO 639-3'teki 7.027 canlı dilin tümü** — 2+ harf yazınca listelenir. Çevirisi henüz yapılmamış bir dili de seçebilirsiniz: arayüz **İngilizce yedeğiyle** açılır ve "EN UI" rozetiyle işaretlenir; o dilin çevirisi katkı ile beklenir.

Çeviriden dürüstçe yapılmayan seçenek yok sayılmış değildir; fakat 7.000+ dilin her biri için **doğrulanmış** çeviri ancak katkının kendisiyle gelir — bu yüzden her çevirisi olmayan dil açıkça "İngilizce arayüz" etiketiyle işaretlidir, makine çevirisiyle doldurulmuş paket asla yayımlanmaz. Çevrilen katman arayüzün kromudur (üst çubuk, durum şeridi, ortak düğmeler, Tema/Dil seçicileri). **Belgeler, AI rapor gövdesi ve bazı uzun metinler henüz yalnız Türkçe'dir.**
`ar`/`he` seçiminde ekran okuyucu dili doğru ayarlanır; yerleşim LTR kalır. Yeni dil eklemek tek komut: `npm run i18n:new` + anlamlı çeviri + `npm run test:i18n` (ayrıntı: [CEVIRI_KATKI.md](CEVIRI_KATKI.md)). Ayrıntı: [GORSEL_ANLATIM.md §7.3](GORSEL_ANLATIM.md).

## 16. Görsel anlatım nerede? Nasıl bu kadar az yer kaplıyor?

**Uygulama içinde: `/resimlianlatim`** — ilk açılıştan rapor onayına kadar her adım, gerçek ekran görüntüleriyle;
her adımda "nerede / ne yapılır / ne olur" ve o adımın statik web demosunda mı yoksa yalnız yerel kurulumda mı
yapılabildiği yazar. Bağlantılar: ana ekran araç çubuğu (**🖼 Resimli anlatım** ve bağlamsal **?**
düğmesi → doğrudan ilgili bölüm), `/yardim` sayfası ve `/tercihler` (Ayarlar) alt bölümü. Sayfa tamamen statiktir, GitHub Pages demosunda da açılır; görseller
`public/kilavuz/` altındadır ve `docs/img/` ile **bayt bayt aynıdır** (`tests/guide-story.test.ts` denetler).

Belge hâli: **[GORSEL_ANLATIM.md](GORSEL_ANLATIM.md)** — uçtan uca, ekran ekran. PDF sürümü tag (`v*`) yayımında
Release asset'i olarak üretilir (`.github/workflows/docs-pdf.yml`). Görseller sıkıştırılmış JPEG (q82,
~52–84 KB) ve elle çizilmiş SVG şemalardır; toplam ≈ 653 KB. Lisanslı/dış kaynaklı PDF'ler depoya
alınmaz, yalnızca özgün şemalar kullanılır; PDF dağıtımı isterseniz `pandoc` ile üretip Release'e koyarız.

## 17. Bu belge ile uygulama içi `/yardim` sayfası farkı?

Yok — **içerik aynıdır**. Uygulama sürümü belgeyi sadeleştirir ama soru listesi ve cevaplar bire bir eşlenir;
biri güncellenmeden diğeri güncellenemez (CI denetimi: kılavuz bakımı kuralı).

## 18. Yönetim panelindeki «Sistem sağlığı» neyi denetler, neyi denetlemez?

`/api/admin/health` **12 kuralı** ortam değişkenlerine bakar (kimlik modu, TLS zorunluluğu, anahtar kaynağı,
veritabanı, depo, `METRICS_TOKEN`, SIEM aktarımı, LLM, istem alımı, HBYS, MFA zorunluluğu, sürüm) ve
liveness/readiness ile `/api/metrics` metinlerini ayrıştırıp gösterir. Sır değerleri (anahtar, parola, jeton)
**hiçbir zaman yanıta yazılmaz** — yalnız «tanımlı / tanımsız».

Denetlemedikleri dürüstçe: gerçek PACS/HBYS bağlantısı, model doğruluğu, disk doluluğu, TLS sertifika süresi.
Bunlar için `Yönetim → Entegrasyon` testleri, `docs/KLINIK_DOGRULAMA_PLANI.md` ve kurumun izleme sistemi gerekir.
Statik web demosunda DB/TLS olmadığı için kart **kırmızı** görünür; yanıt bunu «DEMO VERİSİ» notuyla yazar.

## 19. Yedek gerçekten geri yüklenebilir mi — nasıl kanıtlarım?

**Yönetim → Yedekleme & DR** sekmesindeki tatbikat (`POST /api/admin/backup/drill`) manifestteki her dosyanın
özetini yeniden hesaplar, depoyla karşılaştırır ve isteğe bağlı geri yükleme provası yapar (bellek içi;
depoya yazmaz/silmez). Anahtar yoksa açık içerik doğrulanamaz → `cozulemedi` (sessiz başarı yoktur).
Adımlar ve negatif test: [YEDEK_VE_DR.md §3.1](YEDEK_VE_DR.md). Tatbikat sonucu `drill.last` ayarına ve
`backup.drill` denetim kaydına yazılır; yedek >30 gün eskiyse hazırlık **kritik** sayılır.

## 20. Gölge mod nedir, raporu etkiler mi?

`NEXT_PUBLIC_AI_SHADOW_MODE=true` ile açılır: AI adayları rapora ve ekrana **girmez**, yalnız
`shadow_findings` tablosuna yazılır. Amaç doğrulanmamış modeli üretimde sessizce ölçmektir. Özet,
Yönetim → AI performans sekmesindeki **Gölge mod özeti** kartıdır (`/api/shadow/summary`: motor/model,
kayıt ve bulgu sayısı, ilk/son kayıt). Gölge kayıtları hiçbir koşulda rapor metnine dönüşmez.

## 21. Bağlamsal yardım (?) düğmesi ne yapar?

Ana araç çubuğundaki **?** düğmesi, resimli anlatımın ilgili bölümüne derin bağlantı verir
(`/resimlianlatim#bolum-…`). Konular tek kaynaktan gelir: `src/lib/guideStory.ts` → `HELP_TOPICS`;
her kaydın **gerçekten var olan** bir bölüme bağlandığı ve çapaların sayfada basıldığı
`tests/guide-story.test.ts` ile denetlenir. Statik demoda da çalışır (API gerekmez). Yeni bir noktaya
kısayol eklerken `HELP_TOPICS` + `MENU_KILAVUZU.md` satırı birlikte güncellenir.
