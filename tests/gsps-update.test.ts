/**
 * Presentation State (GSPS/PR) **güncelleme** akışı testleri (f-objects).
 *
 * Kapsam:
 *  1. Eski PR'ın grafik/metin/katman nesneleri yeni PR'da korunur
 *  2. Yeni pencere (VOI LUT) + yeni anotasyonlar birleştirilir
 *  3. Güncelleme yeni SOP Instance UID ile yapılır; eski instance'a not içinde referans
 *  4. Referans kesit bu PR'ın sopUids'inde olmayan eski öğeler atlanır (dürüst)
 *  5. Ayni geometri + katman birden fazla eklenirse tek kez yazılır (tekilleştirme)
 *  6. Base tanımlı değilse yeni PR üretilir (eski davranış korunur)
 */
import dicomParser from "dicom-parser";
import { buildPresentationState, buildUpdatedPresentationState, SOP_PRESENTATION_STATE } from "../src/lib/dicomSr";
import { parsePresentationState } from "../src/lib/dicomSpecial";
import type { Annotation, DicomGSPS } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const ann = (over: Partial<Annotation> & { kind: Annotation["kind"]; points: { x: number; y: number }[] }): Annotation =>
  ({ id: over.id ?? "a1", slice: over.slice ?? 0, text: over.text, ...over }) as Annotation;

const patient = {
  patientName: "Yılmaz^Ayşe", patientId: "TR-123", patientSex: "K",
  studyUid: "1.2.840.113619.2.1.1", studyDate: "2026-11-24", institution: "TEST KLINİĞİ",
};
const seriesUid = "1.2.840.113619.2.1.1.1";
const sopClassUid = "1.2.840.10008.5.1.4.1.1.2";
const sopUids = ["1.2.840.113619.2.55.2.1", "1.2.840.113619.2.55.2.2"];

function parse(bytes: Uint8Array): DicomGSPS | null {
  const ds = dicomParser.parseDicom(bytes);
  return parsePresentationState(ds);
}
function graphicData(g: DicomGSPS["graphics"][number]): string {
  return g.data.map((v) => Math.round(v * 100) / 100).join(",");
}

// ── 1. temel akış: eski PR → güncelleme ──
const baseBytes = buildPresentationState({
  ...patient, seriesUid, sopClassUid, sopUids,
  wl: -600, ww: 1500, rotation: 0, flipH: false, flipV: false, invert: false,
  annotations: [
    ann({ id: "len1", kind: "length", slice: 0, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }),
    ann({ id: "cobb1", kind: "cobb", slice: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }),
  ],
});
const base = parse(new Uint8Array(baseBytes));
ok(!!base, "base PR parse edilebiliyor");
ok(!!base?.sopInstanceUid, `base PR SOP Instance UID taşıyor (${base?.sopInstanceUid})`);
ok(!!base && base.graphics.length === 2, "base PR 2 grafik nesnesi taşıyor");
ok(!!base && base.layers?.length === 2 && base.layers.includes("LENGTH") && base.layers.includes("COBB"), "base PR katman kimlikleri korunuyor");

const baseSopUid = base?.sopInstanceUid ?? "";
const updatedBytes = buildUpdatedPresentationState({
  ...patient, seriesUid, sopClassUid, sopUids,
  baseGsps: base,
  wl: -400, ww: 800, rotation: 90, flipH: true, flipV: false, invert: true,
  annotations: [
    ann({ id: "arrow1", kind: "arrow", slice: 0, points: [{ x: 50, y: 60 }] }),
  ],
});
const updatedDs = dicomParser.parseDicom(new Uint8Array(updatedBytes));
const updated = parse(new Uint8Array(updatedBytes));
ok(!!updatedDs.elements.x00080016 && (updatedDs.string("x00080016") ?? "") === SOP_PRESENTATION_STATE, "güncellenen PR SOP Class GSPS");
ok(updatedDs.string("x00080060") === "PR", "güncellenen PR Modality PR");
ok(!!updated && !!updated.sopInstanceUid && updated.sopInstanceUid !== baseSopUid, "güncelleme yeni SOP Instance UID üretiyor");

// ── 2. eski nesneler korunur ──
ok(!!updated && updated.graphics.length === 3, `eski 2 grafik + yeni 1 grafik = 3 (${updated?.graphics.length})`);
const preserved = [
  { type: "POLYLINE", data: "10,20,30,40" },
  { type: "POLYLINE", data: "0,0,5,5" },
];
for (const want of preserved) {
  const found = updated?.graphics.some((g) => g.type === want.type && graphicData(g) === want.data);
  ok(!!found, `eski grafik korunuyor: ${want.type} [${want.data}]`);
}
ok(!!updated && updated.graphics.some((g) => g.type === "POINT" && graphicData(g) === "50,60"), "yeni anotasyon grafik ekleniyor");
ok(!!updated && updated.layers?.length === 3 && updated.layers.includes("LENGTH") && updated.layers.includes("COBB"), "eski katmanlar + yeni ANNOT katmanı korunuyor");

// ── 3. pencere güncellenir, eski ayar notta kaçmaz ──
const voi = updatedDs.elements.x00283010?.items?.[0]?.dataSet as ReturnType<typeof dicomParser.parseDicom> | undefined;
ok(parseFloat(voi?.string("x00281050") ?? "nan") === -400, "güncelleme yeni WL taşıyor");
ok(parseFloat(voi?.string("x00281051") ?? "nan") === 800, "güncelleme yeni WW taşıyor");
ok(updatedDs.string("x00700041") === "90" && updatedDs.string("x00700042") === "Y", "güncelleme döndürme/çevirme yeni değerleri taşıyor");
const note = updatedDs.string("x00700081") ?? "";
ok(note.includes("WL=-400") && note.includes("WW=800"), "not yeni pencere değerlerini taşıyor");
ok(note.includes(baseSopUid), `not önceki instance'a referans veriyor (${baseSopUid})`);

// ── 4. referans kesit bu PR'da olmayan eski öğe atlanır ──
const orphanBase: DicomGSPS = {
  id: "gsps-orphan", label: "eski", description: "",
  graphics: [{ type: "POLYLINE", data: [1, 2, 3, 4] }],
  texts: [],
  referenceSopUids: ["1.2.9.9.9.9.9"],
  layers: ["LENGTH"],
};
const orphanBytes = buildUpdatedPresentationState({
  ...patient, seriesUid, sopClassUid, sopUids,
  baseGsps: orphanBase,
  wl: -100, ww: 100,
  annotations: [ann({ id: "new1", kind: "length", slice: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })],
});
const orphan = parse(new Uint8Array(orphanBytes));
ok(!!orphan && orphan.graphics.length === 1, `referans kesit eşleşmeyen eski öğe atlanır (${orphan?.graphics.length})`);
ok(!!orphan && orphan.graphics[0]?.type === "POLYLINE" && graphicData(orphan.graphics[0]) === "0,0,1,1", "yalnız yeni anotasyon yazılır");

// ── 5. tekilleştirme: aynı geometri + katman bir kez yazılır ──
const dupBase: DicomGSPS = {
  id: "gsps-dup", label: "eski", description: "",
  graphics: [{ type: "POLYLINE", data: [10, 20, 30, 40] }],
  texts: [],
  referenceSopUids: [sopUids[0]],
  layers: ["LENGTH"],
};
const dupBytes = buildUpdatedPresentationState({
  ...patient, seriesUid, sopClassUid, sopUids,
  baseGsps: dupBase,
  wl: -100, ww: 100,
  annotations: [ann({ id: "same", kind: "length", slice: 0, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] })],
});
const dup = parse(new Uint8Array(dupBytes));
ok(!!dup && dup.graphics.length === 1, `tekilleştirme: aynı geometri bir kez yazılır (${dup?.graphics.length})`);

// ── 6. base tanımlı değilse yeni PR (eski davranış) ──
const freshBytes = buildUpdatedPresentationState({
  ...patient, seriesUid, sopClassUid, sopUids,
  baseGsps: null,
  wl: -300, ww: 600,
  annotations: [ann({ id: "fresh", kind: "rect", slice: 1, points: [{ x: 0, y: 0 }, { x: 9, y: 4 }] })],
});
const fresh = parse(new Uint8Array(freshBytes));
ok(!!fresh && fresh.graphics.length === 1, "base yok → yalnız yeni anotasyonlarla yeni PR");
ok(!!fresh && graphicData(fresh.graphics[0]) === "0,0,9,0,9,4,0,4,0,0", "base yok → dikdörtgen kapalı POLYLINE");
const freshDs = dicomParser.parseDicom(new Uint8Array(freshBytes));
ok(!(freshDs.string("x00700081") ?? "").includes("guncellen:"), "base yok → notta güncelleme referansı yok");

console.log(failed === 0 ? "\nGSPS-UPDATE: TÜM TESTLƏR BAŞARILI" : `\nGSPS-UPDATE: ${failed} BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
