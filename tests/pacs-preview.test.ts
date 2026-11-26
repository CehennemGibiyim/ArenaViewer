/**
 * PACS metadata-first "ilk kare" önizleme: metadata çözümü + kare→RGBA (e-wado-frame dilim 1/2).
 * Ağ çağrısı yapılmaz — DICOMweb JSON ve ham kare baytları sentetik üretilir.
 */
import { parsePreviewMeta, decodeFrameToRgba, expectedFrameBytes } from "../src/lib/pacsPreview";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const mkMeta = (over: Record<string, unknown> = {}): Record<string, { vr: string; Value: unknown[] }> => ({
  "0002,0010": { vr: "UI", Value: ["1.2.840.10008.1.2.1"] },
  "0028,0002": { vr: "US", Value: [1] },
  "0028,0004": { vr: "CS", Value: ["MONOCHROME2"] },
  "0028,0008": { vr: "IS", Value: ["1"] },
  "0028,0010": { vr: "US", Value: [2] },
  "0028,0011": { vr: "US", Value: [4] },
  "0028,0100": { vr: "US", Value: [16] },
  "0028,0101": { vr: "US", Value: [16] },
  "0028,0103": { vr: "US", Value: [1] },
  "0028,1050": { vr: "DS", Value: ["40"] },
  "0028,1051": { vr: "DS", Value: ["400"] },
  "0028,1052": { vr: "DS", Value: ["0"] },
  "0028,1053": { vr: "DS", Value: ["1"] },
  ...(over as Record<string, { vr: string; Value: unknown[] }>),
});
const be = (vals: number[], be16 = false): Uint8Array => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => {
    const u = v < 0 ? 0x10000 + v : v;
    if (be16) { b[i * 2] = (u >> 8) & 0xff; b[i * 2 + 1] = u & 0xff; }
    else { b[i * 2] = u & 0xff; b[i * 2 + 1] = (u >> 8) & 0xff; }
  });
  return b;
};
const b8 = (vals: number[]) => Uint8Array.from(vals);

// ── metadata çözümü ──
const info = parsePreviewMeta(mkMeta());
ok(info.width === 4 && info.height === 2 && info.bitsAllocated === 16 && info.pixelRep === 1, "temel CT metadata'sı çözülür");
ok(info.windowCenter === 40 && info.windowWidth === 400 && info.slope === 1 && info.intercept === 0, "DS dizeleri sayıya çevrilir");
const infoStr = parsePreviewMeta(mkMeta({ "0028,1050": { vr: "DS", Value: ["150"] } }));
ok(infoStr.windowCenter === 150, "pencere dizesi ayrıştırılır");
const infoArr = parsePreviewMeta(mkMeta({ "0028,1050": { vr: "DS", Value: ["100", "200"] } }));
ok(infoArr.windowCenter === 100, "çok değerli pencerede ilk kullanılır");
ok(expectedFrameBytes(info) === 16, "beklenen kare baytı (4×2×2)");
// dizilerle sarmalanmış yanıt
ok(parsePreviewMeta([mkMeta()]).width === 4, "dizi yanıtı kabul edilir");

// ── pencere eşlemesi: v ≤ wl−ww/2 → 0, v ≥ wl+ww/2 → 255 ──
const frame = be([-10000, -160, -159, 40, 240, 2000, 0, 0]);
const dec = decodeFrameToRgba(info, frame);
// v = HU; pencere: low = -160, ww = 400
// -10000 → 0, -160 → 0, -159 → 1, 40 → 128, 240 → 255, 2000 → 255
const g = (i: number) => dec.rgba[i * 4];
ok(dec.rgba.length === 4 * 2 * 4, "RGBA boyutu 4×2×4");
ok(g(0) === 0, "alt sınır altı 0");
ok(g(1) === 0, "alt sınırda 0");
ok(g(2) === Math.round((1 / 400) * 255), `alt sınırın 1 üstü (~1): ${g(2)}`);
ok(g(3) === 128, `pencerenin ortası ~128: ${g(3)}`);
ok(g(4) === 255, "üst sınırda 255");
ok(g(5) === 255, "üst sınır üstü 255");
ok(dec.rgba[3] === 255 && dec.rgba[7] === 255, "her piksel alfa 255");
ok(g(3) === g(3) && dec.sourceMin === -10000 && dec.sourceMax === 2000, "min/max doğru");

// ── MONOCHROME1: gri ters çevrilir ──
const decMono1 = decodeFrameToRgba(parsePreviewMeta(mkMeta({ "0028,0004": { vr: "CS", Value: ["MONOCHROME1"] } })), frame);
ok(decMono1.rgba[3 * 4] === 255 - 128, "MONOCHROME1'de orta gri ters (255−128)");

// ── 8 bit + slope/intercept ──
const info8 = parsePreviewMeta(mkMeta({
  "0028,0100": { vr: "US", Value: [8] }, "0028,0101": { vr: "US", Value: [8] }, "0028,0103": { vr: "US", Value: [0] },
  "0028,1053": { vr: "DS", Value: ["2"] }, "0028,1052": { vr: "DS", Value: ["10"] },
  "0028,1050": { vr: "DS", Value: ["130"] }, "0028,1051": { vr: "DS", Value: ["200"] },
}));
// wl=130, ww=200 → low=30; hu(v)=2v+10: v=0→10 (<30 → 0), v=60→130 ((130−30)/200=0,5 → 128), v=120→250 (>230 → 255)
const dec8 = decodeFrameToRgba(info8, b8([0, 60, 120, 255, 30, 90, 200, 150]));
ok(dec8.rgba[0] === 0 && dec8.rgba[1 * 4] === 128 && dec8.rgba[2 * 4] === 255, "8 bit + slope/intercept + pencere eşlemesi");

// ── Big Endian: baytlar yer değiştirerek çözülür ──
const infoBE = parsePreviewMeta(mkMeta({ "0002,0010": { vr: "UI", Value: ["1.2.840.10008.1.2.2"] } }));
const decBE = decodeFrameToRgba(infoBE, be([-10000, -160, -159, 40, 240, 2000, 0, 0], true));
ok(decBE.rgba[0] === 0 && decBE.rgba[3 * 4] === 128 && decBE.rgba[4 * 4] === 255, "Explicit VR Big Endian bayt sırası");

// ── 12 bit saklanmış işaretli: üst 4 bit işaret uzantısı ──
import { decodeGrayNative } from "../src/lib/pixelDecode";
const dec12 = decodeGrayNative(be([0x0800, 0x0fff, 0x07ff]), 0, { rows: 1, cols: 3, bitsAllocated: 16, bitsStored: 12, pixelRep: 1, bigEndian: false, slope: 1, intercept: 0 })!;
ok(dec12.pixels[0] === -2048 && dec12.pixels[1] === -1 && dec12.pixels[2] === 2047, "12 bit 2's complement işaret uzantısı (0x800→−2048, 0xFFF→−1, 0x7FF→2047)");

// ── pencere yoksa min/max yedeği ──
const decNoWin = decodeFrameToRgba(
  parsePreviewMeta(mkMeta({ "0028,1050": { vr: "DS", Value: [] }, "0028,1051": { vr: "DS", Value: [] } })),
  be([0, 100, 200, 300, 400, 500, 600, 700]),
);
ok(Math.abs(decNoWin.wl - 350) < 1e-9 && decNoWin.ww === 700, "pencere yoksa min/max yedeği kullanılır");

// ── hatalar açık mesajla ──
const expectThrow = (fn: () => unknown, needle: string, msg: string) => {
  try { fn(); ok(false, `${msg} (hata fırlatılmadı)`); }
  catch (e) { ok(String(e instanceof Error ? e.message : e).includes(needle), `${msg} (${needle})`); }
};
expectThrow(() => parsePreviewMeta(mkMeta({ "0002,0010": { vr: "UI", Value: ["1.2.840.10008.1.2.4.50"] } })), "sıkıştırılmış", "JPEG aktarımda açık red");
expectThrow(() => parsePreviewMeta(mkMeta({ "0028,0002": { vr: "US", Value: [3] } })), "RGB", "RGB kare reddedilir");
expectThrow(() => parsePreviewMeta(mkMeta({ "0028,0004": { vr: "CS", Value: ["PALETTE COLOR"] } })), "MONOCHROME", "palet reddedilir");
expectThrow(() => parsePreviewMeta(mkMeta({ "0028,0010": { vr: "US", Value: [] } })), "Rows", "Rows yoksa açık hata");
expectThrow(() => decodeFrameToRgba(info, be([1, 2, 3])), "beklenenden", "kısa kare reddedilir");
expectThrow(() => parsePreviewMeta(mkMeta({ "0028,0100": { vr: "US", Value: [12] } })), "8/16", "12 bit BitsAllocated reddedilir");
expectThrow(() => parsePreviewMeta(null), "DICOMweb", "null metadata reddedilir");

if (failed) { console.error(`${failed} PACS önizleme testi başarısız`); process.exit(1); }
console.log("Tüm PACS metadata-first önizleme testleri geçti.");
