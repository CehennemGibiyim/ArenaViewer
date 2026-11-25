/**
 * c-seg-rtstruct: segmentasyon editörü + DICOM SEG/RTSTRUCT testleri.
 * Üretilen belgeler dicom-parser ile okunur; maske ↔ piksel verisi gidiş-dönüşü
 * ve hacim hesabı denetlenir.
 */
import { parseDicom } from "dicom-parser";
import { buildRtStruct, buildSegDocument, contourPoints, maskContour, packBinaryFrames, sliceContourPoints, traceContours, unpackBinaryFrame, SOP_RTSTRUCT, SOP_SEG } from "../src/lib/dicomSeg";
import { copySlice, emptyMask, getPixel, growRegion, makeSegmentDef, maskFromJson, maskPixelCount, maskToJson, maxAxes, paint, prune, sliceAxes, thresholdFill, unionMasks, volume } from "../src/lib/segmentation";

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

// ── maskeden eksen ölçümü (c-recist-full: otomatik çap) ──
// 5 piksel yatay çizgi, 0,5 mm/piksel → uzun eksen 2,0 mm, kısa eksen 0.
const line = Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0 }));
const la = sliceAxes(line, 0.5, 0.5)!;
ok(Math.abs(la.longMm - 2) < 1e-9, `yatay çizgi uzun ekseni 2 mm (${la.longMm})`);
ok(la.shortMm === 0, "tek sıra pikselde kısa eksen 0");

// 10×10 kare, 0,5 mm/piksel → uzun eksen köşegen ≈ 6,36 mm; kısa eksen kenar = 4,5 mm
const square = [];
for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) square.push({ x, y });
const sq = sliceAxes(square, 0.5, 0.5)!;
ok(Math.abs(sq.longMm - Math.sqrt(81 * 2) * 0.5) < 0.02, `kare uzun ekseni köşegen (${sq.longMm})`);
ok(Math.abs(sq.shortMm - 4.5) < 0.02, `kare kısa ekseni kenar (${sq.shortMm})`);

// Dikdörtgen 20×4 piksel (0,5 mm): uzun ≈ 9,76 mm (köşegen), kısa ≈ 1,5 mm
const rect = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 20; x++) rect.push({ x, y });
const rc = sliceAxes(rect, 0.5, 0.5)!;
ok(Math.abs(rc.longMm - Math.hypot(19, 3) * 0.5) < 0.02, `dikdörtgen uzun ekseni (${rc.longMm})`);
ok(Math.abs(rc.shortMm - 1.5) < 0.02, `dikdörtgen kısa ekseni (${rc.shortMm})`);

// Anizotropik piksel: 4 piksel yatay, px=1 mm, py=3 mm → 3 mm; dikeyde 1 piksel × 3 mm
const aniso = sliceAxes(Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0 })), 1, 3)!;
ok(Math.abs(aniso.longMm - 3) < 1e-9, "anizotropik piksel uzunluğa yansır");

ok(sliceAxes([], 1) === null, "boş kesitte eksen yok");

// Maske genelinde: en büyük kesit seçilir, z yüksekliği raporlanır.
const am = emptyMask(20, 20);
for (let x = 2; x < 6; x++) am.slices.set(1, (am.slices.get(1) ?? new Uint8Array(400)));
const setPx = (mask: typeof am, z: number, x: number, y: number) => {
  const s = mask.slices.get(z) ?? new Uint8Array(mask.width * mask.height);
  s[y * mask.width + x] = 1;
  mask.slices.set(z, s);
};
for (let x = 2; x < 6; x++) setPx(am, 1, x, 5);       // 4 px → 2 mm
for (let x = 2; x < 12; x++) setPx(am, 3, x, 8);       // 10 px → 5 mm (en büyük)
setPx(am, 7, 3, 3);                                     // tek piksel
const ma = maxAxes(am, { px: 0.5, py: 0.5, sliceThickness: 2 })!;
ok(ma.slice === 3, "en büyük uzun eksenin kesiti seçilir");
ok(Math.abs(ma.longMm - 4.5) < 1e-9, `maskeden uzun eksen 4,5 mm (${ma.longMm})`);
ok(ma.zExtentMm === 12, `z yüksekliği kesit aralığından (${ma.zExtentMm} mm)`);
ok(maxAxes(emptyMask(5, 5), { px: 1, sliceThickness: 1 }) === null, "boş maskede eksen yok");
const single = emptyMask(5, 5);
const sp2 = new Uint8Array(25); sp2[12] = 1; single.slices.set(4, sp2);
const sa = maxAxes(single, { px: 1, sliceThickness: 1 })!;
ok(sa.longMm === 0 && sa.zExtentMm === null, "tek piksel/tek kesit: eksen 0, z yüksekliği yok");

// ── kenar izleme (marching benzeri Moore izleme, c-seg-rtstruct) ──
const gridMask = (w: number, h: number, fill: (x: number, y: number) => boolean) => {
  const m2 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) m2[y * w + x] = 1;
  return m2;
};
/** Kontur noktaları 8-komşu zincirinde mi (sıralı sınır)? */
const chained = (pts: { x: number; y: number }[]) =>
  pts.every((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1 && !(p.x === q.x && p.y === q.y);
  });

// L şekli: içbükey köşe kesilmemeli (satır taraması bunu kırpardı)
const lShape = gridMask(10, 10, (x, y) => (x >= 2 && x < 4 && y >= 2 && y < 8) || (x >= 2 && x < 8 && y >= 6 && y < 8));
const lPoly = maskContour(lShape, 10, 10);
ok(lPoly.length >= 10, `L şekli konturu yeterli nokta içerir (${lPoly.length})`);
ok(chained(lPoly), "kontur noktaları sıralı zincir oluşturur");
ok(lPoly.some((p) => p.x === 3 && p.y === 5), "içbükey köşe (3,5) konturda kalır");
ok(lPoly.every((p) => lShape[p.y * 10 + p.x] === 1), "tüm kontur noktaları maske içinde");

// iki ayrı bileşen: en büyüğü seçilir, traceContours ikisini de verir
const twoBlobs = gridMask(20, 10, (x, y) => (x >= 1 && x < 4 && y >= 1 && y < 4) || (x >= 10 && x < 18 && y >= 2 && y < 8));
const polys = traceContours(twoBlobs, 20, 10);
ok(polys.length === 2, `iki bileşen iki kontur (${polys.length})`);
ok(polys[0].length > polys[1].length, "konturlar büyükten küçüğe sıralı");
const largest = maskContour(twoBlobs, 20, 10);
ok(largest.length === polys[0].length && largest[0].x === polys[0][0].x && largest[0].y === polys[0][0].y, "maskContour en büyük bileşeni döndürür");

// halka: yalnız dış sınır (delik ayrı kontur değil)
const ring = gridMask(12, 12, (x, y) => x >= 2 && x < 10 && y >= 2 && y < 10 && !(x >= 4 && x < 8 && y >= 4 && y < 8));
const ringPolys = traceContours(ring, 12, 12);
ok(ringPolys.length === 1, "halkada tek dış kontur");
ok(ringPolys[0].every((p) => p.x <= 3 || p.x >= 8 || p.y <= 3 || p.y >= 8), "delik sınırı dış kontura karışmaz");

// tek piksel ve komşu çift
ok(traceContours(gridMask(5, 5, (x, y) => x === 2 && y === 2), 5, 5)[0].length === 1, "tek piksel tek nokta");
const linePts = traceContours(gridMask(5, 5, (x, y) => y === 2 && x >= 1 && x <= 3), 5, 5)[0];
ok(linePts.length >= 3 && chained(linePts), `üçlü çizgi kapalı zincir verir (${linePts.length} nokta)`);
ok(linePts.every((p) => p.y === 2 && p.x >= 1 && p.x <= 3), "çizgi konturu çizgi piksel sınırında kalır");
ok(traceContours(new Uint8Array(25), 5, 5).length === 0, "boş maskede kontur yok");

// kesit başına kontur noktaları (RTSTRUCT)
const g2 = { pxMm: 0.5, pyMm: 0.5, dz: 1, origin: [0, 0, 0] as [number, number, number] };
const perContour = sliceContourPoints(twoBlobs, 20, 10, g2, 0, 200);
ok(perContour.length === 2, "kesitte iki kontur nokta dizisi üretilir");
ok(perContour.every((c) => c.length >= 9 && c.length % 3 === 0), "her kontur x,y,z üçlüleri hâlinde");
ok(sliceContourPoints(gridMask(20, 10, (x, y) => x === 5 && y === 5), 20, 10, g2, 0, 200).length === 0, "3 noktadan az bileşen kontur sayılmaz");

if (failed) { console.error(`${failed} segmentasyon testi başarısız`); process.exit(1); }
console.log("Tüm c-seg-rtstruct (segmentasyon + SEG/RTSTRUCT) testleri geçti.");

// ── elle maske + işaret maskesi birleşimi (m-seg) ──
// Yarıçap 0,5 → yalnız merkez piksel (tek piksel sayımı için).
const a = emptyMask(10, 10);
paint(a, 0, 2, 2, 0.5);
const b = emptyMask(10, 10);
paint(b, 0, 7, 7, 0.5);
paint(b, 1, 5, 5, 0.5);
const u = unionMasks(a, b);
ok(!!u, "aynı boyutlu maskeler birleşir");
ok(!!u && getPixel(u, 0, 2, 2) === 1, "birleşimde ilk maskenin pikseli korunur");
ok(!!u && getPixel(u, 0, 7, 7) === 1, "birleşimde ikinci maskenin pikseli eklenir");
ok(!!u && getPixel(u, 1, 5, 5) === 1, "ikinci maskenin diğer kesiti taşınır");
ok(!!u && u.slices.size === 2, "kesit sayısı birleşim kümesi");
ok(getPixel(a, 0, 7, 7) === 0, "girdi maskesi değişmez");
ok(unionMasks(emptyMask(10, 10), emptyMask(11, 10)) === null, "boyut uyuşmazsa null (sessiz bozulma yok)");
ok(maskPixelCount(u!) === 3, "piksel sayımı birleşimle tutarlı");

// hacim: birleşik maskede 3 piksel × (0,5×0,5 mm²) × 2 mm = 1,5 mm³
const uv = volume(u!, { px: 0.5, py: 0.5, sliceThickness: 2 });
ok(Math.abs(uv.mm3 - 1.5) < 1e-9, "birleşik maske hacmi mm³");
ok(Math.abs(uv.ml - 0.0015) < 1e-12, "hacim mL'ye çevrilir");
