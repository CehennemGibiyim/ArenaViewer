/**
 * Onayda TID 1500 ölçüm SR'ının PACS'e otomatik gönderimi — sözleşme testleri.
 * Uç (route) DB gerektirdiği için tam istek testi yerine:
 *   1) doğrulama kapısı (measureSr) gerçek SR'lar üzerinde,
 *   2) STOW istemcisi gerçek ağ ile (mock PACS),
 *   3) uç kaynak denetimi (kapılar, audit, sınırlar)
 * birlikte doğrulanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import * as dicomParser from "dicom-parser";
import { buildMeasurementReportSr, SOP_COMPREHENSIVE_SR, QUANTITY, SITES, atikCode } from "../src/lib/sr1500";
import { buildReportSr } from "../src/lib/dicomSr";
import { validateMeasurementSrBytes } from "../src/lib/measureSr";
import { stowInstance } from "../src/lib/server/pacs";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";

const ms = [
  {
    trackingId: "NOD-1", value: 8.4, unit: "mm", quantity: QUANTITY.length,
    finding: atikCode("NODULE", "Nodül"), site: SITES.akciger,
    image: { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUid: "1.2.3.4.1.9" },
  },
  { trackingId: "HU-1", value: -45, unit: "hu", quantity: QUANTITY.mean, finding: atikCode("DENSITY", "Dansite") },
];
const tidSr = buildMeasurementReportSr({
  patientName: "Test^Hasta", patientId: "PID", patientSex: "K",
  studyUid: "1.2.840.113619.2.9.9", studyDate: "2026-11-20", institution: "TEST",
  title: "Toraks BT ölçümleri", measurements: ms,
  approvedBy: "Dr Test", doctorTitle: "Uz.", approvedAt: "2026-11-20T10:15:00.000Z",
});

// ── 1) doğrulama kapısı ──
const good = validateMeasurementSrBytes(tidSr);
assert.ok(good.ok && good.sopClass === SOP_COMPREHENSIVE_SR, "TID 1500 SR kapıdan geçer");
console.log("PASS geçerli TID 1500 SR kabul");

const basicSr = buildReportSr({
  patientName: "T", patientId: "P", patientSex: "K", patientAge: "45Y",
  studyUid: "1.2.3.4", studyDate: "20260110", institution: "T", studyModality: "CT",
  clinicalInfo: "", technique: "", findings: "", impression: "", recommendation: "", measurements: "",
  approvedBy: "Dr", doctorTitle: "", approvedAt: "2026-01-10T12:00:00Z",
});
const bad = validateMeasurementSrBytes(basicSr);
assert.ok(!bad.ok && bad.sopClass !== SOP_COMPREHENSIVE_SR, "Basic Text SR reddedilir (yalnız Comprehensive SR)");
console.log("PASS Basic Text SR kapıda reddedilir");

assert.equal(validateMeasurementSrBytes(new Uint8Array(10)).ok, false, "çok küçük nesne reddedilir");
const noMagic = new Uint8Array(tidSr);
noMagic[128] = 0;
assert.equal(validateMeasurementSrBytes(noMagic).ok, false, "DICM imzası yoksa reddedilir");
assert.equal(validateMeasurementSrBytes(new Uint8Array(0)).ok, false, "boş nesne reddedilir");
console.log("PASS bozuk/eksik nesneler reddedilir");

// ── 2) STOW istemcisi gerçek ağ (mock PACS kabul eder) ──
const uid = dicomParser.parseDicom(tidSr, { untilTag: "x00080018" }).string("x00080018")!;
const sq = (u: string) => ({ vr: "SQ", Value: [{ "00081155": { vr: "UI", Value: [u] } }] });
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/dicom+json" });
    res.end(JSON.stringify({ "00081199": sq(uid) }));
  });
});
async function main(): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const cfg = { ...DEFAULT_PACS, qidoRoot: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/dicom-web` };
  try {
    const out = await stowInstance(cfg, tidSr);
    assert.equal(out.stored, 1, "TID 1500 SR mock PACS tarafından kabul edilmeli");
    console.log("PASS STOW: TID 1500 SR kabul (ulusal uç sözleşme testi)");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

// ── 3) uç kaynak sözleşme denetimi ──
const route = fs.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/stow/route.ts"), "utf8");
for (const marker of [
  'kind === "sr1500"',
  "stowMeasurementSr",
  "validateMeasurementSrBytes",
  "pacs.send_sr1500",
  "Yalnızca onaylanmış raporun ölçüm SR'ı PACS'e gönderilebilir",
  "40_000_000",
  "b.instances.slice(0, 4)",
]) {
  assert.ok(route.includes(marker), `rota "${marker}" içermeli`);
}
const modal = fs.readFileSync(path.join(__dirname, "..", "src/components/ReportPrintModal.tsx"), "utf8");
for (const marker of ["srAutoSend", "Ölçümleri TID 1500 SR olarak PACS", "sendMeasurementSr"]) {
  assert.ok(modal.includes(marker), `onay penceresi "${marker}" içermeli`);
}
const workstation = fs.readFileSync(path.join(__dirname, "..", "src/components/Workstation.tsx"), "utf8");
for (const marker of ["opts?.sendMeasurementSr", "buildMeasurementReportSr", 'kind: "sr1500"', "/api/pacs/stow"]) {
  assert.ok(workstation.includes(marker), `Workstation "${marker}" içermeli`);
}
assert.ok(workstation.includes("annotationsToMeasurements"), "Workstation ölçümleri TID 1500'e çeviriyor");
console.log("PASS uç + onay penceresi + Workstation sözleşme denetimi");
main().then(() => console.log("Tüm sr1500-send testleri geçti.")).catch((e) => { console.error(e); process.exitCode = 1; });
