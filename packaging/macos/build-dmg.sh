#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — macOS DMG kurulum paketi üretimi
# ============================================================================
# Kullanım (macOS, depodan):
#   bash packaging/macos/build-dmg.sh
#
# Çıktı (dist/):
#   ATIKVIEWER-<sürüm>-macOS.dmg     — çift tıkla açılır, "Install.command"
#   ATIKVIEWER-<sürüm>-macOS.tar.gz   — kurulumsuz taşınabilir arşiv
#
# DMG içindekiler: ATIKVIEWER/ (kaynak + betikler), Install.command,
# KURULUM.txt ve packaging/ (AI worker kurulumu için).
# Node.js ve PostgreSQL DMG'ye GİRMEZ (lisans ve boyut); Install.command
# eksikleri denetler ve yönlendirir.
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
STAGE="$DIST/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$DIST" "$STAGE/ATIKVIEWER"

info "Paket ağacı hazırlanıyor (node_modules, .git, veri hariç)"
tar -cf - \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.next' \
  --exclude='./dist' \
  --exclude='./.venv' \
  --exclude='./.data' \
  --exclude='./.env' \
  --exclude='./ai-worker/data' \
  --exclude='./*.tsbuildinfo' \
  . | tar -xf - -C "$STAGE/ATIKVIEWER"

# İkon
if [ -f public/icons/rad-ai-scan.svg ]; then
  cp public/icons/rad-ai-scan.svg "$STAGE/ATIKVIEWER/ATIKVIEWER.icns" 2>/dev/null || true
fi

# ── Install.command ────────────────────────────────────────────────────────
cat > "$STAGE/Install.command" <<'INSTALL_EOF'
#!/bin/bash
# ATIKVIEWER macOS kurulumu — çift tıklayın.
set -euo pipefail
cd "$(dirname "$0")/ATIKVIEWER"
echo "=============================================="
echo " ATIKVIEWER kuruluyor (macOS)"
echo "=============================================="
if ! command -v node >/dev/null 2>&1; then
  echo "! Node.js bulunamadı."
  echo "  1) https://nodejs.org adresinden LTS kurun  veya"
  echo "  2) Homebrew ile:  brew install node@22"
  read -r -p "Kurulduktan sonra Enter'a basın... " _
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "! Node.js 22+ gerekli (mevcut: $(node -v 2>/dev/null || echo yok))"
  read -r -p "Enter'a basın ve tekrar deneyin... " _
  exit 1
fi
bash packaging/macos/install.sh
INSTALL_EOF
chmod +x "$STAGE/Install.command"

# ── KURULUM.txt ────────────────────────────────────────────────────────────
cat > "$STAGE/KURULUM.txt" <<TXT_EOF
ATIKVIEWER $VERSION — macOS kurulumu
====================================

1) "Install.command" dosyasına çift tıklayın (ilk seferde Gatekeeper
   engellerse: sağ tık → Aç  veya  xattr -dr com.apple.quarantine ATIKVIEWER)

2) Eksikleri Install.command kurar:
   - Node.js 22+   (https://nodejs.org veya brew install node@22)
   - PostgreSQL    (brew install postgresql@16 && brew services start postgresql@16)

3) Başlat:   atikviewer        veya terminalden: cd ATIKVIEWER && npm start
   Adres:    http://127.0.0.1:3000

4) ÜCRETSİZ yerel yapay zekâ (MONAI modelleri, hasta verisi çıkmaz):
   cd ATIKVIEWER
   python3 -m venv .venv
   ./.venv/bin/pip install -r ai-worker/requirements.txt
   ./.venv/bin/python ai-worker/setup_model.py
   ./.venv/bin/python ai-worker/server.py

5) Sistem servisi (otomatik başlatma):
   bash packaging/macos/install.sh   → LaunchAgent sorar

UYARI: Araştır amaçlıdır, klinik karar için kullanılamaz.
AI bulguları radyoloji uzmanı onayı gerektirir.
Dosya yolları için: packaging/README.md
TXT_EOF

# ── DMG ────────────────────────────────────────────────────────────────────
DMG="$DIST/ATIKVIEWER-$VERSION-macOS.dmg"
if command -v hdiutil >/dev/null 2>&1; then
  info "DMG oluşturuluyor"
  rm -f "$DMG"
  hdiutil create -volname "ATIKVIEWER $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  ok "$DMG ($(du -h "$DMG" | cut -f1))"
else
  warn "hdiutil yok (macOS dışında çalışıyor olabilirsiniz) — DMG atlandı"
fi

# ── Taşınabilir tar.gz ─────────────────────────────────────────────────────
TAR="$DIST/ATIKVIEWER-$VERSION-macOS.tar.gz"
tar -czf "$TAR" -C "$STAGE" .
ok "$TAR ($(du -h "$TAR" | cut -f1))"

rm -rf "$STAGE"
info "Çıktılar: dist/"
