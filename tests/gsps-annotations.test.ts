/**
 * Anotasyon → DICOM GSPS (PR) grafik katmanı testleri.
 *
 * Kapsam: anotasyon türlerinin GSPS grafik nesnesine eşlenmesi, SOP eşleşmeyen
 * kesitlerin atlanması ve üretilen PR belgesinin dicom-parser ile geri okunup
 * grafik/metin nesnelerini koruduğunun doğrulanması.
 */
import dicomParser from "dicom-parser";
import { annotationToGraphic, annotationsToGsps, writableAnnotationCount } from "../src/lib/gspsGraphics";
import { buildPresentationState } from "../src/lib/dicomSr";
import { parsePresentationState } from "../src/lib/dicomSpecial";
import type { Annotation } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const ann = (over: Partial<Annotation> & { kind: Annotation["kind"]; points: { x: number; y: number }[] }): Annotation =>
  ({ id: over.id ?? "a1", slice: over.slice ?? 0, text: over.text, ...over }) as Annotation;

// ── 1. tür eşlemesi ──
const len = annotationToGraphic(ann({ kind: "length", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }))!;
ok(len.type === "POLYLINE" && len.data.join(",") === "10,20,30,40", "uzunluk → açık POLYLINE (noktalar aynen)");
const ell = annotationToGraphic(ann({ kind: "ellipse", points: [{ x: 30, y: 40 }, { x: 10, y: 20 }] }))!;
// DICOM PS3.3 C.10.6: ELLIPSE = [cx,cy, x1,y1, x2,y2] — merkez + iki yarı-eksen ucu.
ok(ell.type === "ELLIPSE" && ell.data.join(",") === "20,30,30,30,20,40", `elips → standart ELLIPSE (merkez + eksen uçları, ${ell.data.join(",")})`);
ok(annotationToGraphic(ann({ kind: "ellipse", points: [{ x: 5, y: 5 }, { x: 5, y: 25 }] })) === null, "sıfır yarı-eksenli elips çizilmez (null)");
const rect = annotationToGraphic(ann({ kind: "rect", points: [{ x: 0, y: 0 }, { x: 10, y: 5 }] }))!;
ok(rect.type === "POLYLINE" && rect.data.length === 10 && rect.data[0] === 0 && rect.data[8] === 0, "dikdörtgen → kapalı POLYLINE (ilk nokta tekrar)");
const pg = annotationToGraphic(ann({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] }))!;
ok(pg.type === "POLYLINE" && pg.data.length === 8, "poligon → kapalı POLYLINE");
const ang = annotationToGraphic(ann({ kind: "angle", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }))!;
ok(ang.type === "POLYLINE", "açı → POLYLINE");
const one = annotationToGraphic(ann({ kind: "arrow", points: [{ x: 5, y: 6 }] }))!;
ok(one.type === "POINT" && one.data.join(",") === "5,6", "tek noktalı işaret → POINT");
ok(annotationToGraphic(ann({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })) === null, "2 noktalı poligon çizilmez (null)");
ok(annotationToGraphic(ann({ kind: "length", points: [] })) === null, "boş nokta listesi null");
const nan = annotationToGraphic(ann({ kind: "length", points: [{ x: NaN, y: 1 }, { x: 2, y: 3 }] }))!;
ok(nan.type === "POINT", "geçersiz nokta atılır, kalan tek nokta POINT olur");

// ── 2. gruplama / metin / sayım ──
const items = annotationsToGsps([
  ann({ id: "a", kind: "length", slice: 2, text: " 8 mm ", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }),
  ann({ id: "b", kind: "length", slice: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
]);
ok(items.length === 2 && items[0].slice === 2, "her anotasyon ayrı öğe, kesit korunur");
ok(items[0].texts.length === 1 && items[0].texts[0].text === "8 mm", "metin kırpılarak taşınır");
ok(items[0].texts[0].anchor.join(",") === "1,2", "metin bağlantı noktası ilk nokta");
ok(items[1].texts.length === 0, "metinsiz anotasyonda metin nesnesi yok");
ok(writableAnnotationCount([ann({ kind: "length", slice: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })], ["uid0"]) === 0, "SOP UID yoksa anotasyon yazılamaz sayılır");
ok(writableAnnotationCount([ann({ kind: "length", slice: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })], ["uid0", "uid1"]) === 1, "SOP UID varsa yazılabilir");

// ── 3. PR belgesi tur-gidiş ──
const sopUids = ["1.2.3.4.1", "1.2.3.4.2"];
const bytes = buildPresentationState({
  patientName: "TEST HASTA", patientId: "TR-1", patientSex: "E", studyUid: "1.2.3.4", studyDate: "20260101",
  institution: "Test", seriesUid: "1.2.3.4.9", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids,
  wl: 40, ww: 400, rotation: 90, flipH: true,
  annotations: [
    ann({ id: "x", kind: "length", slice: 0, text: "uzunluk 12 mm", points: [{ x: 10, y: 20 }, { x: 40, y: 20 }] }),
    ann({ id: "y", kind: "ellipse", slice: 1, points: [{ x: 5, y: 5 }, { x: 15, y: 25 }] }),
    ann({ id: "z", kind: "length", slice: 7, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }), // eşleşmeyen kesit
  ],
});
const ds = dicomParser.parseDicom(bytes);
ok(ds.string("x00080016") === "1.2.840.10008.5.1.4.1.1.11.1", "SOP Class = GSPS (PR)");
ok(ds.string("x00700080") === "ATIK-PR", "PR etiketi korunur");

const parsed = parsePresentationState(ds)!;
ok(parsed !== null, "üretilen belge PR olarak okunabilir");
ok(parsed.graphics.length === 2, `2 grafik yazıldı (eşleşmeyen kesit atlandı) — ${parsed.graphics.length}`);
ok(parsed.graphics[0].type === "POLYLINE" && parsed.graphics[0].data.join(",") === "10,20,40,20", "uzunluk grafiği geri okunur (FL)");
ok(parsed.graphics[1].type === "ELLIPSE" && parsed.graphics[1].data.join(",") === "10,15,15,15,10,25", `elips grafiği standart biçimde geri okunur (${parsed.graphics[1].data.join(",")})`);
ok(parsed.displayedArea === undefined, "Displayed Area yoksa uydurulmaz");
ok(!parsed.layers?.some((l) => !l), "her grafik nesnesinin katman kimliği var");
ok(parsed.texts.length === 1 && parsed.texts[0].text === "uzunluk 12 mm", "metin nesnesi metniyle geri okunur");

// Not: VOI LUT / döndürme alanları bu değişiklikten etkilenmemeli.
ok(ds.elements.x00283010 !== undefined, "VOI LUT dizisi korunur (pencere)");
ok((ds.string("x00700041") || "") === "90", "döndürme alanı korunur");

// Anotasyonsuz PR: grafik katmanı yazılmaz (geriye dönük uyum).
const plain = dicomParser.parseDicom(buildPresentationState({
  patientName: "T", patientId: "1", patientSex: "E", studyUid: "1.2.3", studyDate: "20260101", institution: "",
  seriesUid: "1.2.3.9", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids, wl: 40, ww: 400,
}));
ok(plain.elements.x00700001 === undefined && plain.elements.x00700060 === undefined, "anotasyon yoksa GSPS grafik dizileri yazılmaz");

if (failed) { console.error(`${failed} GSPS anotasyon testi başarısız`); process.exit(1); }
console.log("GSPS anotasyon testleri geçti.");
