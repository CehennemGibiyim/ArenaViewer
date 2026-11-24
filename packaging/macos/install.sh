#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — macOS kurulum betiği (Intel ve Apple Silicon)
# ============================================================================
# Kullanım:
#   bash packaging/macos/install.sh
#
# Önkoşullar: Xcode Command Line Tools (xcode-select --install), Homebrew
# (opsiyonel; Node yoksa kurulumu önerir), PostgreSQL (brew services).
#
# Ne yapar: Node 22+, bağımlılıklar, .env, Drizzle şeması, üretim derlemesi,
# /usr/local/bin/atikviewer başlatıcısı, LaunchAgent (otomatik başlatma,
# isteğe bağlı) ve sağlık kontrolü. Ücretsizdir; hasta verisi çıkmaz.
# ============================================================================
set -euo pipefail

APP_PORT="${ATIKVIEWER_PORT:-3000}"
REPO_URL="https://github.com/CehennemGibiyim/ArenaViewer.git"
INSTALL_DIR="${ATIKVIEWER_HOME:-$HOME/atikviewer}"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[33mUYARI\033[0m %s\n' "$*"; }
fail() { printf '\033[31mHATA\033[0m %s\n' "$*" >&2; exit 1; }

# ── Kaynak ─────────────────────────────────────────────────────────────────
if [ -f "package.json" ] && [ -d "src" ]; then
  SOURCE_DIR="$(pwd)"
else
  command -v git >/dev/null 2>&1 || fail "git yok: xcode-select --install"
  [ -d "$INSTALL_DIR/.git" ] || git clone "$REPO_URL" "$INSTALL_DIR"
  SOURCE_DIR="$INSTALL_DIR"
fi
cd "$SOURCE_DIR"
info "Kaynak: $SOURCE_DIR"

# ── Node.js ────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    info "Node.js 22 kuruluyor (Homebrew)"
    brew install node@22
    brew link --overwrite node@22
  else
    fail "Node.js yok. Kurun: https://nodejs.org  veya  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  fi
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js ≥ 22 gerekli (mevcut: $(node -v))"
ok "Node.js $(node -v)"

# ── PostgreSQL ─────────────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  warn "PostgreSQL yok. Öneri: brew install postgresql@16 && brew services start postgresql@16"
else
  ok "PostgreSQL bulundu ($(psql --version | awk '{print $3}'))"
fi

# ── Bağımlılıklar ──────────────────────────────────────────────────────────
info "npm ci"
npm ci
ok "bağımlılıklar hazır"

[ -f .env ] || { cp .env.example .env; ok ".env oluşturuldu — DATABASE_URL doldurun"; }

if command -v psql >/dev/null 2>&1; then
  info "Drizzle şeması uygulanıyor"
  npx drizzle-kit push --config=drizzle.config.ts && ok "şema uygulandı" || warn "şema uygulanamadı (veritabanı ayarlarını kontrol edin)"
fi

info "Üretim derlemesi"
npm run build
ok "derleme tamam"

# ── Başlatıcı ──────────────────────────────────────────────────────────────
info "Başlatıcı kuruluyor"
sudo -n true 2>/dev/null && SUDO=sudo || SUDO=""
BIN_DIR="/usr/local/bin"
if [ ! -w "$BIN_DIR" ]; then BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; fi

cat > "$BIN_DIR/atikviewer" <<LAUNCH
#!/usr/bin/env bash
set -euo pipefail
cd "$SOURCE_DIR"
export NODE_ENV=production
[ -f .env ] && { set -a; . ./.env; set +a; }
exec ./node_modules/.bin/next start -p "$APP_PORT" -H 127.0.0.1
LAUNCH
chmod 755 "$BIN_DIR/atikviewer"
ok "$BIN_DIR/atikviewer"

# ── LaunchAgent (otomatik başlatma — isteğe bağlı) ─────────────────────────
read -r -p "Oturum açılışında otomatik başlatılsın mu? [e/H] " ans || ans="h"
case "$ans" in
  e|E)
    PLIST="$HOME/Library/LaunchAgents/com.atikviewer.app.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.atikviewer.app</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/atikviewer</string></array>
  <key>WorkingDirectory</key><string>$SOURCE_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/atikviewer.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/atikviewer.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST" && ok "LaunchAgent: $PLIST"
    ;;
  *) warn "Otomatik başlatma kapalı — elle: $BIN_DIR/atikviewer" ;;
esac

# ── AI worker (ücretsiz, yerel) ────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
  read -r -p "Yerel derin AI worker kurulsun mu? (ücretsiz, veri çıkmaz) [E/h] " ans || ans="h"
  case "$ans" in
    E|e|"")
      [ -d .venv ] || python3 -m venv .venv
      ./.venv/bin/pip install --upgrade pip >/dev/null
      ./.venv/bin/pip install -r ai-worker/requirements.txt
      ./.venv/bin/python ai-worker/setup_model.py
      ok "AI worker hazır — başlat: ./.venv/bin/python ai-worker/server.py"
      ;;
  esac
else
  warn "python3 bulunamadı — AI worker kurulamadı"
fi

# ── Sağlık kontrolü ────────────────────────────────────────────────────────
sleep 1
curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 \
  && ok "http://127.0.0.1:$APP_PORT/api/health → çalışıyor" \
  || warn "Sunucu çalışmıyor — başlat: $BIN_DIR/atikviewer"

cat <<SUMMARY

──────────────────────────────────────────────────────────────
 ATIKVIEWER kuruldu (macOS).

   Başlat:   atikviewer
   Adres:    http://127.0.0.1:$APP_PORT
   AI worker: ./.venv/bin/python ai-worker/server.py

   Araştır amaçlıdır; klinik karar için kullanılamaz.
   Tüm AI bulguları radyoloji uzmanı onayı gerektirir.
──────────────────────────────────────────────────────────────
SUMMARY
