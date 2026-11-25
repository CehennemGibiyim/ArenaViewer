import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { buildReportSr } from "../src/lib/dicomSr";
import { stowInstance } from "../src/lib/server/pacs";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";
import * as dicomParser from "dicom-parser";

const sr = buildReportSr({ patientName: "Test^Hasta", patientId: "PID", patientSex: "F", patientAge: "45Y", studyUid: "1.2.3.4", studyDate: "20260110", institution: "TEST", studyModality: "CT", clinicalInfo: "", technique: "", findings: "", impression: "", recommendation: "", measurements: "", approvedBy: "Test", doctorTitle: "", approvedAt: "2026-01-10T12:00:00Z" });
const uid = dicomParser.parseDicom(sr).string("x00080018")!;
const sq = (u: string) => ({ vr: "SQ", Value: [{ "00081155": { vr: "UI", Value: [u] } }] });
async function main() {
  let status = 200;
  let body = JSON.stringify({ "00081199": sq(uid) });
  let called = 0;
  const server = http.createServer((req, res) => {
    called++;
    assert.equal(req.method, "POST");
    assert.match(req.headers["content-type"] || "", /^multipart\/related/);
    req.resume();
    req.on("end", () => { res.writeHead(status, { "Content-Type": "application/dicom+json" }); res.end(body); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Sunucu adresi yok");
  const cfg = { ...DEFAULT_PACS, qidoRoot: `http://127.0.0.1:${address.port}/dicom-web` };
  try {
    assert.equal((await stowInstance(cfg, sr)).stored, 1);
    body = JSON.stringify({ "00081198": sq(uid) }); status = 202;
    await assert.rejects(stowInstance(cfg, sr), /reddetti/);
    body = JSON.stringify({ "00081199": sq("1.2.999") }); status = 200;
    await assert.rejects(stowInstance(cfg, sr), /doğrulanamadı/);
    body = "";
    await assert.rejects(stowInstance(cfg, sr), /doğrulanamadı/);
    status = 401;
    await assert.rejects(stowInstance(cfg, sr), /401/);
    const previous = called;
    await assert.rejects(stowInstance(cfg, new Uint8Array([1, 2, 3])), /UID okunamadı/);
    assert.equal(called, previous, "geçersiz DICOM gönderilmemeli");
    console.log("PASS STOW gerçek HTTP istemcisi: kabul, red, yanlış UID, belirsiz sonuç ve hatalar");
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
