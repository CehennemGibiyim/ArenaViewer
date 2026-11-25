/**
 * Pencere/seviye (WL/WW) performans yolu (v-perf) testleri.
 * Not: hız kendisi ortam değişken olduğundan testte DEĞİL,
 * scripts/window-bench.ts ile ölçülür ve README/gapAnalysis'e yazılır.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildWindowLUT, GRAY_PALETTE, windowToRGBA, windowToRGBALegacy } from "../src/lib/window";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const wl = 40, ww = 400;
const lut = buildWindowLUT(wl, ww, false);

// ── tablo doğruluğu ──
ok(lut.lo === wl - ww / 2, "tablo alt sınırı WL−WW/2");
ok(lut.lut.length >= ww, "tablo pencere genişliğini kaplar");
ok(lut.lut[0] === 0 && lut.lut[lut.lut.length - 1] === 255, "tablo uçları 0 ve 255");
for (const v of [-3000, 0, 200, 240, 1000, 5000]) {
  const a = windowToRGBA(Float32Array.of(v), lut.lut, lut.lo)[0];
  const b = windowToRGBALegacy(Float32Array.of(v), wl, ww, false)[0];
  ok(Math.abs((a & 0xff) - (b & 0xff)) <= 1, `değer ${v}: LUT ve eski döngü arası fark ≤1`);
}

// ── ikna edici bir tamsayı serisinde toplu eşdeğerlik ──
const intSrc = new Int16Array(4096);
let seed = 7;
for (let i = 0; i < intSrc.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; intSrc[i] = ((seed % 2001) - 1000) | 0; }
const ra = windowToRGBA(intSrc, lut.lut, lut.lo);
const rb = windowToRGBALegacy(intSrc, wl, ww, false);
let maxDiff = 0;
for (let i = 0; i < ra.length; i++) maxDiff = Math.max(maxDiff, Math.abs((ra[i] & 0xff) - (rb[i] & 0xff)));
ok(maxDiff <= 1, `tamsayı seride 4096 örnekte en çok ${maxDiff} gri farkı`);

// ── ters çevirme ve paketleme ──
const inv = buildWindowLUT(wl, ww, true);
const plain = windowToRGBA(intSrc.slice(0, 1), lut.lut, lut.lo)[0] & 0xff;
const inverted = windowToRGBA(intSrc.slice(0, 1), inv.lut, inv.lo)[0] & 0xff;
ok(plain + inverted === 255, "invert tablo 255−g verir");
ok(GRAY_PALETTE[128] === 0xff808080, "palet opak griyi doğru paketler");

// ── out parametresi yeniden kullanım (bench/ön belleğe yazım) ──
const sink = new Uint32Array(intSrc.length);
windowToRGBA(intSrc, lut.lut, lut.lo, sink);
ok(sink.every((v, i) => v === ra[i]), "out verilince aynı sonucu yazar");

// ── Viewport entegrasyonu ──
const root = path.resolve(__dirname, "..");
const vp = readFileSync(path.join(root, "src/components/Viewport.tsx"), "utf8");
ok(vp.includes("buildBaseCanvas") && vp.includes("windowToRGBA"), "Viewport taban katmanı LUT yolunu kullanıyor");
ok(vp.includes("baseCache") && vp.includes("trimBaseCache"), "taban katmanı sınırlı önbellek taşıyor");
ok(vp.includes("PREFETCH_PIXELS_MAX") && vp.includes("slice + 1"), "komşu kesit ön-işleme ve bellek kapısı var");
const bench = readFileSync(path.join(root, "scripts/window-bench.ts"), "utf8");
ok(bench.includes("windowToRGBA") && bench.includes("legacy"), "karşılaştırmalı bench betiği mevcut");

if (failed) { console.error(`${failed} pencereleme testi başarısız`); process.exit(1); }
console.log("Tüm pencereleme (v-perf) testleri geçti.");
