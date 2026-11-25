# ATIKVIEWER — Vision AI Radyoloji İstasyonu

> ⚠️ **Araştırma / demo yazılımıdır; klinik karar için kullanılamaz.**
> Yapay zekâ çıktıları taslak niteliğindedir ve hekim onayı gerektirir.

ATIKVIEWER; DICOM görüntüleme, kesit kesit yapay zekâ destekli inceleme ve
yapısal radyoloji raporu üretimini tek ekranda toplayan, Next.js (App Router) +
PostgreSQL (Drizzle ORM) tabanlı bir radyoloji iş istasyonudur.

## Özellikler

- **DICOM görüntüleyici:** klasör/dosya/ZIP içe aktarma, sürükle-bırak, pencere/seviye
  (WL/WW + BT hazır ayarları), yakınlaştırma, kaydırma, döndürme, ters çevirme, cine
- **Gerçek codec desteği:** JPEG, JPEG Lossless, 12-bit JPEG Extended, JPEG 2000,
  HTJ2K, JPEG-LS, RLE, Deflated, Big Endian (WASM + JS çözücüler)
- **Fotometrik yorumlar:** MONOCHROME1/2, RGB, YBR, PALETTE COLOR; DICOM Overlay
  (60xx) ve GSPS sunum durumları
- **Özel nesneler:** DICOM SR (yapısal rapor), Encapsulated PDF, 12-derivasyonlu EKG
- **MPR:** axial/koronal/sagital yeniden kesit; kalın kesitte ortalama/MIP/MinIP;
  oblik (eğimli) MPR ve WebGL 3B hacim. Kesit konumu kaydı (IPP) varsa koronal/sagital
  gerçek hasta geometrisinden, ölçek kayması olmadan örneklenir (`src/lib/mpr.ts` +
  `VolumeView`). Kaynak seri salt okunur tutulur.
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
- Ayrıştırma: `src/lib/hl7.ts` (saf fonksiyonlar, `npm run test:hl7`). MWL/C-FIND ve DIMSE tarafı bu script'te **yoktur**; siparişe dayalı çalışma listesi uygulamada oluşur.

## Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `DATABASE_URL` | Evet | PostgreSQL bağlantı dizesi |
| `DATA_ENCRYPTION_KEY` | Üretimde | Base64, 32 bayt AES-256 anahtarı (boşsa `.data/enc.key` üretilir) |
| `PACS_AUTH_HEADER` | Hayır | DICOMweb kimlik başlığı — yalnızca geriye dönük; kimlik/ayarlar Yönetim → Entegrasyon'dan girilir ve sunucuda şifrelenir |
| `HIS_API_KEY` | Hayır | HBYS istem alımı API anahtarı |
| `ACCESS_TOKEN` | Hayır | Tek erişim anahtarı (kapı); tanımlıysa `/giris` kapısı ve 401 koruması açılır |
| `AUTH_MODE` | Hayır | Boş/demo: ACCESS_TOKEN varsa onunla, yoksa tek operatör. `hesap`: kullanıcı adı/parola (+MFA) zorunlu, rol denetimi aktif |
| `SESSION_SECRET` | Hesap modunda | Oturum çerezini imzalayan gizli anahtar (tanımsızsa `DATA_ENCRYPTION_KEY` kullanılır) |
| `REQUIRE_TOTP_FOR_ROLES` | Hayır | MFA zorunluluğu olan roller (varsayılan `yonetici`). Bu rollerdeki hesaplar authenticator kodu olmadan giremez |
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
npm run bench:window                # WL/WW dönüşümü kıyaslaması (eski vs LUT)
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
