#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — evrensel kurulum arşivi (tüm işletim sistemleri)
# ============================================================================
# Kullanım:
#   bash packaging/universal/build-source-zip.sh
#
# Çıktı (dist/):
#   ATIKVIEWER-<sürüm>-kurulum.zip   — kuruluma dair TÜM dosyalar,
#                                       orijinal dosya yollarıyla korunur.
#
# İçerik: windows/, packaging/ (linux, macos, universal), Dockerfile,
# docker-compose.yml, .env.example, README.md, docs/ (kurulum ve klinik
# doğrulama belgeleri), ai-worker/ (ücretsiz yerel yapay zekâ).
# node_modules, .next, .git ve .env PAKETLENMEZ.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { printf '\033[31mHATA\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m OK\033[0m %s\n' "$*"; }

VERSION="$(sed -n 's/.*APP_VERSION = "\([^"]*\)".*/\1/p' src/lib/version.ts)"
[ -n "$VERSION" ] || fail "Sürüm okunamadı"
ok "sürüm: $VERSION"

DIST="$ROOT/dist"
STAGE="$DIST/source-stage"
rm -rf "$STAGE"
mkdir -p "$DIST" "$STAGE"

# Paketlenecek yollar (dosya yolları korunarak)
PATHS=(
  windows
  packaging
  docs
  Dockerfile
  docker-compose.yml
  .dockerignore
  .env.example
  README.md
  LICENSE
  render.yaml
)

for p in "${PATHS[@]}"; do
  [ -e "$p" ] || { echo "  (atlandı, yok: $p)"; continue; }
  mkdir -p "$STAGE/$(dirname "$p")"
  cp -r "$p" "$STAGE/$p"
done

# ai-worker: ağır veri/venv hariç kod dosyaları
mkdir -p "$STAGE/ai-worker"
find ai-worker -maxdepth 1 -type f ! -name "*.pyc" -exec cp {} "$STAGE/ai-worker/" \;
[ -d ai-worker/__pycache__ ] && rm -rf "$STAGE/ai-worker/__pycache__" || true

# Yükleme betiği: her işletim sisteminden tek komut
cat > "$STAGE/KUR.bat" <<'EOF'
@echo off
rem ATIKVIEWER kurulumu (Windows) — bu arsivi acin ve calistirin
powershell -ExecutionPolicy Bypass -File windows\Kurulum.bat
pause
EOF

cat > "$STAGE/KUR.sh" <<'EOF'
#!/usr/bin/env bash
# ATIKVIEWER kurulumu (Linux / macOS)
set -e
cd "$(dirname "$0")"
case "$(uname -s)" in
  Darwin) bash packaging/macos/install.sh ;;
  *)      bash packaging/linux/install.sh ;;
esac
EOF
chmod +x "$STAGE/KUR.sh"

ZIP="$DIST/ATIKVIEWER-$VERSION-kurulum.zip"
rm -f "$ZIP"
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -qr "$ZIP" . )
else
  ( cd "$STAGE" && python3 -c "
import shutil, sys
shutil.make_archive('$ZIP'.replace('.zip',''), 'zip', '.')
" )
fi
[ -f "$ZIP" ] || fail "ZIP üretilemedi"
ok "$ZIP ($(du -h "$ZIP" | cut -f1))"

# Özet dosya yolları
cat > "$DIST/DOSYA_YOLLARI.txt" <<SUM_EOF
ATIKVIEWER $VERSION — kurulum dosyaları ve yolları
===================================================
Arşiv: $(basename "$ZIP")

Windows
  windows/Kurulum.bat              tek komutla kurulum (önerilen)
  windows/Baslat.bat               başlat
  windows/Dur.bat                  durdur
  windows/Veritabani.ps1           PostgreSQL kurulumu
  windows/Paket.ps1                Inno Setup ile Setup.exe + portable.zip üretir
  windows/atikviewer.iss           Inno Setup betiği
  docs/WINDOWS_KURULUM.md          Windows kurulum rehberi ve hata çözümleri

Linux
  packaging/linux/install.sh       tek komutla kurulum (Debian/Fedora/Arch)
  packaging/linux/build-deb.sh     .deb + taşınabilir tar.gz üretir
  packaging/linux/atikviewer.desktop   masaüstü girişi
  packaging/linux/atikviewer-user.service  systemd kullanıcı birimi

macOS
  packaging/macos/install.sh       kurulum + LaunchAgent
  packaging/macos/build-dmg.sh     .dmg + tar.gz üretir
  packaging/macos/Info.plist       uygulama paketi bilgisi

Çapraz platform
  packaging/universal/build-source-zip.sh  bu arşivi üretir
  packaging/universal/verify.sh     kurulum sonrası sağlık ve AI denetimi
  packaging/README.md               tüm paketlerin yol ve komut tablosu
  Dockerfile / docker-compose.yml   Docker (her işletim sistemi)
  .env.example                      ortam değişkenleri şablonu

Yapay zekâ (ücretsiz, yerel)
  ai-worker/server.py               yerel çıkarım sunucusu (127.0.0.1:8787)
  ai-worker/setup_model.py          MONAI modellerini indirir
  ai-worker/requirements.txt        Python bağımlılıkları
  docs/Klinik_Dogrulama_LUNA16.md   akciğer nodülü teknik doğrulaması
  docs/Klinik_Dogrulama_ICH.md      beyin kanaması doğrulaması

UYARI: Araştır amaçlıdır; klinik karar için kullanılamaz.
Tüm AI bulguları radyoloji uzmanı onayı gerektirir.
SUM_EOF

rm -rf "$STAGE"
info "Çıktılar: dist/"
