/**
 * DICOM sunum durumu (GSPS/PR) dışa aktarma testleri (m-key).
 * Üretilen belgenin okunabilir olması (dicom-parser) ve taşıdığı ayarların
 * doğru olması denetlenir.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDicom } from "dicom-parser";
import { buildPresentationState, SOP_PRESENTATION_STATE } from "../src/lib/dicomSr";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

function val(ds: ReturnType<typeof parseDicom>, tag: string): string {
  const e = ds.elements[tag];
  if (!e) return "";
  const b = ds.byteArray.slice(e.dataOffset, e.dataOffset + e.length);
  return new TextDecoder().decode(b).replace(/\0.*$/, "").trim();
}

const sopUids = ["1.2.840.113619.2.55.2.1", "1.2.840.113619.2.55.2.2"];
const bytes = buildPresentationState({
  patientName: "Yılmaz^Ayşe", patientId: "TR-123", patientSex: "K",
  studyUid: "1.2.840.113619.2.1.1", studyDate: "2026-11-24", institution: "TEST KLINİĞİ",
  seriesUid: "1.2.840.113619.2.1.1.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2",
  sopUids, wl: -600, ww: 1500, rotation: 90, flipH: true, flipV: false, invert: true,
});

// ── parse edilebilirlik ──
const ds = parseDicom(new Uint8Array(bytes));
ok(!!ds, "üretilen PR belgesi parse edilebiliyor");
ok(val(ds, "x00080016") === SOP_PRESENTATION_STATE, "SOP Class UID GSPS");
ok(val(ds, "x00080060") === "PR", "Modality PR");
ok(!!val(ds, "x00080018"), "SOP Instance UID var");
ok(val(ds, "x0020000d") === "1.2.840.113619.2.1.1", "Study Instance UID korunuyor");

// ── kaydedilen ayarlar ──
const voi = ds.elements.x00283010?.items?.[0]?.dataSet as ReturnType<typeof parseDicom> | undefined;
ok(!!voi, "VOI LUT Sequence var");
ok(parseFloat(voi?.string("x00281050") ?? "nan") === -600, "pencere merkezi (WL) doğru");
ok(parseFloat(voi?.string("x00281051") ?? "nan") === 1500, "pencere genişliği (WW) doğru");
ok(val(ds, "x00700041") === "90", "görüntü döndürmesi kaydedildi");
ok(val(ds, "x00700042") === "Y", "yatay çevirme kaydedildi");
const note = val(ds, "x00700081");
ok(note.includes("ters=Y") && note.includes("dikeyCevir=N"), `not ters/dikey çevirmeyi taşıyor (${note.slice(0, 60)}…)`);

// ── referanslar ──
const refs = ds.elements.x00081115;
ok(!!refs && refs.items?.length === 1, "Referenced Series Sequence tek seri");
const inner = refs?.items?.[0]?.dataSet as ReturnType<typeof parseDicom> | undefined;
ok(inner?.string("x0020000e") === "1.2.840.113619.2.1.1.1", "referans seri UID'si doğru");
const imgSeq = inner?.elements.x00081140;
ok(imgSeq?.items?.length === sopUids.length, `${sopUids.length} referans kesit yazıldı`);
const refItems = imgSeq?.items ?? [];
ok(refItems.every((it) => {
  const d = it.dataSet as ReturnType<typeof parseDicom>;
  return !!d.elements.x00081150 && !!d.elements.x00081155;
}), "her referansta SOP Class/Instance UID var");
ok(refItems.every((it, i) => {
  const d = it.dataSet as ReturnType<typeof parseDicom>;
  return d.string("x00081155") === sopUids[i];
}), "kesit sırasıyla SOP Instance UID eşleşiyor");

// ── UI bağlantısı ──
const root = path.resolve(__dirname, "..");
const menu = readFileSync(path.join(root, "src/components/ExportMenu.tsx"), "utf8");
ok(menu.includes("buildPresentationState") && menu.includes("Görünüm → DICOM PR"), "dışa aktarma menüsünde PR girişi var");
const ws = readFileSync(path.join(root, "src/components/Workstation.tsx"), "utf8");
ok(ws.includes("rotation={rotation}") && ws.includes("flipH={flipH}"), "Workstation görünüm durumunu ExportMenu'a geçiriyor");

if (failed) { console.error(`${failed} sunum durumu testi başarısız`); process.exit(1); }
console.log("Tüm sunum durumu (PR) testleri geçti.");
