/**
 * a-lungquant: akciğer kantitasyonu (LAA-950 / ortalama HU / PD15 / hacim).
 *
 * Kapsam: histogramdan sınıflandırma ve yüzdelikler, seriden örnekleme
 * (gövde dışı hava dışlama, piksel/kesit adımı), kesit profili özeti ve rapor satırı.
 */
import {
  lungQuant, lungQuantText, percentileHu, profileSummary, sampleLungHistogram,
  type HuBin,
} from "../src/lib/lungQuant";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── histogramdan sınıflandırma ──
const binsOf = (spec: Record<number, number>): HuBin[] => {
  // −1200…0 arası 60 HU'luk 20 küme
  const out: HuBin[] = [];
  for (let i = 0; i < 20; i++) out.push({ lo: -1200 + i * 60, hi: -1200 + (i + 1) * 60, count: spec[i] ?? 0 });
  return out;
};
// küme 0–3: −1200…−960 (tamamen −950 altı), küme 4: −960…−900 (kısmi)
const normal = lungQuant(binsOf({ 6: 400, 7: 600 }));       // −840…−720 normal parankim
ok(normal.laa950Pct === 0 && normal.category === "normal–hafif", "normal parankim → LAA-950 %0, normal–hafif");
const mild = lungQuant(binsOf({ 6: 950, 0: 50 }));            // %5
ok(Math.abs(mild.laa950Pct - 5) < 1e-9 && mild.category === "hafif", "LAA-950 %5 → hafif sınırı");
const moderate = lungQuant(binsOf({ 6: 880, 0: 120 }));       // %12
ok(Math.abs(moderate.laa950Pct - 12) < 1e-9 && moderate.category === "orta", "LAA-950 %12 → orta");
const severe = lungQuant(binsOf({ 0: 300, 6: 700 }));
ok(Math.abs(severe.laa950Pct - 30) < 1e-9 && severe.category === "ağır", "LAA-950 %30 → ağır");
ok(severe.advice.includes("DSBG"), "ağır sınıfta DSBG önerisi yazılır");
const partial = lungQuant([{ lo: -990, hi: -930, count: 100 }, { lo: -900, hi: -840, count: 100 }]);
ok(Math.abs(partial.laa950Pct - 100 * (40 / 60) / 2) < 1e-6, "kesişen küme oransal sayılır (kısmi −950 payı)");
ok(lungQuant([]).totalVoxels === 0 && lungQuant([]).category === "—", "boş histogram güvenli");

// ── yüzdelikler ──
ok(percentileHu(binsOf({ 0: 100 }), 15) === -1170, "ilk küme dolu → PD15 o kümenin ortası");
// Kural: kümülatif toplam hedefi İLK aşan kümenin orta değeri (enterpolasyon yok).
ok(percentileHu(binsOf({ 0: 100, 5: 100 }), 50) === -1170, "PD50 tam eşitlikte ilk kümeyi döndürür");
ok(percentileHu(binsOf({ 0: 100, 5: 100 }), 51) === -870, "hedef ilk kümeyi aşınca sonraki küme kullanılır");
ok(percentileHu(binsOf({ 0: 100 }), 100) === -1170, "p100 son dolu küme");
ok(percentileHu([], 15) === null && percentileHu(binsOf({}), 15) === null, "boş/kümülatifsiz yüzdelik null");
ok(percentileHu(binsOf({ 0: 100 }), 150) === -1170, "p>100 kırpılır");

// hacim: 1000 voksel × 2 mm³ = 2 mL
ok(Math.abs(lungQuant(binsOf({ 6: 1000 }), 2).volumeMl! - 2) < 1e-9, "voksel hacmi mL'ye çevrilir");

// ── seriden örnekleme ──
const W = 20, H = 20;
/** Kenarları gövde (50 HU), içi akciğer; `airRows` satırları tamamen hava (−1000). */
const makeSlice = (lungHu: number, emphysemaRows: number[], airRows: number[] = []) => {
  const a = new Float32Array(W * H).fill(lungHu);
  for (let y = 0; y < H; y++) {
    a[y * W] = 50; a[y * W + W - 1] = 50;
    if (emphysemaRows.includes(y)) for (let x = 2; x < W - 2; x++) a[y * W + x] = -1000;
    if (airRows.includes(y)) for (let x = 0; x < W; x++) a[y * W + x] = -1000;
  }
  return a;
};
const slices = Array.from({ length: 8 }, (_, i) => makeSlice(-850, i >= 4 ? [5, 6] : []));
const prof = sampleLungHistogram((z) => slices[z], W, H, slices.length);
ok(prof.sliceStep === 1, "8 kesit → adım 1");
ok(prof.profile.length === 8, "her kesitte profil satırı var");
ok(prof.sampledVoxels > 0, "akciğer vokseli örneklendi");
ok(prof.bins.every((b) => b.count >= 0) && prof.bins.reduce((n, b) => n + b.count, 0) === prof.sampledVoxels,
  "histogram toplamı örneklenen voksele eşit");
ok(prof.profile[7].laa950Pct > prof.profile[0].laa950Pct, "emfizemli alt kesitlerde LAA-950 daha yüksek");

// gövde dışı hava sayılmaz: tüm satır hava olan kesit hiç voksel üretmez
const airOnly = sampleLungHistogram(() => makeSlice(-850, [], [3, 4, 5, 6, 7, 8, 9]), W, H, 1);
ok(airOnly.profile.length === 1 && airOnly.profile[0].voxels > 0, "gövde kenarı olan satırlar sayılır");
const noBody = new Float32Array(W * H).fill(-1000);
ok(sampleLungHistogram(() => noBody, W, H, 1).sampledVoxels === 0, "gövde yoksa (tam hava) voksel sayılmaz");
ok(sampleLungHistogram(() => new Float32Array(W * H).fill(60), W, H, 1).sampledVoxels === 0, "tam yumuşak doku → akciğer yok");

// örnekleme adımları
const s1 = sampleLungHistogram((z) => slices[z], W, H, 8, { pixelStride: 1 });
const s2 = sampleLungHistogram((z) => slices[z], W, H, 8, { pixelStride: 2 });
ok(s1.sampledVoxels > s2.sampledVoxels * 3, "piksel adımı 2 → yaklaşık dörtte bir örnek");
const capped = sampleLungHistogram((z) => slices[z], W, H, 8, { maxSlices: 4 });
ok(capped.sliceStep === 2 && capped.profile.length === 4, "kesit sayısı sınırlanınca adım büyür");
ok(sampleLungHistogram((z) => slices[z], W, H, 0).sampledVoxels === 0, "kesitsiz seri güvenli");

// ── profil özeti ──
const summary = profileSummary(prof.profile)!;
ok(summary.worstSlice >= 4, `en kötü kesit alt gruptan seçilir (kesit ${summary.worstSlice})`);
ok(summary.basalMinusApical !== null && summary.basalMinusApical > 0, "bazal–apikal farkı pozitif");
ok(summary.note.includes("bazal"), "dağılım notu bazal baskınlığı yazar");
const shortProf = profileSummary([{ slice: 0, voxels: 10, laa950Pct: 1, meanHu: -800 }, { slice: 1, voxels: 10, laa950Pct: 9, meanHu: -900 }])!;
ok(shortProf.worstSlice === 1 && shortProf.basalMinusApical === null && shortProf.note.includes("yeterli kesit yok"),
  "az kesitte yön karşılaştırması yapılmaz");
ok(profileSummary([]) === null && profileSummary([{ slice: 0, voxels: 0, laa950Pct: 0, meanHu: 0 }]) === null, "boş profilde özet yok");

// ── rapor satırı ──
const text = lungQuantText(severe, { sliceStep: 2, pixelStride: 2 });
for (const part of ["LAA-950 %30.0", "PD15", "sınıf ağır", "2 kesit / 2 piksel örnekleme", "lob/fissür ayrımı yapılmaz"]) {
  ok(text.includes(part), `rapor satırında "${part}" bulunur`);
}
ok(lungQuantText(normal).includes("Akciğer kantitasyonu:"), "profil yokken de satır üretilir");

if (failed) { console.error(`${failed} akciğer kantitasyonu testi başarısız`); process.exit(1); }
console.log("Tüm akciğer kantitasyonu testleri geçti.");
