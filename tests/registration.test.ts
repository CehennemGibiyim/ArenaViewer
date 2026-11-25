/**
 * a-prior: önceki/şimdiki tetkik hizalaması (registration).
 *
 * Sentetik desenlerle öteleme/ölçek geri kazanımı, farklı matris boyutu ve
 * ilişkisiz görüntüde "güvenilmez" kararı sınanır. Gerçek BT'de skor daha
 * düşük olur; eşik bu yüzden 0,55 ve sonuç hekim doğrulamasına tabidir.
 */
import assert from "node:assert/strict";
import {
  alignmentNote, alignmentTrusted, downsample, estimateAlignment, MIN_ALIGNMENT_SCORE,
  ncc, nccMasked, sampleBilinear, warp, warpInto,
} from "../src/lib/registration";

/** Deterministik, dokulu sentetik görüntü (sinüs karışımı). */
function pattern(w: number, h: number, seed = 1): Float32Array {
  const out = new Float32Array(w * h);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 30; i++) {
    const fx = (rnd() * 0.2 + 0.01) * 2 * Math.PI;
    const fy = (rnd() * 0.2 + 0.01) * 2 * Math.PI;
    const ph = rnd() * 2 * Math.PI;
    const amp = 0.5 + rnd();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] += amp * Math.sin(fx * x + fy * y + ph);
  }
  return out;
}

// ── Yardımcılar ────────────────────────────────────────────────────────────
const ds = downsample(new Float32Array([0, 2, 4, 6, 1, 3, 5, 7, 8, 10, 12, 14, 9, 11, 13, 15]), 4, 4, 2);
assert.equal(ds.w, 2);
assert.equal(ds.h, 2);
assert.deepEqual(Array.from(ds.data), [1.5, 5.5, 9.5, 13.5], "indirgeme kutu ortalaması");
assert.deepEqual(Array.from(downsample(new Float32Array([1, 2, 3, 4]), 2, 2, 1).data), [1, 2, 3, 4], "f=1 kopya");

const img = new Float32Array([10, 20, 30, 40]);
assert.equal(sampleBilinear(img, 2, 2, 0, 0), 10, "tam piksel");
assert.equal(sampleBilinear(img, 2, 2, 0.5, 0.5), 25, "dört komşunun ortası");
assert.equal(sampleBilinear(img, 2, 2, -3, -3), 10, "sınır dışı kenetlenir");
assert.equal(sampleBilinear(img, 2, 2, 99, 99), 40);

assert.equal(ncc(img, img), 1, "kendisiyle korelasyon 1");
assert.equal(ncc(img, Float32Array.from([11, 21, 31, 41])), 1, "sabit fark korelasyonu bozmaz (NCC)");
assert.equal(ncc(img, Float32Array.from([1, 1, 1, 1])), 0, "sabit görüntüde 0");
// Maskeli NCC en az 16 geçerli piksel ister (gürültülü kestirimi engellemek için).
assert.equal(nccMasked(img, img, new Uint8Array([1, 1, 1, 1])).score, -1, "az pikselde geçersiz");
const full = new Uint8Array(64).fill(1);
const fullImg = pattern(8, 8, 3);
assert.equal(nccMasked(fullImg, fullImg, full).score, 1);
assert.equal(nccMasked(fullImg, fullImg, full).overlap, 1);
assert.equal(nccMasked(fullImg, fullImg, new Uint8Array(64)).score, -1, "örtüşme yoksa geçersiz");
console.log("PASS yardımcılar: indirgeme, bilineer örnekleme, NCC ve maskeli NCC.");

// ── warp: birim dönüşüm ve tersinirlik ─────────────────────────────────────
const W = 48;
const ref = pattern(W, W, 11);
const id = warp(W, W, ref, W, W, 0, 0, 1);
let maxDiff = 0;
for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(id.data[i] - ref[i]));
assert.ok(maxDiff < 1e-4, `birim warp görüntüyü değiştirmemeli (fark ${maxDiff})`);
assert.ok(id.mask.every((v) => v === 1), "birim warp tamamen geçerli");
const shifted = warp(W, W, ref, W, W, 5, 0, 1);
assert.ok(shifted.mask.some((v) => v === 0), "kaydırmada kenarlar geçersiz (örtüşme azalır)");
const bufOut = new Float32Array(W * W);
const bufMask = new Uint8Array(W * W);
warpInto(bufOut, bufMask, W, W, ref, W, W, 0, 0, 1);
assert.ok(Math.abs(bufOut[10] - ref[10]) < 1e-4, "warpInto aynı sonucu verir (tampon yeniden kullanımı)");
console.log("PASS warp: birim dönüşüm korunur, kenarlar maskelenir, tampon sürümü eşdeğer.");

// ── Öteleme geri kazanımı ──────────────────────────────────────────────────
for (const [sx, sy] of [[3, -2], [-5, 4], [0, 0], [6, 6]] as [number, number][]) {
  const mov = warp(W, W, ref, W, W, -sx, -sy, 1).data;
  const res = estimateAlignment(ref, W, W, mov, W, W, { maxShift: 8 });
  assert.equal(res.dx, sx, `dx geri kazanılmalı (gerçek ${sx}, bulunan ${res.dx})`);
  assert.equal(res.dy, sy, `dy geri kazanılmalı (gerçek ${sy}, bulunan ${res.dy})`);
  assert.equal(res.scale, 1);
  assert.ok(res.score > 0.95, `güçlü skor beklenir (${res.score})`);
  assert.equal(alignmentTrusted(res), true);
}
console.log("PASS öteleme: 4 farklı kaydırma tam olarak geri kazanıldı, skor > 0,95.");

// ── Ölçek geri kazanımı (gerçek ölçeğin tersi aranır) ──────────────────────
const scaled = warp(64, 64, pattern(64, 64, 7), 64, 64, -2, 3, 1.06).data;
const sres = estimateAlignment(pattern(64, 64, 7), 64, 64, scaled, 64, 64, { maxShift: 10 });
assert.ok(Math.abs(sres.scale - 1 / 1.06) < 0.03, `ölçek ~0,943 olmalı (bulunan ${sres.scale})`);
assert.ok(Math.abs(sres.dx - 2) <= 2 && Math.abs(sres.dy + 3) <= 2, `öteleme ±2 px (bulunan ${sres.dx},${sres.dy})`);
assert.ok(sres.score > 0.8, `ölçekli hizada skor yüksek (${sres.score})`);
console.log(`PASS ölçek: ~${sres.scale} (beklenen ~0,943), skor ${sres.score}.`);

// ── Farklı matris boyutu (128² hareketli ↔ 64² referans) ───────────────────
const r64 = pattern(64, 64, 5);
const m128 = new Float32Array(128 * 128);
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) m128[y * 128 + x] = sampleBilinear(r64, 64, 64, (x - 4) / 2, (y - 6) / 2);
const diffSize = estimateAlignment(r64, 64, 64, m128, 128, 128, { maxShift: 12 });
assert.equal(diffSize.dx, -2, "farklı boyutta öteleme referans ızgarasında");
assert.equal(diffSize.dy, -3);
assert.ok(diffSize.score > 0.9);
console.log("PASS farklı boyut: 128² hareketli görüntü 64² referansa doğru hizalandı.");

// ── İlişkisiz görüntü → güvenilmez ─────────────────────────────────────────
const noise = Float32Array.from({ length: W * W }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);
const bad = estimateAlignment(ref, W, W, noise, W, W, { maxShift: 8 });
assert.ok(bad.score < MIN_ALIGNMENT_SCORE, `ilişkisiz görüntüde skor eşiğin altında (${bad.score})`);
assert.equal(alignmentTrusted(bad), false);
assert.match(alignmentNote(bad), /GÜVENİLİR DEĞİL/);
assert.match(alignmentNote(bad), /hekim|görsel/i);
console.log("PASS güvenilirlik: ilişkisiz görüntü 'güvenilir değil' olarak işaretlenir.");

// ── Not metni ──────────────────────────────────────────────────────────────
const okNote = alignmentNote({ dx: 3, dy: -2, scale: 1, score: 0.91, level: 1 });
assert.match(okNote, /Δx \+3 px/);
assert.match(okNote, /Δy -2 px/);
assert.match(okNote, /skor 0,91|skor 0\.91/);
assert.match(okNote, /katı hizalama/);
assert.match(alignmentNote({ dx: 0, dy: 0, scale: 1, score: 0.9, level: 1 }), /Δx 0 px · Δy 0 px/);
console.log("PASS not metni: öteleme/ölçek/skor ve güven uyarısı yazılıyor.");
console.log("Tüm hizalama (registration) testleri geçti.");
