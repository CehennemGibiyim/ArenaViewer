/**
 * Pencere/seviye (WL/WW) performans yolu (v-perf) testleri.
 * Not: hız kendisi ortam değişken olduğundan testte DEĞİL,
 * scripts/window-bench.ts ile ölçülür ve README/gapAnalysis'e yazılır.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildWindowLUT, GRAY_PALETTE, windowToRGBA, windowToRGBALegacy } from "../src/lib/window";
import { gpuWindowCompatible, renderWindowFrame, WINDOW_WORKER_MIN_PIXELS, windowGrayFromIndex, windowSampleGray } from "../src/lib/windowFrame";
import { WINDOW_SHADER_SOURCE } from "../src/lib/webglWindow";
import { renderWindowWorker } from "../src/lib/windowWorker";

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
const glSrc = readFileSync(path.join(root, "src/lib/webglWindow.ts"), "utf8");
ok(vp.includes("buildBaseCanvas") && vp.includes("windowToRGBA"), "Viewport taban katmanı LUT yolunu kullanıyor");
ok(vp.includes("baseCache") && vp.includes("trimBaseCache"), "taban katmanı sınırlı önbellek taşıyor");
ok(vp.includes("PREFETCH_PIXELS_MAX") && vp.includes("slice + 1"), "komşu kesit ön-işleme ve bellek kapısı var");
const bench = readFileSync(path.join(root, "scripts/window-bench.ts"), "utf8");
ok(bench.includes("windowToRGBA") && bench.includes("legacy"), "karşılaştırmalı bench betiği mevcut");

// ── paylaşılan çerçeve: worker ve GPU aynı aritmetiği kullanmalı ──
const frame = renderWindowFrame(intSrc, wl, ww, false);
ok(frame.every((v, i) => v === ra[i]), "renderWindowFrame ana iş parçacığı LUT yoluyla birebir aynı");
let sampleDiff = 0;
for (let i = 0; i < 512; i++) {
  const got = frame[i * 7] & 0xff;
  const want = windowSampleGray(intSrc[i * 7], wl, ww, false);
  sampleDiff = Math.max(sampleDiff, Math.abs(got - want));
}
ok(sampleDiff === 0, "windowSampleGray (GPU referansı) LUT çıktısıyla aynı");
for (const t of [-5, 0, 1, 199, 200, 400, 401]) {
  ok(windowGrayFromIndex(t, 400, false) === (t <= 0 ? 0 : t >= 400 ? 255 : Math.min(255, Math.trunc(t * (255 / 400)))), `indeks ${t} → gri eşlemesi doğru`);
}
ok(windowSampleGray(1000, 40.5, 400, true) === 255 - windowSampleGray(1000, 40.5, 400, false), "ters çevirme simetrik");
ok(gpuWindowCompatible(40, 400) && !gpuWindowCompatible(40.5, 400), "GPU yalnız tam sayı pencere alt sınırında kullanılır");
ok(WINDOW_WORKER_MIN_PIXELS === 1_000_000, "worker eşiği ~1 MP");
ok(WINDOW_SHADER_SOURCE.frag.includes("texelFetch") && WINDOW_SHADER_SOURCE.frag.includes("uSpan") && WINDOW_SHADER_SOURCE.frag.includes("uInvert"), "gölgelendirici pencereleme formülünü taşıyor");
ok(WINDOW_SHADER_SOURCE.frag.includes("isampler2D") && WINDOW_SHADER_SOURCE.fragUnsigned.includes("usampler2D"), "işaretli ve işaretsiz kesitler için ayrı doku örnekleyicisi");
const u16 = new Uint16Array(intSrc.length);
for (let i = 0; i < intSrc.length; i++) u16[i] = (intSrc[i] + 32768) & 0xffff;
let u16Diff = 0;
for (let i = 0; i < 256; i++) {
  const got = renderWindowFrame(u16.subarray(i, i + 1), wl, ww, false)[0] & 0xff;
  u16Diff = Math.max(u16Diff, Math.abs(got - windowSampleGray(u16[i], wl, ww, false)));
}
ok(u16Diff === 0, "işaretsiz 16 bit değerler GPU referansıyla aynı griyi veriyor");

// ── float32 kesitler (R32F) ──
ok(WINDOW_SHADER_SOURCE.fragFloat.includes("sampler2D") && !WINDOW_SHADER_SOURCE.fragFloat.includes("isampler2D"), "float gölgelendiricisi float örnekleyici kullanıyor");
ok(WINDOW_SHADER_SOURCE.fragFloat.includes("uniform float uLo") && WINDOW_SHADER_SOURCE.fragFloat.includes("uniform float uSpan"), "float yolu ondalık pencere taşıyor");
const f32 = new Float32Array(256);
for (let i = 0; i < 256; i++) f32[i] = (i - 128) * 1.75; // ondalıklı HU benzeri değerler
let f32Diff = 0;
for (let i = 0; i < 256; i++) {
  const got = renderWindowFrame(f32.subarray(i, i + 1), 0.5, 300, false)[0] & 0xff;
  f32Diff = Math.max(f32Diff, Math.abs(got - windowSampleGray(f32[i], 0.5, 300, false)));
}
ok(f32Diff === 0, "float32 değerler CPU referansıyla aynı griyi veriyor");
ok(glSrc.includes("gl.R32F") && glSrc.includes("gl.FLOAT"), "float32 kesitler R32F dokusuna yükleniyor");
ok(glSrc.includes("uniform1f") && glSrc.includes("uniform1i(u.uLo"), "int ve float yolları doğru uniform türünü kullanıyor");

// ── worker sözleşmesi ──
const workerSrc = readFileSync(path.join(root, "src/workers/window.worker.ts"), "utf8");
ok(workerSrc.includes("renderWindowFrame") && workerSrc.includes("postMessage") && workerSrc.includes("[u32.buffer]"), "worker aynı çerçeveyi hesaplar ve RGBA'yı transfer eder");
const clientSrc = readFileSync(path.join(root, "src/lib/windowWorker.ts"), "utf8");
ok(clientSrc.includes("new Worker(new URL") && clientSrc.includes("renderWindowFrame"), "worker istemcisi worker yoksa/hata verirse CPU'ya düşer");
ok(glSrc.includes("readPixels") && glSrc.includes("windowSampleGray"), "GPU çıktısı CPU referansıyla öz-test edilir");
ok(vp.includes("createWindowGpuRenderer") && vp.includes("renderWindowWorker"), "Viewport GPU ve worker yollarını bağlar");
ok(vp.includes("slPixels instanceof Uint16Array"), "Viewport işaretsiz 16 bit kesitleri de GPU'ya veriyor");

// ── worker istemcisi: tarayıcı yoksa (Node) CPU'ya düşer, söz reddetmez ──
// (Üst düzey await kullanılmaz: depo testleri CJS olarak çalıştırılır.)
renderWindowWorker(intSrc, wl, ww, false).then((fallback) => {
  ok(fallback.length === intSrc.length && fallback.every((v, i) => v === ra[i]), "worker yoksa CPU yedeği aynı sonucu verir");
  if (failed) { console.error(`${failed} pencereleme testi başarısız`); process.exit(1); }
  console.log("Tüm pencereleme (v-perf) testleri geçti.");
});
