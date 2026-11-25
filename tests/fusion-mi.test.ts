/** Çok modaliteli (MI) hizalama testleri — v-fusion. */
import {
  MIN_NMI, entropy, estimateTranslationMI, metricFor, miNote, miTrusted, mutualInformation,
} from "../src/lib/fusionMi";
import { applyRigid, normalizeRigid } from "../src/lib/fusionRigid";
import { nccMasked } from "../src/lib/registration";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── entropi ve MI sözleşmesi ──
ok(entropy(new Float32Array(64).fill(5)) === 0, "sabit dizinin entropisi 0");
ok(Math.abs(entropy(Float32Array.from({ length: 400 }, (_, i) => i % 4)) - 2) < 0.05, "dört eşit değer ≈ 2 bit");

const ident = new Float32Array(4096);
let seed = 7;
for (let i = 0; i < ident.length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; ident[i] = (seed / 2147483648) * 100; }
const self = mutualInformation(ident, ident);
ok(self.nmi > 0.95 && self.mi > 0.5, `aynı görüntüde NMI ≈ 1 (${self.nmi.toFixed(3)})`);
ok(Math.abs(self.mi - self.hA) < 0.05, "aynı görüntüde MI = marjinal entropi");
const flat = mutualInformation(new Float32Array(400).fill(3), ident);
ok(flat.nmi === 0 && flat.mi === 0, "düz görüntüde MI 0 (bilgi yok)");

// bağımsız görüntüler: düşük MI
let seed2 = 99;
const noise = new Float32Array(4096);
for (let i = 0; i < noise.length; i++) { seed2 = (seed2 * 1103515245 + 12345) % 2147483648; noise[i] = (seed2 / 2147483648) * 100; }
const indep = mutualInformation(ident, noise);
ok(indep.nmi < 0.15, `bağımsız görüntülerde NMI düşük (${indep.nmi.toFixed(3)})`);

// Farklı modalite benzeri eşleme: V şeklinde (monoton OLMAYAN) yoğunluk ilişkisi.
// Gerçek hayatta BT↔MR ilişkisi böyledir: kemik BT'de parlak, MR'da koyu; doku tersi.
// Pearson korelasyonu bu ilişkiyi göremez, joint histogram (MI) görür.
const vshape = Float32Array.from(ident, (v) => Math.abs(v - 50));
const miMapped = mutualInformation(ident, vshape);
const nccMaskedOf = (a: Float32Array, b: Float32Array) => {
  const mask = new Uint8Array(a.length);
  for (let i = 0; i < mask.length; i++) mask[i] = Number.isFinite(a[i]) && Number.isFinite(b[i]) ? 1 : 0;
  return nccMasked(a, b, mask).score;
};
const nccMapped = nccMaskedOf(ident, vshape);
ok(nccMapped < 0.3, `monoton olmayan eşlemede NCC zayıf (${nccMapped.toFixed(3)})`);
ok(miMapped.nmi > 0.6, `aynı eşlemede MI yüksek (NMI ${miMapped.nmi.toFixed(3)})`);

// maske: geçersiz pikseller hesaba katılmaz
const maskHalf = new Uint8Array(ident.length);
for (let i = 0; i < maskHalf.length; i++) maskHalf[i] = i % 2 ? 1 : 0;
const masked = mutualInformation(ident, vshape, maskHalf);
ok(masked.n === ident.length / 2 && masked.nmi > 0.5, "maske yalnız seçili pikselleri sayar");

// ── MI tabanlı öteleme kestirimi ──
const SW = 96, SH = 96;
let seed3 = 4242;
const texture = new Float32Array(SW * SH);
for (let i = 0; i < texture.length; i++) { seed3 = (seed3 * 1103515245 + 12345) % 2147483648; texture[i] = seed3 / 2147483648; }
// yumuşatma: gerçek görüntüye benzer komşuluk korelasyonu
const smooth = new Float32Array(SW * SH);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  let s = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy < 0 || xx < 0 || yy >= SH || xx >= SW) continue;
    s += texture[yy * SW + xx]; n++;
  }
  smooth[y * SW + x] = s / n;
}
// BT benzeri: pencere uygulanmış gri doku; MR benzeri: V şeklinde (monoton olmayan) eşleme
const ct = Float32Array.from(smooth, (v) => Math.round(v * 1000) - 500);
const mr = Float32Array.from(ct, (v) => Math.abs(v));
const shifted = applyRigid(mr, SW, SH, normalizeRigid({ dx: -4, dy: -3 })); // içerik 4 px sola, 3 px yukarı
const est = estimateTranslationMI(ct, shifted, SW, SH, { maxShift: 10, coarseStep: 2 });
ok(Math.abs(est.rigid.dx - 4) <= 1 && Math.abs(est.rigid.dy - 3) <= 1, `MI ötelemeyi bulur (${est.rigid.dx.toFixed(1)}, ${est.rigid.dy.toFixed(1)} ≈ 4, 3)`);
ok(est.score > est.baseline && miTrusted(est), `MI kazancı ve güven (NMI ${est.baseline.toFixed(2)} → ${est.score.toFixed(2)})`);
ok(est.candidates > 50, `aday sayısı raporlanır (${est.candidates})`);
const nccShifted = nccMaskedOf(ct, shifted);
ok(nccShifted < 0.2, `aynı çiftte NCC zayıf (${nccShifted.toFixed(3)}) — MI tercih nedeni`);

// determinizm
const est2 = estimateTranslationMI(ct, shifted, SW, SH, { maxShift: 12, coarseStep: 3 });
ok(est2.rigid.dx === est.rigid.dx && est2.rigid.dy === est.rigid.dy && est2.score === est.score, "MI kestirimi deterministik");

// hizalanmış girdi: kimlik ve güven
const estSame = estimateTranslationMI(ct, ct, SW, SH, { maxShift: 8 });
ok(Math.abs(estSame.rigid.dx) <= 1 && Math.abs(estSame.rigid.dy) <= 1, "aynı görüntüde öteleme ≈ 0");
ok(!estSame.improved, "aynı görüntüde 'kazanç' iddia edilmez");

// düz girdi: güvenilmez
const estFlat = estimateTranslationMI(new Float32Array(SW * SH), new Float32Array(SW * SH), SW, SH);
ok(!estFlat.improved && !miTrusted(estFlat) && Number.isFinite(estFlat.score), "düz görüntüde MI güvenilmez, çökmez");

// ── not metni ──
ok(miNote(est).includes("MI") && miNote(est).includes("görsel doğrulama"), "güvenilir MI notu bilgilendirir");
ok(miNote(estFlat).includes("güvenilmez"), "güvenilmez MI notu uyarır");
ok(!miTrusted({ score: MIN_NMI - 0.01, improved: true }) && miTrusted({ score: MIN_NMI, improved: true }), "MI güven eşiği");

// ── metrik seçimi ──
ok(metricFor("CT", "CT") === "ncc" && metricFor("MR", "MR") === "ncc", "aynı modalitede NCC");
ok(metricFor("CT", "MR") === "mi" && metricFor("PT", "CT") === "mi", "farklı modalitede MI");
ok(metricFor(" ct ", "ct") === "ncc" && metricFor(undefined, "CT") === "ncc", "modalite normalizasyonu");

if (failed) { console.error(`${failed} MI hizalama testi başarısız`); process.exit(1); }
console.log("Tüm çok modaliteli (MI) hizalama testleri geçti.");
