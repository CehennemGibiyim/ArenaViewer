#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — Debian/Ubuntu .deb kurulum paketi üretimi
# ============================================================================
# Kullanım (depodan, Node.js 22+ gerekir):
#   bash packaging/linux/build-deb.sh
#
# Çıktılar (dist/):
#   ATIKVIEWER-<sürüm>-amd64.deb     — dpkg ile kurulur:  sudo dpkg -i dist/*.deb
#   ATIKVIEWER-<sürüm>-linux.tar.gz   — kurulumsuz taşınabilir arşiv
#
# Paket içeriği (/opt/atikviewer): package.json, .next, public, next.config.ts,
# node_modules (yalnız üretim bağımlılıkları) + /usr/bin/atikviewer başlatıcısı.
# Python/AI modelleri pakete GİRMEZ (çok büyük); isteğe bağlı olarak kurulum
# sonunda packaging/linux/install.sh ile eklenir.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { printf '\033[31mHATA\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m OK\033[0m %s\n' "$*"; }

VERSION="$(sed -n 's/.*APP_VERSION = "\([^"]*\)".*/\1/p' src/lib/version.ts)"
[ -n "$VERSION" ] || fail "Sürüm okunamadı (src/lib/version.ts)"
ok "sürüm: $VERSION"

command -v dpkg-deb >/dev/null 2>&1 || fail "dpkg-deb yok (Debian/Ubuntu gerekir: sudo apt install dpkg-dev)"

# ── 1. Üretim derlemesi ────────────────────────────────────────────────────
info "Üretim derlemesi"
npm ci --no-audit --no-fund
npm run build

DIST="$ROOT/dist"
STAGE="$DIST/deb-stage"
PKG="$DIST/ATIKVIEWER-$VERSION"
rm -rf "$STAGE" "$PKG"
mkdir -p "$DIST" "$STAGE"

# ── 2. Uygulama ağacı ──────────────────────────────────────────────────────
info "Paket ağacı hazırlanıyor"
APP="$STAGE/opt/atikviewer"
mkdir -p "$APP"

cp package.json "$APP/"
cp next.config.ts "$APP/"
[ -f .env.example ] && cp .env.example "$APP/"
cp -r public "$APP/public"
cp -r .next "$APP/.next"
[ -d src ] && mkdir -p "$APP/src" && cp -r src/app "$APP/src/app" 2>/dev/null || true
cp -r packaging "$APP/packaging" 2>/dev/null || true
cp -r windows "$APP/windows" 2>/dev/null || true
cp -r ai-worker "$APP/ai-worker" 2>/dev/null || true
cp README.md LICENSE "$APP/" 2>/dev/null || true
mkdir -p "$APP/docs" && cp docs/*.md "$APP/docs/" 2>/dev/null || true

info "Üretim bağımlılıkları kuruluyor (npm ci --omit=dev)"
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )

# Gereksiz ağırlığı at
rm -rf "$APP/.next/cache" "$APP/node_modules/.cache" 2>/dev/null || true
find "$APP" -name "*.tsbuildinfo" -delete 2>/dev/null || true

# ── 3. Başlatıcı ───────────────────────────────────────────────────────────
mkdir -p "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor/scalable/apps" "$STAGE/DEBIAN"

cat > "$STAGE/usr/bin/atikviewer" <<'EOF'
#!/usr/bin/env bash
# ATIKVIEWER başlatıcı (deb)
set -euo pipefail
PORT="${ATIKVIEWER_PORT:-3000}"
cd /opt/atikviewer
if [ -f /etc/atikviewer.env ]; then set -a; . /etc/atikviewer.env; set +a; fi
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export NODE_ENV=production
exec ./node_modules/.bin/next start -p "$PORT" -H 127.0.0.1
EOF
chmod 755 "$STAGE/usr/bin/atikviewer"

sed 's#/usr/local/bin/atikviewer#/usr/bin/atikviewer#' packaging/linux/atikviewer.desktop \
  > "$STAGE/usr/share/applications/atikviewer.desktop"
[ -f public/icons/rad-ai-scan.svg ] && cp public/icons/rad-ai-scan.svg \
  "$STAGE/usr/share/icons/hicolor/scalable/apps/atikviewer.svg"

SIZE_KB="$(du -sk "$STAGE" | cut -f1)"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: atikviewer
Version: $VERSION
Section: science
Priority: optional
Architecture: amd64
Maintainer: CehennemGibiyim <cehennemgibiyim@users.noreply.github.com>
Installed-Size: $SIZE_KB
Depends: nodejs (>= 18)
Homepage: https://github.com/CehennemGibiyim/AtikViewer
Description: ATIKVIEWER - Vision AI radyoloji istasyonu (DICOM + yerel yapay zeka)
 DICOM goruntuleme, kesit kesit AI analizi ve yapilas radyoloji raporu uretimi.
 Tamamen yerel ve ucretsiz derin ogrenme cikarimi (MONAI). Hasta verisi disari
 cikmaz. Arastirma amaclidir; klinik karar icin kullanilamaz.
EOF
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
echo "ATIKVIEWER kuruldu."
echo "  Baslat:   atikviewer"
echo "  Adres:    http://127.0.0.1:3000"
echo "  AI icin:  /opt/atikviewer/packaging/linux/install.sh  (model kurulumu)"
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

# ── 4. Derle ───────────────────────────────────────────────────────────────
info ".deb derleniyor"
dpkg-deb --build --root-owner-group "$STAGE" "$DIST/ATIKVIEWER-$VERSION-amd64.deb" >/dev/null
ok "dist/ATIKVIEWER-$VERSION-amd64.deb ($(du -h "$DIST/ATIKVIEWER-$VERSION-amd64.deb" | cut -f1))"

# ── 5. Taşınabilir tar.gz ──────────────────────────────────────────────────
info "Taşınabilir tar.gz"
TAR="$DIST/ATIKVIEWER-$VERSION-linux.tar.gz"
tar -czf "$TAR" -C "$STAGE" opt usr
ok "$TAR ($(du -h "$TAR" | cut -f1))"

rm -rf "$STAGE"
cat <<SUMMARY

Paketler hazır (dist/):
  ATIKVIEWER-$VERSION-amd64.deb    sudo dpkg -i dist/ATIKVIEWER-$VERSION-amd64.deb
  ATIKVIEWER-$VERSION-linux.tar.gz tar -xzf ... && ./usr/bin/atikviewer
SUMMARY
