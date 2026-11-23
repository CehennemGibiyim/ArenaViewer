#!/usr/bin/env bash
# ============================================================================
# ATIKVIEWER — kurulum sonrası doğrulama (Linux / macOS)
# ============================================================================
# Kullanım:
#   bash packaging/universal/verify.sh            # denetim
#   bash packaging/universal/verify.sh --ai       # + yerel AI worker denetimi
#
# Klinik kullanımdan ÖNCE çalıştırılmalıdır. Çıktı bir "geçti/kaldı" listesidir
# ve doğrulama dosyasına yazılır: dist/ATIKVIEWER-dogrulama-<tarih>.log
# ============================================================================
set -uo pipefail

PORT="${ATIKVIEWER_PORT:-3000}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/dist"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ATIKVIEWER-dogrulama-$(date +%Y%m%d-%H%M%S).log"

PASS=0; FAIL=0; WARN=0
say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
chk()  { # chk "ad" "komut"
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    say "  [GEÇTİ] $name"; PASS=$((PASS+1))
  else
    say "  [KALDI ] $name"; FAIL=$((FAIL+1))
  fi
}
note() { say "  [UYARI] $name"; WARN=$((WARN+1)); }

say "=============================================================="
say " ATIKVIEWER kurulum doğrulaması — $(date '+%Y-%m-%d %H:%M:%S')"
say "=============================================================="

say ""
say "1) Sistem önkoşulları"
chk "Node.js 22+"            bash -c 'v=$(node -v 2>/dev/null | tr -d v); [ "${v%%.*}" -ge 22 ]'
chk "npm mevcut"             command -v npm
chk "Python 3.11+ (AI için)" bash -c 'python3 -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,11) else 1)" 2>/dev/null'
if command -v psql >/dev/null 2>&1; then say "  [GEÇTİ] psql mevcut"; PASS=$((PASS+1)); else say "  [UYARI] psql yok (AI'sız görüntüleme çalışır)"; WARN=$((WARN+1)); fi

say ""
say "2) Uygulama dosyaları"
cd "$ROOT"
chk "package.json"           test -f package.json
chk "üretim derlemesi .next" test -d .next
chk "bağımlılıklar node_modules" test -d node_modules
chk ".env"                   test -f .env
chk "başlatıcı betikleri (windows/)" test -d windows
chk "çapraz platform betikleri (packaging/)" test -d packaging

say ""
say "3) Sağlık ucu"
if curl -sf "$BASE/api/health" >/dev/null 2>&1; then
  say "  [GEÇTİ] $BASE/api/health → $(curl -sf "$BASE/api/health")"
  PASS=$((PASS+1))
else
  say "  [KALDI ] $BASE/api/health — sunucu çalışmıyor mu? (atikviewer / npm start)"
  FAIL=$((FAIL+1))
fi

say ""
say "4) Derin AI (ücretsiz yerel çıkarım)"
if curl -sf "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
  say "  [GEÇTİ] AI worker çalışıyor: $(curl -sf http://127.0.0.1:8787/health)"
  PASS=$((PASS+1))
else
  say "  [UYARI] AI worker kapalı — kural tabanlı motor devrede."
  say "          Başlat: ./.venv/bin/python ai-worker/server.py"
  say "          Kurulum: ai-worker/setup_model.py (akciğer ≈84 MB + beyin ≈147 MB, ücretsiz)"
  WARN=$((WARN+1))
fi

say ""
say "5) Veritabanı şeması"
if command -v psql >/dev/null 2>&1 && [ -f .env ]; then
  if npx drizzle-kit push --config=drizzle.config.ts --force >/dev/null 2>&1; then
    say "  [GEÇTİ] Drizzle şeması güncel"; PASS=$((PASS+1))
  else
    say "  [UYARI] şema denetimi başarısız (veritabanı kapalı olabilir)"; WARN=$((WARN+1))
  fi
fi

say ""
say "=============================================================="
say " Sonuç: $PASS geçti · $FAIL kaldı · $WARN uyarı"
if [ "$FAIL" -eq 0 ]; then
  say " KURULUM SAĞLIKLI — ancak bu YAZILIM ARAŞTIRMA AMAÇLIDIR ve"
  say " klinik karar için kullanılamaz. AI bulguları radyoloji uzmanı"
  say " onayı olmadan rapora işlenemez."
else
  say " Eksikler var: yukarıdaki [KALDI ] satırlarını giderin."
fi
say " Kayıt: $LOG"
say "=============================================================="
[ "$FAIL" -eq 0 ]
