/**
 * c-seg-rtstruct: segmentasyon editörü + DICOM SEG/RTSTRUCT testleri.
 * Üretilen belgeler dicom-parser ile okunur; maske ↔ piksel verisi gidiş-dönüşü
 * ve hacim hesabı denetlenir.
 */
import { parseDicom } from "dicom-parser";
import { buildRtStruct, buildSegDocument, contourPoints, maskContour, packBinaryFrames, unpackBinaryFrame, SOP_RTSTRUCT, SOP_SEG } from "../src/lib/dicomSeg";
import { cloneMask, copySlice, emptyMask, getPixel, growRegion, makeSegmentDef, maskFromJson, maskToJson, paint, paintStroke, prune, screenToImage, slicePixelCount, thresholdFill, volume } from "../src/lib/segmentation";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const u8 = (b: Uint8Array) => new Uint8Array(b);

// ── fırça ──
const m = emptyMask(40, 30);
paint(m, 0, 20, 15, 5);
const px = (x: number, y: number, s = 0) => getPixel(m, s, x, y);
ok(px(20, 15) === 1 && px(20 + 6, 15) === 0, "fırça merkezi dolu, yarıçap dışı boş");
let count = 0;
for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) count += px(x, y);
ok(count > 60 && count < 90, `dairesel fırça alanı makul (${count} piksel, π·25≈79)`);
paint(m, 0, 20, 15, 2, true);
ok(px(20, 15) === 0 && px(20, 25) === 0, "silgi merkezi temizler");
ok(px(0, 0) === 0 && px(-5, -5) === 0 && px(999, 999) === 0, "sınır dışı güvenli");
paint(m, 3, 5, 5, 1, true);
ok(!m.slices.has(3), "boş kesiti silmek maske oluşturmaz");

// ── eşik / büyütme ──
const m2 = emptyMask(10, 10);
const hu = new Float32Array(100).fill(-1000);
for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) hu[y * 10 + x] = 40;
ok(thresholdFill(m2, 0, hu, 0, 100) === 16, "eşik dolgusu 4×4 = 16 piksel");
ok(thresholdFill(m2, 0, hu, 0, 100, { x: 0, y: 0, w: 5, h: 5 }) === 4, "bölge sınırı uygulanır (2×2)");
const m3 = emptyMask(10, 10);
ok(growRegion(m3, 0, hu, { x: 4, y: 4 }, 0, 100) === 16, "tohumdan bağlı bölge büyütme");
ok(growRegion(m3, 0, hu, { x: 0, y: 0 }, 0, 100) === 0, "aralık dışı tohum büyütmez");
ok(copySlice(m, 0, 5) && getPixel(m, 5, 20, 15) === 0, "kesit kopyalanır (silinmiş içerik)");
const m4 = emptyMask(4, 4);
paint(m4, 1, 1, 1, 0.9);
prune(m4);
ok(m4.slices.size === 1, "prune boş olmayan kesiti korur");

// ── hacim ──
const mv = emptyMask(10, 10);
paint(mv, 0, 5, 5, 1); // ~5 piksel
const v = volume(mv, { px: 0.5, py: 0.5, sliceThickness: 2 });
ok(Math.abs(v.mm3 - v.voxelCount * 0.25 * 2) < 1e-9, "hacim = voksel × px × py × dilim");
ok(Math.abs(v.ml - v.mm3 / 1000) < 1e-12, "mL dönüşümü");
ok(v.sliceRange![0] === 0 && v.perSlice.length === 1, "kesit aralığı ve profil");
ok(volume(emptyMask(5, 5), { px: 1, sliceThickness: 1 }).sliceRange === null, "boş maskede aralık null");

// ── JSON gidiş-dönüş ──
const rt = maskFromJson(maskToJson(mv));
ok(rt.slices.size === 1 && getPixel(rt, 0, 5, 5) === 1, "maske JSON gidiş-dönüşü");
ok(maskFromJson({ width: 2, height: 2, slices: [{ slice: 0, data: "@@@" }] }).slices.size === 0, "bozuk base64 atlanır");
ok(maskFromJson({}).slices.size === 0, "eksik veri güvenli");

// ── bit paketleme ──
const f0 = new Uint8Array(16); f0[0] = 1; f0[9] = 1;
const f1 = new Uint8Array(16); f1[15] = 1;
const packed = packBinaryFrames([f0, f1], 4, 4);
ok(packed.length === 4, "4×4 maske çerçeve başına 2 bayt");
ok(packed[0] === 1 && packed[1] === 2, "bit sırası LSB önce");
ok(unpackBinaryFrame(packed, 1, 4, 4)[15] === 1 && unpackBinaryFrame(packed, 0, 4, 4)[9] === 1, "paket açma doğru");

// ── kontur ──
const mc = emptyMask(20, 20);
paint(mc, 0, 10, 10, 4);
const contour = maskContour(mc.slices.get(0)!, 20, 20);
ok(contour.length >= 8, `kontur noktaları üretildi (${contour.length})`);
ok(contour.every((p) => p.x >= 5 && p.x <= 15 && p.y >= 5 && p.y <= 15), "kontur maske sınırları içinde");
ok(maskContour(new Uint8Array(400), 20, 20).length === 0, "boş maskede kontur yok");
const geo = { pxMm: 0.8, pyMm: 0.8, dz: 1.2, origin: [100, -50, 10] as [number, number, number] };
const pts = contourPoints([{ x: 0, y: 0 }, { x: 2, y: 1 }], geo, 3, 200);
ok(pts[0] === 100.4 && pts[1] === -49.6 && pts[2] === 13.6, "kontur mm koordinatı (piksel merkezi + origin + z)");

// ── SEG belgesi ──
const ms1 = emptyMask(16, 16); paint(ms1, 0, 8, 8, 3);
const ms2 = emptyMask(16, 16); paint(ms2, 1, 4, 4, 2);
const src = { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1.1", "1.2.3.4.1.2"] };
const segBytes = buildSegDocument({
  patientName: "Yılmaz^Ayşe", patientId: "TR-9", patientSex: "K", studyUid: "1.2.3.4", studyDate: "2026-11-20", institution: "TEST",
  source: src, geometry: { pxMm: 0.5, pyMm: 0.5, dz: 1, origin: [0, 0, 0] },
  width: 16, height: 16,
  segments: [{ def: makeSegmentDef(1, "Nodül", "MANUAL"), mask: ms1 }, { def: makeSegmentDef(2, "Lenf nodu", "AUTOMATIC"), mask: ms2 }],
});
const ds = parseDicom(u8(segBytes));
ok(!!ds, "SEG belgesi parse edilebiliyor");
ok(ds.string("x00080016") === SOP_SEG, "SOP Class UID Segmentation");
ok(ds.string("x00080060") === "SEG", "Modality SEG");
ok(ds.uint16("x00280008") === 4, "NumberOfFrames = segment(2) × kesit(2)");
ok(ds.uint16("x00280100") === 1 && ds.uint16("x00280101") === 1, "BitsAllocated/BitsStored = 1");
const pd = ds.elements["x7fe00010"]!;
const pix = u8(segBytes).slice(pd.dataOffset, pd.dataOffset + pd.length);
const back0 = unpackBinaryFrame(pix, 0, 16, 16);
let n0 = 0; for (const b of back0) n0 += b;
ok(Math.abs(n0 - ms1.slices.get(0)!.reduce((a, b) => a + b, 0)) === 0, "piksel verisi maskeyle birebir");
ok(pix.length === 4 * 32, "1 bit/piksel paketleme (16×16 → 32 bayt/çerçeve)");
ok(!!ds.string("x00200052"), "Frame of Reference UID yazıldı");
const segText = new TextDecoder("utf-8").decode(u8(segBytes));
ok(segText.includes("AUTOMATIC") && segText.includes("MANUAL"), "algoritma türleri yazıldı");

// ── RTSTRUCT belgesi ──
const rtBytes = buildRtStruct({
  patientName: "Yılmaz^Ayşe", patientId: "TR-9", patientSex: "K", studyUid: "1.2.3.4", studyDate: "2026-11-20", institution: "TEST",
  source: src, geometry: { pxMm: 0.5, pyMm: 0.5, dz: 1, origin: [0, 0, 0] }, width: 16, height: 16,
  rois: [{ def: makeSegmentDef(1, "Nodül"), mask: ms1 }],
});
const drt = parseDicom(u8(rtBytes));
ok(!!drt, "RTSTRUCT belgesi parse edilebiliyor");
ok(drt.string("x00080016") === SOP_RTSTRUCT && drt.string("x00080060") === "RTSTRUCT", "SOP Class/Modality RTSTRUCT");
const rtText = new TextDecoder("utf-8").decode(u8(rtBytes));
ok(rtText.includes("CLOSED_PLANAR"), "kontur geometri türü CLOSED_PLANAR");
ok(rtText.includes("Nodül") && rtText.includes("ORGAN"), "ROI adı ve türü yazıldı");
ok(!!drt.string("x30060010") || rtText.includes("1.2.840.10008.5.1.4.1.1.481.5"), "RTSTRUCT başlığı yazıldı");

// ── tuval eşlemesi (CSS ölçekli tuval → görüntü pikseli) ──
const rect = { left: 100, top: 50, width: 256, height: 128 };
const mid = screenToImage({ x: 228, y: 114 }, rect, 512, 256);
ok(Math.round(mid.x) === 256 && Math.round(mid.y) === 128, "tuval ortası görüntü ortasına eşleniyor (yarı yarıya ölçek)");
const clampLow = screenToImage({ x: -40, y: -40 }, rect, 512, 256);
ok(clampLow.x === 0 && clampLow.y === 0, "tuval dışı sol/üst sınıra kırpılıyor");
const clampHigh = screenToImage({ x: 9999, y: 9999 }, rect, 512, 256);
ok(clampHigh.x === 511 && clampHigh.y === 255, "tuval dışı sağ/alt sınıra kırpılıyor");
ok(screenToImage({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 }, 10, 10).x === 0, "sıfır boyutlu tuval güvenli");

// ── editör: fırça darbesi, geri alma kopyası, kesit sayımı ──
const stroke = emptyMask(80, 40);
paintStroke(stroke, 0, { x: 5, y: 20 }, { x: 75, y: 20 }, 3);
let gaps = 0;
for (let x = 5; x <= 75; x++) if (!getPixel(stroke, 0, x, 20)) gaps++;
ok(gaps === 0, "hızlı fırça darbesinde kesit yolu boyunca boşluk yok");
ok(slicePixelCount(stroke, 0) > 300, "fırça darbesi beklenen piksel hacmini üretiyor");
ok(slicePixelCount(stroke, 1) === 0, "başka kesit etkilenmiyor");

const strokeCopy = cloneMask(stroke);
paint(stroke, 0, 40, 20, 10);
ok(slicePixelCount(strokeCopy, 0) < slicePixelCount(stroke, 0), "cloneMask geri alma kopyası sonraki darbeden etkilenmiyor");

const eraseStroke = emptyMask(40, 40);
paintStroke(eraseStroke, 0, { x: 20, y: 20 }, { x: 20, y: 20 }, 8);
const beforeErase = slicePixelCount(eraseStroke, 0);
paintStroke(eraseStroke, 0, { x: 14, y: 20 }, { x: 26, y: 20 }, 2, true);
ok(slicePixelCount(eraseStroke, 0) < beforeErase, "silgi darbesi pikselleri kaldırıyor");


if (failed) { console.error(`${failed} segmentasyon testi başarısız`); process.exit(1); }
console.log("Tüm c-seg-rtstruct (segmentasyon + SEG/RTSTRUCT) testleri geçti.");
