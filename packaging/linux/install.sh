#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — Linux kurulum betiği (Ubuntu / Debian / Mint / Fedora / Arch)
# ============================================================================
# Kullanım (depodan):
#   bash packaging/linux/install.sh
#
# Ne yapar:
#   1. Önkoşulları denetler (Node.js 22+, PostgreSQL, Python 3.11+ — opsiyonel AI)
#   2. .env oluşturur, Drizzle şemasını uygular
#   3. Bağımlılıkları kurar ve üretim derlemesini alır
#   4. ~/.local/bin/atikviewer başlatıcısını ve masaüstü kısayolunu kurar
#   5. (İsteğe bağlı) yerel derin AI worker'ı — MONAI modelleri, TAMAMEN ÜCRETSİZ
#   6. Sağlık kontrolü: http://127.0.0.1:3000/api/health
#
# Hasta verisi bu makineden dışarı çıkmaz. Ücretli servis kullanılmaz.
# ============================================================================
set -euo pipefail

APP_NAME="atikviewer"
APP_PORT="${ATIKVIEWER_PORT:-3000}"
INSTALL_DIR="${ATIKVIEWER_HOME:-$HOME/atikviewer}"
REPO_URL="https://github.com/CehennemGibiyim/ArenaViewer.git"
PYTHON_MIN="3.11"

info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m OK\033[0m %s\n' "$*"; }
warn()  { printf '\033[33mUYARI\033[0m %s\n' "$*"; }
fail()  { printf '\033[31mHATA\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Depo var mı? ────────────────────────────────────────────────────────
if [ -f "package.json" ] && [ -d "src" ]; then
  SOURCE_DIR="$(pwd)"
  info "Mevcut kaynak dizini kullanılıyor: $SOURCE_DIR"
else
  info "Kaynak bulunamadı — depo klonlanıyor: $REPO_URL"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  [ -d "$INSTALL_DIR/.git" ] || git clone "$REPO_URL" "$INSTALL_DIR"
  SOURCE_DIR="$INSTALL_DIR"
fi

# ── 1. Önkoşullar ──────────────────────────────────────────────────────────
info "Önkoşullar denetleniyor"

command -v git >/dev/null 2>&1 || fail "git yok. Kurun: sudo apt install git (Fedora: sudo dnf install git)"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js yok. Kurulum: https://nodejs.org (22+) veya:
         sudo apt install nodejs npm   # sürüm eskiyse:
         curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR ≥ 22 gerekli. nodesource/setup_22.x ile güncelleyin."
ok "Node.js $(node -v)"

if ! command -v psql >/dev/null 2>&1; then
  warn "PostgreSQL istemcisi yok. Kurulum önerilir:"
  warn "  sudo apt install postgresql postgresql-client   # Debian/Ubuntu"
  warn "  sudo dnf install postgresql-server              # Fedora (sonra: sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql)"
fi

command -v npm >/dev/null 2>&1 || fail "npm yok"

PYTHON_BIN=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1; then PYTHON_BIN="$c"; break; fi
done

# ── 2. Uygulamayı kur ──────────────────────────────────────────────────────
cd "$SOURCE_DIR"
info "Bağımlılıklar kuruluyor (npm ci)"
npm ci
ok "npm ci tamam"

if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env oluşturuldu (DATABASE_URL ve DATA_ENCRYPTION_KEY doldurun)"
fi

# Veritabanı var mı, yoksa oluştur
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' || true)"
if [ -n "${DB_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's#^postgresql://([^:/]+)(:[^@]*)?@[^/]+/([^?]+).*#\3#')"
  if [ -n "$DB_NAME" ] && [ "$DB_NAME" != "$DB_URL" ]; then
    info "Veritabanı hazırlanıyor: $DB_NAME"
    if psql "$DB_URL" -c 'select 1' >/dev/null 2>&1; then
      ok "Veritabanı erişilebilir"
    else
      CREATEDB_URL="$(printf '%s' "$DB_URL" | sed -E "s#/[^/?]+(#/?|$)#/postgres\1#")"
      psql "$CREATEDB_URL" -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null 2>&1 || warn "Veritabanı oluşturulamadı (izin?). Elle oluşturun: createdb $DB_NAME"
    fi
    npx drizzle-kit push --config=drizzle.config.ts && ok "Drizzle şeması uygulandı" || warn "Şema uygulanamadı — veritabanı ayarlarını kontrol edin"
  fi
else
  warn "psql yok — şema elle uygulanmalı: npx drizzle-kit push --config=drizzle.config.ts"
fi

info "Üretim derlemesi alınıyor (next build)"
npm run build
ok "Derleme tamam"

# ── 3. Başlatıcı + masaüstü girişi ─────────────────────────────────────────
info "Başlatıcı kuruluyor"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/atikviewer" <<LAUNCH
#!/usr/bin/env bash
# ATIKVIEWER başlatıcı — üretilen dosya, elle düzenlemeyin.
set -euo pipefail
cd "$SOURCE_DIR"
export NODE_ENV=production
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec ./node_modules/.bin/next start -p "$APP_PORT" -H 127.0.0.1
LAUNCH
chmod +x "$BIN_DIR/atikviewer"
ok "$BIN_DIR/atikviewer"

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  warn "$BIN_DIR PATH'te değil — ~/.bashrc dosyasına ekleyin:  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
sed "s#/usr/local/bin/atikviewer#$BIN_DIR/atikviewer#" packaging/linux/atikviewer.desktop > "$DESKTOP_DIR/atikviewer.desktop"
# İkon: varsa public/icons/rad-ai-scan.svg
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR"
[ -f public/icons/rad-ai-scan.svg ] && cp public/icons/rad-ai-scan.svg "$ICON_DIR/atikviewer.svg"
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
ok "Masaüstü girişi: $DESKTOP_DIR/atikviewer.desktop"

# ── 4. İsteğe bağlı: yerel derin AI worker (ücretsiz) ──────────────────────
if [ "${ATIKVIEWER_SKIP_AI:-0}" != "1" ] && [ -n "$PYTHON_BIN" ]; then
  read -r -p "Yerel derin AI worker kurulsun mu? (MONAI modelleri, ücretsiz, veri çıkmaz) [E/h] " ans || ans="h"
  case "$ans" in
    E|e|"")
      info "Python sanal ortamı ve AI paketleri kuruluyor ($PYTHON_BIN)"
      if [ ! -d .venv ]; then "$PYTHON_BIN" -m venv .venv; fi
      ./.venv/bin/pip install --upgrade pip >/dev/null
      ./.venv/bin/pip install -r ai-worker/requirements.txt
      info "Modeller indiriliyor (akciğer ≈84 MB + beyin ≈147 MB)"
      ./.venv/bin/python ai-worker/setup_model.py
      ok "AI worker kuruldu. Başlatmak için: ./.venv/bin/python ai-worker/server.py"
      ;;
    *) warn "AI worker kurulmadı — istediğinizde: python ai-worker/setup_model.py" ;;
  esac
else
  [ -z "$PYTHON_BIN" ] && warn "Python 3.11+ bulunamadı — derin AI worker kurulamadı"
fi

# ── 5. Sağlık kontrolü ─────────────────────────────────────────────────────
info "Sağlık kontrolü"
if curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
  ok "http://127.0.0.1:$APP_PORT/api/health → çalışıyor"
else
  warn "Sunucu şu an çalışmıyor. Başlatmak için:  atikviewer"
fi

cat <<SUMMARY

──────────────────────────────────────────────────────────────
 ATIKVIEWER kuruldu.

   Başlat:      atikviewer
   Adres:       http://127.0.0.1:$APP_PORT
   Durum:       http://127.0.0.1:$APP_PORT/api/health
   Kaynak:      $SOURCE_DIR
   AI worker:   ./.venv/bin/python ai-worker/server.py   (ücretsiz, yerel)

   Otomatik başlatma (systemd --user):
     cp packaging/linux/atikviewer-user.service ~/.config/systemd/user/
     systemctl --user daemon-reload && systemctl --user enable --now atikviewer

   Uyarı: Bu yazılım araştırmadır; klinik karar için kullanılamaz.
   Tüm AI bulguları radyoloji uzmanı onayı gerektirir.
──────────────────────────────────────────────────────────────
SUMMARY
