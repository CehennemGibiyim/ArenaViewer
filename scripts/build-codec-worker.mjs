/**
 * public/codecs/codecWorker.bundle.js üretir (v-perf).
 *
 * Sıkıştırılmış DICOM çerçevelerini Web Worker'da çözen klasik (classic)
 * worker'ın tek dosyalık, kendi kendine yeterli ikili halidir:
 *   esbuild src/lib/codecWorker.ts --bundle --format=iife --minify
 *
 * Neden public/: Turbopack `new Worker(new URL(...))` deseninde worker'ı
 * DERLEMEZ (ham .ts'i statik medya olarak kopyalar); public/ altında commit'li
 * statik ikili ise her ortamda (dev, prod, statik export) aynı şekilde çalışır.
 * Bundle depoya commit edilir (public/codecs/*.js ile aynı usul); tazeliği
 * tests/codec-worker.test.ts denetler (kaynak ile birebir yeniden üretilir).
 *
 * Kullanım: node scripts/build-codec-worker.mjs [--check]
 *   --check: dosyayı yazmadan yeniden üretip fark varsa hata ile çıkar.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const check = process.argv.includes("--check");
const entry = path.join(process.cwd(), "src/lib/codecWorker.ts");
const outfile = path.join(process.cwd(), "public/codecs/codecWorker.bundle.js");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  logLevel: "silent",
  define: {
    "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify(process.env.NEXT_PUBLIC_BASE_PATH ?? ""),
  },
});

const output = result.outputFiles[0].text;

if (check) {
  const current = fs.existsSync(outfile) ? fs.readFileSync(outfile, "utf8") : "";
  if (current !== output) {
    console.error("codecWorker.bundle.js güncel değil. Çalıştırın: node scripts/build-codec-worker.mjs");
    process.exit(1);
  }
  console.log("codecWorker.bundle.js güncel.");
} else {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, output);
  console.log(`yazıldı: ${path.relative(process.cwd(), outfile)} (${output.length} bayt)`);
}
