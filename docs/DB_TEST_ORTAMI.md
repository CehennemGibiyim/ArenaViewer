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
npm run test:db-api                  # 51 kontrol
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

Sonuç: **51/51 kontrol geçti.**

### Giriş akışı (ayrı, boş veritabanı ister)

```bash
# atik_auth veritabanını oluşturup şemayı uygulayın, sonra:
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik_auth AUTH_INTEGRATION_TEST=1 \
  npm run test:auth-integration
```

Sonuç (3 blok): **parola + MFA + imzasız oturum + `lastLoginAt`**; **oturum
listesi/iptali** (kendi oturumu `current` işaretli, yetkisiz iptal 403, iptal edilen
çerezle `/api/profile` 401); **hesap kilitleme** (`AUTH_LOCK_MAX_FAILURES=3` ile 423,
kilitliyken doğru parola da reddedilir, `unlockAccount` sonrası giriş başarılı ve
sayaç sıfır). (Test, `users` tablosuna id=1 eklediği için boş şema ister.)

Kurumsal giriş (OIDC) için ayrı bir test vardır; kendi sahte IdP'sini başlatır
(keşif + JWKS + token ucu) ve DB'ye hesap açar — bkz. `docs/OIDC.md`:

```bash
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:oidc-integration
```

Sonuç: **8 blok PASS** — ilk giriş (PKCE + hesap açma + oturum), tekrar giriş,
yönetici grubu (yükseltme, düşürmeme), doğrulanmış e-posta ile bağlama, doğrulanmamış
e-posta reddi, state/nonce/imza/token hata yolları, otomatik açma kapalı, MFA
zorunluluğu ve yapılandırma yokluğu. Saf çekirdek: `npm run test:oidc`.

Kurumsal dizin (LDAP/AD) için test kendi **sahte dizin sunucusunu** başlatır
(gerçek TCP + BER: BindRequest/SearchRequest ayrıştırılır) ve gerçek PostgreSQL'e
hesap açar — bkz. `docs/LDAP.md`:

```bash
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:ldap-integration
```

Sonuç: **9 blok PASS** — ilk giriş (servis bind → arama → kullanıcı bind → hesap +
oturum + `"method":"ldap"`), tekrar giriş (mükerrer hesap yok), yönetici grubu
yükseltmesi, hatalı/boş parola (boş parola dizine **hiç** gitmez) ve bilinmeyen
kullanıcı, filtre enjeksiyonu, otomatik açma kapalı (403), pasif hesabın dizinle
atlanmaması, doğrudan bind modu (tek bind) ve dizin sunucusu kapalıyken 503.
Saf çekirdek: `npm run test:ldap` (ağ yok).

SAML 2.0 için test kendi **sahte IdP'sini** (gerçek HTTP sunucusu) başlatır; SP'nin
AuthnRequest'ini DEFLATE+base64'ten çözer, alanlarını doğrular ve **RSA ile
imzalanmış** SAMLResponse üretir — bkz. `docs/SAML.md`:

```bash
DATABASE_URL=postgres://atik@127.0.0.1:5432/atik AUTH_INTEGRATION_TEST=1 \
  npm run test:saml-integration
```

Sonuç: **10 blok PASS** — start (AuthnRequest alanları + imzalı durum çerezi),
başarılı dönüş (imza + hesap + oturum + `auth.login.saml`), replay (aynı Assertion
ikinci kez reddedilir), tekrar giriş (mükerrer hesap yok), yönetici grubu, otomatik
açma kapalı, MFA politikası, kurcalanan/imzasız/süresi geçmiş/yanlış audience/
yanlış InResponseTo yanıtların reddi, çerezsiz dönüş ve SP metadata ucu.
Saf çekirdek: `npm run test:saml` (ağ/DB yok; XML DSig + C14N + koşullar).

Kilit ayarları testte/deployda ortam değişkeniyle verilir:
`AUTH_LOCK_MAX_FAILURES` (varsayılan 5) ve `AUTH_LOCK_MINUTES` (varsayılan 15).
Oturum kayıtları `sessions` tablosundadır; `db:push` bu tabloyu ve
`users.failed_login_count`/`users.locked_until` kolonlarını ekler. Kurumsal giriş
için `users.oidc_issuer`/`users.oidc_subject` kolonları ve `users_oidc_idx`
indeksi, LDAP için `users.ldap_dn` kolonu ve `users_ldap_idx` indeksi, SAML için
`users.saml_issuer`/`users.saml_name_id` kolonları + `users_saml_idx` indeksi ve
tek kullanım (replay) tablosu `saml_replay` aynı komutla gelir.

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
| `test:seg-ui` | 3 kontrol — segment editöründe fırça, eşik, geri al, kesit kopyalama, mL hacmin ana görünümleyiciye aktarımı, **AI adayından tohumlama** ve **kesit dağılımı** (mm² barları, en geniş kesit, bara tıklayınca o kesite gidiş) |
| `test:panels-ui` | 6 kontrol — 📈 Trend (DB'deki ölçümler, %+değişim, ikilenme), ⚖ Peer (RADPEER dağılımı, %95 GA), /yonetim → model kayıt defteri (sürüm/aşama/trafik planı), **Oturumlar** (sunucu tarafı oturum listesi / boş durum) ve **Kullanıcılar → hesap kilidi** (kilitli rozet, "Kilidi aç" düğmesi, DB'de sayaç/kilit temizliği) |

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
