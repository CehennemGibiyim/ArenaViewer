# Push (GitHub'a gönderme) rehberi

Bu depo `CehennemGibiyim/ArenaViewer` üzerindedir. Aşağıdaki sırayla itin:
her adımın beklenen çıktısı vardır; hata olursa adım durur.

## 0. Sürüm tutarlılığı (zorunlu — CI denetler)

Üç yer aynı olmalıdır:

| Nerede | Ne |
|---|---|
| `src/lib/version.ts` | `export const APP_VERSION = "0.1.0";` |
| `package.json` | `"version": "0.1.0"` |
| Git etiketi | `v0.1.0` |

## 1. Yerel doğrulama (push ÖNCESİ — hepsi geçmeli)

```bash
npx next typegen
npm exec tsc -- --noEmit --pretty false
npm run build
node --experimental-strip-types tests/recist.test.mjs   # 8/8 geçmeli
bash packaging/universal/build-source-zip.sh            # kurulum ZIP'i
```

## 2. Değişiklikleri ekle ve imzala

```bash
git status                                   # değişen dosyaları gözden geçir
git add -A
git commit -m "Çapraz platform kurulum paketleri (Linux/macOS/ZIP), RECIST 1.1, /paketler sayfası"
```

İyi bir commit mesajı şu üçü içerir: **ne değişti**, **neden**, **nasıl doğrulandı**.

## 3. Push

```bash
git remote add origin https://github.com/CehennemGibiyim/ArenaViewer.git   # yoksa
git branch -M main
git push -u origin main
```

Kimlik doğrulama gerekirse (önerilen, parola yerine):

```bash
# GitHub → Settings → Developer settings → Personal access tokens (classic)
# kapsam: repo
git remote set-url origin https://<TOKEN>@github.com/CehennemGibiyim/ArenaViewer.git
```

## 4. Sürüm etiketi ve kurulum paketleri (CI otomatik üretir)

```bash
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` tetiklenir ve **GitHub Releases** sayfasına yükler:

- `ATIKVIEWER-0.1.0-Setup.exe` — Windows kurulumu (Inno Setup)
- `ATIKVIEWER-0.1.0-portable.zip` — Windows taşınabilir
- `ATIKVIEWER-0.1.0-amd64.deb` — Debian/Ubuntu
- `ATIKVIEWER-0.1.0-linux.tar.gz` — Linux taşınabilir
- `ATIKVIEWER-0.1.0-macOS.dmg` — macOS
- `ATIKVIEWER-0.1.0-kurulum.zip` — tüm kurulum dosyaları (yollarıyla)

## 5. Yayın sonrası denetim

```bash
bash packaging/universal/verify.sh        # kurulum + AI denetimi, log üretir
curl -s http://127.0.0.1:3000/api/health  # {"ok":true}
```

> **Not:** `git push` yerel makinenizde GitHub kimlik bilgisiyle (HTTPS + PAT
> veya SSH anahtarı) çalışır. Paket çıktıları normalde CI (`release.yml`) üretip
> GitHub Releases’e ekler; yerelde üretmek isterseniz
> `bash packaging/universal/build-source-zip.sh` (çıktı: `dist/`) çalıştırın.
> `dist/` ve `.env` gitignore’dadır, repoya eklenmez.

## Sık karşılaşılan hatalar

| Hata | Çözüm |
|---|---|
| `Sürüm uyuşmuyor` | 3. tabloyu eşitleyin |
| `remote already exists` | `git remote set-url origin <url>` |
| `Permission denied (publickey)` | HTTPS + PAT kullanın veya SSH anahtarı ekleyin |
| `pre-commit` başarısız | önce `npm run build` ve testleri geçirin |
| CI `npm ci` hatalı | `package-lock.json` commitlenmiş mi? |
