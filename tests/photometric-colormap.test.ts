/**
 * f-pixel — nadir YBR türevleri (YBR_RCT / YBR_ICT) ve renkli seri
 * pencere/renk haritası denetimi testleri.
 *
 * Kapsam: JPEG 2000 renk dönüşümleri (RCT dönüştürülebilir, ICT BT.709
 * tabanlı dönüştürülmez) için özel yol tanıma + matris doğrulama +
 * renkli seride renk haritası denetimi (colorMapInfo). Eski YBR_FULL /
 * 4:2:2 / 4:2:0 yollarının bozulmamış olduğunu doğrular.
 */
import {
  isYbrDerivative, isRct, isIct, isStandardYbr, isYbr,
  rctToRgb, ictToRgb, ybrToRgb, colorToRgba, colorMapInfo, photometricLabel,
} from "../src/lib/photometric";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const eqRgb = (v: number, r: number, g: number, b: number) =>
  ((v & 0xff) === r && ((v >> 8) & 0xff) === g && ((v >> 16) & 0xff) === b);

// ── nadir YBR türev tanıma ──
ok(isYbrDerivative("YBR_RCT") && isYbrDerivative("YBR_ICT"), "YBR_RCT/YBR_ICT türev olarak tanınır");
ok(!isYbrDerivative("YBR_FULL") && !isYbrDerivative("YBR_FULL_422"), "standart YBR türev değil");
ok(isRct("YBR_RCT") && !isRct("YBR_ICT"), "YBR_RCT RCT'dir, YBR_ICT değil");
ok(isIct("YBR_ICT") && !isIct("YBR_RCT"), "YBR_ICT ICT'dir, YBR_RCT değil");
ok(isStandardYbr("YBR_FULL") && isStandardYbr("YBR_FULL_422"), "standart YBR tanınır");
ok(!isStandardYbr("YBR_RCT") && !isStandardYbr("YBR_ICT"), "nadir türev standart YBR değil");
ok(isYbr("YBR_RCT") && isYbr("YBR_ICT"), "nadir türev yine YBR ailesindendir");

// ── RCT ters dönüşüm matrisi (RGB → YBR_RCT → RGB döngüsü) ──
// 8-bit RCT'de saf primary renklerde Cb/Cr 0–255 alanından taşar (gerçek özellik,
// kısaltma uygulanır); round-trip için 8-bit'te sığ kalan mid-tone renkleri kullan.
const rctCases: Array<[number, number, number]> = [
  [128, 128, 128], [40, 90, 160], [200, 120, 60], [120, 60, 200], [90, 150, 80], [160, 40, 120],
];
for (const [r, g, b] of rctCases) {
  // forward RCT (DICOM/JPEG2000): Y=.25R+.5G+.25B, Cb=.5R-.5B, Cr=.25R-.5G+.25B
  const Y = 0.25 * r + 0.50 * g + 0.25 * b;
  const Cb = 0.50 * r - 0.50 * b + 128;
  const Cr = 0.25 * r - 0.50 * g + 0.25 * b + 128;
  const [or, og, ob] = rctToRgb(Y, Cb, Cr);
  ok(Math.abs(or - r) <= 1 && Math.abs(og - g) <= 1 && Math.abs(ob - b) <= 1,
    `RCT döngüsü (${r},${g},${b}) → (${or},${og},${ob})`);
}
// nötr: Cb=Cr=128 → gri korunur
const rctNeutral = rctToRgb(128, 128, 128);
ok(rctNeutral[0] === 128 && rctNeutral[1] === 128 && rctNeutral[2] === 128, "RCT nötr (Cb=Cr=128) gri korunur");
// 8-bit'te saf kırmızı RCT: Cb taşar (255.5) → kısaltma ile ~kırmızı
const rctRed = rctToRgb(63.75, 255, 191.75);
ok(rctRed[0] >= 250 && rctRed[1] <= 2 && rctRed[2] <= 2, `RCT saf kırmızı (8-bit kısaltmalı) (${rctRed.join(",")})`);

// ── ICT ters dönüşüm matrisi (BT.709 tabanlı) ──
const ictCases: Array<[number, number, number]> = [
  [128, 128, 128], [40, 90, 160], [200, 120, 60], [120, 60, 200], [90, 150, 80], [160, 40, 120],
];
for (const [r, g, b] of ictCases) {
  // forward ICT (BT.709): Y=.2126R+.7152G+.0722B, Cb=-.1146R-.3854G+.5B, Cr=.5R-.4542G-.0458B
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Cb = -0.1146 * r - 0.3854 * g + 0.5000 * b + 128;
  const Cr = 0.5000 * r - 0.4542 * g - 0.0458 * b + 128;
  const [or, og, ob] = ictToRgb(Y, Cb, Cr);
  ok(Math.abs(or - r) <= 1 && Math.abs(og - g) <= 1 && Math.abs(ob - b) <= 1,
    `ICT döngüsü (${r},${g},${b}) → (${or},${og},${ob}) (±1 yuvarlama)`);
}
const ictNeutral = ictToRgb(128, 128, 128);
ok(ictNeutral[0] === 128 && ictNeutral[1] === 128 && ictNeutral[2] === 128, "ICT nötr (Cb=Cr=128) gri korunur");

// ── RCT/ICT ile colorToRgba yönlendirme ──
// mid-tone RGB → YBR_RCT → RGBA sonrası aynı renk
const rctPx = colorToRgba([95, 68, 133], 1, { photometric: "YBR_RCT", bitsStored: 8 });
ok(eqRgb(rctPx[0], 40, 90, 160), "colorToRgba YBR_RCT mid-tone pikseli RGBA'ya (RCT matrisiyle)");
// convertYbr=false ise dönüşüm atlanır (codec RGB verdi)
const rctNoConv = colorToRgba([64, 191, 191], 1, { photometric: "YBR_RCT", bitsStored: 8, convertYbr: false });
ok(eqRgb(rctNoConv[0], 64, 191, 191), "YBR_RCT convertYbr=false ise dönüşüm atlanır");
// ICT mid-tone (BT.709 matris tekhanelik → ±1 yuvarlama)
const ictPx = colorToRgba([84, 169, 100], 1, { photometric: "YBR_ICT", bitsStored: 8 });
const ictR = ictPx[0] & 0xff, ictG = (ictPx[0] >> 8) & 0xff, ictB = (ictPx[0] >> 16) & 0xff;
ok(Math.abs(ictR - 40) <= 1 && Math.abs(ictG - 90) <= 1 && Math.abs(ictB - 160) <= 1,
  `colorToRgba YBR_ICT mid-tone pikseli RGBA'ya (ICT matrisiyle) (${ictR},${ictG},${ictB})`);
// eski YBR_FULL yolu bozulmadı
const ybrPx = colorToRgba([128, 128, 128], 1, { photometric: "YBR_FULL", bitsStored: 8 });
ok(eqRgb(ybrPx[0], 128, 128, 128), "YBR_FULL nötr pikseli gri korunur (eski yol bozulmadı)");

// ── renk haritası denetimi (renkli seri) ──
const cmYbr = colorMapInfo("YBR_FULL", 3);
ok(cmYbr.family === "YBR" && cmYbr.path === "ybr-601" && cmYbr.partial === false, "renk haritası: YBR_FULL BT.601 tam aralık");
const cmYbrPartial = colorMapInfo("YBR_PARTIAL_422", 3);
ok(cmYbrPartial.family === "YBR" && cmYbrPartial.partial === true, "renk haritası: YBR_PARTIAL_422 dar aralık");
const cmRct = colorMapInfo("YBR_RCT", 3);
ok(cmRct.family === "YBR_RCT" && cmRct.path === "rct", "renk haritası: YBR_RCT RCT matrisi");
const cmIct = colorMapInfo("YBR_ICT", 3);
ok(cmIct.family === "YBR_ICT" && cmIct.path === "ict", "renk haritası: YBR_ICT ICT matrisi");
const cmPale = colorMapInfo("PALETTE COLOR", 1);
ok(cmPale.family === "PALETTE" && cmPale.path === "palette-lut", "renk haritası: PALETTE_COLOR LUT");
const cmRgb = colorMapInfo("RGB", 3);
ok(cmRgb.family === "RGB" && cmRgb.path === "rgb-direct", "renk haritası: RGB doğrudan");
// renkli seride pencere uygulanmaz (renk haritası kendi penceredir)
ok(cmYbr.windowApplied === false && cmRct.windowApplied === false && cmPale.windowApplied === false,
  "renkli seride renk haritasının kendi penceresi vardır (pencere uygulanmaz)");

// ── etiketler ──
ok(photometricLabel("YBR_RCT", 3).includes("dönüştürülebilir"), "YBR_RCT etiketi dönüştürülebilir renk");
ok(photometricLabel("YBR_ICT", 3).includes("BT.709"), "YBR_ICT etiketi BT.709");
ok(photometricLabel("YBR_FULL", 3).includes("YBR_FULL"), "YBR_FULL etiketi korunur");

// ── RCT/ICT matrisleri, standart YBR ile farklı ──
// aynı YCbCr girdi: RCT ile ICT farklı RGB verir
const sameInput: [number, number, number] = [128, 180, 150];
const [rr, rg, rb] = rctToRgb(...sameInput);
const [ir, ig, ib] = ictToRgb(...sameInput);
ok(Math.abs(rr - ir) > 1 || Math.abs(rg - ig) > 1 || Math.abs(rb - ib) > 1,
  `RCT ile ICT aynı girdiden farklı RGB verir (${rr},${rg},${rb}) vs (${ir},${ig},${ib})`);

if (failed) { console.error(`${failed} fotometri/renk haritası testi başarısız`); process.exit(1); }
console.log("Tüm fotometri/renk haritası testi başarılı");
