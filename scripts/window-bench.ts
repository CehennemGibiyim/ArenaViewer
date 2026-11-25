/**
 * Pencere/seviye (WL/WW) dönüşümü kıyaslaması — eski döngü vs LUT.
 * Kullanım: npx tsx scripts/window-bench.ts [genişlik] [yükseklik] [tur]
 * v-perf iddialarını ölçmek içindir; testlerin parçası değildir.
 */
import { buildWindowLUT, windowToRGBA, windowToRGBALegacy } from "../src/lib/window";

const W = Number(process.argv[2] ?? 512);
const H = Number(process.argv[3] ?? 512);
const TURNS = Number(process.argv[4] ?? 20);

// Tam sayı HU gibi gerçekçi veri: ±1000 aralığı, klapar içinde.
const src = new Int16Array(W * H);
let seed = 42;
for (let i = 0; i < src.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  src[i] = ((seed % 2001) - 1000) | 0;
}

const sink = new Uint32Array(src.length); // aynı hedef tampon: gerçek uygulamadaki base katman

function bench(name: string, fn: () => Uint32Array) {
  fn(); // ısınma
  const t0 = performance.now();
  let out: Uint32Array = sink;
  for (let t = 0; t < TURNS; t++) out = fn();
  const dt = (performance.now() - t0) / TURNS;
  console.log(`${name.padEnd(18)} ${dt.toFixed(3)} ms/kesit (${W}x${H}, ${TURNS} tur ort.)`);
  return out;
}

const wl = Number(process.env.WL ?? 40), ww = Number(process.env.WW ?? 400);
const w = buildWindowLUT(wl, ww, false);
const legacySink = new Uint32Array(src.length);
const ref = bench("eski döngü", () => windowToRGBALegacy(src, wl, ww, false));
const lut = bench("LUT (tablo yeniden)", () => windowToRGBA(src, buildWindowLUT(wl, ww, false).lut, w.lo, sink));
bench("LUT (tablo önbellekli)", () => windowToRGBA(src, w.lut, w.lo, sink));

// eski sonucu legacySink'e çizip karşılaştır
windowToRGBALegacy(src, wl, ww, false).forEach?.(() => {});
legacySink.set(windowToRGBALegacy(src, wl, ww, false));
let maxDiff = 0;
for (let i = 0; i < ref.length; i++) {
  const r = ref[i] & 0xff, l = lut[i] & 0xff;
  if (Math.abs(r - l) > maxDiff) maxDiff = Math.abs(r - l);
}
console.log(`gri farkı en çok: ${maxDiff}`);
