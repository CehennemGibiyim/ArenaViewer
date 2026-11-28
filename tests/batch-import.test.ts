/** f-batch: toplu içe aktarma kuyruğu sözleşmesi — saf karar + gerçek DICOM baytları. */
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import {
  applyBatchItemOutcome,
  batchErrorReportCsv,
  batchProgressSummary,
  buildBatchErrorReport,
  batchRetryDelayMs,
  classifyBatchError,
  dueForBatchRetry,
  isRetryableBatchError,
  MAX_BATCH_ATTEMPTS,
  planBatchImport,
  planNextBatchRound,
  publicBatchItem,
  type BatchItemView,
} from "../src/lib/batchImport";
import { inspectDicom, loadManifest, processBatchItem } from "../scripts/batch-worker";
import { concat, el, str, uidEl } from "../src/lib/dicomWrite";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

async function main(): Promise<void> {
const mk = (over: Partial<BatchItemView> = {}): BatchItemView => ({
  id: 1, name: "f.dcm", size: 1024, sha256: "a".repeat(64), studyUid: "1.2.3", modality: "CT",
  status: "pending", attempts: 0, lastError: "", lastAttemptAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

// ── 1. Hata sınıflandırma (gerçek hata metinleri) ──
{
  ok(classifyBatchError("DICOM parse hatası: enough data") === "invalid", "parse hatası → invalid");
  ok(classifyBatchError("DICOM dosyasında Study InstanceUID yok") === "invalid", "UID yok → invalid");
  ok(classifyBatchError("PACS reddetti (0008,1198) Failure Reason 272") === "rejected", "içerik reddi → rejected");
  ok(classifyBatchError("HTTP 500 (500) Internal Server Error") === "network", "5xx → network");
  ok(classifyBatchError("zaman aşımı: ETIMEDOUT") === "network", "timeout → network");
  ok(classifyBatchError("HTTP 429 (429) Too Many Requests") === "network", "429 → network");
  ok(classifyBatchError("esnet") === "unknown", "garip hata → unknown");
  ok(isRetryableBatchError("HTTP 500 (500)") === true, "5xx yeniden denenir");
  ok(isRetryableBatchError("HTTP 408 (408)") === true, "408 yeniden denenir");
  ok(isRetryableBatchError("HTTP 400 (400)") === false, "400 yeniden denemEZ");
  ok(isRetryableBatchError("PACS reddetti (0008,1198)") === false, "içerik reddi yeniden denemEZ");
  ok(isRetryableBatchError("DICOM parse hatası") === false, "parse hatası yeniden denemEZ");
  ok(isRetryableBatchError("HTTP 401 (401)") === false, "401 yeniden denemEZ");
}

// ── 2. Backoff + deneme politikası ──
{
  ok(batchRetryDelayMs(0) === 20_000, "ilk backoff 20 sn");
  ok(batchRetryDelayMs(1) === 40_000, "2. backoff 40 sn");
  ok(batchRetryDelayMs(5) === 600_000, "10 dk'da doygunlaşır");
  ok(dueForBatchRetry({ attempts: 0 }, null) === true, "denemeyen öge hemen sıraya girer");
  ok(dueForBatchRetry({ attempts: MAX_BATCH_ATTEMPTS }, null) === false, "vazgeçilen öge tekrar girmez");
  ok(dueForBatchRetry({ attempts: 1 }, new Date()) === false, "backoff süresi gelmez");
  ok(dueForBatchRetry({ attempts: 1 }, new Date(Date.now() - 41_000)) === true, "süre dolunca deneme planlanır");
}

// ── 3. planBatchImport dedupe + sınır ──
{
  const items = [
    { name: "a.dcm", size: 1, sha256: "s1" },
    { name: "a.dcm", size: 1, sha256: "s1" },
    { name: "b.dcm", size: 2, sha256: "s2" },
    { name: "a.dcm", size: 9, sha256: "s9" },
  ];
  const r = planBatchImport(items as never);
  ok(r.accepted.length === 3, `dedupe sonrası ${r.accepted.length} öge`);
  ok(r.skippedDuplicates.length === 1 && r.skippedDuplicates[0] === "a.dcm", "yineleyen öge atlandı");
  const lim = planBatchImport(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.dcm`, size: 1 })), { maxItems: 4 });
  ok(lim.accepted.length === 4, "sınır 4 ögeden sonra kesilir");
}

// ── 4. Durum değişikliği + tur planlama ──
{
  const done = applyBatchItemOutcome(mk(), "done");
  ok(done.status === "done" && done.attempts === 1 && done.lastError === "", "done → attempts artar, hata temizlenir");
  const failed = applyBatchItemOutcome(mk(), "failed", new Date(), "500");
  ok(failed.status === "failed" && failed.attempts === 1 && failed.lastError === "500", "failed → hata kaydedilir");

  const items = [
    mk({ id: 1, status: "pending" }),
    mk({ id: 2, status: "pending" }),
    mk({ id: 3, status: "failed", attempts: 1, lastError: "HTTP 500 (500)", lastAttemptAt: new Date(Date.now() - 60_000) }),
    mk({ id: 4, status: "failed", attempts: 1, lastError: "HTTP 400 (400)" }),
    mk({ id: 5, status: "done" }),
  ];
  const round = planNextBatchRound(items, { now: Date.now() });
  const ids = round.map((i) => i.id).sort((a, b) => a - b);
  ok(ids.join(",") === "1,2,3", `tur ögeleri ${ids.join(",")} (due failed önce, kalıcı failed atlanır)`);
  ok(round.every((i) => i.status === "processing"), "tur ögeleri processing olarak işaretlenir");
}

// ── 5. İlerleme + hata raporu ──
{
  const items = [
    mk({ id: 1, status: "done" }),
    mk({ id: 2, status: "done" }),
    mk({ id: 3, status: "failed", lastError: "HTTP 500 (500) Internal Server Error" }),
    mk({ id: 4, status: "failed", lastError: "DICOM parse hatası" }),
    mk({ id: 5, status: "pending" }),
  ];
  const s = batchProgressSummary(items);
  ok(s.total === 5 && s.done === 2 && s.failed === 2 && s.pending === 1, `özet ${s.done} done / ${s.failed} failed / ${s.pending} pending`);
  ok(s.percent === 80, `ilerleme %${s.percent}`);
  ok(s.errorGroups === 2, "2 hata grubu");
  const report = buildBatchErrorReport(items);
  ok(report.find((g) => g.kind === "invalid")?.count === 1, "invalid grubu 1 öge");
  ok(report.find((g) => g.kind === "network")?.files[0] === "f.dcm", "network grubu dosya adını taşır");
  const csv = batchErrorReportCsv(items);
  ok(csv.startsWith("hata_turu;sayı;dosyalar") && csv.includes("Ağ/zaman aşımı"), "CSV raporu başlık + grup");
  const pub = publicBatchItem(items[2]);
  ok(!("payloadCipher" in pub) && "createdAt" in pub, "görüntü payload sızdırmaz + createdAt içerir");
  ok(pub.exhausted === false && publicBatchItem(mk({ attempts: MAX_BATCH_ATTEMPTS })).exhausted === true, "deneme sınırı görünür");
}

// ── 6. Gerçek DICOM baytları + inspectDicom + processBatchItem ──
{
  // dicomWrite ile üretilen geçerli Explicit VR LE DICOM (meta + gövde).
  const body = concat([
    str(0x0008, 0x0060, "CS", "CT"),
    uidEl(0x0008, 0x0018, "1.2.840.113619.2.55.3.604688.1"),
    str(0x0010, 0x0010, "PN", "YILMAZ^AYSE"),
    str(0x0010, 0x0020, "LO", "MRK-77"),
    uidEl(0x0020, 0x000d, "1.2.840.113619.2.55.3.604688.1"),
  ]);
  const meta = concat([
    uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"),
    uidEl(0x0002, 0x0012, "1.2.840.113619.2.55.3"),
  ]);
  const glen = new Uint8Array(4);
  new DataView(glen.buffer).setUint32(0, meta.length, true);
  const bytes = concat([new Uint8Array(128), new TextEncoder().encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body]);
  const v = inspectDicom(bytes);
  ok(v.ok === true, "gerçek DICOM parse edilir");
  ok(v.ok && v.studyUid === "1.2.840.113619.2.55.3.604688.1", `Study UID ${v.ok ? v.studyUid : ""}`);
  ok(v.ok && v.modality === "CT", "modalite CT");
  ok(v.ok && v.patientName === "YILMAZ^AYSE", "hasta adı taşınır");

  const bad = inspectDicom(new Uint8Array(Buffer.from("DICM")));
  ok(bad.ok === false, "DICM dışındaki bayt parse hatası verir");

  const item = mk({ size: bytes.byteLength });
  ok((await processBatchItem(item, bytes)) === "done", "doğru DICOM ögesi done olur");
  const wrongSize = mk({ size: bytes.byteLength + 5 });
  ok((await processBatchItem(wrongSize, bytes)) === "failed", "boyut uyuşmazlığı failed");
  const badItem = mk({ size: 3 });
  ok((await processBatchItem(badItem, new Uint8Array(Buffer.from("DICM")))) === "failed", "geçersiz DICOM failed (yeniden denemEZ)");
}

// ── 7. Manifest yükleme + manifest → öge meta verileri ──
{
  const tmp = mkdtempSync(path.join(tmpdir(), "atik-batch-"));
  try {
    const manifestPath = path.join(tmp, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ batchId: "b-77", items: [{ name: "a.dcm", size: 10 }, { name: "b.dcm", size: 20 }] }));
    const m = loadManifest(manifestPath);
    ok(m.batchId === "b-77" && m.items.length === 2, "manifest batchId + öge sayısı");
    // sha256 hesaplama: geçerli dosyadan
    const goodPath = path.join(tmp, "good.dcm");
    const body = concat([
      str(0x0008, 0x0060, "CS", "CT"),
      uidEl(0x0020, 0x000d, "1.2.840.113619.2.55.3.604688.1"),
    ]);
    const meta = concat([uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1")]);
    const glen = new Uint8Array(4);
    new DataView(glen.buffer).setUint32(0, meta.length, true);
    writeFileSync(goodPath, Buffer.from(concat([new Uint8Array(128), new TextEncoder().encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body])));
    const m2 = loadManifest(manifestPath);
    ok(m2.items[0].name === "a.dcm", "manifest ögesi ismi taşınır");
    // bozuk manifest reddedilir
    writeFileSync(path.join(tmp, "bad.json"), "{ nope");
    let threw = false;
    try { loadManifest(path.join(tmp, "bad.json")); } catch { threw = true; }
    ok(threw, "bozuk manifest JSON hata fırlatır");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

}

void main().then(() => {
  console.log(`\nbatch-import: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
});
