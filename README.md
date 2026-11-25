# ATIKVIEWER — Vision AI Radyoloji İstasyonu

> ⚠️ **Araştırma / demo yazılımıdır; klinik karar için kullanılamaz.**
> Yapay zekâ çıktıları taslak niteliğindedir ve hekim onayı gerektirir.

ATIKVIEWER; DICOM görüntüleme, kesit kesit yapay zekâ destekli inceleme ve
yapısal radyoloji raporu üretimini tek ekranda toplayan, Next.js (App Router) +
PostgreSQL (Drizzle ORM) tabanlı bir radyoloji iş istasyonudur.

## Özellikler

- **DICOM görüntüleyici:** klasör/dosya/ZIP içe aktarma, sürükle-bırak, pencere/seviye
  (WL/WW + BT hazır ayarları), yakınlaştırma, kaydırma, döndürme, ters çevirme, cine
- **GPU pencereleme (büyük görüntüler):** ≥1 MP gri kesitlerde doku bir kez WebGL2'ye
  yüklenir (Int16→R16I, Uint16→R16UI, Float32→R32F — kayıpsız), WL/WW/invert yalnız
  uniform güncellemesi olur; shader CPU LUT'u ile **birebir** aynı gri seviyeyi verir
  (`tests/gpu-window.test.ts`). Bağlam kaybı, doku sınırı aşımı veya renkli seride
  sessizce CPU yoluna döner — davranış değişmez (`src/lib/gpuWindow.ts`).
- **Gerçek codec desteği:** JPEG, JPEG Lossless, 12-bit JPEG Extended, JPEG 2000,
  HTJ2K, JPEG-LS, RLE, Deflated, Big Endian (WASM + JS çözücüler)
- **Fotometrik yorumlar:** MONOCHROME1/2, RGB, YBR, PALETTE COLOR; DICOM Overlay
  (60xx) ve GSPS sunum durumları
- **Özel nesneler:** DICOM SR (yapısal rapor), Encapsulated PDF, 12-derivasyonlu EKG
- **MPR:** axial/koronal/sagital yeniden kesit; kalın kesitte ortalama/MIP/MinIP;
  oblik (eğimli) MPR ve WebGL 3B hacim. Kesit konumu kaydı (IPP) varsa koronal/sagital
  gerçek hasta geometrisinden, ölçek kayması olmadan örneklenir (`src/lib/mpr.ts` +
  `VolumeView`). Kaynak seri salt okunur tutulur.
- **Önceki tetkik karşılaştırması + görsel hizalama:** Geçmiş çalışma ikinci panele
  anatomik senkronla (IPP/kesit konumu) açılır; bulgu kartında çap/hacim farkı
  yazılır. Karşılaştırma panelindeki 🎯 **Hizala**, iki kesidi normalize çapraz
  korelasyonla **öteleme + izotropik ölçek** olarak hizalar; Δx/Δy/ölçek/skor
  gösterilir, skor < 0,55 ise sonuç "güvenilir değil" sayılır ve uygulanmaz.
  Hizalama yalnız görüntü katmanını kaydırır — ölçüm koordinatları değişmez
  (`src/lib/registration.ts`). Döndürme/deformable/3B kayıt yoktur.
- **Takip görevleri:** Onaylı raporun önerisi göreve dönüşür; sonuç tarihine göre
  **geciken / bugün / yaklaşan (14 gün) / ileri / tarihsiz** kovaları, öncelik
  sıralaması, görev tarihçesi CSV'si ve HBYS/RIS **iade eşleme** (rapor kimliği →
  çalışma UID → tek aday; belirsizse eşleşmez) + sonuçla kapatma.
- **Kritik sonuç kapanışı:** Önem derecesine göre süre politikası (kritik 15 dk
  alınma / 30 dk eskalasyon), süresi dolan bildirim için **ikinci hekim / sorumlu
  uzman / kurum nöbeti** eskalasyonu ve 15 dk'lık hatırlatma; her adım denetim
  izine yazılır. 🔔 panelinde süre etiketi ve "⏱ Süre taraması" düğmesi.
- **Akciğer kantitasyonu:** Araç çubuğu → 🫁 Akciğer (CT): LAA-950 (emfizem
  oranı), ortalama HU, PD15, tahmini hacim ve **kesit dağılım profili**. Gövde
  dışı hava dışlanır; lob/fissür ayrımı yoktur, DSBG ile birlikte değerlendirilir.
- **Hasta mektubu:** Rapor ekranı → 💬 Hasta mektubu: onaylı rapordan **TR/EN/DE**
  dillerinde, **sade/standart** okuma düzeyinde özet; sade düzeyde tıbbi terimler
  günlük karşılıklarına çevrilir, yazdırma/PDF ve panoya kopyalama var. Onaysız
  raporda mektup TASLAK olarak kilitlenir.
- **Nükleer tıp:** Araç çubuğu → 🧪 Nükleer (PT/NM ya da SUV çarpanı olan seri):
  eşik tabanlı **MTV/SUVpeak/SUVmean** (mutlak SUV veya maksimumun %41'i) ve
  zaman-aktivite noktalarından **TIC** sınıflandırması (wash-out/plato/progresif).
- **İş akışı panosu:** Yönetim → İş akışı: **haftalık TAT trendi** (modalite
  süzgeçli), ayarlanabilir **hedef TAT** eşiği ve otomatik uyarılar (hedefi aşan
  hafta, %25'ten fazla yavaşlama, bayat taslak).
- **Erişilebilirlik:** görünür klavye odağı, «İçeriğe geç» bağlantısı, diyaloglarda
  `role="dialog"`/`aria-modal` + Escape, `aria-live` geri bildirim, **yüksek
  kontrast** teması (◐ Kontrast; tercih cihazda saklanır) ve `prefers-reduced-motion`
  desteği. WCAG kontrast matematiği testlidir (`npm run test:a11y`).
- **Model kayıt defteri:** Yönetim → AI: model sürümleri (aday/aktif/emekli),
  trafik payı, parmak izi; `/api/ai/registry` deterministik **A/B ataması**
  (tohum → kova) ve aşama değişikliğinde denetim kaydı.
- **RECIST 1.1 (tam):** Hedef lezyon seçim denetimi (≥10 mm; lenf nodu kısa eksen
  ≥15 mm; organ başına ≤2, toplam ≤5), non-hedef bileşkesi ve **genel yanıt
  tablosu** (yeni lezyon → PD; hedef CR + non-hedef CR → CR). Nodül takibi
  panelinden işaretlenir; CSV'ye genel değerlendirme eklenir. **Çalışmalar arası
  eşleştirme:** en yeni iki çalışma tarihi otomatik karşılaştırılır (anatomi +
  lezyon adı imzası); eşleşen lezyonlarda Δ mm / Δ%, yeni ve saptanmayan
  lezyonlar, **lenf nodu kısa eksen tablosu** (normal/takip/patolojik) gösterilir
  ve CSV'ye eklenir. **Sunucu ölçüm geçmişi:** girilen ölçümler `measurement_history`
  tablosuna (`/api/measurements`, hasta + tarih + lezyon tekil) yazılır; «☁ Sunucu
  geçmişi» paneli lezyon bazlı trend grafiği (SVG), Δ mm/% ve HU değişimini gösterir.
- **Segmentasyon editörü + SEG/RTSTRUCT:** Araç çubuğu → 🧩 Segmentasyon:
  **fırça/silgi** (1–40 px), **eşik dolgusu** (HU aralığı), **tohumdan bölge
  büyütme**, kesit gezinme ve «sonraki kesite kopyala». Maske seri kimliğiyle
  tarayıcıda saklanır; **hacim mL/mm³** canlı hesaplanır (piksel aralığı × kesit
  kalınlığı); maskeden **otomatik uzun/kısa eksen** (mm, RECIST çap adayı) okunur. DICOM **SEG** (1 bit/piksel, renk/etiket/algoritma) ve **RTSTRUCT**
  (CLOSED_PLANAR konturlar) dışa aktarımı; Dışa aktar menüsündeki işaret tabanlı
  SEG çıktısı elle çizilen maskeyle **birleştirilir**. AI aday örtüsü
  düzenlenebilir maske değildir; SEG/RTSTRUCT hekim düzenlemesine açıktır.
- **Yapılandırılmış ölçüm SR (TID 1500):** Ekran ölçümleri (uzunluk, elipsoid,
  ROI, çokgen) DICOM **Comprehensive SR** olarak yazılır: 125007 Measurement
  Group içinde izleme kimliği, kodlu bulgu/bölge, NUM değer + UCUM birimi ve
  referans görüntü. Standart kodlar DCM/SCT/UCUM; eşleşmeyenler `99ATIKVIEWER`
  (uydurma kod yazılmaz). Dışa aktar ▾ → "Ölçümler → DICOM SR (TID 1500)".
- **İnme / CTP:** ASPECTS 10 bölge skoru + `ctp.ts` ile cSVD (kesilmiş SVD)
  dekonvolüsyonu: rölatif CBF/CBV/MTT ve Tmax, **otomatik AIF seçimi**, çoklu
  bölge özeti (core: rCBF<%30, penumbra: Tmax≥6 sn) ve mismatch oranı. Panelden
  `ad | zaman | değer` biçiminde eğri yapıştırılır. Değerler **rölatiftir**;
  mutlak mL/100 g/dk için dansite kalibrasyonu gerekir, klinik karar aracı değildir.
- **Kritik bulgu bildirimi (çok kanallı):** kritik/yüksek aday bulgu uygulama içi
  bildirime ek olarak **e-posta / SMS / çağrı cihazı / webhook** kanallarına gider.
  Kanallar Yönetim → Entegrasyon'da JSON olarak tanımlanır (kurumun SMTP relay'i,
  SMS/pager ağ geçidi veya push köprüsü tek HTTP uç noktası); kanal başına önem
  eşiği ve `enabled` anahtarı vardır, "Test gönder" HTTP durum kodlarını listeler.
  Yük **kimliksizdir** (önem, çalışma UID, modalite, kısa mesaj — hasta adı
  gönderilmez). Bir kanalın hatası diğerlerini engellemez, sonuç denetim kaydına
  kanal bazında yazılır (`src/lib/notifyChannels.ts`).
- **Denetim → SIEM:** Her denetim olayı aynı işlemde `audit_delivery` kuyruğuna
  CEF olarak yazılır. `AUDIT_SIEM_URL` (+ isteğe bağlı `AUDIT_SIEM_SECRET`) tanımlıysa
  HMAC-SHA256 imzalı POST ile gönderilir; hata olursa üstel geri çekilmeyle
  yeniden denenir, vazgeçilen olaylar silinmez. Yönetim → Denetim kaydı'ndan
  kuyruk durumu izlenir ve elle boşaltılır.
- **Kare düzeyinde getirme (WADO-RS frames):** `.../instances/{sop}/frames/1,2,3`
  ile yalnız görünen kareler indirilir; istemcide LRU önbellek (240 kare) ve ±2
  ön getirme penceresi vardır. Büyük çalışmalarda tüm instance indirmek yerine
  kademeli getirme sağlar.
- **İkinci ekran ve dokunmatik jestler:** Her panelin kendi ⛶ tam ekran düğmesi
  vardır. Araç çubuğu → 🖥 İkinci ekran, aktif seriyi `/ayna` penceresine canlı
  yayınlar (BroadcastChannel; yalnız görüntülenen kesit + WL/WW/zoom gönderilir,
  veri sunucuya gitmez, alıcı salt izlemedir) — pencereyi başka bir monitöre
  sürükleyin. Dokunmatikte iki parmak kıstırma = zoom, iki parmak = kaydırma,
  tek parmak = kaydırma (`src/lib/gestures.ts`).
- **Anonim seri gönderimi:** Seriyi PACS'e **kimliksiz** göndermek için anonim
  DICOM baytları tarayıcıda sıfırdan üretilir (özel etiket / orijinal UID / ad
  taşınmaz); sunucu örnek sayısı, toplam boyut ve DICM imzasını yeniden denetler.
  Her gönderim denetime yazılır (`/api/pacs/stow` kind=anon).
- **PACS gönderimi (STOW-RS):** Onaylanmış rapor DICOM SR olarak, anahtar
  kesitler KO ve pencere/döndürme ayarı GSPS (PR) olarak PACS'e gönderilebilir.
  KO/PR gönderiminde kesit UID'leri önce QIDO-RS ile PACS'te doğrulanır;
  her gönderim denetim kaydına yazılır (`/api/pacs/stow`, `pacsSend.ts`).
- **Üretken taslak + üslup:** Rapor için izlenim taslağı üretilir (LLM varsa
  OpenAI uyumlu uç, yoksa kural tabanlı; yalnızca onaylanmış bulgular, kimlik
  gönderilmez). Hekimin geçmiş onaylı raporlarından kimliksiz üslup örneği
  seçilerek taslağın üsluba uyması sağlanır (`styleProfile.ts`).
- **Şablon makroları:** 24+ hazır bölge/protokol şablonu arasından arama/filtre;
  `[BOYUT]`/`[KONUM]` gibi yer tutucular tanınır, raporu onaylamadan önce
  "doldurulmamış şablon alanları" uyarısı gösterilir (`templateMacro.ts`).
- **Model belirsizliği:** AI skorları sınıf eşiğine göre SINIRDA/ORTA/GÜÇLÜ
  bandında gösterilir; bulgu kartlarına "model emin değil" notu eklenir.
  Bu kalibrasyon değildir — güven aralığı için doğrulama seti gerekir.
- **Önceki tetkik karşılaştırması:** Geçmiş çalışma ikinci panele konum senkronuyla
  açılır; aynı kategoriden bulgular için önceki çap/hacim ölçümüyle karşılaştırma
  notu gösterilir (`priorCompare.ts`). Piksel hizalaması (registration) yapılmaz.
- **Bildirimler:** Kritik/yüksek aday bulgularda uygulama içi zil, sunucudan
  webhook'a JSON POST (denetimde kanıt), alındı/iletildi/eskalasyon kaydı ve
  masaüstü tarayıcı bildirimi (izin akışlı). E-posta/SMS/çağrı için kurumsal
  sağlayıcı gerekir.
- **AI ısı haritası örtüsü:** CXR modeli pozitif sınıflarda aktivasyon haritası
  üretir; görüntüde saydamlık ayarlanabilir renkli katman olarak gösterilir
  (düşük aktivasyon gizlenir). Bu bir klinik araç değildir ve rapora işlenmez.
- **Anahtar kesit ve sunum durumu:** ★ ile seçilen anahtar kesitler rapora
  gider; ayrıca DICOM **Key Object Selection** (KO) ve **Grayscale Softcopy
  Presentation State** (GSPS/PR: pencere, döndürme, çevirme, referanslar) olarak
  dışa aktarılabilir (araç çubuğundaki "Dışa aktar"). PR rapor belgesi değildir.
- **Performans:** Pencere/seviye (WL/WW) dönüşümü tek geçişli tablo + renk
  paletiyle yapılır (`src/lib/window.ts`); ölçülmüş kazanç 512×512'de ≈2×,
  4096×4096'da ≈2.2× (`npm run bench:window`). Kaydırmada komşu kesitler boş
  zamanda ön-işlenir (sınırlı önbellek; büyük grafiklerde bellek kapısı uygulanır).
- **3B imleç:** İmleç aracı (araç çubuğu) ile tıklanan noktada aynı çalışmanın
  (Frame of Reference) diğer panellerinin kesidi o hasta koordinatına atlar;
  paralel olmayan serilerde de nokta bazlı en yakın kesit seçilir.
- **Elektronik imza kaydı:** Rapor ekranında imza kaydı paneli; SHA-256 içerik
  mühürü + imza sahibi + kurum + zaman + sürüm kanonik biçimde denetim zincirine
  (`report.esignature`) yazılır ve yeniden doğrulanabilir. **Nitelikli elektronik
  imza (NES) değildir** — bu, arayüzde ve her kayıtta açıkça belirtilir.
- **MSK ölçüm yardımcısı:** El bileği (radiyal inklinasyon/ulnar varyans), ayak bileği
  (Böhler, tibiofibular mesafe), ayak lateral (Meary, kalkaneal pitch) ve kalça AP
  (CE/Wiberg, asetabular indeks) protokollerini adlandırılmış noktalarla çizer;
  kenar-yapışmalı nokta seçimi ve aralık yorumu sunar (`src/lib/msk.ts`). **Tanısal
  model değildir**; kırık/landmark sınıflandırması bu sürümde yoktur.
- **ICD-10 / istem uygunluğu:** Rapor metninden yaklaşık ICD-10 önerileri ve
  ACR tarzı istem uygunluğu puanı (`src/lib/icd10.ts`). Öneriler raporda açıkça
  "yaklaşık eşleme; radyolog onayı şart" olarak etiketlenir.
- **Mobil/PWA:** `public/manifest.webmanifest` (tr-TR, tek başına ekran), 192/512 simgeler
  ve hizmet işçisi (`public/sw.js`). İşçi yalnızca statik varlıkları önbelleğe alır;
  klinik veri ve API yanıtları asla önbelleğe girmez, çevrimdışıda eski hasta bilgisi
  gösterilmez (`public/offline.html`).
- **Sesle dikte:** Rapor alanlarında Türkçe dikte (Web Speech API). Sayı sözcükleri
  ("yirmi beş" → 25), noktalama komutları (virgül / iki nokta / yeni satır / yeni
  paragraf / temizle), ölçü birimleri (milimetre → mm) ve tıbbi sözlük düzeltmeleri
  (`src/lib/dictate.ts`); aynı normalize katmanı `/api/reports/normalize` ile
  sunucuda da çağrılabilir. Dikte metni hekim metnidir; tarayıcı konuşma tanıma
  motorunu kullanır.
- **Hanging Protocol motoru:** 1×1'den 3×2'ye düzenler, modaliteye göre otomatik
  protokoller ve görsel özel protokol editörü (JSON içe/dışa aktarma)
- **Görüntü incelemesi:** US renkli Doppler, MR, direkt grafi ve diğer piksel içeren
  modalitelerde bütün kareler gerçek piksellerden ölçülür (sinyal/kontrast, RGB renkli
  alan oranı, kare değişimi); tıklanabilir kare tablosu vardır. **Bu tanısal AI,
  hastalık tespiti veya acil klinik triyaj değildir.** RGB Doppler rengi kan hızı değildir.
- **BT aday odak motoru:** Yalnızca BT beyin (kanama adayı) ve BT toraks (nodül
  adayı) için kural tabanlı, klinik olarak doğrulanmamış inceleme; kesit bazlı kutular,
  aday öncelik skoru ve yöntem kartı. MR/CR örneklerindeki ön tanımlı bulgular DEMO'dur.
- **Derin öğrenme ile gerçek AI çıkarımı (yerel, ücretsiz):** BT toraks serilerinin
  gerçek HU hacmi yerel AI worker'ındaki MONAI `lung_nodule_ct_detection` modeline
  (LUNA16 eğitimi, RetinaNet + ResNet50-3D) gönderilir; model nodül adaylarını kesit
  aralığı, normalize sınır kutusu ve skoruyla döndürür. Bulgular kural tabanlı
  adaylarla birleştirilir, otomatik anahtar kesit önerir ve rapora model kartıyla girer.
  **Çıkarım tamamen bu makinede çalışır; hasta verisi dışarı çıkmaz, ücretli servis
  kullanılmaz. Klinik doğrulanmamıştır; her bulgu radyoloji uzmanı onayı gerektirir.**
- **Raporlama:** taslak → onay akışı, bulgu bazlı hekim doğrulaması, sürümleme,
  addendum, A4 yazdırma, FHIR R4 DiagnosticReport dışa aktarma, ikinci okuma (peer review) kaydı
- **Süreli paylaşım:** onaylı rapor için süre seçilebilir (1–30 gün), kapatılabilir,
  filigranlı salt okunur bağlantı (`/paylas/<token>`); her erişim denetimde işlenir. Ham görüntü paylaşılmaz.
- **İş akışı:** çalışma listesi, PACS (DICOMweb QIDO/WADO — hazır sistem ayarları, şifreli kimlik, bağlantı testi), HBYS istem alımı,
  kritik bulgu bildirimleri, şifreli sunucu depolaması, hash zincirli denetim kaydı

## Hızlı başlangıç (Docker Compose — önerilen)

```bash
cp .env.example .env        # POSTGRES_PASSWORD ve DATA_ENCRYPTION_KEY doldurun
docker compose up --build -d
```

Ardından `http://localhost:3000` adresini açın. Veritabanı şeması ilk açılışta
otomatik uygulanır. Durum: `http://localhost:3000/api/health`

Yerel derin AI (MONAI akciğer + ICH beyin modelleri) **ayrı bir servis**tir:

```bash
docker compose --profile ai up --build -d   # ilk açılışta ~231 MB model indirir
```

Worker kapalıyken BT analizi kural tabanlı motora düşer ve ekran “worker: kapalı”
olarak bunu belirtir; hasta verisi bu servise yalnızca makine içinden gider.

## Kurulum paketleri — Windows · Linux · macOS

Tüm kurulum dosyaları **orijinal dosya yollarıyla** tek arşiv üretilir:
`dist/ATIKVIEWER-<sürüm>-kurulum.zip` (`bash packaging/universal/build-source-zip.sh`).
Uygulama içindeki **📦 Kurulum → `/paketler`** sayfası bu arşivi
`public/downloads/` altında bulduğunda doğrudan indirme bağlantısı sunar; yoksa
üretim komutunu gösterir. Ayrıntılı yol ve komut tablosu:
**[packaging/README.md](packaging/README.md)**.

| İşletim sistemi | Tek komutla kurulum | Paket üretimi |
|---|---|---|
| Windows | `windows\Kurulum.bat` | `windows\Paket.ps1` → `dist\*-Setup.exe` |
| Linux (Debian/Ubuntu/Fedora/Arch) | `bash packaging/linux/install.sh` | `bash packaging/linux/build-deb.sh` → `dist/*.deb` |
| macOS | `bash packaging/macos/install.sh` | `bash packaging/macos/build-dmg.sh` → `dist/*.dmg` |
| Her işletim sistemi (Docker) | `docker compose up --build -d` | — |
| Çapraz platform arşivi | `bash packaging/universal/build-source-zip.sh` | `dist/*-kurulum.zip` |
| Kurulum sonrası denetim | `bash packaging/universal/verify.sh` | `dist/ATIKVIEWER-dogrulama-*.log` |

Windows Setup ile kurulan sürüm, her başlatmada en son kararlı GitHub sürümünü
kontrol eder; yeni sürümün kurulum dosyasını SHA-256 ile doğrulayıp sessizce
kurar, Node bağımlılıklarını ve uygulama derlemesini yeniler. Uygulama zaten
çalışıyorsa veya kaynak koddan geliştirme modunda başlatılıyorsa güncelleme
uygulanmaz. `.env` ve `.data` korunur. Linux/macOS paketlerinde güncelleme
şimdilik Releases sayfasından elle yapılır. v0.1.0 Windows kurulumlarının bu
özelliği edinmesi için v0.2.0 Setup'ı bir kez elle kurması gerekir; sonraki
sürümler otomatik alınır.

Ücretsiz yerel yapay zekâ (MONAI akciğer + ICH beyin modelleri) için:
`ai-worker/setup_model.py` → `ai-worker/server.py` (yalnız `127.0.0.1:8787`,
hasta verisi dışarı çıkmaz, ücretli servis kullanılmaz).

## Manuel kurulum

Gerekenler: Node.js 22+, PostgreSQL 16+

```bash
npm ci
cp .env.example .env        # DATABASE_URL doldurun
npx drizzle-kit push        # şemayı uygula
npm run dev                 # http://localhost:3000
```

Üretim derlemesi:

```bash
npm run build
npm start
```

> **Windows — tek komutla kurulum (önerilen):** betik önkoşulları (Git, Node.js,
> Python), yapay zekâ paketlerini (`ai-worker/requirements.txt`) ve modelleri
> (akciğer ≈84 MB + beyin ≈147 MB) kendisi kurar:
>
> ```bat
> windows\Kurulum.bat     :: kurulum (ilk seferde PyTorch ≈2 GB iner)
> windows\Baslat.bat      :: AI worker + görüntüleyici + tarayıcı
> windows\Dur.bat         :: çalışırken kapat
> ```
>
> Elle kurulum, PostgreSQL (opsiyonel), CUDA ve **sık karşılaşılan hataların
> çözümleri** için **[docs/WINDOWS_KURULUM.md](docs/WINDOWS_KURULUM.md)**:
>
> ```powershell
> git clone https://github.com/CehennemGibiyim/ArenaViewer.git
> cd ArenaViewer
> Copy-Item .env.example .env
> npm ci
> npx drizzle-kit push --config=drizzle.config.ts
> npm run dev                 # http://localhost:3000
> ```

### Yerel Derin AI (ai-worker)

Derin öğrenme çıkarımı ayrı bir yerel süreçte çalışır (Next.js'ten bağımsız,
yalnızca `127.0.0.1:8787`):

```bash
# Python 3.11–3.14 + (tercihen) CUDA'lı torch
python -m venv .venv
.venv/Scripts/pip install -r ai-worker/requirements.txt   # torch, monai, cv2, skp…
python ai-worker/setup_model.py     # iki modeli indirir: akciğer ≈84 MB + beyin ≈147 MB
python ai-worker/server.py          # worker'ı başlatır (CPU'da da çalışır, yavaş olur)
```

- Windows'ta tüm bu adımları betik yapar: `windows\Kurulum.bat` (bkz. docs/WINDOWS_KURULUM.md §0).
- Akciğer (BT) modeli: `~/.cache/atikviewer-ai/model/model.pt` (`ATIK_MODEL_DIR` ile değiştirilebilir).
- Beyin (ICH) modeli: `~/.cache/atikviewer-ai/brain` (7 × `.safetensors`, MIT/RSNA).
- Akciğer grafisi (CXR) modeli: repoda `ai-worker/models/cxr_densenet121_medx_320.onnx`
  (Medical_X DenseNet121, Apache-2.0, 28 MB). Öncelik sırası:
  `CXR_MODEL_PATH` → `~/.cache/atikviewer-ai/cxr/` (`ATIK_CXR_DIR`) → depodaki dosya.
  Türetimi: `python ai-worker/tools/export_cxr_onnx.py --verify`;
  kaynak lisansı/bildirim: `ai-worker/models/LICENSE.Medical_X.txt` + `NOTICE.md`.
- Durum: `GET /api/deep-scan` → `{"worker":"up"|"down", ...}`; worker `/health` içinde
  `cxr.modelFile` / `cxr.modelLoaded`.
- Uygulama içinde BT toraks analizi otomatik olarak bu uca gider; worker kapalıysa
  kural tabanlı motor devam eder ve uyarı satırı gösterilir.
- Direkt grafilerde (CR/DX/RG) ise yerel CXR modeli çalışır: 14 torasik bulgu için olasılık
  tablosu + **Grad-CAM ısı haritası** örtüsü. Model lokalizasyon kutusu vermez; bulgular
  "aday" sayılır, klinik doğrulaması yoktur ve skorlar kalibre olasılık değildir.
  Hasta görüntüsü yalnızca bu makinedeki worker'a gider, dış ağa çıkmaz.
- Not: Büyük HU hacimleri için `next.config.ts` içinde gövde sınırı 700 MB'a ayarlıdır.

### HBYS/RIS sipariş köprüsü (HL7 v2 MLLP)

Kurum içi HBYS, teknik olarak `ORM^O01` gibi sipariş mesajlarını TCP/MLLP ile gönderir.
Bu mesajları ArenaViewer'ın `/api/his/orders` ucuna çeviren ayrı bir dinleyici script'i vardır:

```bash
HIS_API_KEY=<ayarlardaki anahtar> HL7_PORT=2575 npm run hl7:mllp
```

- Dinleme: `HL7_HOST`/`HL7_PORT` (varsayılan `127.0.0.1:2575`); kurum ağına açarken `HL7_HOST=0.0.0.0`.
- Hedef: `HIS_BASE_URL` (varsayılan `http://127.0.0.1:3000`) → `/api/his/orders`, `x-api-key` başlığı ile.
- Yanıt: PACS/HBYS'e `MSA|AA` (kabul), `AR` (eksik alan) veya `AE` (ulaşılamadı) ACK'i döner.
- Ayrıştırma: `src/lib/hl7.ts` (saf fonksiyonlar, `npm run test:hl7`).

### Modality Worklist (MWL) — modalite konsolu

Modalitenin "bugün hangi işler beni bekliyor" listesi DICOM MWL'den gelir. ArenaViewer
üç kaynağı sırayla dener (`src/lib/mwl.ts` ayrıştırma, `pacs.ts` `fetchMwl()`):

1. **MWL kökü** — Yönetim → Entegrasyon → *MWL kökü* (ör. `…/dcm4chee-arc/aets/AET/rs`),
2. **DICOMweb** — QIDO/WADO kökü üzerinden `GET …/modality-worklist?modality=CT&scheduled-date=20260115`,
3. **DIMSE C-FIND köprüsü** — Node'da DIMSE yığını yok; köprü ayrı süreçte C-FIND yapar:

```bash
MWL_PACS_HOST=10.0.0.20 MWL_PACS_PORT=104 MWL_PACS_AET=ORTHANC npm run mwl:cfind
# → http://127.0.0.1:2580/cfind ; Yönetim'de "DIMSE köprüsü" alanına yazın
```

- Liste: **Çalışma listesi → İş listesi (MWL)** sekmesi (tarih, modalite, açık işler süzgeci).
- "Çalışmaya al" ögeyi yerel çalışmaya çevirir (`POST /api/his/mwl`, denetim `his.mwl_to_study`);
  DICOM StudyInstanceUID varsa korunur, PACS'ten gelen görüntü aynı UID ile eşleşir.
- `findscu` (dcm4che) yoksa `MWL_BACKEND=bin` + `MWL_BIN` ile kendi C-FIND betiğinizi bağlayın;
  köprü ham Implicit VR yanıtını da DICOM JSON'a çevirir (`parseImplicitVr`).

## Tedarik zinciri (SBOM + SLSA)

Her `v*` etiketinde `.github/workflows/sbom.yml` şunları üretir ve Release'e ekler:
CycloneDX 1.6 **SBOM**, kaynak arşivi, `SHA256SUMS` ve **SLSA v1 derleme kökeni**
(`actions/attest-build-provenance`; imza GitHub OIDC ile atılır, özel anahtar yok).
`.github/workflows/supplychain-verify.yml` yayınlanan varlıkları indirip bağımsız
olarak yeniden doğrular.

İndirilen bir sürümü kurumda denetlemek için:

```bash
node scripts/supplychain.mjs verify --dir <indirilen-klasör> --strict
# → SHA256SUMS eşleşmesi, SBOM biçimi (purl/lisans), kanıtın dosya özetleriyle bağlantısı
gh attestation verify <dosya> --repo CehennemGibiyim/ArenaViewer   # imzalı köken
```

Doğrulayıcı, SBOM'u `--sbom`, kanıtı `--provenance` ile başka yoldan da okur;
`SHA256SUMS` üretmek için `node scripts/supplychain.mjs manifest --dir dist`.

## Anahtar rotasyonu (KMS)

Şifreli alanlar anahtar kimliğini taşır (`enc:v2:<kid>:…`); bu sayede rotasyon
**veri kaybı olmadan** yapılır. Anahtarlar `DATA_ENCRYPTION_KEYS` içinde virgülle
ayrılır, **en sağdaki yazar**, soldakiler yalnız okuma içindir:

```bash
# 1) Yeni anahtar üret (Yönetim → Güvenlik → Anahtar rotasyonu → "Yeni anahtar üret")
DATA_ENCRYPTION_KEYS=<eski>,<yeni>   # 2) .env'e yaz, servisi yeniden başlat
# 3) "Rotasyonu çalıştır"  (kalan kayıt varsa düğmeye tekrar basılır)
# 4) "Eski anahtarları çıkar" → DATA_ENCRYPTION_KEYS=<yeni> → yeniden başlat
```

- Çözülemeyen tek bir kayıt bile varsa rotasyon **409 ile durur** (anahtar kaybı
  işaretidir; önce yedekten/anahtar kasasından doğrulayın).
- v1 (kimliksiz) kayıtlar halkadaki anahtarlarla okunur ve ilk rotasyonda v2'ye taşınır.
- Rotasyon ilerlemesi `GET /api/admin/status` içindeki `staleKey` alanında görünür.

## Depolama, yedek ve DR

Görüntü dosyaları `StorageAdapter` üzerinden yazılır: yerel disk (`.data/`),
S3/MinIO (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_REGION`, `S3_VIRTUAL_HOST=1`) veya Yönetim → Entegrasyon'daki `storage`
ayarı. S3 istemcisi AWS SigV4 kullanır (AWS/MinIO/R2/Wasabi uyumlu).

- Yedek manifesti: `GET /api/admin/backup?download=1` (dosya listesi + SHA-256)
- Doğrulama: `POST /api/admin/backup {"verify": <manifest>}`
- Geri yükleme: `POST /api/admin/backup {"restore": <manifest>}` — idempotent,
  hiçbir dosyayı silmez; aynı özetliler atlanır.
- İşletim playbook'u (pg_dump, felaket senaryoları, tatbikat listesi):
  [docs/YEDEK_VE_DR.md](docs/YEDEK_VE_DR.md)

> `DATA_ENCRYPTION_KEY` yedekten **ayrı** saklanmalıdır; anahtarsız şifreli
> dosyalar kurtarılamaz.

## Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | Evet | PostgreSQL bağlantı dizesi |
| `DATA_ENCRYPTION_KEY` | Üretimde | Base64, 32 bayt AES-256 anahtarı (boşsa `.data/enc.key` üretilir) |
| `DATA_ENCRYPTION_KEYS` | Hayır | Virgülle ayrılmış anahtar halkası; **en sağdaki yazar**, soldakiler yalnız çözme (rotasyon) |
| `PACS_AUTH_HEADER` | Hayır | DICOMweb kimlik başlığı — yalnızca geriye dönük; kimlik/ayarlar Yönetim → Entegrasyon'dan girilir ve sunucuda şifrelenir |
| `HIS_API_KEY` | Hayır | HBYS istem alımı API anahtarı |
| `ACCESS_TOKEN` | Hayır | Tek erişim anahtarı (kapı); tanımlıysa `/giris` kapısı ve 401 koruması açılır |
| `AUTH_MODE` | Hayır | Boş/demo: ACCESS_TOKEN varsa onunla, yoksa tek operatör. `hesap`: kullanıcı adı/parola (+MFA) zorunlu, rol denetimi aktif |
| `SESSION_SECRET` | Hesap modunda | Oturum çerezini imzalayan gizli anahtar (tanımsızsa `DATA_ENCRYPTION_KEY` kullanılır) |
| `REQUIRE_TOTP_FOR_ROLES` | Hayır | MFA zorunluluğu olan roller (varsayılan `yonetici`). Bu rollerdeki hesaplar authenticator kodu olmadan giremez |
| `SESSION_MAX_AGE_SECONDS` | Hayır | Oturum ömrü (varsayılan `28800` = 8 saat, sınır 3600–604800). Sunucu tarafındaki kayıt bu süreden bağımsız iptal edilebilir |
| `LOGIN_LOCK_WINDOW_MIN` / `LOGIN_LOCK_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | Hayır | Kaba kuvvet kilidi: pencere içinde N hatalı giriş → M dakika kilit (varsayılan 15 / 5 / 15) |
| `REQUIRE_TLS` | Hayır | `0` (kapalı, varsayılan) · `1`/`true`/`forward` (ters vekil `x-forwarded-proto` bildirir) · `direct` (TLS'i uygulama sonlandırır). TLS'siz sayfa istekleri https'e yönlenir, TLS'siz API istekleri `426` alır; `/api/health` ve statik varlıklar muaf |
| `HSTS_MAX_AGE` / `HSTS_SUBDOMAINS` / `HSTS_PRELOAD` | Hayır | HSTS başlığı (varsayılan `31536000` / `1` / `0`). Yalnız TLS'li yanıtlarda yazılır; önce tüm alt alan adlarının https olduğundan emin olun |
| `TRUST_PROXY` | Hayır | `1` ise istemci IP'si `x-forwarded-for` başlığından okunur (giriş kilidi ve denetim kaydı). Yalnız güvenilir ters vekil arkasında açın |
| `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` | Hayır | Taslak izlenim LLM'i (yoksa kural tabanlı yedek). Ücretsiz yerel yol: [docs/OLLAMA.md](docs/OLLAMA.md) |
| `AI_WORKER_URL` | Hayır | Yerel derin AI worker adresi (varsayılan `http://127.0.0.1:8787`) |

Anahtar üretme: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev` | Geliştirme sunucusu |
| `npx next typegen` | Rota tipleri |
| `npm run typecheck` | TypeScript kontrolü |
| `npm run build` / `npm start` | Üretim derlemesi / sunucusu |
| `npx drizzle-kit push` | Şemayı yerel DB'ye uygula |
| `npm run hl7:mllp` | HL7 v2 (MLLP) sipariş alıcısını başlatır (`HIS_API_KEY` gerekir) |
| `npm run mwl:cfind` | Modality Worklist DIMSE C-FIND köprüsü (`MWL_PACS_HOST`/`MWL_PACS_AET` gerekir) |
| `npx drizzle-kit push --config=drizzle.config.ts` | Şemayı `DATABASE_URL`'deki DB'ye uygula (Docker/üretim) |

## Testler

Tarayıcı regresyon testleri **production** sunucuya karşı çalıştırılır:

```bash
npm ci
npx playwright install chromium     # tarayıcı için (playwright artık devDependency)

# Birim/entegrasyon testleri (sunucu gerektirmez)
npm test                            # tam birim/entegrasyon zinciri (~276 PASS)
npm run test:image-review
npm run test:pacs
npm run test:recist
npm run test:mpr                    # MPR geometrisi + trilinear yeniden kesit
npm run test:dictate                 # sesle dikte: sayılar, komutlar, tıbbi sözlük
npm run test:pwa                     # manifest + hizmet işçisi kapsamı
npm run test:icd10                   # ICD-10 öneri + istem uygunluğu
npm run test:msk                     # MSK protokol hesapları + nokta yapışması
npm run test:esign                   # imza kaydı + NES sınır etiketi
npm run test:xref                    # 3B imleç: en yakın kesit + panel güncellemeleri
npm run test:perf                   # pencere/seviye doğruluğu + önbellek ön-işleme
npm run test:gpu                    # GPU pencereleme kararı + shader≡CPU eşdeğerliği
npm run test:gestures               # dokunmatik jest matematiği (pinch/pan)
npm run test:mirror                 # ikinci ekran yayını + gerçek BroadcastChannel turu
npm run test:ui-smoke               # ikinci ekran + segmentasyon editörü render duman testi
npm run test:registration           # önceki/şimdiki tetkik hizalaması (NCC, öteleme+ölçek)
npm run test:notify-channels        # e-posta/SMS/çağrı kanalları: ayrıştırma, eşik, PHI'siz yük
npm run bench:window                # WL/WW dönüşümü kıyaslaması (eski vs LUT)
npm run test:pr                     # GSPS/PR dışa aktarma + parse doğrulama
npm run test:notify                 # masaüstü bildirimi + izin akışı
npm run test:prior                  # önceki tetkik ölçüm karşılaştırması
npm run test:uncert                 # belirsizlik bandı + CXR bulgu notu
npm run test:template               # şablon yer tutucuları + onay öncesi uyarı
npm run test:style                  # üslup örneği seçimi + LLM prompt entegrasyonu
npm run test:pacssend               # KO/PR → PACS gönderim planı ve uç sözleşmesi
npm run test:siem                   # SIEM kuyruğu, yeniden deneme, HMAC imza
npm run test:ctp                    # CTP cSVD dekonvolüsyonu + otomatik AIF
npm run test:sr1500                 # TID 1500 yapılandırılmış ölçüm SR (+köprü)
npm run test:seg                    # segmentasyon maskesi + DICOM SEG/RTSTRUCT
npm run test:recistfull             # RECIST hedef seçimi + non-hedef + genel yanıt
npm run test:tracking               # lezyon eşleştirme + nodül takibi köprüsü
npm run test:measure-history        # sunucu ölçüm geçmişi serileri + trend + CSV
npm run test:lungquant              # LAA-950, PD15, kesit profili, örnekleme
npm run test:model-registry         # model kayıt defteri + A/B ataması
npm run test:a11y                   # WCAG kontrastı + tema sabitleri
npm run test:nuclear                # MTV/SUV örnekleme + TIC sınıflandırması
npm run test:patient-letter         # hasta mektubu: TR/EN/DE, okuma düzeyi, taslak kilidi
npm run test:closeloop              # kapanış döngüsü süre/eskalasyon kuralları
npm run test:followup               # takip görev kovaları + iade eşleme
npm run test:stowanon               # anonim seri → PACS (plan + sunucu doğrulaması)
npm run test:wadoframe              # kare düzeyinde getirme + istemci önbelleği
npm run test:mwl                    # Modality Worklist (DICOMweb + DIMSE köprüsü)
npm run test:webhard                # hız sınırı + CSRF + CSP
npm run test:supplychain            # SBOM + SHA256SUMS + SLSA köken doğrulaması
npm run test:backupdr               # depolama adaptörü + yedek/geri yükleme
npm run test:kms                    # anahtar halkası + rotasyon
npm run test:codecs                 # WASM codec (J2K / JPEG-LS) piksel testleri

# Tarayıcı regresyon testleri (production sunucusu gerekir; BASE_URL varsayılanı :3000)
npm run build && npm start &
npm run test:menu                   # menü, sekme, MPR, PNG, iframe, hata senaryoları
npm run test:folder                 # klasör içe aktarma + yükleme raporu
npm run test:review                 # görüntü inceleme ölçümleri
npm run test:report-flow            # rapor onay + derin AI akışı
```

> `tests/menu-interactions.cjs` hem klasik `webkitdirectory` yolunu hem de Chromium'un
> `showDirectoryPicker` yolunu ayrı ayrı sınar. Windows için ayrıntı: [docs/WINDOWS_KURULUM.md](docs/WINDOWS_KURULUM.md)

## GitHub ve yayınlama

Ayrıntılı kılavuz: **[docs/GITHUB_YAYINLAMA.md](docs/GITHUB_YAYINLAMA.md)**

Özet:

```bash
git init && git add . && git commit -m "ATIKVIEWER ilk sürüm"
git branch -M main
git remote add origin https://github.com/CehennemGibiyim/ArenaViewer.git
git push -u origin main
```

- **CI:** her push'ta tip + derleme kontrolü (`.github/workflows/ci.yml`)
- **Docker imajı:** GHCR'a otomatik yayın (`.github/workflows/docker.yml`)
- **Tek tıkla bulut:** `render.yaml` (Render Blueprint) hazır
- **VPS:** `docker compose up --build -d`

> Not: GitHub Pages yalnızca statik site sunar; sunucu + veritabanı gerektiren bu
> uygulamanın tamamını çalıştıramaz. Gerekçe ve alternatifler yayınlama
> kılavuzundadır.

## Proje yapısı

```text
src/
  app/            Sayfalar ve API uçları (App Router)
  components/     Workstation, Viewport, MPR, SR/PDF/EKG görüntüleyiciler…
  lib/            DICOM okuyucu, codec'ler, AI motoru, hanging protocol…
  lib/server/     Kimlik, denetim, şifreleme, PACS yardımcıları
  lib/vendor/     Lisanslı 12-bit JPEG çözücü (atıflı)
  db/             Drizzle şeması ve istemcisi
public/codecs/    WASM görüntü çözücüleri (repoda tutulur, CDN değildir)
ai-worker/        Yerel derin AI worker (MONAI model çıkarımı, Python)
tests/            Playwright menü + klasör yükleme regresyon testleri
docs/             Yayınlama ve işletim kılavuzları
```

## Güvenlik notları

- `.env` ve `.data/` asla commit'lenmez (`.gitignore` ile korunur). Yeni kurulumda
  `cp .env.example .env` yapıp **kendi** `DATA_ENCRYPTION_KEY`'iniz üretin. Eğer bir
  anahtar hiç commitlendiyse (bu depoda ilk sürümde oldu gibi) o anahtarı iptal edin:
  Şifreli hasta kaydı **yoksa** `.env`'deki değeri yenisiyle değiştirip uygulamayı
  yeniden başlatın. **Varsa** önce yedek alın; anahtarı doğrudan değiştirmek eski
  verinin çözülmesini engeller (`[çözülemedi]`). Yönetim → Güvenlik'teki “Mevcut
  kayıtları şifle” yalnız aynı anahtarla yeniden şifreler, anahtar rotasyonu için
  çift anahtarlı çözüm ya da yeni kurulum + içe aktarma gerekir.
- Hasta verisi diskte AES-256-GCM ile şifrelidir; anahtar yedeğini saklayın.
- **Web sertleştirme (G1):** tüm yanıtlarda `nosniff`, `Referrer-Policy`, COOP/CORP,
  `Permissions-Policy`, `X-Frame-Options` ve sayfalarda **nonce tabanlı CSP**
  (`script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'`; `object-src 'none'`,
  `frame-ancestors 'self'`). CSP ihlalleri `/api/csp-report` ucuna raporlanır; günlüğe
  yalnız yönerge/engellenen adres/köken yazılır (hasta bağlamı taşınmaz).
- **Hız sınırı:** API uçları sınıf bazlı kayan pencere ile sınırlanır (giriş 10/dk,
  analiz 30/dk, PACS/HBYS 60/dk, yazma 120/dk, genel 600/dk). Sınır aşımı `429` +
  `Retry-After` döner. Sayaçlar süreç belleğindedir (tek örnek); çok örnekli dağıtımda
  Redis gerekir. Ölçüm/test için `AV_RATE_LIMIT=off`.
- **CSRF:** durum değiştiren API istekleri `Origin`/`Referer`/`Sec-Fetch-Site` kontrolünden
  ve `av_csrf` çerezi ↔ `x-csrf-token` başlığı eşleşmesinden geçer (tarayıcı tarafındaki
  yardımcı: `src/lib/csrfClient.ts` → `apiFetch`). İlk sayfa yüklemesindeki çerez yarışı
  için istemci, `needsCsrfToken` yanıtında jetonu tazeleyip bir kez yeniden dener.

- **Erişim kapısı:** `ACCESS_TOKEN` tanımlıysa tüm sayfa/API istekleri `/giris`
  sayfasına düşer; doğru anahtar oturum çerezi (`httpOnly`, 30 gün) yazar. API’ler
  401 döner, `/api/health` ve giriş akışı kapalı kalmaz. Tanım **yoksa** kapı
  açıktır (demo varsayılanı) ve adresi bilen herkes hasta verisini görebilir; bu
  hâlde uygulamayı yalnızca VPN/güvenlik duvarı arkasında açın. Çıkış:
  `POST /api/auth/logout`.
- **Kullanıcı hesapları ve roller (F1):** `AUTH_MODE=hesap` yapıldığında her işlem
  kullanıcı adı/parola ile doğrulanmış bir oturum ister; `yonetici`, `radyolog`,
  `teknisyen` rolleri işlem bazında denetlenir (ör. rapor onayı radyolog/yönetici,
  silme ve ayarlar yalnız yönetici). İlk yönetici `/giris` sayfasındaki kurulum
  formuyla oluşturulur; sonraki hesaplar Yönetim → Kullanıcılar bölümünden eklenir.
  Oturum imzalı bir çerezle taşınır (`SESSION_SECRET`/`DATA_ENCRYPTION_KEY` anahtarı).
- **İki faktörlü doğrulama (F2):** `REQUIRE_TOTP_FOR_ROLES` (varsayılan `yonetici`)
  bu rollere sahip hesaplara TOTP/MFA şart koşar; Yönetim → Profil & MFA ekranından
  authenticator uygulamasıyla kurulur. Hesap MFA kurmadan giriş yapamaz, denetim
  kaydına `auth.login`/`profile.totp.*` olarak yazılır.
- **Sunucu taraflı oturumlar (F3):** çerez yalnız rastgele bir oturum kimliği taşır,
  kaydı veritabanındadır (SHA-256 özeti). Yönetim → **Oturumlar** sekmesinden açık
  oturumlar görülür, tek tek ya da “bu cihaz dışındakiler” topluca kapatılır; iptal
  edilen çerez süresi dolmamış olsa bile reddedilir. Ömür `SESSION_MAX_AGE_SECONDS`
  (varsayılan 8 saat). Çıkış oturumu sunucuda da iptal eder.
- **Hesap kilidi (F4):** `LOGIN_LOCK_WINDOW_MIN` içinde `LOGIN_LOCK_MAX_FAILURES`
  hatalı giriş olursa hesap `LOGIN_LOCK_MINUTES` boyunca kilitlenir (`429` +
  `Retry-After`); sayaç başarılı girişte sıfırlanır ve olay denetim kaydına yazılır.
- **TLS/HSTS (G2):** `REQUIRE_TLS` açıkken TLS'siz sayfa istekleri https'e yönlendirilir,
  TLS'siz API istekleri `426` ile reddedilir (`/api/health` muaf); HSTS başlığı TLS'li
  yanıtlarda yazılır. Ters vekil arkasında `TRUST_PROXY=1` vererek kilidin doğru IP'yi
  görmesini sağlayın. Sertifika sonlandırma kurumun ağında yapılır — uygulama kendi
  sertifikasını üretmez.
- Onay akışı hâlâ kişisel kimlik kanıtı değildir: rapora oturumdaki hekim adı
  yazılır ve içerik SHA-256 ile mühürlenir; mühür yalnızca sonradan değişikliği
  saptar. Gerçek hasta verisi için ağ düzeyinde erişim kısıtı ve kurumsal kimlik
  (SSO/rol) şarttır; bu yazılım tıbbi cihaz değildir.
  Bu yazılım tıbbi cihaz değildir ve düzenleyici onay süreçlerinin (MDR/TİTCK vb.)
  yerini tutmaz.

## Doğrulama, risk ve gölge mod

- **Risk yönetimi:** [docs/RISK_YONETIMI.md](docs/RISK_YONETIMI.md) — ISO 14971
  biçiminde tehlike/hasar/olasılık-şiddet tablosu ve mevcut azaltıcı kontroller
  (genel + CXR/BT toraks/ICH modelleri).
- **Doğrulama kayıtları ve planı:** [docs/KLINIK_DOGRULAMA_PLANI.md](docs/KLINIK_DOGRULAMA_PLANI.md)
  mevcut doğrulama raporlarını (`Dogrulama_Raporu.md`, `Klinik_Dogrulama_ICH.md`,
  `Klinik_Dogrulama_LUNA16.md`) ve açıkta kalan CXR modeli için yapılması gerekenleri
  birleştirir; performans izleme `/yonetim → AI performans` üzerindedir (PPV,
  kalibrasyon bölmeleri).
- **Gölge mod:** Henüz doğrulanmamış bir modeli üretimde denemek için
  `NEXT_PUBLIC_AI_SHADOW_MODE=true`. Bu durumda AI adayları **rapora/ekrana girmez**;
  yalnızca etiket/şiddet/skor özeti `shadow_findings` tablosuna yazılır
  (`POST /api/shadow`, özet `GET /api/shadow/summary`). Kapatıldığında bulgular yeniden
  "aday" etiketiyle rapora girer. Yeni tabloyu veritabanına uygulamak için
  `npx drizzle-kit push --config=drizzle.config.ts`.
- **Uyum:** Yönetim → Uyum sekmesi kurumsal süreç takip listesidir (amaçlanan kullanım,
  sınıflandırma, ISO 13485/IEC 62304/14971, klinik değerlendirme, KVKK, NES, satış
  sonrası izleme). Liste kodla tamamlanamaz; sorumluluk üretici kuruma aittir.

## Lisans

MIT — ayrıntı için [LICENSE](LICENSE) dosyasına bakın.
