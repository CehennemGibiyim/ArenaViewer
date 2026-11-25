#!/usr/bin/env node
/**
 * Playwright tarayıcısı CDN'den indirilemiyorsa hazır Chromium (npm paketi).
 *
 * Neden: CI/sandbox ortamlarında `npx playwright install` engellenebilir.
 * `@sparticuz/chromium` ikiliyi ve gerekli paylaşılan kütüphaneleri npm
 * paketinin içinde taşır; bu betik ikiliyi açar ve gerekli ortam değişkenlerini
 * yazdırır. Test betikleri `CHROMIUM_PATH` verildiğinde bu ikiliyi kullanır.
 *
 * Kurulum (bir kez):
 *   npm i -D @sparticuz/chromium
 *
 * Kullanım:
 *   node scripts/local-chromium.mjs                 # insan okur özet
 *   eval "$(node scripts/local-chromium.mjs --print-env)"
 *   BASE_URL=http://127.0.0.1:3000 npm run test:seg-ui
 *
 * Not: bu yalnız TEST içindir; uygulama paketine dahil edilmez.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);

// Paket depo dışına kurulduysa AV_CHROMIUM_MODULE ile yol verilebilir
// (ör. AV_CHROMIUM_MODULE=/opt/test-tools/node_modules).
const extraPaths = [process.cwd(), ...(process.env.AV_CHROMIUM_MODULE ? [process.env.AV_CHROMIUM_MODULE] : [])];
let modPath;
try {
  modPath = require.resolve("@sparticuz/chromium", { paths: extraPaths });
} catch {
  console.error("[chromium] @sparticuz/chromium bulunamadı. Kurun: npm i -D @sparticuz/chromium");
  console.error("           veya AV_CHROMIUM_MODULE=<paketin kurulu olduğu node_modules dizini> verin.");
  process.exit(1);
}
const mod = require(modPath);

/** Paket kökü: require.resolve derlenmiş dosyayı döndürür, arşiv kökte durur. */
function packageRoot(entry) {
  let dir = path.dirname(entry);
  for (let i = 0; i < 6; i++) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, "utf8")).name === "@sparticuz/chromium") return dir;
      } catch { /* bozuk package.json */ }
    }
    dir = path.dirname(dir);
  }
  return path.dirname(entry);
}
const chromium = mod.default ?? mod;
if (typeof chromium.executablePath !== "function") {
  console.error("[chromium] paket API'si beklenenden farklı (executablePath yok).");
  process.exit(1);
}

const exe = await chromium.executablePath();
const libDir = process.env.AV_CHROMIUM_LIBDIR ?? "/tmp/av-chromium-libs";
const tarBr = path.join(packageRoot(modPath), "bin", "al2023.tar.br");

if (existsSync(tarBr)) {
  const stamp = path.join(libDir, ".extracted");
  if (!existsSync(stamp)) {
    mkdirSync(libDir, { recursive: true });
    const tarPath = path.join("/tmp", "av-chromium-al2023.tar");
    writeFileSync(tarPath, zlib.brotliDecompressSync(readFileSync(tarBr)));
    const r = spawnSync("tar", ["-xf", tarPath, "-C", libDir], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[chromium] kütüphane arşivi açılamadı (tar gerekli).");
      process.exit(1);
    }
    writeFileSync(stamp, new Date().toISOString());
  }
}

const libPath = [existsSync(path.join(libDir, "lib")) ? path.join(libDir, "lib") : libDir, "/tmp"].join(":");
if (process.argv.includes("--print-env")) {
  console.log(`export CHROMIUM_PATH=${exe}`);
  console.log(`export LD_LIBRARY_PATH=${libPath}`);
} else {
  console.log(`[chromium] ikili:       ${exe}`);
  console.log(`[chromium] kitaplıklar: ${libPath}`);
  console.log(`[chromium] kullanım:    eval "$(node scripts/local-chromium.mjs --print-env)"`);
}
