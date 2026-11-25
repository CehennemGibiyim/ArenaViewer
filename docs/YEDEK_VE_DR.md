# Yedekleme, geri yükleme ve olağanüstü durum (DR)

Bu belge **ne yedeklenir**, **nasıl doğrulanır** ve **felaket sonrası nasıl geri
dönülür** sorularını yanıtlar. Klinik kullanım öncesi DR tatbikatı bir kez
yapılmalı ve sonucu `docs/KLINIK_DOGRULAMA_PLANI.md` ile birlikte arşivlenmelidir.

## 1. Neyin yedeği alınır?

| Bileşen | İçerik | Yöntem |
|---|---|---|
| PostgreSQL | kullanıcılar, çalışmalar, raporlar, denetim kaydı, ayarlar | `pg_dump` (aşağıdaki playbook) |
| Görüntü dosyaları | DICOM dosyaları, AES-256-GCM ile **şifreli** | `StorageAdapter` (`.data/` ya da S3/MinIO) |
| Anahtar | `DATA_ENCRYPTION_KEY` | **Ayrı** kasada (KMS/parola yöneticisi), yedekle aynı yerde tutulmaz |
| Yedek manifesti | dosya listesi + SHA-256 | `GET /api/admin/backup?download=1` |

> Anahtar ile şifreli veri aynı yerde tutulursa yedek sızıntısı doğrudan hasta
> verisi sızıntısı olur. İkisini ayrı sorumluluk alanlarında saklayın.

## 2. Veritabanı (pg_dump)

```bash
# Günlük tam yedek (sıkıştırılmış, 14 gün saklanır)
pg_dump "$DATABASE_URL" -Fc -Z6 -f "yedek/db-$(date +%Y%m%d-%H%M).dump"

# Doğrulama: yedeğin okunabildiğini ve şemasının beklendiğini denetle
pg_restore --list "yedek/db-YYYYmmdd-HHMM.dump" | grep -q "TABLE DATA studies" \
  || echo "YEDEK BOZUK"

# Geri yükleme (boş veritabanına)
createdb app_db_restore
pg_restore -d app_db_restore --no-owner --clean --if-exists "yedek/db-YYYYmmdd-HHMM.dump"
```

Saklama: en az 7 günlük, tercihen 30 günlük döngü ve **haftalık offsite** kopya
(3-2-1 kuralı). Yedekler `DATA_ENCRYPTION_KEY`'den bağımsız bir anahtarla da
şifrelenmelidir (`age`/`gpg`).

## 3. Görüntü dosyaları ve manifest

Adaptör iki arka ucu destekler; seçim sırası **ayar → `S3_*` ortamı → yerel disk**.

```bash
# S3/MinIO (MinIO varsayılan yol tarzı adresleme kullanır)
S3_ENDPOINT=https://minio.kurum.local:9000 S3_BUCKET=atikviewer \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_REGION=eu-central-1 npm start
# AWS/R2 gibi sanal host kullanan servisler için: S3_VIRTUAL_HOST=1
```

Manifest üretme ve doğrulama (yönetici oturumu gerekir):

```bash
curl -s -b cookies.txt "https://radyo.kurum.local/api/admin/backup?download=1" -o yedek-$(date +%F).json
# Depodaki dosyaları manifeste karşı doğrula (DR tatbikatının makine adımı)
curl -s -b cookies.txt -X POST -H 'Content-Type: application/json' \
     -H "x-csrf-token: $(grep av_csrf cookies.txt | awk '{print $7}')" \
     -d "{\"verify\": $(cat yedek-2026-01-15.json)}" \
     https://radyo.kurum.local/api/admin/backup
```

Yanıt: `{ ok, errors[], warnings[], checked, summary }`. `summary` örneği:
`412 dosya / 3.2 GB / 412 denetlendi / 0 eksik / sağlam`.

```bash
# Elle (tarayıcıdan bağımsız) doğrulama — CI/otomasyon için
node scripts/supplychain.mjs verify --dir <sürüm-klasörü> --strict
```

## 4. Felaket senaryoları

### 4.1 Disk arızası (veritabanı sağlam, dosyalar gitti)

1. Yeni makinede `.env` içine **aynı** `DATA_ENCRYPTION_KEY` yazılır.
2. `StorageAdapter` yeni diske/S3'e yönlendirilir.
3. Yedeği geri yükle: S3 → yeni depo için `POST /api/admin/backup` gövdesinde
   `{"restore": <manifest>}`. Bu işlem **idempotenttir**: aynı özetli dosyalar
   atlanır, fazladan dosyalar **silinmez** (raporlanır).
4. `verify` çağrısıyla doğrula; `errors` boş olmalı.

> Manifest dosya **içeriği taşımaz**; içerik depoda (S3/disk) durur. Depo da
> kaybolduysa dosya düzeyi yedek (S3 versiyonlama / offsite kopya) gerekir.

### 4.2 Veritabanı kaybı

`pg_restore` ile en son dökümü geri yükle → uygulamayı başlat → `Yönetim →
Güvenlik → Mevcut kayıtları şifle` durumunu kontrol et. Denetim kaydı
zinciri (`audit_logs.prev_hash/hash`) bozulmuşsa döküm sonrası ilk satırdan
itibaren doğrulanmalıdır.

### 4.3 Anahtar kaybı

Şifreli dosyalar çözülemez (`[çözülemedi]`). Manifestte bu dosyalar
`shaScope: "cipher"` olarak işaretlenir; bütünlükleri doğrulanabilir ama içerik
kurtarılamaz. **Anahtar kaybı = veri kaybı**; bu yüzden anahtar yedeği zorunludur.

## 5. Tatbikat kontrol listesi

- [ ] `pg_dump` alındı ve `pg_restore --list` ile doğrulandı
- [ ] Boş bir veritabanına geri yükleme yapıldı, uygulama açıldı, bir rapor görüntülendi
- [ ] Manifest indirildi, `verify` → `ok: true`
- [ ] Rastgele bir görüntü dosyası silinip `restore` ile geri getirildi
- [ ] Silinen dosya `verify` ile **hata** olarak raporlandı (negatif test)
- [ ] Anahtar ayrı kasada; yedekle aynı ortamda değil
- [ ] Tatbikat tarihi, süresi ve sonucu arşivlendi
