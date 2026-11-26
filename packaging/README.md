# ATIKVIEWER — Çapraz Platform Kurulum Paketleri

> **Araştırma amaçlıdır; klinik karar için kullanılamaz.** Yapay zekâ çıktıları
> taslaktır ve **radyoloji uzmanı onayı** olmadan rapora işlenemez.
> Tüm derin öğrenme çıkarımı **yerel ve ücretsizdir**; hasta verisi dışarı çıkmaz.

Bu klasör, Windows · Linux · macOS üzerinde çalışan kurulum paketlerinin
**kaynak dosyalarını ve komutlarını** içerir. Her dosyanın yolu aşağıdadır.

---

## 1. Dosya yolu tablosu (teslim edilen paket)

### Windows

| Dosya yolu | Ne işe yarar |
|---|---|
| `windows/Kurulum.bat` | **Tek komutla kurulum** (Git, Node.js, Python, AI paketleri ve modelleri indirir) |
| `windows/Kurulum.ps1` | Kurulumun PowerShell çekirdeği (idempotent, hata ayıklamalı) |
| `windows/Baslat.bat` | AI worker + görüntüleyici + tarayıcıyı başlatır |
| `windows/Guncelle.ps1` | Kurulu Windows sürümünde Release'i doğrular ve otomatik günceller |
| `windows/Baslat.ps1` | Başlatıcının PowerShell çekirdeği |
| `windows/Dur.bat` / `Dur.ps1` | Çalışan süreçleri kapatır |
| `windows/Veritabani.ps1` | PostgreSQL kurulumu ve veritabanı oluşturma |
| `windows/atikviewer.iss` | **Inno Setup 6** kurulum EXE betiği |
| `windows/Paket.ps1` | `dist\ATIKVIEWER-<sürüm>-Setup.exe` + `portable.zip` üretir |
| `docs/WINDOWS_KURULUM.md` | Windows kurulum rehberi + sık karşılaşılan hataların çözümleri |
| `docs/KURULUM_VE_KULLANIM.md` | **Her işletim sistemi** için görsel + videolu kurulum/kullanım kılavuzu (≈3,2 MB varlık) |

```powershell
# Üretim (CI'da .github/workflows/release.yml otomatik yapar)
winget install JRSoftware.InnoSetup
powershell -ExecutionPolicy Bypass -File windows\Paket.ps1
# Çıktı: dist\ATIKVIEWER-0.2.0-Setup.exe, dist\ATIKVIEWER-0.2.0-portable.zip, SHA256SUMS
```

### Linux

| Dosya yolu | Ne işe yarar |
|---|---|
| `packaging/linux/install.sh` | **Tek komutla kurulum** (Debian/Ubuntu/Mint/Fedora/Arch) |
| `packaging/linux/build-deb.sh` | `ATIKVIEWER-<sürüm>-amd64.deb` + `linux.tar.gz` üretir |
| `packaging/linux/atikviewer.desktop` | Masaüstü menü girişi (GNOME/KDE/XFCE) |
| `packaging/linux/atikviewer-user.service` | systemd kullanıcı birimi (`systemctl --user enable atikviewer`) |

```bash
bash packaging/linux/install.sh        # kurulu değilse kaynak klonlar ve kurar
bash packaging/linux/build-deb.sh      # dist/ATIKVIEWER-0.2.0-amd64.deb
sudo dpkg -i dist/ATIKVIEWER-0.2.0-amd64.deb
atikviewer                             # http://127.0.0.1:3000
```

### macOS

| Dosya yolu | Ne işe yarar |
|---|---|
| `packaging/macos/install.sh` | Kurulum + isteğe bağlı LaunchAgent (otomatik başlatma) |
| `packaging/macos/build-dmg.sh` | `ATIKVIEWER-<sürüm>-macOS.dmg` + `macOS.tar.gz` üretir (DMG içinde `Install.command`; ayrı plist dosyası gerekmez) |

```bash
bash packaging/macos/install.sh
bash packaging/macos/build-dmg.sh     # dist/ATIKVIEWER-0.2.0-macOS.dmg
```

### Çapraz platform

| Dosya yolu | Ne işe yarar |
|---|---|
| `packaging/universal/build-source-zip.sh` | **Tüm kurulum dosyalarını orijinal yollarıyla ZIP'e koyar** |
| `packaging/universal/verify.sh` | Kurulum sonrası sağlık + AI denetimi, log üretir |
| `packaging/README.md` | Bu belge |
| `Dockerfile` / `docker-compose.yml` | Docker ile her işletim sisteminde |
| `.env.example` | Ortam değişkenleri şablonu (`DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `AI_WORKER_URL`) |
| `render.yaml` | Tek tıkla bulut dağıtımı |

```bash
bash packaging/universal/build-source-zip.sh   # → dist/ATIKVIEWER-0.2.0-kurulum.zip
bash packaging/universal/verify.sh             # → dist/ATIKVIEWER-dogrulama-<tarih>.log
```

### Ücretsiz yerel yapay zekâ

| Dosya yolu | Ne işe yarar |
|---|---|
| `ai-worker/server.py` | Yerel çıkarım sunucusu — yalnız `127.0.0.1:8787`, ağ dışına çıkmaz |
| `ai-worker/setup_model.py` | Modelleri indirir: akciğer ≈84 MB + beyin ≈147 MB (**ücretsiz**) |
| `ai-worker/model_lib.py` | MONAI `lung_nodule_ct_detection` (LUNA16) — BT toraks nodülü |
| `ai-worker/brain_lib.py` + `ich_inference.py` | `ct-head-hemorrhage-detection` (MIT/RSNA) — BT beyin kanaması |
| `ai-worker/requirements.txt` | torch, monai, opencv, safetensors… (ücretsiz) |
| `ai-worker/validate_*.py` | Teknik doğrulama betikleri |
| `docs/Klinik_Dogrulama_LUNA16.md` | Akciğer modeli doğrulama raporu |
| `docs/Klinik_Dogrulama_ICH.md` | Beyin kanaması doğrulama raporu |
| `docs/OLLAMA.md` | **Ücretsiz yerel LLM** ile taslak izlenim |

```bash
python3 -m venv .venv
./.venv/bin/pip install -r ai-worker/requirements.txt
./.venv/bin/python ai-worker/setup_model.py     # modelleri indir
./.venv/bin/python ai-worker/server.py          # 127.0.0.1:8787
# Durum:  curl http://127.0.0.1:8787/health   veya   /api/deep-scan
```

---

## 2. İşletim sistemi başına tek komut

| İşletim sistemi | Komut | Çıktı |
|---|---|---|
| Windows | `windows\Kurulum.bat` | Kurulum + `windows\Baslat.bat` |
| Windows (paket üretimi) | `powershell -ExecutionPolicy Bypass -File windows\Paket.ps1` | `dist\*-Setup.exe`, `*-portable.zip` |
| Ubuntu/Debian | `bash packaging/linux/install.sh` | `/usr/local/bin/atikviewer` + masaüstü girişi |
| Debian (paket) | `bash packaging/linux/build-deb.sh` | `dist/*.deb`, `dist/*.tar.gz` |
| macOS | `bash packaging/macos/install.sh` | `atikviewer` + LaunchAgent |
| macOS (paket) | `bash packaging/macos/build-dmg.sh` | `dist/*.dmg`, `dist/*.tar.gz` |
| Herhangi biri (Docker) | `docker compose up --build -d` | `http://localhost:3000` |
| Kurulum sonrası denetim | `bash packaging/universal/verify.sh` | `dist/ATIKVIEWER-dogrulama-*.log` |

---

## 3. Ücretlidir / ücretsizdir ayrımı

| Kalem | Durum |
|---|---|
| Görüntüleme, MPR, VR, ölçüm, rapor, PACS | **Ücretsiz** (açık kaynak bağımlılıklar) |
| Derin öğrenme çıkarımı (MONAI + ICH) | **Ücretsiz**, bu makinede çalışır |
| Yerel LLM ile taslak izlenim (Ollama) | **Ücretsiz** |
| Modeller (akciğer + beyin) | **Ücretsiz** (~231 MB, MIT/lisanslı) |
| Harici bulut AI API'si | **Kullanılmaz** — ücretli servis yok |
| PostgreSQL | Ücretsiz (sistem paketi) |

---

## 4. Klinik güvenlik kuralları (değiştirilemez)

1. Her AI bulgusu **"Onay Bekliyor"** gelir; radyoloji uzmanı onaylamadan rapor
   onaylanamaz (sunucuda da zorunlu).
2. Model yok / worker kapalı ise sonuç **açıkça etiketlenir**; sahte bulgu üretilmez.
3. Skorlar **"kalibre değil"** etiketlidir; olasılık gibi sunulmaz.
4. Denetim kaydı (audit) hash zincirlidir ve değiştirilemez.
5. Hasta verisi AES-256-GCM ile şifrelenir ve **bu makineden dışarı çıkmaz**.
6. Erişim kısıtı önerilir: uygulamayı yalnızca yerel ağ/VPN üzerinden açın
   (`127.0.0.1` varsayılanıdır) — KVKK için bu şarttır.

---

## 5. Sürüm tutarlılığı

Sürüm üç yerde aynı olmalıdır (CI bunu denetler, `windows/Paket.ps1` de):

1. `src/lib/version.ts` → `APP_VERSION`
2. `package.json` → `version`
3. Git etiketi → `vX.Y.Z`
