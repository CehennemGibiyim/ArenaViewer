/**
 * Büyük çalışma performans ölçümü (v-perf).
 *
 *   npx tsx scripts/volume-bench.ts [kesit=800] [genişlik=512] [yükseklik=512]
 *
 * Ölçülenler: Float32 → Int16 dönüşümü (bellek kazancı), tam hacim bellek
 * tahmini, parçalı çözücüde rastgele kesit erişimi (kaç parça çözüldü) ve
 * WL/WW süresi (CPU LUT). Sonuç README'ye yazılır; test DEĞİLDİR (donanıma
 * bağlı süreler CI'da kararsız olur).
 */
import { ChunkedVolume, formatBytes, planMemory, prefetchOrder, transcodeSlices, type SliceArray } from "../src/lib/volumePerf";
import { buildWindowLUT, windowToRGBA } from "../src/lib/window";

const SLICES = Number(process.argv[2] ?? 800);
const W = Number(process.argv[3] ?? 512);
const H = Number(process.argv[4] ?? 512);

function syntheticVolume(n: number, w: number, h: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let k = 0; k < n; k++) {
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = ((i * 37 + k * 911) % 4096) - 1024;
    out.push(a);
  }
  return out;
}

const vol = syntheticVolume(SLICES, W, H);
const before = vol.reduce((n, s) => n + s.byteLength, 0);
const t0 = performance.now();
const { slices, stats } = transcodeSlices(vol);
const t1 = performance.now();
void slices;

console.log(`Hacim: ${SLICES} × ${W}×${H}`);
console.log(`  Float32 bellek: ${formatBytes(before)}`);
const kazanc = Math.round((1 - stats.ratio) * 100);
console.log(`  ${stats.kind} bellek: ${formatBytes(stats.afterBytes)} (%${kazanc} kazanç)`);
console.log(`  dönüşüm süresi: ${(t1 - t0).toFixed(0)} ms`);
const mem = planMemory(SLICES, W * H, 2);
console.log(`  bellek planı: ${mem.fits ? "sığar" : "sığmaz"} / pencere ${mem.cacheSlices} kesit`);

// Parçalı çözücü: rastgele 5 kesite atla
let decoded = 0;
const cv = new ChunkedVolume<SliceArray>(SLICES, 32, (from, to) => {
  decoded += to - from;
  return vol.slice(from, to);
});
const spots = Array.from({ length: 5 }, (_, i) => Math.floor((i * 157 + 13) % SLICES));
for (const s of spots) {
  cv.get(s);
  cv.prefetch(prefetchOrder(s, SLICES, 2));
}
console.log(`  parçalı erişim: ${spots.join(", ")} → ${decoded} kesit çözüldü (${cv.statistics.resolved} parça), yüklü parça: ${cv.loadedChunks}`);

// WL/WW süresi
const lut = buildWindowLUT(40, 400, false);
const target = new Uint32Array(W * H);
const runs = 20;
const t2 = performance.now();
for (let i = 0; i < runs; i++) windowToRGBA(vol[i % SLICES], lut.lut, lut.lo, target);
const per = (performance.now() - t2) / runs;
console.log(`  WL/WW (CPU LUT): ${per.toFixed(2)} ms/kesit → ${(1000 / per).toFixed(0)} kesit/sn`);
