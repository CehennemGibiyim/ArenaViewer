/** Füzyon elastik (deforme) hizalama testleri — v-fusion. */
import type { SeriesData } from "../src/lib/types";
import { buildFusionLayer } from "../src/lib/fusion";
import { applyRigid, normalizeRigid } from "../src/lib/fusionRigid";
import {
  MIN_DEFORM_GAIN, applyDeform, clampField, deformKey, deformNote, estimateDeform, fieldAt,
  fieldStats, identityField, isIdentityField, nodeCoord, smoothField, type DeformField,
} from "../src/lib/fusionDeform";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

// ── alan sözleşmesi ──
const id7 = identityField(64, 48);
ok(id7.gw === 7 && id7.gh === 7 && id7.ux.length === 49 && id7.uy.length === 49, "kimlik alan 7×7 düğüm üretir");
ok(isIdentityField(id7) && isIdentityField(null) && isIdentityField(undefined), "kimlik alan tanınır");
ok(id7.w === 64 && id7.h === 48, "alan görüntü boyutunu taşır");
const odd = identityField(64, 64, 2, 40);
ok(odd.gw === 2 && odd.gh === 21, "ızgara sınırlanır (en çok 21)");
ok(Math.abs(nodeCoord(0, 7, 61) - 0) < 1e-9 && Math.abs(nodeCoord(6, 7, 61) - 60) < 1e-9 && Math.abs(nodeCoord(3, 7, 61) - 30) < 1e-9, "düğümler görüntüyü eşit böler");
ok(Math.abs(nodeCoord(0, 1, 95) - 47) < 1e-9, "tek düğüm görüntü merkezinde");
const corner = fieldAt(id7, 0, 0);
ok(corner.ux === 0 && corner.uy === 0, "kimlik alanda her yerde sıfır kayma");

const shift = identityField(16, 16, 2, 2);
shift.ux[0] = 4; shift.ux[1] = 4; // üst sıra sağa (j=0 → indeks 0,1)
ok(!isIdentityField(shift), "sıfır olmayan alan kimlik sayılmaz");
ok(Math.abs(fieldAt(shift, 0, 0).ux - 4) < 1e-6 && Math.abs(fieldAt(shift, 15, 0).ux - 4) < 1e-6, "üst sıra bilineer yayılır");
ok(Math.abs(fieldAt(shift, 8, 15).ux) < 1e-6, "alt sıra sıfır kalır");

// ── yeniden örnekleme ──
const W = 32, H = 32;
const disc = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) disc[y * W + x] = Math.hypot(x - 10, y - 12) < 5 ? 1 : 0;
const sameImg = applyDeform(disc, W, H, null);
ok(sameImg.length === disc.length && sameImg[12 * W + 10] === 1 && sameImg[0] === 0, "alan yoksa piksel kopyalanır");
const constField = identityField(W, H, 3, 3);
constField.ux.fill(2);
const moved = applyDeform(disc, W, H, constField);
ok(moved[12 * W + 12] > 0.8, "sabit ux=2 içeriği 2 piksel sağa kaydırır");
ok(moved[12 * W + 6] < 0.5, "sol kenar boşalır (kaynak dışarıda)");
const outward = identityField(W, H, 3, 3);
outward.ux.fill(40);
const emptyImg = applyDeform(disc, W, H, outward);
ok(emptyImg.every((v) => Number.isNaN(v)), "tamamen dışa kayan görüntü NaN (şeffaf)");
const nanIn = Float32Array.from(disc);
nanIn[5] = NaN;
const nanOut = applyDeform(nanIn, W, H, null);
ok(Number.isNaN(nanOut[5]) && nanOut[6] === nanIn[6], "NaN girdi NaN olarak korunur");

// ── elastik düzenlileştirme ──
const spike = identityField(28, 28, 7, 7);
spike.ux[3 * 7 + 3] = 6;
const smoothed = smoothField(spike, 0.8);
ok(smoothed.ux[3 * 7 + 3] < 6, "düzleştirme tepe değerini düşürür");
ok(Math.abs(smoothed.ux[3 * 7 + 4]) > 0.1 && Math.abs(smoothed.ux[3 * 7 + 5]) > 0, "komşu düğümlere yayılır");
const sum = (a: Float32Array) => [...a].reduce((s, v) => s + v, 0);
ok(Math.abs(sum(smoothed.ux) - 6) < 0.05, "toplam kayma korunur (kütle)");
const untouched = smoothField(spike, 0);
ok(untouched.ux[3 * 7 + 3] === 6 && untouched.ux[3 * 7 + 4] === 0, "sigma=0 alanı değiştirmez");

const big = identityField(8, 8, 2, 2);
big.ux[0] = 3; big.uy[0] = 4; // |u| = 5
const limited = clampField(big, 2);
ok(Math.abs(Math.hypot(limited.ux[0], limited.uy[0]) - 2) < 1e-6 && Math.abs(limited.ux[0] - 1.2) < 1e-6 && Math.abs(limited.uy[0] - 1.6) < 1e-6, "kırpma yönü korur");
ok(clampField(big, 0).ux[0] === 0, "sıfır sınır tüm alanı sıfırlar");

const st = fieldStats(id7);
ok(st.nodes === 49 && st.meanDisp === 0 && st.maxDisp === 0, "kimlik alan istatistiği sıfır");
const st2 = fieldStats(big);
ok(Math.abs(st2.maxDisp - 5) < 1e-6 && Math.abs(st2.meanDisp - 5 / 4) < 1e-6, "istatistik ortalama/maks kayma");

// ── önbellek anahtarı ──
const k1 = identityField(16, 16, 3, 3);
const k2 = identityField(16, 16, 3, 3);
ok(deformKey(null) === "id" && deformKey(k1) === "id", "kimlik alan anahtarı id");
k1.ux[1] = 1.5; k2.ux[1] = 1.5;
ok(deformKey(k1) === deformKey(k2) && deformKey(k1) !== "id", "aynı alan aynı anahtar");
k2.ux[1] = 1.51;
ok(deformKey(k1) === deformKey(k2), "0.02 px altı değişim anahtarı değiştirmez");
k2.ux[1] = 2.5;
ok(deformKey(k1) !== deformKey(k2), "anlamlı değişim anahtarı değiştirir");
ok(deformKey(k1).startsWith("d3x3-"), "anahtar ızgara boyutunu taşır");

// ── sentetik deformasyon kestirimi ──
const SW = 96, SH = 96;
// Dokulu fantom: 45 adet sabit tohumlu yuvarlak leke. Düz gradyanlı görüntülerde
// kayma belirsizdir (düzgün bir kayma benzer görüntü üretir); gerçek dokuda
// yer değiştirme ayırt edilebilir.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const blobs: { x: number; y: number; r: number; a: number }[] = [];
for (let k = 0; k < 45; k++) blobs.push({ x: rnd() * SW, y: rnd() * SH, r: 1.5 + rnd() * 3.5, a: 0.4 + rnd() * 0.6 });
const refImg = new Float32Array(SW * SH);
for (let y = 0; y < SH; y++) {
  for (let x = 0; x < SW; x++) {
    let v = 0;
    for (const b of blobs) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < b.r) v = Math.max(v, b.a * Math.cos((Math.PI / 2) * (d / b.r)));
    }
    refImg[y * SW + x] = v;
  }
}
const sample = (img: ArrayLike<number>, w: number, h: number, x: number, y: number): number => {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const x0 = Math.min(w - 2, Math.floor(x)), y0 = Math.min(h - 2, Math.floor(y));
  const ax = x - x0, ay = y - y0;
  return (
    img[y0 * w + x0] * (1 - ax) * (1 - ay) + img[y0 * w + x0 + 1] * ax * (1 - ay) +
    img[(y0 + 1) * w + x0] * (1 - ax) * ay + img[(y0 + 1) * w + x0 + 1] * ax * ay
  );
};
const AMP = 3;
const truthX = (x: number, y: number) => AMP * Math.sin((2 * Math.PI * y) / (SH - 1));
const truthY = (x: number) => AMP * Math.cos((2 * Math.PI * x) / (SW - 1));
// mov(x,y) = ref(x + ux, y + uy) → hizalamak için alan ≈ +u olmalı.
const movImg = new Float32Array(SW * SH);
for (let y = 0; y < SH; y++) {
  for (let x = 0; x < SW; x++) movImg[y * SW + x] = sample(refImg, SW, SH, x + truthX(x, y), y + truthY(x));
}
const est = estimateDeform(refImg, movImg, SW, SH, { maxDisp: 8, grid: 7, search: 3, iterations: 2 });
ok(est.improved && est.scoreAfter > est.scoreBefore + MIN_DEFORM_GAIN, `deforme kazanç (NCC ${est.scoreBefore.toFixed(3)} → ${est.scoreAfter.toFixed(3)})`);
ok(est.field.gw === 7 && est.field.gh === 7, "kestirim 7×7 ızgara döner");
ok(est.stats.maxDisp <= 8 + 1e-6, "kestirim maxDisp sınırında kalır");
ok(est.candidates > 100, `aday sayısı raporlanır (${est.candidates})`);
let errEst = 0, errBase = 0;
for (let j = 0; j < est.field.gh; j++) {
  for (let i = 0; i < est.field.gw; i++) {
    const x = nodeCoord(i, est.field.gw, SW), y = nodeCoord(j, est.field.gh, SH);
    errEst += Math.hypot(est.field.ux[j * 7 + i] - truthX(x, y), est.field.uy[j * 7 + i] - truthY(x));
    errBase += Math.hypot(truthX(x, y), truthY(x));
  }
}
ok(errEst < errBase * 0.7, `alan hatası kimliğe göre düşer (${(errEst / 49).toFixed(2)} px < ${(errBase / 49).toFixed(2)} px)`);
ok(deformNote(est).includes("Elastik hizalama") && deformNote(est).includes("7×7") && deformNote(est).includes("görsel doğrulama"), "kazanç notu bilgilendirir");

// sınırlı kayma: alan 1 px'i aşmamalı
const estLimited = estimateDeform(refImg, movImg, SW, SH, { maxDisp: 1, grid: 5, search: 2 });
ok(fieldStats(estLimited.field).maxDisp <= 1 + 1e-6, "maxDisp=1 alanı sınırlar");
ok(!estLimited.improved || estLimited.scoreAfter <= est.scoreAfter + 1e-9, "dar sınır daha iyi skor üretmez");

// tur artışı kötüleştirmez (kabul ölçütü: kademe içi skor düşerse alan geri alınır)
const est4 = estimateDeform(refImg, movImg, SW, SH, { maxDisp: 8, grid: 7, search: 3, iterations: 4 });
ok(est4.scoreAfter >= est.scoreAfter - 1e-3, `iterasyon artışı skoru düşürmez (${est4.scoreAfter.toFixed(3)} ≥ ${est.scoreAfter.toFixed(3)})`);
ok(est4.scoreAfter > est4.scoreBefore, "iyileşen her kestirimde skor yükselir");

// determinizm
const est2 = estimateDeform(refImg, movImg, SW, SH, { maxDisp: 8, grid: 7, search: 3, iterations: 2 });
ok(JSON.stringify([...est.field.ux]) === JSON.stringify([...est2.field.ux]) && JSON.stringify([...est.field.uy]) === JSON.stringify([...est2.field.uy]), "kestirim deterministik");

// kazanç yoksa alan sıfırlanır
const estSame = estimateDeform(refImg, refImg, SW, SH, { maxDisp: 6 });
ok(!estSame.improved && isIdentityField(estSame.field) && Math.abs(estSame.scoreAfter - 1) < 1e-6, "aynı görüntüde alan sıfır (bindirme kötüleşmez)");
ok(deformNote(estSame).includes("kazanç sağlamadı"), "kazançsız durum dürüstçe bildirilir");

// düz görüntü: korelasyon yok → kestirim yok
const flat = new Float32Array(SW * SH).fill(7);
const estFlat = estimateDeform(flat, flat, SW, SH);
ok(!estFlat.improved && isIdentityField(estFlat.field) && !!estFlat.reason && Number.isFinite(estFlat.scoreAfter), "düz görüntüde güvenli sonuç");

// çok küçük görüntü
const estTiny = estimateDeform(new Float32Array(64), new Float32Array(64), 8, 8);
ok(!estTiny.improved && !!estTiny.reason && estTiny.field.gw === 7, "küçük görüntüde kestirim yapılmaz, neden bildirilir");

// NaN'li hareketli görüntü çökmez
const withNaN = Float32Array.from(movImg);
for (let i = 0; i < withNaN.length; i += 11) withNaN[i] = NaN;
const estNaN = estimateDeform(refImg, withNaN, SW, SH, { maxDisp: 6 });
ok(Number.isFinite(estNaN.scoreBefore) && Number.isFinite(estNaN.scoreAfter), "NaN'li girdi sonlu skor üretir");

// ── uçtan uca: buildFusionLayer deformasyonu uygular ──
function mkSeries(id: string, pixel: (x: number, y: number) => number, n = 2): SeriesData {
  const W8 = 8, H8 = 8;
  const slice = new Float32Array(W8 * H8);
  for (let y = 0; y < H8; y++) for (let x = 0; x < W8; x++) slice[y * W8 + x] = pixel(x, y);
  return {
    id, modality: "CT", description: id, bodyPart: "HEAD", patientName: "T", patientId: "1", patientAge: "40", patientSex: "E",
    studyDate: "", institution: "", studyUid: "1.2.3", width: W8, height: H8, pixelSpacing: 1, pixelSpacingX: 1,
    sliceThickness: 2, orientation: [1, 0, 0, 0, 1, 0], frameOfRef: "F1",
    ipp: Array.from({ length: n }, (_, i) => [0, 0, i * 2]),
    slices: Array.from({ length: n }, () => Float32Array.from(slice)),
    defaultWL: 0, defaultWW: 1, unit: "HU",
  } as SeriesData;
}
const tgt = mkSeries("t", () => 100);
const fus = mkSeries("f", (x, y) => (Math.hypot(x - 2, y - 3) < 1.2 ? 500 : 0));
const base = { series: fus, alpha: 1, cmap: "hot" as const, loPct: 10, hiPct: 100 };
const lit = (layer: Uint32Array | null, x: number, y: number) => (layer ? (layer[y * 8 + x] >>> 24) > 0 : false);
const plain = buildFusionLayer(tgt, 0, base);
const df = identityField(8, 8, 2, 2);
df.ux.fill(2);
const warped = buildFusionLayer(tgt, 0, { ...base, deform: df });
ok(!!plain && lit(plain, 2, 3) && !lit(plain, 4, 3), "deformasyonsuz katman kaynaktaki konumda");
ok(!!warped && lit(warped, 4, 3) && !lit(warped, 2, 3), "deforme alan katmanı 2 piksel kaydırır");
const rigidPlusDeform = buildFusionLayer(tgt, 0, { ...base, rigid: normalizeRigid({ dx: 1 }), deform: df });
ok(!!rigidPlusDeform && lit(rigidPlusDeform, 5, 3), "katı + elastik birlikte uygulanır (1 + 2 px)");
const rigidOnly = buildFusionLayer(tgt, 0, { ...base, rigid: normalizeRigid({ dx: 1 }) });
ok(JSON.stringify([...(rigidOnly ?? [])]) !== JSON.stringify([...(rigidPlusDeform ?? [])]), "elastik alan önbellek anahtarını değiştirir");
const idAgain = buildFusionLayer(tgt, 0, { ...base, rigid: normalizeRigid({ dx: 1 }), deform: identityField(8, 8, 2, 2) });
ok(JSON.stringify([...(rigidOnly ?? [])]) === JSON.stringify([...(idAgain ?? [])]), "kimlik alan katmanı değiştirmez");

// katı + elastik birleşimi: applyRigid çıktısı üzerine alan (sıra sözleşmesi)
const rigidMoved = applyRigid(new Float32Array(8 * 8).fill(0), 8, 8, normalizeRigid({}));
ok(rigidMoved.length === 64, "kimlik katı dönüşüm boyutu korur");

if (failed) { console.error(`${failed} füzyon elastik hizalama testi başarısız`); process.exit(1); }
console.log("Tüm füzyon elastik (deforme) hizalama testleri geçti.");
