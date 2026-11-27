/**
 * Seg-stow-return (Faz A0.3) — STOW yeniden deneme kuyruğu sözleşmesi.
 * Uç / DB gerektiren kısımlar için uç kaynak denetimi + mock PACS üzerinden
 * gerçek gönderim denemesi yapılır; kuyruk mantığı saf yardımcılarla doğrulanır.
 * Hasta kimliği içeren baytların DB'ye yalnız şifreli yazıldığı, listeleme ucunun
 * payload sızdırmadığı ve içerik reddi (0008,1198) yeniden denenmediği denetlenir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import * as dicomParser from "dicom-parser";

process.env.DATA_ENCRYPTION_KEYS = randomBytes(32).toString("base64");
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/app_db";

import { buildSegDocument, SOP_SEG } from "../src/lib/dicomSeg";
import { emptyMask, makeSegmentDef, paint } from "../src/lib/segmentation";
import { encryptText, isEncrypted } from "../src/lib/server/crypto";
import { attemptQueuedSend } from "../src/lib/server/stowQueueRepo";
import { stowRetryDelayMs, dueForStowRetry, isRetryableStowError, publicRow, MAX_STOW_ATTEMPTS } from "../src/lib/server/stowQueue";
import { DEFAULT_PACS } from "../src/lib/pacsPresets";

const studyUid = "1.2.840.113619.2.55.3.1";
const ms = emptyMask(16, 16); paint(ms, 0, 8, 8, 3);
const segments = [{ def: makeSegmentDef(1, "Test segment", "MANUAL"), mask: ms }];
const segBytes = buildSegDocument({
  patientName: "Test^Hasta", patientId: "PID", patientSex: "K", studyUid, studyDate: "2026-11-20", institution: "TEST",
  source: { seriesUid: "1.2.3.4.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", sopUids: ["1.2.3.4.1.1"] },
  geometry: { pxMm: 0.8, pyMm: 0.8, dz: 1.2, origin: [0, 0, 0] }, width: 16, height: 16, segments,
});
const segSopUid = dicomParser.parseDicom(segBytes, { untilTag: "x00080018" }).string("x00080018")!;

// ── 1) saf yardımcılar ──
assert.equal(stowRetryDelayMs(0), 30_000, "ilk deneme 30 sn sonra");
assert.equal(stowRetryDelayMs(1), 60_000);
assert.equal(stowRetryDelayMs(2), 120_000);
assert.equal(stowRetryDelayMs(20), 3_600_000, "1 saatte doygunlaşır");
console.log("PASS backoff gecikmeleri (30 sn × 2^n, tavan 1 saat)");

assert.equal(dueForStowRetry({ attempts: 0 }, null), true, "hiç denenmemiş satır gönderilir");
assert.equal(dueForStowRetry({ attempts: MAX_STOW_ATTEMPTS }, null), false, "vazgeçilen satır gönderilmez");
assert.equal(dueForStowRetry({ attempts: 1 }, new Date(Date.now())), false, "bekleme süresi gelmeden gönderilmez");
assert.equal(dueForStowRetry({ attempts: 1 }, new Date(Date.now() - 61_000)), true, "süre dolunca denenir");
console.log("PASS yeniden deneme uygunluğu (dueForStowRetry)");

assert.equal(isRetryableStowError("PACS reddetti (0008,1198) SOP ... Failure Reason 272"), false, "içerik reddi yeniden denenmez");
assert.equal(isRetryableStowError("HTTP 409 (409) Conflict"), false, "409 yeniden denenmez");
assert.equal(isRetryableStowError("HTTP 400 (400) Bad Request"), false, "400 yeniden denenmez");
assert.equal(isRetryableStowError("HTTP 401 (401) Unauthorized"), false, "401 yeniden denenmez (yetkisizlik kalıcı)");
assert.equal(isRetryableStowError("HTTP 500 (500) Internal Server Error"), true, "5xx yeniden denenir");
assert.equal(isRetryableStowError("HTTP 408 (408) Request Timeout"), true, "408 yeniden denenir");
assert.equal(isRetryableStowError("HTTP 429 (429) Too Many Requests"), true, "429 yeniden denenir");
assert.equal(isRetryableStowError("ağ hatası: bağlantı reddedildi"), true, "ağ hatası yeniden denenir");
assert.equal(isRetryableStowError("PACS yapılandırılmamış"), true, "yapılandırma eksikliği yeniden denenir");
console.log("PASS yeniden denenebilirlik ayrımı (0008,1198 / 4xx dışı)");

const pub = publicRow({ id: 7, kind: "seg", studyUid, fileName: "s.dcm", attempts: 3, lastError: "503", lastAttemptAt: null, createdAt: new Date(0), owner: "rad1" });
assert.ok(!("payloadCipher" in pub), "liste görünümünde payload YOKTUR");
assert.equal(pub.exhausted, false);
assert.equal(publicRow({ ...pub, attempts: MAX_STOW_ATTEMPTS }).exhausted, true, "deneme sınırı görünür");
console.log("PASS publicRow payload sızdırmaz + deneme sınırı işaretli");

// ── 2) şifreli saklama + mock PACS üzerinden attemptQueuedSend ──
const sq = (...v: unknown[]) => ({ vr: "SQ", Value: v });
const ref = (u: string) => ({ "00081155": { vr: "UI", Value: [u] } });
const cipher = encryptText(Buffer.from(segBytes).toString("base64"));
assert.ok(isEncrypted(cipher), "kuyruk payload'ı AES şifreli olmalı");
assert.ok(!cipher.includes(Buffer.from(segBytes.subarray(0, 64)).toString("base64")), "ham DICOM base64 sızmaz");
console.log("PASS kuyruk payload'ı AES-256-GCM şifreli");

async function withServer(respond: (res: http.ServerResponse) => void, fn: (cfg: typeof DEFAULT_PACS) => Promise<void>) {
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => respond(res)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const cfg = { ...DEFAULT_PACS, qidoRoot: `http://127.0.0.1:${port}/dicom-web` };
  try { await fn(cfg); } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

async function main() {
  await withServer(
    (res) => { res.writeHead(200, { "Content-Type": "application/dicom+json" }); res.end(JSON.stringify({ "00081199": sq(ref(segSopUid)) })); },
    async (cfg) => { await attemptQueuedSend({ kind: "seg", studyUid, payloadCipher: cipher }, cfg); },
  );
  console.log("PASS kuyruk nesnesi PACS kabulünde gönderilir");

  await withServer(
    (res) => { res.writeHead(409, { "Content-Type": "application/dicom+json" }); res.end(JSON.stringify({ "00081198": sq({ ...ref(segSopUid), "00081197": { vr: "US", Value: [272] } }) })); },
    async (cfg) => {
      await assert.rejects(attemptQueuedSend({ kind: "seg", studyUid, payloadCipher: cipher }, cfg), /reddetti/, "içerik reddi hatası yükselir");
    },
  );
  console.log("PASS PACS içerik reddi (0008,1198) hatası çağırana ulaşır");

  await assert.rejects(
    attemptQueuedSend({ kind: "seg", studyUid, payloadCipher: "enc:v1:bozuk" }, DEFAULT_PACS),
    "çözülemeyen kuyruk nesnesi hata fırlatır (çöpe gitmez)",
  );
  console.log("PASS bozuk/şifre-uyumsuz payload hata fırlatır");

  // ── 3) uç ve arayüz kaynak denetimi ──
  const route = fs.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/stow/route.ts"), "utf8");
  for (const marker of ["enqueueStow", "isRetryableStowError", "queued"]) {
    assert.ok(route.includes(marker), `STOW ucu "${marker}" içermeli`);
  }
  const queueRoute = fs.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/stow/queue/route.ts"), "utf8");
  for (const marker of ['action === "flush"', 'action === "discard"', "listStowQueue", "payloadCipher"]) {
    // "payloadCipher" KULLANILMAMALI: liste payload döndürmez
    if (marker === "payloadCipher") assert.ok(!queueRoute.includes(marker), "kuyruk ucu payload adını sızdırmamalı");
    else assert.ok(queueRoute.includes(marker), `kuyruk ucu "${marker}" içermeli`);
  }
  const repo = fs.readFileSync(path.join(__dirname, "..", "src/lib/server/stowQueueRepo.ts"), "utf8");
  for (const marker of ["encryptText", "decryptText", 'CREATE TABLE IF NOT EXISTS stow_queue', "ensureStowQueueTable", "audit(", "dueForStowRetry"]) {
    assert.ok(repo.includes(marker), `kuyruk deposu "${marker}" içermeli`);
  }
  const schema = fs.readFileSync(path.join(__dirname, "..", "src/db/schema.ts"), "utf8");
  assert.ok(schema.includes('"stow_queue"'), "drizzle şemasında stow_queue tablosu tanımlı");
  const menu = fs.readFileSync(path.join(__dirname, "..", "src/components/ExportMenu.tsx"), "utf8");
  assert.ok(menu.includes("Gönderim kuyruğu"), "dışa aktar menüsünde kuyruk düğmesi");
  console.log("PASS uç + kuyruk bileşenleri kaynak denetimi");
  console.log("\nTüm seg-stow-queue (A0.3) sözleşme testleri geçti.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
