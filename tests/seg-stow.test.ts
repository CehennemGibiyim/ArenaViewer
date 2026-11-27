/**
 * SEG / RTSTRUCT STOW-RS geri yazma (seg-stow-return, Faz A0.1) — sözleşme testleri.
 * Uç (route) DB gerektirdiği için tam istek testi yerine:
 *   1) doğrulama kapısı (derivedStow) gerçek SEG/RTSTRUCT belgeleri üzerinde,
 *   2) STOW istemcisi gerçek ağ ile (mock PACS — hem kabul hem 0008,1198 reddi),
 *   3) uç kaynak denetimi (kapılar, audit, sınırlar)
 * birlikte doğrulanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import * as dicomParser from "dicom-parser";
import { buildSegDocument, buildRtStruct, SOP_SEG, SOP_RTSTRUCT } from "../src/lib/dicomSeg";
import { emptyMask, makeSegmentDef, paint } from "../src/lib/segmentation";
import { validateDerivedDicomBytes } from "../src/lib/derivedStow";
import { stowInstance } from "../src/lib/server/pacs";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";

const studyUid = "1.2.840.113619.2.55.3.1";
const src = { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1.1", "1.2.3.4.1.2"] };
const base = {
  patientName: "Test^Hasta", patientId: "PID", patientSex: "K", studyUid, studyDate: "2026-11-20", institution: "TEST",
  source: src, geometry: { pxMm: 0.8, pyMm: 0.8, dz: 1.2, origin: [0, 0, 0] as [number, number, number] },
  width: 16, height: 16,
};
const ms = emptyMask(16, 16); paint(ms, 0, 8, 8, 3);
const segments = [{ def: makeSegmentDef(1, "Test segment", "MANUAL"), mask: ms }];
const segBytes = buildSegDocument({ ...base, segments });
const rtBytes = buildRtStruct({ ...base, rois: segments });

// ── 1) doğrulama kapısı ──
const segCheck = validateDerivedDicomBytes(segBytes, "seg", studyUid);
assert.ok(segCheck.ok && segCheck.sopClass === SOP_SEG, "SEG kapıdan geçer (SOP Class + Study UID)");
console.log("PASS geçerli SEG kabul");
const rtCheck = validateDerivedDicomBytes(rtBytes, "rtstruct", studyUid);
assert.ok(rtCheck.ok && rtCheck.sopClass === SOP_RTSTRUCT, "RTSTRUCT kapıdan geçer");
console.log("PASS geçerli RTSTRUCT kabul");

// Tür eşleşmesi: SEG baytları RTSTRUCT diye sunulamaz, tersi de öyle.
assert.equal(validateDerivedDicomBytes(segBytes, "rtstruct").ok, false, "SEG RTSTRUCT olarak gönderilemez");
assert.equal(validateDerivedDicomBytes(rtBytes, "seg").ok, false, "RTSTRUCT SEG olarak gönderilemez");
console.log("PASS tür eşleşmesi zorunlu");

// Study UID bağlama: başka çalışmaya ait nesnenin geri yazımı reddedilir.
assert.equal(validateDerivedDicomBytes(segBytes, "seg", "1.2.3.999").ok, false, "başka çalışmanın SEG'i reddedilir");
console.log("PASS StudyInstanceUID bağlaması");

// Bozuk/eksik nesneler
assert.equal(validateDerivedDicomBytes(new Uint8Array(0), "seg").ok, false, "boş nesne reddedilir");
assert.equal(validateDerivedDicomBytes(new Uint8Array(10), "seg").ok, false, "çok küçük nesne reddedilir");
const noMagic = new Uint8Array(segBytes);
noMagic[128] = 0;
assert.equal(validateDerivedDicomBytes(noMagic, "seg").ok, false, "DICM imzası yoksa reddedilir");
console.log("PASS bozuk/eksik nesneler reddedilir");

// ── 2) STOW istemcisi gerçek ağ (mock PACS) ──
const segSopUid = dicomParser.parseDicom(segBytes, { untilTag: "x00080018" }).string("x00080018")!;
const ref = (u: string) => ({ "00081155": { vr: "UI", Value: [u] } });
const sq = (...v: unknown[]) => ({ vr: "SQ", Value: v });

// 2a) kabul yanıtı
const acceptServer = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/dicom+json" });
    res.end(JSON.stringify({ "00081199": sq(ref(segSopUid)) }));
  });
});

// 2b) ret yanıtı: FailedSOPSequence + Failure Reason (A0.3 detay görünürlüğü)
const refuseServer = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(409, { "Content-Type": "application/dicom+json" });
    res.end(JSON.stringify({ "00081198": sq({ ...ref(segSopUid), "00081197": { vr: "US", Value: [272] } }) }));
  });
});

async function withServer(server: http.Server, fn: (cfg: typeof DEFAULT_PACS) => Promise<void>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const cfg = { ...DEFAULT_PACS, qidoRoot: `http://127.0.0.1:${port}/dicom-web` };
  try {
    await fn(cfg);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

async function main(): Promise<void> {
  await withServer(acceptServer, async (cfg) => {
    const out = await stowInstance(cfg, segBytes);
    assert.equal(out.stored, 1, "SEG mock PACS tarafından kabul edilmeli");
    console.log("PASS STOW: SEG kabul (sözleşme testi)");
  });
  await withServer(refuseServer, async (cfg) => {
    await assert.rejects(stowInstance(cfg, segBytes), (e: Error) => {
      assert.match(e.message, /reddetti/, "red hatası mesajı korunur");
      assert.match(e.message, /272/, "Failure Reason (0008,1197) kullanıcıya görünür");
      assert.match(e.message, new RegExp(segSopUid.replace(/\./g, "\\.")), "reddedilen nesnenin SOP Instance UID'si görünür");
      return true;
    });
    console.log("PASS STOW: ret detayı (SOP UID + Failure Reason) kullanıcıya görünür");
  });

  // ── 3) uç kaynak denetimi ──
  const route = fs.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/stow/route.ts"), "utf8");
  for (const marker of [
    'body.kind === "seg" || body.kind === "rtstruct"',
    "stowDerived",
    "validateDerivedDicomBytes",
    "pacs.send_seg",
    "pacs.send_rtstruct",
    "40_000_000",
    "isUid(studyUid)",
    "b.instances.slice(0, 4)",
  ]) {
    assert.ok(route.includes(marker), `rota "${marker}" içermeli`);
  }
  for (const marker of ["SEG → PACS", "RTSTRUCT → PACS"]) {
    for (const file of ["src/components/ExportMenu.tsx", "src/components/SegEditor.tsx", "src/components/KneeSegPanel.tsx"]) {
      const srcText = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.ok(srcText.includes(marker), `${file} "${marker}" içermeli`);
    }
  }
  console.log("PASS uç + üç arayüz sözleşme denetimi");
  console.log("Tüm seg-stow testleri geçti.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
