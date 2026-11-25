/**
 * Gerçek PACS (Orthanc) ile uçtan uca DICOMweb testi.
 *
 * Çalıştırma (CI veya yerel):
 *   ORTHANC_URL=http://localhost:8042 ORTHANC_USER=orthanc ORTHANC_PASS=orthanc \
 *     npx tsx tests/pacs.orthanc.e2e.ts
 *
 * ORTHANC_URL tanımlı değilse test ATLANIR (boş CI'da hata vermez).
 *
 * Senaryo: minimal geçerli bir DICOM yarat → STOW-RS ile yükle → QIDO-RS ile
 * ara/bul → WADO-RS ile geri al → temizlik için sil. Böylece okuma VE yazma
 * yönü de gerçek bir PACS üzerinde doğrulanır.
 */
import { randomInt } from "node:crypto";
import * as dicomParser from "dicom-parser";
import { parseMultipartRelated } from "../src/lib/server/pacs";

const BASE = (process.env.ORTHANC_URL ?? "").replace(/\/$/, "");
const USER = process.env.ORTHANC_USER ?? "orthanc";
const PASS = process.env.ORTHANC_PASS ?? "orthanc";

if (!BASE) {
  console.log("ATLANDI: ORTHANC_URL tanımlı değil — gerçek PACS e2e testi çalıştırılmadı.");
  process.exit(0);
}

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const uid = (root: string) => `${root}.${randomInt(0, 1_000_000)}.${Date.now()}`;

// ───────── Minimal Explicit VR Little Endian DICOM üreteci ─────────

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

function minimalDicom(meta: { patientId: string; patientName: string; studyUid: string; seriesUid: string; sopUid: string }): Uint8Array {
  const sopClass = "1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture Image Storage
  const parts: Uint8Array[] = [];

  // Preamble + DICM
  parts.push(new Uint8Array(128), strVal("DICM"));

  // Dosya meta grubu (0002)
  const metaElems: Uint8Array[] = [
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0002, "UI", uiVal(sopClass)),
    element(0x0002, 0x0003, "UI", uiVal(meta.sopUid)),
    element(0x0002, 0x0010, "UI", uiVal("1.2.840.10008.1.2.1")),
    element(0x0002, 0x0012, "UI", uiVal("1.2.3.4.5.6.7.8.9")),
    element(0x0002, 0x0013, "SH", strVal("ARENA-E2E")),
  ];
  const metaLen = metaElems.reduce((n, e) => n + e.length, 0);
  parts.push(element(0x0002, 0x0000, "UL", new Uint8Array(4)));
  // grup uzunluğu elemanını doğru değerle yeniden yaz
  {
    const dv = new DataView(parts[parts.length - 1].buffer);
    dv.setUint32(8, metaLen, true);
  }
  parts.push(...metaElems);

  // Veri kümesi
  const px = new Uint8Array(32);
  const dvpx = new DataView(px.buffer);
  for (let i = 0; i < px.length / 2; i++) dvpx.setUint16(i * 2, 16 + i, true);
  parts.push(
    element(0x0008, 0x0016, "UI", uiVal(sopClass)),
    element(0x0008, 0x0018, "UI", uiVal(meta.sopUid)),
    element(0x0008, 0x0020, "DA", strVal("20260101")),
    element(0x0008, 0x0030, "TM", strVal("120000")),
    element(0x0008, 0x0060, "CS", strVal("OT")),
    element(0x0010, 0x0010, "PN", strVal(meta.patientName)),
    element(0x0010, 0x0020, "LO", strVal(meta.patientId)),
    element(0x0020, 0x000d, "UI", uiVal(meta.studyUid)),
    element(0x0020, 0x000e, "UI", uiVal(meta.seriesUid)),
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

// ───────── HTTP yardımcıları ─────────

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: auth, ...(init.headers as Record<string, string> | undefined) },
  });
}

const jget = async (path: string) => (await req(path)).json() as Promise<unknown>;

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

async function main() {
  const root = "1.2.826.0.1.3680043.8.498.";
  const patientId = `ARENA-${Date.now()}`;
  const studyUid = uid(root);
  const seriesUid = uid(root);
  const sopUid = uid(root);
  const dcm = minimalDicom({ patientId, patientName: "E2E^PACIENT", studyUid, seriesUid, sopUid });

  ok(dcm.slice(128, 132).every((b, i) => b === "DICM".charCodeAt(i)), "minimal DICOM: DICM imzası var");
  const parsed = dicomParser.parseDicom(dcm);
  ok(parsed.string("x0020000d") === studyUid && parsed.string("x0020000e") === seriesUid && parsed.string("x00080018") === sopUid, "minimal DICOM: UID alanları okunabilir");

  // 1) STOW-RS: tek part'lı multipart gövde
  const boundary = `arena-${Date.now()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const stowResp = await req("/dicom-web/studies", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` },
    body: Buffer.concat([head, Buffer.from(dcm), tail]),
  });
  if (!stowResp.ok) console.error(`STOW yanıtı: ${(await stowResp.text()).slice(0, 1000)}`);
  ok(stowResp.ok, `STOW-RS: örnek çalışma yüklendi (${stowResp.status})`);

  // 2) QIDO-RS: çalışmayı hasta kimliğiyle bul
  const studies = (await jget(`/dicom-web/studies?PatientID=${patientId}&includefield=all`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(studies) && studies.length >= 1, `QIDO-RS: yüklenen çalışma bulundu (${studies.length} sonuç)`);

  // 3) Seri ve instance listesi
  const series = (await jget(`/dicom-web/studies/${studyUid}/series`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(series) && series.length >= 1, "QIDO-RS: seri listesi alındı");
  const instances = (await jget(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances`)) as Array<Record<string, unknown>>;
  ok(Array.isArray(instances) && instances.length >= 1, "QIDO-RS: instance listesi alındı");

  // 4) WADO-RS: instance'ı geri al ve DICM imzasını doğrula
  const wado = await req(`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`, {
    headers: { Accept: 'multipart/related; type="application/dicom"' },
  });
  if (wado.ok) {
    const body = new Uint8Array(await wado.arrayBuffer());
    const dicom = parseMultipartRelated(body, wado.headers.get("content-type") ?? "");
    ok(!!dicom && dicom.length > 132 && dicom.slice(128, 132).every((b, i) => b === "DICM".charCodeAt(i)), `WADO-RS: DICOM instance geri alındı (${dicom?.length ?? 0} bayt)`);
  } else {
    ok(false, `WADO-RS: instance alınamadı (${wado.status})`);
  }

  // 5) Temizlik
  const lookup = await req("/tools/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
  });
  if (lookup.ok) {
    const studyIds = await lookup.json() as string[];
    const deleted = await Promise.all(studyIds.map((id) => req(`/studies/${id}`, { method: "DELETE" })));
    const remaining = await req("/tools/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Level: "Study", Query: { StudyInstanceUID: studyUid } }),
    });
    const remainingIds = remaining.ok ? await remaining.json() as string[] : [studyUid];
    ok(deleted.every((response) => response.ok) && remainingIds.length === 0, "Temizlik: çalışma silindi");
  } else {
    ok(false, `Temizlik: Orthanc çalışma kimliği bulunamadı (${lookup.status})`);
  }

  if (failed) { console.error(`${failed} Orthanc e2e adımı başarısız`); process.exit(1); }
  console.log("Tüm Orthanc uçtan uca testleri geçti.");
}

main().catch((e) => { console.error("Orthanc e2e hatası:", e instanceof Error ? e.message : e); process.exit(1); });
