/**
 * PR/GSPS ölçüm içe aktarma — uçtan uca test (m-persist).
 *
 * Kapsam:
 *  1. Standart GSPS geometrilerinin (POINT/POLYLINE/CIRCLE/ELLIPSE) noktalara çevrilmesi
 *  2. Kendi yazdığımız PR'ın **tam geri okunması** (tür + kesit + geometri)
 *  3. Kesit eşleşmesi olmayan / desteklenmeyen nesnelerde dürüst davranış (tahmin yok)
 *  4. `loadMedicalFiles` hattının PR dosyasını görüntü serisine bağlaması
 *  5. Kopya ölçüm eklenmemesi
 */
import assert from "node:assert/strict";
import dicomParser from "dicom-parser";
import { buildPresentationState } from "../src/lib/dicomSr";
import { parsePresentationState } from "../src/lib/dicomSpecial";
import { graphicToPoints, gspsToAnnotations, mergeGspsAnnotations, pickPresentationState, sopUidIndex } from "../src/lib/gspsImport";
import { loadMedicalFiles } from "../src/lib/dicom";
import type { Annotation, GSPSGraphicObject, SeriesData } from "../src/lib/types";
import { concat, el, str, uidEl, us } from "../src/lib/dicomWrite";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};
const g = (type: GSPSGraphicObject["type"], data: number[]): GSPSGraphicObject => ({ type, data });

// ── 1. geometri çevirisi ──
const point = gspsToPointsOf(g("POINT", [7, 9]));
ok(point?.length === 1 && point[0].x === 7 && point[0].y === 9, "POINT → tek nokta");
const circle = gspsToPointsOf(g("CIRCLE", [50, 60, 10, 20]));
ok(circle?.length === 2 && circle[0].x === 40 && circle[1].x === 60 && circle[1].y === 80, "CIRCLE → merkez ± yarıçap (sınırlayıcı kutu)");
const ellipse = gspsToPointsOf(g("ELLIPSE", [50, 50, 70, 50, 50, 80]));
ok(ellipse?.length === 2 && ellipse[0].x === 30 && ellipse[0].y === 20 && ellipse[1].x === 70 && ellipse[1].y === 80, "ELLIPSE (merkez + eksen uçları) → sınırlayıcı kutu");
const openPoly = gspsToPointsOf(g("POLYLINE", [0, 0, 10, 0, 10, 10]));
ok(openPoly?.length === 3, "açık POLYLINE noktaları korunur");
const closedPoly = gspsToPointsOf(g("POLYLINE", [0, 0, 10, 0, 10, 10, 0, 0]));
ok(closedPoly?.length === 3, "kapalı POLYLINE'da tekrarlanan ilk nokta atılır");
ok(gspsToPointsOf(g("POLYLINE", [1, 1])) === null, "tek çiftli POLYLINE çizilemez (null)");
ok(gspsToPointsOf(g("INTERPOLATED", [0, 0, 1, 1])) === null, "INTERPOLATED tahmin edilmez (null)");
ok(gspsToPointsOf(g("ELLIPSE", [5, 5, 5, 5, 5, 5])) === null, "sıfır yarı-eksenli ELLIPSE null");
ok(gspsToPointsOf(g("CIRCLE", [5, 5, 0, 5])) === null, "sıfır yarıçaplı CIRCLE null");

function gspsToPointsOf(gr: GSPSGraphicObject) {
  return graphicToPoints(gr);
}

// ── 2. kesit indeksi ──
const idx = sopUidIndex(["a", "b", undefined, "d", "a"]);
ok(idx.get("a") === 0 && idx.get("b") === 1 && idx.get("d") === 3 && idx.size === 3, "SOP UID → kesit indeksi (boş/tekrar güvenli)");

// ── 3. kendi PR'ımız → ölçüm tur-gidiş ──
const sopUids = ["1.2.3.4.1", "1.2.3.4.2", "1.2.3.4.3"];
const src: Annotation[] = [
  { id: "a", kind: "length", slice: 0, points: [{ x: 10, y: 20 }, { x: 40, y: 20 }] },
  { id: "b", kind: "ellipse", slice: 2, points: [{ x: 60, y: 70 }, { x: 100, y: 110 }], text: "lezyon" },
  { id: "c", kind: "cobb", slice: 1, points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 1, y: 6 }, { x: 5, y: 6 }] },
];
const bytes = buildPresentationState({
  patientName: "TEST^HASTA", patientId: "TR-2", patientSex: "E", studyUid: "1.2.3.4", studyDate: "20260101",
  institution: "Test", seriesUid: "1.2.3.4.9", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids,
  wl: 40, ww: 400, annotations: src,
});
const parsed = parsePresentationState(dicomParser.parseDicom(bytes))!;
ok(parsed.presentedSeriesUid === "1.2.3.4.9", "PR sunduğu seri UID'sini taşır");
ok(parsed.referenceSopUids?.length === 3 && parsed.referenceSopUids[0] === sopUids[0], "her grafiğin görüntü referansı okunur");
ok(parsed.layers?.join(",") === "LENGTH,ELLIPSE,COBB", `katman kimlikleri türü taşır (${parsed.layers?.join(",")})`);

const imported = gspsToAnnotations(parsed, sopUids);
ok(imported.annotations.length === 3, `3 ölçüm geri alındı (${imported.annotations.length})`);
ok(imported.graphics === 3 && imported.skipped === 0, "hiçbir grafik atlanmadı");
const kinds = imported.annotations.map((a) => `${a.kind}@${a.slice}`).join(",");
ok(kinds === "length@0,ellipse@2,cobb@1", `tür + kesit birebir korunur (${kinds})`);
const ellBack = imported.annotations.find((a) => a.kind === "ellipse")!;
ok(ellBack.points[0].x === 60 && ellBack.points[0].y === 70 && ellBack.points[1].x === 100 && ellBack.points[1].y === 110,
  "elips geometrisi kayıpsız döner (sınırlayıcı kutu)");
ok(ellBack.text === "lezyon", "metin nesnesi ölçüme etiket olarak bağlanır");
ok(imported.annotations.every((a) => !("stats" in a)), "GSPS istatistik taşımaz — uydurma stats yok");

// ── 4. eşleşmeyen / desteklenmeyen durumlar ──
const noRef = gspsToAnnotations({ id: "x", label: "L", description: "", graphics: [g("POLYLINE", [0, 0, 5, 5])], texts: [] }, sopUids);
ok(noRef.annotations.length === 0 && noRef.skipped === 1 && noRef.notes.some((n) => n.includes("0008,1140")), "görüntü referansı yoksa tahmin edilmez, not düşülür");
const badUid = gspsToAnnotations({
  id: "y", label: "L", description: "", graphics: [g("POLYLINE", [0, 0, 5, 5])], texts: [], referenceSopUids: ["yok-boyle-uid"],
}, sopUids);
ok(badUid.annotations.length === 0 && badUid.skipped === 1, "seride olmayan SOP UID'ye bağlı grafik alınmaz");
const noSop = gspsToAnnotations({ id: "z", label: "L", description: "", graphics: [g("POINT", [1, 2])], texts: [], referenceSopUids: ["1.2.3.4.1"] }, undefined);
ok(noSop.annotations.length === 0 && noSop.notes.some((n) => n.includes("SOP Instance UID yok")), "seride SOP UID yoksa açık hata notu");
const infer = gspsToAnnotations({ id: "w", label: "L", description: "", graphics: [g("POLYLINE", [0, 0, 5, 5])], texts: [], referenceSopUids: ["1.2.3.4.1"] }, sopUids);
ok(infer.annotations[0]?.kind === "length", "katman kimliği olmayan dış PR'da 2 nokta → uzunluk (asgari çıkarım)");
const pointNoLayer = gspsToAnnotations({ id: "v", label: "L", description: "", graphics: [g("POINT", [3, 4])], texts: [], referenceSopUids: ["1.2.3.4.2"] }, sopUids);
ok(pointNoLayer.annotations[0]?.kind === "arrow" && pointNoLayer.annotations[0].slice === 1, "POINT → işaret (ok), kesit doğru");

// ── 5. kopya koruması ──
const merge1 = mergeGspsAnnotations(src, imported.annotations);
ok(merge1.added.length === 0 && merge1.duplicates === 3, "aynı ölçümler ikinci kez eklenmez");
const merge2 = mergeGspsAnnotations([], imported.annotations);
ok(merge2.added.length === 3 && merge2.duplicates === 0, "boş listeye hepsi eklenir");

// ── 6. PR seçimi ──
const docs = [
  { id: "p1", label: "A", description: "", graphics: [g("POINT", [1, 1])], texts: [], presentedSeriesUid: "other" },
  { id: "p2", label: "B", description: "", graphics: [g("POINT", [1, 1])], texts: [], presentedSeriesUid: "1.2.3.4.9" },
];
ok(pickPresentationState(docs, "1.2.3.4.9")?.id === "p2", "seriye ait PR seçilir (UID eşleşmesi)");
ok(pickPresentationState([], "x") === null && pickPresentationState([{ ...docs[0], graphics: [] }], "x") === null, "ölçümsüz PR seçilmez");

  // ── 7. dosya yükleme hattı (async): görüntü serisi + PR birlikte ──
  async function filePipeline() {
  // ── 7. dosya yükleme hattı: görüntü serisi + PR birlikte ──
  function minimalDicom(opts: { sopClass: string; sopUid: string; seriesUid: string; instance: number }): Uint8Array {
    // Not: uzun VR'lar (OB/OW) 12 baytlık başlık ister — repo yazıcısı doğru yapıyor.
    const body = concat([
      str(0x0008, 0x0016, "UI", opts.sopClass), uidEl(0x0008, 0x0018, opts.sopUid),
      str(0x0008, 0x0020, "DA", "20260101"), str(0x0008, 0x0060, "CS", "CT"),
      str(0x0010, 0x0010, "PN", "TEST^HASTA"), str(0x0010, 0x0020, "LO", "TR-9"),
      uidEl(0x0020, 0x000d, "1.2.3.4.77"), uidEl(0x0020, 0x000e, opts.seriesUid),
      str(0x0020, 0x0013, "IS", String(opts.instance)),
      us(0x0028, 0x0002, 1), str(0x0028, 0x0004, "CS", "MONOCHROME2"),
      us(0x0028, 0x0010, 2), us(0x0028, 0x0011, 2),
      us(0x0028, 0x0100, 16), us(0x0028, 0x0101, 16), us(0x0028, 0x0102, 15), us(0x0028, 0x0103, 0),
      el(0x7fe0, 0x0010, "OW", new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0])),
    ]);
    const meta = concat([
      el(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
      uidEl(0x0002, 0x0002, opts.sopClass), uidEl(0x0002, 0x0003, opts.sopUid),
      uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"), uidEl(0x0002, 0x0012, "1.2.3"),
    ]);
    const glen = new Uint8Array(4);
    new DataView(glen.buffer).setUint32(0, meta.length, true);
    return concat([new Uint8Array(128), new TextEncoder().encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body]);
  }

  const seriesUid = "1.2.3.4.200";
  const imgUids = ["1.2.3.4.200.1", "1.2.3.4.200.2"];
  const prBytes = buildPresentationState({
    patientName: "TEST^HASTA", patientId: "TR-9", patientSex: "E", studyUid: "1.2.3.4.77", studyDate: "20260101",
    institution: "Test", seriesUid, sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: imgUids,
    wl: 40, ww: 400,
    annotations: [
      { id: "p", kind: "length", slice: 1, points: [{ x: 1.5, y: 2 }, { x: 5, y: 2 }], text: "12 mm" },
    ],
  });

  const toFile = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name, { type: "application/dicom" });
  const files = [
    // PR önce gelir: bağlama işlemi dosya sırasından bağımsız olmalı.
    toFile("pr.dcm", prBytes),
    ...imgUids.map((u, i) => toFile(`img${i}.dcm`, minimalDicom({ sopClass: "1.2.840.10008.5.1.4.1.1.2", sopUid: u, seriesUid, instance: i + 1 }))),
  ];
  const warnings: string[] = [];
  const loaded: SeriesData[] = await (async () => loadMedicalFiles(files, undefined, (w) => warnings.push(w)))();

  ok(loaded.length === 1, `PR görüntü serisi olarak açılmaz; tek seri yüklenir (${loaded.length})`);
  const s0 = loaded[0];
  ok(s0?.seriesUid === seriesUid, "görüntü serisi doğru seridir");
  ok(!!s0?.gsps && s0.gsps.length === 1, "PR seriye eklendi (gsps)");
  ok(s0?.sopUids?.join(",") === imgUids.join(","), "kesit SOP UID'leri sırayla");
  ok(warnings.length === 0, `beklenmeyen uyarı yok (${warnings.join(" | ")})`);

  const e2e = gspsToAnnotations(s0!.gsps![0], s0!.sopUids);
  ok(e2e.annotations.length === 1 && e2e.annotations[0].slice === 1, "yüklenen PR'dan ölçüm çıkar (kesit 1)");
  ok(e2e.annotations[0].text === "12 mm", "ölçüm etiketi korunur");

  if (failed) { console.error(`${failed} GSPS içe aktarma testi başarısız`); process.exit(1); }
  console.log("GSPS içe aktarma testleri geçti.");

}

filePipeline().catch((e) => { console.error("GSPS içe aktarma testi çöktü:", e); process.exit(1); });
