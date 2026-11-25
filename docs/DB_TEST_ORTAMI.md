# Veritabanlı ve tarayıcılı test ortamı (Docker/apt olmadan)

Bu belge, **PostgreSQL yok** ve **Playwright tarayıcı CDN'i kapalı** olan
ortamlarda (CI sandbox, kısıtlı ağ) uçtan uca testlerin nasıl çalıştırıldığını ve
25 Kasım 2026'da alınan sonuçları kaydeder. Üretim kurulumu değildir.

## 1) PostgreSQL — npm paketinden

`@embedded-postgres/*` paketleri `initdb`/`postgres` ikililerini taşır; root,
docker veya apt gerekmez. Linux x64 için paket `optionalDependencies` içindedir
(`package.json`), diğer platformlarda `EMBEDDED_PG_DIR` ile kendi ikili dizininizi
verin.

```bash
npm run db:local                     # initdb (gerekirse) + postgres + veritabanı
# → postgres://atik@127.0.0.1:5432/atik  (trust auth, yalnız 127.0.0.1)

export DATABASE_URL=postgres://atik@127.0.0.1:5432/atik
npm run db:push                      # drizzle şeması (measurement_history, model_registry dahil)

AV_RATE_LIMIT=off npm start &        # testlerde hız sınırı kapalı; CSRF açık kalır
npm run test:db-api                  # 38 kontrol
npm run db:local:stop
```

Doğrulanan sürüm: **PostgreSQL 17.12** (`@embedded-postgres/linux-x64@17.12.0-beta.19`).
Veri dizini varsayılan `/tmp/av-pgdata`, günlük `server.log`; ikisi de depo dışındadır.

### `npm run test:db-api` neyi kanıtlıyor?

`tests/db-api.e2e.ts` gerçek HTTP + gerçek şema üzerinden çalışır (demo oturumu,
`av_csrf` çerezi zorunlu):

- **Ölçüm geçmişi:** CSRF'siz POST 403; 3 satır kaydı (`saved=3`) ve DB'de birebir
  varlığı; mL değerinin hassasiyetle saklanması; aynı hasta+çalışma+seri için
  yeniden kaydın 3 → 2 satıra **değiştirmesi** (kopya yok); güncellenen değerin
  GET'te görünmesi (25 → 27,5); geçersiz birim/sıfır değer/eksik `patientId` 400.
- **RADPEER:** onaylı rapor örnekleme giriyor; uyumsuz değerlendirmede açıklama
  zorunlu (400); geçersiz fark türü 400; ikinci okuma 201 ve addendum önerisi;
  istatistikte `known` artıyor, RADPEER 3 dağılımı ve %95 GA başlığı var;
  değerlendirilen rapor sonraki örneklemden **çıkıyor**.
- **Model kayıt defteri:** yeni sürüm 201, gölge sürüm 201, mevcut sürüm 200
  (trafik 80); emekli/gölge sürüme trafik 400; geçersiz anahtar 400; liste iki
  sürümü ve özeti döndürüyor; DB'de upsert tek satır.
- **Denetim:** `model_registry.register/update`, `measurement-history-save`,
  `report.peer_review` kayıtları `audit_logs`ta.

Sonuç: **38/38 kontrol geçti.**

### Giriş akışı (ayrı, boş veritabanı ister)

```bash
# atik_auth veritabanını oluşturup şemayı uygulayın, sonra:
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik_auth AUTH_INTEGRATION_TEST=1 \
  npm run test:auth-integration
```

Sonuç: parola + MFA + imzasız oturum + başarılı girişte `lastLoginAt` senaryoları
geçti. (Test, `users` tablosuna id=1 eklediği için boş şema ister.)

## 2) Playwright tarayıcısı — npm'den Chromium

`npx playwright install chromium` CDN'i kapalıysa:

```bash
npm i -D @sparticuz/chromium          # ya da depo dışına kurup AV_CHROMIUM_MODULE verin
eval "$(node scripts/local-chromium.mjs --print-env)"   # CHROMIUM_PATH + LD_LIBRARY_PATH
BASE_URL=http://127.0.0.1:3000 npm run test:seg-ui
BASE_URL=http://127.0.0.1:3000 DATABASE_URL=... npm run test:panels-ui
```

`scripts/local-chromium.mjs` Chromium'u `/tmp/chromium`e, Amazon Linux uyumlu
paylaşılan kütüphaneleri `/tmp/av-chromium-libs/lib`e açar. Test betikleri
`CHROMIUM_PATH` verildiğinde `executablePath` olarak onu kullanır.

Doğrulanan sürüm: **Chromium 158.0.8127.0** (`@sparticuz/chromium@158.0.0`),
Playwright 1.65.1.

### Çalıştırılan tarayıcı testleri (production sunucu :3300, E2E fixture'ları açık)

| Test | Sonuç |
| --- | --- |
| `test:menu` | 16 kontrol — üst menü, dosya/klasör seçicileri, Oto-düzen, MPR, 3B, PNG, protokol editörü, iframe, hata senaryoları |
| `test:review` | 5 kontrol — renkli Doppler 12/12 kare, US raporu, CR tek kare, BT beyin |
| `test:report-flow` | 3 kontrol — onay kapıları, derin AI akışı, JS hatası yok |
| `test:folder` | 3 kontrol — boş/medikal olmayan/desteklenmeyen klasör mesajları |
| `test:seg-ui` | 2 kontrol — segment editöründe fırça, eşik, geri al, kesit kopyalama, mL hacmin ana görünümleyiciye aktarımı ve **AI adayından tohumlama** |
| `test:panels-ui` | 4 kontrol — 📈 Trend (DB'deki ölçümler, %+değişim, ikilenme), ⚖ Peer (RADPEER dağılımı, %95 GA), /yonetim → model kayıt defteri (sürüm/aşama/trafik planı) |

Fixture'lı production derlemesi ve sunucu:

```bash
NEXT_PUBLIC_E2E_FIXTURES=true DATABASE_URL=... npm run build
DATABASE_URL=... AV_RATE_LIMIT=off npx next start -p 3300
```

## 3) Sınırlar

- `db:local` **trust** kimlik doğrulaması kullanır ve yalnız `127.0.0.1`i dinler;
  üretimde kullanılmaz. Veriler `/tmp` altındadır, makine kapanınca kaybolur.
- Tarayıcı testleri fixture (sentetik) verisiyle çalışır; gerçek DICOM/PACS
  uyumunu kanıtlamaz.
- Bu ortamda ölçülen süreler kaydedilmedi (performans iddiası yok).
