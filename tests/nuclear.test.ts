/**
 * a-nm: nükleer tıp yardımcıları.
 *
 * Kapsam: DSA çıkarma özeti, TIC sınıflandırması, SUV örnekleme ve eşik tabanlı
 * MTV/SUVpeak. Sentetik verilerle sınırlar (NaN/negatif piksel, örnekleme adımı,
 * eşik modları) doğrulanır.
 */
import {
  metabolicTumorVolume, resolveSuvThreshold, sampleSuvVoxels, subtractionSummary,
  suvMeanAbove, ticCurve,
} from "../src/lib/nuclear";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── subtraksiyon ──
const pre = { rows: [[10, 10], [10, 10]] };
const post = { rows: [[12, 10], [14, 10]] };
const sub = subtractionSummary(pre, post)!;
ok(sub.meanDiff === 1.5, "ortalama fark (post−pre) 1,5");
ok(sub.enhancedPct === 50, "artış gösteren piksel oranı %50");
ok(sub.hotPixels > 0 && sub.stdDiff > 0, "üst %1 piksel toplamı ve standart sapma raporlanır");
ok(subtractionSummary(pre, { rows: [[1]] }) === null, "boyut uyuşmazlığında null");
ok(subtractionSummary({ rows: [] }, post) === null, "boş matriste null");

// ── TIC ──
const wo = ticCurve([0, 60, 120, 300], [1, 5, 4.5, 3.5]);
ok(wo.pattern === "washout" && Math.abs(wo.washOutPct! - 30) < 1e-9, "wash-out ≥%15 sınıflanır (%30)");
ok(wo.peakTimeSec === 60 && wo.washIn !== null, "zirve zamanı ve wash-in hesaplanır");
const pl = ticCurve([0, 60, 120, 300], [1, 4, 4, 3.6]);
ok(pl.pattern === "plateau", "wash-out %10 → plato");
// Zirveden sonra düşüş yoksa (wash-out ≤%5) kinetik "progresif" sayılır.
const barely = ticCurve([0, 60, 120, 300], [1, 4, 4, 3.85]);
ok(barely.pattern === "progressif", "wash-out %3,75 → progresif (belirgin wash-out yok)");

ok(ticCurve([0, 60], [1, 2]).pattern === "yetersiz", "3 noktadan az → yetersiz veri");
const mono = ticCurve([0, 60, 120, 300, 600], [1, 2, 3, 4, 5]);
ok(mono.pattern === "yetersiz" && mono.advice.includes("doygunluk"), "zirve son noktada → wash-out hesaplanamaz");

// ── SUV örnekleme ──
const W = 8, H = 8;
const mk = (val: number) => { const a = new Float32Array(W * H).fill(val); return a; };
const slices = [mk(0), mk(10), mk(4), mk(0)];
const s = sampleSuvVoxels((z) => slices[z], W, H, 4, 8, { factor: 0.5, pixelStride: 1 });
ok(s.sliceStep === 1 && s.pixelStride === 1, "küçük seride adım 1");
ok(s.sampledVoxels === 64 * 2, "yalnız pozitif piksel örneklenir (2 kesit × 64)");
ok(s.values.every((v) => v === 5 || v === 2) && s.values.filter((v) => v === 5).length === 64, "SUV = piksel × factor (10→5, 4→2)");
ok(Math.abs(s.voxelMl - 0.008) < 1e-9, "örnek hacmi mL (8 mm³ → 0,008 mL)");

const s2 = sampleSuvVoxels((z) => slices[z], W, H, 4, 8, { factor: 0.5, pixelStride: 2 });
ok(s2.sampledVoxels < s.sampledVoxels, "piksel adımı 2 örnek sayısını azaltır");
ok(Math.abs(s2.voxelMl - 0.032) < 1e-9, "örnek hacmi adımla ölçeklenir");
const capped = sampleSuvVoxels((z) => slices[z], W, H, 4, 8, { factor: 1, maxSlices: 2 });
ok(capped.sliceStep === 2, "kesit sınırı adımı büyütür");
ok(sampleSuvVoxels((z) => slices[z], W, H, 4, 8, { factor: 0 }).values.length === 0, "çarpan yoksa örnek yok");
ok(sampleSuvVoxels(() => new Float32Array(W * H).fill(-5), W, H, 1, 8, { factor: 1 }).values.length === 0, "negatif piksel atılır");
ok(sampleSuvVoxels(() => new Float32Array(4), W, H, 1, 8, { factor: 1 }).values.length === 0, "kısa veri atlanır");

// ── eşik ve MTV ──
const vals = [1, 2, 3, 4, 5, 10];
ok(resolveSuvThreshold(vals, "mutlak", 2.5) === 2.5, "mutlak eşik aynen döner");
ok(resolveSuvThreshold(vals, "mutlak", -3) === 2.5, "geçersiz mutlak eşik varsayılana döner");
ok(Math.abs(resolveSuvThreshold(vals, "yuzde", 41) - 4.1) < 1e-9, "yüzde eşiği maksimumun %41'i");
ok(resolveSuvThreshold(vals, "yuzde", 500) === 10, "yüzde 100'e kırpılır");
const mtv = metabolicTumorVolume(vals, 0.5, 4);
ok(mtv.voxelCount === 3 && Math.abs(mtv.mtvMl - 1.5) < 1e-9, "MTV = eşik üstü voksel × hacim (3 × 0,5 = 1,5 mL)");
ok(mtv.suvPeak === 10, "SUVpeak = en yüksek SUV");
ok(metabolicTumorVolume([], 0.5).mtvMl === 0, "veri yoksa MTV 0");
ok(metabolicTumorVolume(vals, 0.5, 99).advice.includes("MTV 0"), "eşik çok yüksekse uyarı yazılır");
ok(suvMeanAbove(vals, 4) === 6.33, "eşik üstü SUV ortalaması (19/3 → 6,33)");
ok(suvMeanAbove(vals, 99) === null, "eşik üstü voksel yoksa null");

if (failed) { console.error(`${failed} nükleer tıp testi başarısız`); process.exit(1); }
console.log("Tüm nükleer tıp testleri geçti.");
