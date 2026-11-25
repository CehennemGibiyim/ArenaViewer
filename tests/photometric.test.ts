/**
 * Fotometrik yorum testleri — `f-pixel`.
 *
 * Kapsam: MONOCHROME1/2, RGB (8/16 bit, planar/piksel sıralı), YBR_FULL,
 * YBR_FULL_422 ve YBR_PARTIAL_420 (native seyreltilmiş), PALETTE COLOR
 * (8/16-bit LUT, firstMapped) ve çok kareli renkli seri.
 */
import {
  colorToRgba, deplanarize, isColorPhotometric, isPartialRange, isSubsampled, isYbr,
  monochrome1Invert, paletteToRgba, photometricLabel, scaleTo8, upsampleSubsampled, ybrToRgb,
} from "../src/lib/photometric";
import type { PaletteColorLUT } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const rgbaOf = (u: number) => ({ r: u & 0xff, g: (u >>> 8) & 0xff, b: (u >>> 16) & 0xff, a: (u >>> 24) & 0xff });
const eqRgb = (u: number, r: number, g: number, b: number, tol = 1) => {
  const c = rgbaOf(u);
  return Math.abs(c.r - r) <= tol && Math.abs(c.g - g) <= tol && Math.abs(c.b - b) <= tol && c.a === 255;
};

// ── sınıflandırma ──
ok(isColorPhotometric("RGB", 3) && isColorPhotometric("PALETTE COLOR", 1) && !isColorPhotometric("MONOCHROME2", 1), "renkli/ gri ayrımı");
ok(isSubsampled("YBR_FULL_422") && isSubsampled("YBR_PARTIAL_420") && !isSubsampled("YBR_FULL"), "4:2:2 / 4:2:0 tanınır");
ok(isYbr("YBR_FULL") && !isYbr("RGB") && !isYbr("PALETTE COLOR"), "YBR ailesi");
ok(isPartialRange("YBR_PARTIAL_422") && isPartialRange("YBR_FULL_422") && !isPartialRange("YBR_FULL"), "partial/dar aralık");
ok(photometricLabel("RGB", 3) === "RGB (renkli)" && photometricLabel("MONOCHROME1", 1).includes("ters"), "görüntüleyici etiketi");
ok(photometricLabel("PALETTE COLOR", 1) === "Palet renkli" && photometricLabel("YBR_FULL", 3).includes("YBR_FULL"), "palet/YBR etiketi");

// ── 8/16 bit ölçekleme ──
ok(scaleTo8(0, 8) === 0 && scaleTo8(255, 8) === 255, "8 bit dokunulmaz");
ok(scaleTo8(0xff00, 16) === 255 && scaleTo8(0x8000, 16) === 128, "16 bit → 8 bit");
ok(scaleTo8(-5, 16) === 0 && scaleTo8(99999, 16) === 255, "aralık dışı kırpılır");
ok(scaleTo8(200, 10) === 50, "10 bit saklanan veri 8 bite ölçeklenir");

// ── YBR → RGB ──
const white = ybrToRgb(255, 128, 128);
ok(white[0] === 255 && white[1] === 255 && white[2] === 255, "YBR nötr (Cb=Cr=128) → beyaz/gri");
const redY = 0.299 * 255, cbR = -0.168736 * 255 + 128, crR = 0.5 * 255 + 128;
const red = ybrToRgb(redY, cbR, crR);
ok(Math.abs(red[0] - 255) <= 1 && red[1] <= 1 && red[2] <= 1, `kırmızı YBR→RGB (${red.join(",")})`);
const partialBlack = ybrToRgb(16, 128, 128, true);
ok(partialBlack.every((v) => v === 0), "partial düzeyde Y=16 → siyah");
const partialWhite = ybrToRgb(235, 128, 128, true);
ok(partialWhite.every((v) => v === 255), "partial düzeyde Y=235 → beyaz");

// ── planar ──
const planar = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
const inter = deplanarize(planar, 3, 3);
ok(inter[0] === 10 && inter[1] === 40 && inter[2] === 70, "planar → piksel sıralı (ilk piksel)");
ok(inter[6] === 30 && inter[7] === 60 && inter[8] === 90, "planar → piksel sıralı (son piksel)");
ok(deplanarize(planar, 3, 1) === planar, "tek örnekte planar dokunulmaz");

// ── RGB RGBA ──
const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
const rgba = colorToRgba(rgb, 4, { photometric: "RGB" });
ok(eqRgb(rgba[0], 255, 0, 0), "RGB kırmızı pikseli");
ok(eqRgb(rgba[1], 0, 255, 0) && eqRgb(rgba[2], 0, 0, 255), "yeşil/mavi pikseller");
ok(eqRgb(rgba[3], 10, 20, 30), "ara tonlar korunur");

// 16 bit renk
const rgb16 = new Uint16Array([0xff00, 0, 0, 0, 0x8000, 0]);
const rgba16 = colorToRgba(rgb16, 2, { photometric: "RGB", bitsStored: 16 });
ok(eqRgb(rgba16[0], 255, 0, 0) && eqRgb(rgba16[1], 0, 128, 0), "16 bit renk 8 bite ölçeklenir");

// YBR veri → RGBA
const ybrPixels = new Uint8Array([255, 128, 128, 76, 85, 255]);
const rgbaYbr = colorToRgba(ybrPixels, 2, { photometric: "YBR_FULL" });
ok(eqRgb(rgbaYbr[0], 255, 255, 255), "YBR beyaz pikseli RGBA'ya");
const c2 = rgbaOf(rgbaYbr[1]);
ok(c2.r > 200 && c2.g < 40 && c2.b < 40, `YBR kırmızıya yakın piksel (${c2.r},${c2.g},${c2.b})`);
ok(eqRgb(colorToRgba(ybrPixels, 2, { photometric: "YBR_FULL", convertYbr: false })[0], 255, 128, 128), "codec RGB verdiyse YBR dönüşümü atlanır");

// ── 4:2:2 / 4:2:0 açma ──
const packed422 = new Uint8Array([100, 128, 200, 128, 50, 90, 250, 160]);
const up = upsampleSubsampled(packed422, 4, false);
ok(up[0] === 100 && up[1] === 128 && up[2] === 128 && up[3] === 200, "4:2:2 ilk iki piksel Y/Cb/Cr alır");
ok(up[6] === 50 && up[7] === 90 && up[8] === 160 && up[9] === 250, "4:2:2 ikinci çift (Cb/Cr paylaşılır)");
const packed420 = new Uint8Array([10, 20, 30, 40, 128, 128]);
const up420 = upsampleSubsampled(packed420, 4, true);
ok([0, 1, 2, 3].every((i) => up420[i * 3] === (i + 1) * 10) && up420[1] === 128, "4:2:0 dört parlaklık, tek renk çifti");
ok(upsampleSubsampled(new Uint8Array([1, 2, 3, 4]), 2, false).length === 6, "eksik veri güvenli (sıfır dolgu)");

// ── PALETTE COLOR ──
const lut8: PaletteColorLUT = {
  numEntries: 3, firstMapped: 0, bits: 8,
  r: new Uint8Array([255, 0, 0]), g: new Uint8Array([0, 255, 0]), b: new Uint8Array([0, 0, 255]),
};
const pal8 = paletteToRgba(new Uint8Array([0, 1, 2, 2]), lut8);
ok(eqRgb(pal8[0], 255, 0, 0) && eqRgb(pal8[1], 0, 255, 0) && eqRgb(pal8[2], 0, 0, 255), "8-bit palet indeks → RGBA");
const lut16: PaletteColorLUT = {
  numEntries: 2, firstMapped: 10, bits: 16,
  r: new Uint16Array([0xffff, 0]), g: new Uint16Array([0, 0xffff]), b: new Uint16Array([0, 0]),
};
const pal16 = paletteToRgba(new Uint16Array([10, 11, 5, 99]), lut16);
ok(eqRgb(pal16[0], 255, 0, 0) && eqRgb(pal16[1], 0, 255, 0), "16-bit palet + 8 bite indirme");
ok(eqRgb(pal16[2], 255, 0, 0), "firstMapped altındaki indeks ilk girdiye kenetlenir");
ok(eqRgb(pal16[3], 0, 255, 0), "üst sınır aşımı son girdiye kenetlenir");

// ── MONOCHROME1 ──
const mono = [new Uint16Array([0, 100, 200, 1000]), new Uint16Array([500, 1000, 0, 200])];
const inv = monochrome1Invert(mono);
ok(inv.k === 1000, "ters çevirme sabiti = max + min");
ok(inv.frames[0][0] === 1000 && inv.frames[0][3] === 0, "ilk kesit ters çevrildi");
ok(inv.frames[1][1] === 0 && inv.frames[1][2] === 1000, "ikinci kesit aynı sabitle ters çevrildi (kesitler arası sıçrama yok)");
ok(inv.frames[0] instanceof Uint16Array, "tip korunur (Uint16 → Uint16)");
ok(mono[0][0] === 0, "girdi dizisi değiştirilmez");
const f32 = monochrome1Invert([new Float32Array([1.5, 2.5])]);
ok(f32.frames[0] instanceof Float32Array && Math.abs(f32.frames[0][0] - 2.5) < 1e-6, "Float32 tipi korunur");

// ── çok kareli renkli seri ──
const frames = [new Uint8Array([255, 0, 0]), new Uint8Array([0, 255, 0]), new Uint8Array([0, 0, 255])];
const multi = frames.map((f) => colorToRgba(f, 1, { photometric: "RGB" }));
ok(multi.length === 3 && eqRgb(multi[0][0], 255, 0, 0) && eqRgb(multi[2][0], 0, 0, 255), "her kare ayrı RGBA tamponu üretir");
ok(multi.every((m) => m.length === 1 && rgbaOf(m[0]).a === 255), "kareler opak alfa taşır");

if (failed) { console.error(`${failed} fotometri testi başarısız`); process.exit(1); }
console.log("Tüm fotometri testleri geçti.");
