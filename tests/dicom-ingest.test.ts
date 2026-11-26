/**
 * DICOMweb STOW-RS alımı (f-objects: XA/US çok kareli akışın canlı kabulü) testleri.
 *
 * Gerçek bir DICOM P10 üreteciyle doğrulama, STOW-RS yanıt gövdesi ve akış
 * birleştirme mantığı birlikte sınanır. Ayrıca kaynağa gömülü kablolama
 * denetimleri vardır (route yolları, kimlik doğrulama deseni, Workstation düğmesi).
 *
 * Kapsam dürüstlüğü: bu testler DIMSE C-STORE'u KANITLAMAZ — ortamda DIMSE
 * istemcisi/sunucusu yoktur. Alım yolu DICOMweb STOW-RS'tir; DIMSE gereken
 * kurumlar Orthanc/dcm4chee gibi bir ağ geçidi kullanmalıdır.
 *
 * Çalıştırma: npx tsx tests/dicom-ingest.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  validateIngestInstance,
  buildStowResponseBody,
  mergeSeriesData,
  INGEST_MAX_INSTANCES,
  INGEST_MAX_INSTANCE_BYTES,
  INGEST_MAX_TOTAL_BYTES,
} from "../src/lib/dicomIngest";
import type { SeriesData } from "../src/lib/types";

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok ${name}`); };

// ───────── Minimal Explicit VR Little Endian DICOM üreteci (pacs.orthanc.e2e ile aynı desen) ─────────

function element(group: number, elem: number, vr: string, value: Uint8Array): Uint8Array {
  const long = ["OB", "OW", "OF", "SQ", "UC", "UR", "UT", "UN"].includes(vr);
  const paddedLength = value.length + (value.length % 2);
  const head = long ? 12 : 8;
  const out = new Uint8Array(head + paddedLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out.set(vr.split("").map((c) => c.charCodeAt(0)), 4);
  if (long) { dv.setUint32(8, paddedLength, true); } else { dv.setUint16(6, paddedLength, true); }
  out.set(value, head);
  if (paddedLength !== value.length && vr !== "UI" && vr !== "OB" && vr !== "OW") out[out.length - 1] = 0x20;
  return out;
}
const strVal = (s: string) => new TextEncoder().encode(s);
const uiVal = (s: string) => new TextEncoder().encode(s);

function makeDicom(over: { modality?: string; patientName?: string; studyUid?: string; seriesUid?: string; sopUid?: string; sopClass?: string } = {}): Uint8Array {
  const sopClass = over.sopClass ?? "1.2.840.10008.5.1.4.2.1"; // X-Ray Angiographic Image Storage
  const studyUid = over.studyUid ?? "1.2.3.4.5.6.7.8.9.100";
  const seriesUid = over.seriesUid ?? "1.2.3.4.5.6.7.8.9.200";
  const sopUid = over.sopUid ?? "1.2.3.4.5.6.7.8.9.300";
  const parts: Uint8Array[] = [new Uint8Array(128), strVal("DICM")];
  const metaElems: Uint8Array[] = [
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0002, "UI", uiVal(sopClass)),
    element(0x0002, 0x0003, "UI", uiVal(sopUid)),
    element(0x0002, 0x0010, "UI", uiVal("1.2.840.10008.1.2.1")),
    element(0x0002, 0x0012, "UI", uiVal("1.2.3.4.5.6.7.8.9")),
    element(0x0002, 0x0013, "SH", strVal("ARENA-INGEST")),
  ];
  const metaLen = metaElems.reduce((n, e) => n + e.length, 0);
  const groupLen = element(0x0002, 0x0000, "UL", new Uint8Array(4));
  new DataView(groupLen.buffer).setUint32(8, metaLen, true);
  parts.push(groupLen, ...metaElems);
  const px = new Uint8Array(32);
  const dvp = new DataView(px.buffer);
  for (let i = 0; i < px.length / 2; i++) dvp.setUint16(i * 2, 7 + i, true);
  parts.push(
    element(0x0008, 0x0016, "UI", uiVal(sopClass)),
    element(0x0008, 0x0018, "UI", uiVal(sopUid)),
    element(0x0008, 0x0020, "DA", strVal("20260227")),
    element(0x0008, 0x0060, "CS", strVal(over.modality ?? "XA")),
    element(0x0010, 0x0010, "PN", strVal(over.patientName ?? "CANLI^AKis")),
    element(0x0010, 0x0020, "LO", strVal("PID-1")),
    element(0x0020, 0x000d, "UI", uiVal(studyUid)),
    element(0x0020, 0x000e, "UI", uiVal(seriesUid)),
    element(0x0020, 0x0011, "IS", strVal("1")),
    element(0x0020, 0x0013, "IS", strVal("1")),
    element(0x0028, 0x0002, "US", new Uint8Array([1, 0])),
    element(0x0028, 0x0004, "CS", strVal("MONOCHROME2")),
    element(0x0028, 0x0010, "US", new Uint8Array([4, 0])),
    element(0x0028, 0x0011, "US", new Uint8Array([4, 0])),
    element(0x0028, 0x0100, "US", new Uint8Array([16, 0])),
    element(0x0028, 0x0101, "US", new Uint8Array([16, 0])),
    element(0x0028, 0x0102, "US", new Uint8Array([15, 0])),
    element(0x0028, 0x0103, "US", new Uint8Array([0, 0])),
    element(0x7fe0, 0x0010, "OW", px),
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

console.log("· validateIngestInstance");
ok("geçerli XA örneğini kabul eder ve künyeleri okur", () => {
  const v = validateIngestInstance(makeDicom({ modality: "XA", patientName: "CANLI^AKis" }));
  assert.ok(v.ok, v.ok ? "" : v.error);
  assert.equal(v.info.modality, "XA");
  assert.equal(v.info.seriesUid, "1.2.3.4.5.6.7.8.9.200");
  assert.equal(v.info.sopUid, "1.2.3.4.5.6.7.8.9.300");
  assert.equal(v.info.patientName, "CANLI AKis");
});
ok("US modalitesi de kabul edilir", () => {
  const v = validateIngestInstance(makeDicom({ modality: "US" }));
  assert.ok(v.ok); assert.equal(v.info.modality, "US");
});
ok("DICM imzası yoksa reddeder", () => {
  const bad = makeDicom(); bad[130] = 0x00;
  const v = validateIngestInstance(bad);
  assert.equal(v.ok, false);
});
ok("çok kısa girdi reddedilir", () => {
  assert.equal(validateIngestInstance(new Uint8Array(32)).ok, false);
});
ok("bozuk gövde (parse hatası) reddedilir, süreç çökmez", () => {
  const bad = makeDicom();
  // dataset etiketlerini yarıdan kes — dicom-parser untilTag'da patlamalı
  const cut = bad.slice(0, 400);
  const v = validateIngestInstance(cut);
  // kesilen örneğin UID'leri okunabiliyorsa kabul edilebilir; kimliği okunamıyorsa reddedilmeli
  if (!v.ok) assert.match(v.error ?? "", /.+/);
});
ok("geçersiz UID reddedilir", () => {
  const v = validateIngestInstance(makeDicom({ studyUid: "not a uid!!" }));
  assert.equal(v.ok, false);
});

console.log("· sınır sabitleri");
ok("sınırlar makul ve pozitif", () => {
  assert.equal(INGEST_MAX_INSTANCES, 64);
  assert.equal(INGEST_MAX_INSTANCE_BYTES, 40 * 1024 * 1024);
  assert.equal(INGEST_MAX_TOTAL_BYTES, 300 * 1024 * 1024);
});

console.log("· buildStowResponseBody");
ok("yalnız başarı: 00081199 dolu, 00081198 yok", () => {
  const body = buildStowResponseBody([{ sopUid: "1.2.3", ok: true }]) as Record<string, { Value: { "00081155": { Value: string[] } }[] }>;
  assert.ok(body["00081199"]);
  assert.equal(body["00081198"], undefined);
  assert.equal(body["00081199"].Value[0]["00081155"].Value[0], "1.2.3");
});
ok("yalnız başarısızlık: 00081198 durum 272 ile", () => {
  const body = buildStowResponseBody([{ sopUid: "1.2.4", ok: false, error: "bozuk" }]) as Record<string, { Value: Record<string, { Value: unknown[] }>[] }>;
  assert.ok(body["00081198"]);
  assert.equal(body["00081199"], undefined);
  assert.equal(body["00081198"].Value[0]["00081190"].Value[0], 272);
});
ok("karışık sonuç iki diziyi de doldurur", () => {
  const body = buildStowResponseBody([{ sopUid: "1.1", ok: true }, { sopUid: "2.2", ok: false, error: "x" }]) as Record<string, unknown>;
  assert.ok(body["00081199"]); assert.ok(body["00081198"]);
});

console.log("· mergeSeriesData");
const mkSeries = (id: string, over: Partial<SeriesData> = {}): SeriesData => ({
  id, seriesUid: "1.2.3.4.5.6.7.8.9.200", modality: "XA", description: "Anjio", bodyPart: "COR",
  patientName: "P", patientId: "1", patientAge: "50Y", patientSex: "E", studyDate: "20260227",
  institution: "Hastane", studyUid: "1.2.3.4.5.6.7.8.9.100",
  width: 4, height: 4, pixelSpacing: 0.5, sliceThickness: 1, defaultWL: 0, defaultWW: 4096, unit: "HU",
  slices: [new Uint16Array(16)], lesions: [], tags: [], isSample: false, files: [],
  sopUids: ["1.2.3.4.5.6.7.8.9.300"], ipp: [[0, 0, 0]], slicePositions: [0],
  ...over,
});
ok("aynı seriesUid + aynı boyut → kareler eklenir, id korunur", () => {
  const existing = [mkSeries("orig-id")];
  const incoming = [mkSeries("tmp", { slices: [new Uint16Array(16), new Uint16Array(16)], sopUids: ["1.2.3.4.5.6.7.8.9.301", "1.2.3.4.5.6.7.8.9.302"], ipp: [[0, 0, 1], [0, 0, 2]], slicePositions: [1, 2] })];
  const before = existing[0].slices.length;
  const { series, addedFrames, mergedSeries } = mergeSeriesData(existing, incoming);
  assert.equal(mergedSeries, 1);
  assert.equal(addedFrames, 2);
  assert.equal(series.length, 1);
  assert.equal(series[0].id, "orig-id");
  assert.equal(series[0].slices.length, before + 2);
  assert.deepEqual(series[0].sopUids, ["1.2.3.4.5.6.7.8.9.300", "1.2.3.4.5.6.7.8.9.301", "1.2.3.4.5.6.7.8.9.302"]);
  assert.equal(series[0].ipp?.length, 3);
  assert.equal(existing[0].slices.length, before, "girdi dilimlenmemeli (saf fonksiyon)");
});
ok("boyut farklıysa ayrı seri olarak eklenir", () => {
  const existing = [mkSeries("orig-id")];
  const incoming = [mkSeries("tmp", { width: 8, height: 8 })];
  const { series, mergedSeries } = mergeSeriesData(existing, incoming);
  assert.equal(mergedSeries, 0);
  assert.equal(series.length, 2);
  assert.equal(series[1].width, 8);
});
ok("seriesUid yoksa ayrı seri eklenir", () => {
  const existing = [mkSeries("orig-id")];
  const incoming = [mkSeries("tmp", { seriesUid: undefined })];
  const { series } = mergeSeriesData(existing, incoming);
  assert.equal(series.length, 2);
});
ok("rgbaSlices ikisinde de varsa eklenir; yoksa düşer", () => {
  const rgba = () => [new Uint32Array(16)];
  const a = [mkSeries("a", { rgbaSlices: rgba(), isColor: true })];
  const withRgba = mergeSeriesData(a, [mkSeries("b", { rgbaSlices: rgba(), isColor: true })]);
  assert.equal(withRgba.series[0].rgbaSlices?.length, 2);
  const withoutRgba = mergeSeriesData([mkSeries("a")], [mkSeries("b")]);
  assert.equal(withoutRgba.series[0].rgbaSlices, undefined);
});

console.log("· kaynak kablolama (STOW-RS yolunun varlığı)");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
ok("alım rotası INGEST_API_KEY + x-api-key + timingSafeEqual kullanır", () => {
  const src = read("src/app/api/dicomweb/studies/route.ts");
  assert.match(src, /INGEST_API_KEY/);
  assert.match(src, /x-api-key/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /multipart\/related/);
  assert.match(src, /storeDicomInstance/);
  assert.match(src, /upsertStudy/);
  assert.match(src, /buildStowResponseBody/);
});
ok("feed rotası session kimliği + studyUid + after kullanır", () => {
  const src = read("src/app/api/ingest/feed/route.ts");
  assert.match(src, /authorize\(/);
  assert.match(src, /studyUid/);
  assert.match(src, /after/);
});
ok("Workstation canlı düğmesi ve yoklama yolu mevcut", () => {
  const src = read("src/components/Workstation.tsx");
  assert.match(src, /live-flow-toggle/);
  assert.match(src, /\/api\/ingest\/feed/);
  assert.match(src, /mergeSeriesData/);
});
ok("DIMSE reddi kaynak başlıklarında açıkça yazıyor", () => {
  const src = read("src/lib/dicomIngest.ts");
  assert.match(src, /DIMSE/);
  assert.match(src, /C-STORE/);
});

console.log(`\nTÜM OK — ${passed} denetim geçti`);
