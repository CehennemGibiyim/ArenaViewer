/**
 * v-vr: VR kesme düzlemi sözleşmesi testleri.
 * Not: WebGL ışın izlemenin kendisi bu testte çalıştırılamaz (sandbox'ta GPU yok);
 * test edilen şey düzlem çözümü ve nokta kabul eşitsizliği — shader aynı ifadeyi
 * kaynak düzeyinde içerir (aşağıdaki kaynak denetimi).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { halfExtents, keepPoint, resolveClip } from "../src/lib/vrClip";

// 1) resolveClip: kapalı eksen her şeyi sıfırlar
assert.deepEqual(resolveClip(-1, 30, true, [1, 2, 3]), { axis: -1, pos: 0, flip: false });
assert.deepEqual(resolveClip(9, 30, true, [1, 2, 3]), { axis: -1, pos: 0, flip: false }, "bilinmeyen eksen kapalı sayılır");
console.log("PASS eksen kapalı/bilinmeyen → kırpma yok");

// 2) kaydırıcı uçları: 0 → -half, 100 → +half, 50 → 0
assert.equal(resolveClip(0, 0, false, [2, 4, 6]).pos, -2);
assert.equal(resolveClip(0, 100, false, [2, 4, 6]).pos, 2);
assert.equal(resolveClip(1, 50, false, [2, 4, 6]).pos, 0);
assert.equal(resolveClip(2, 25, false, [2, 4, 6]).pos, -3, "Z ekseninde %25 → yarı-uzantının yarısı");
console.log("PASS konum eşlemesi (0/50/100)");

// 3) aralık dışı ve NaN kaydırıcı kırpılır
assert.equal(resolveClip(0, -50, false, [2, 4, 6]).pos, -2);
assert.equal(resolveClip(0, 250, false, [2, 4, 6]).pos, 2);
assert.equal(resolveClip(0, Number.NaN, false, [2, 4, 6]).pos, 0, "NaN → orta");
console.log("PASS sınır dışı kaydırıcı güvenli");

// 4) keepPoint doğruluk tablosu
const c = resolveClip(2, 50, false, [2, 4, 6]); // Z düzlemi tam ortada, ön (+z) atılır
assert.ok(keepPoint(c, 0, 0, -6) && keepPoint(c, 0, 0, 0), "arka yarı kalır");
assert.ok(!keepPoint(c, 0, 0, 0.001) && !keepPoint(c, 0, 0, 6), "ön yarı atılır");
const cf = resolveClip(2, 50, true, [2, 4, 6]); // yön çevir: ön kalır
assert.ok(keepPoint(cf, 0, 0, 6) && !keepPoint(cf, 0, 0, -0.001), "yön düğmesi yarıları takaslar");
assert.ok(keepPoint(resolveClip(-1, 0, false, [2, 4, 6]), 99, 99, 99), "kapalıyken her nokta kabul");
// sınır nokta: eşitlikte grafik kalır (iki yönde de a >= pos / a <= pos)
assert.ok(keepPoint(c, 0, 0, 0) && keepPoint(cf, 0, 0, 0), "düzlem üzeri nokta korunur");
console.log("PASS nokta kabul tablosu (yön + sınır + kapalı)");

// 5) eksen seçimi doğru bileşeni okur
const cx = resolveClip(0, 100, false, [2, 4, 6]);
assert.ok(!keepPoint(cx, 2.5, 0, 0) && keepPoint(cx, -2.5, 0, 0), "X düzlemi yalnız x'i okur");
const cy = resolveClip(1, 100, false, [2, 4, 6]);
assert.ok(!keepPoint(cy, 0, 4.5, 0) && keepPoint(cy, 0, 4.5 * 0 - 4.5, 0), "Y düzlemi yalnız y'yi okur");
console.log("PASS eksen → bileşen eşlemesi");

// 6) halfExtents: draw() ile aynı yarı-uzantılar, en büyük uzantıya normalize
const half = halfExtents(512, 512, 300, 0.7, 0.7, 1.0); // ext = 512*0.7 = 358.4
assert.ok(Math.abs(half[0] - 0.5) < 1e-9 && Math.abs(half[1] - (300 / 358.4) / 2) < 1e-9 && Math.abs(half[2] - 0.5) < 1e-9, "normalize yarı-uzantılar");
console.log("PASS halfExtents normalizasyonu");

// 7) kaynak denetimi: shader ve bileşen sözleşmeye uyuyor
const src = fs.readFileSync(path.join(__dirname, "..", "src/components/VolumeRender.tsx"), "utf8");
for (const marker of ["uClipAxis", "uClipPos", "uClipFlip", "resolveClip", "halfExtents", "Kırp", "Kırpma düzlemi ekseni", "Kırpma düzlemi konumu"]) {
  assert.ok(src.includes(marker), `VolumeRender.tsx "${marker}" içermeli`);
}
assert.ok(/uClipAxis > -0\.5/.test(src) && /uClipFlip > 0\.5/.test(src), "shader kırpma eşitsizliği");
assert.ok(src.includes('aria-label="Kırpma düzlemi ekseni"') && src.includes('aria-label="Kırpma düzlemi konumu"'), "erişilebilir etiketler");
// kemik çıkarma (BT): shader atlaması + arayüz mevcut
for (const marker of ["uBoneCut", "Kemik çıkar", 'aria-label="Kemik eşiği (HU)"', "boneHU"]) {
  assert.ok(src.includes(marker), `VolumeRender.tsx "${marker}" içermeli`);
}
assert.ok(/uBoneCut >= 0\. && d > uBoneCut/.test(src), "shader kemik atlaması");
console.log("PASS kemik çıkarma (shader + arayüz)");

console.log("Tüm vr-clip testleri geçti.");
