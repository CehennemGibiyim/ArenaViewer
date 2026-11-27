#!/usr/bin/env bash
# GitHub Pages derlemesini YERELDE sınama: geçici kopyada `prepare-pages.sh`
# (sunucu/veritabanı sayfalarını çıkarır) + `next build` (output: "export").
#
# Neden: `pages-build` CI işi yalnız PR'larda koşuyor ve main'e push'ta statik
# derleme ancak Pages işinde deneniyordu; DB'ye bağlı yeni bir sayfa eklendiğinde
# kırılma ancak dağıtımdan sonra görülüyordu (main'deki /ayna kırılması gibi).
# Bu betik, main'e birleştirmeden ÖNCE aynı derlemeyi burada dener.
#
# Kullanım: npm run build:pages   (node_modules kurulu olmalı)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
# KEEP=1 → çıktı korunur ve yolu yazılır: `out/*.html` içinde arama yapmak,
# sayfanın gerçekten üretildiğini görmek için (yalnız "PASS" satırı yetmiyordu).
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$tmp"; }
trap cleanup EXIT

# Çalışma ağacının kopyası (node_modules/.git/.next hariç).
tar -c --exclude=./node_modules --exclude=./.git --exclude=./.next -C "$root" . | tar -x -C "$tmp"

# node_modules'ü sembolik bağ DEĞİL sabit bağla kopyala: Turbopack, çalışma
# kökü dışındaki paketleri derlemiyor (sembolik bağ "next/package.json yok" hatası verir).
cp -al "$root/node_modules" "$tmp/node_modules"

cd "$tmp"
bash scripts/prepare-pages.sh
GITHUB_PAGES=true NEXT_PUBLIC_STATIC_DEMO=true NEXT_PUBLIC_BASE_PATH=/ArenaViewer NEXT_TELEMETRY_DISABLED=1 npx next build
echo "PASS statik (Pages) derlemesi: çıktı $tmp/out"
[ "${KEEP:-0}" = "1" ] && echo "KEEP=1: dizin silinmedi → $tmp/out"
