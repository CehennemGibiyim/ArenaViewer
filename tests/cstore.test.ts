/** e-stow: C-STORE (DIMSE) kuyruğu sözleşmesi — saf karar + gerçek DICOM baytları. */
import { randomBytes, createHash } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import {
  applyCstoreOutcome,
  applyCstoreReport,
  buildCstoreErrorReport,
  classifyCstoreStatus,
  cstoreDedupeKey,
  cstoreProgressSummary,
  cstoreRetryDelayMs,
  cstoreStatusLabel,
  CSTORE_STATUS,
  dueForCstoreRetry,
  isRetryableCstoreError,
  MAX_CSTORE_ATTEMPTS,
  planCstoreQueue,
  planNextCstoreRound,
  publicCstoreItem,
  validateCstoreInstance,
  validateCstoreRequest,
  type CstoreItemView,
} from "../src/lib/cstore";
import { buildEnqueueBody, loadManifest, parseCstoreScuOutput } from "../scripts/cstore-bridge";
import { concat, el, str, uidEl } from "../src/lib/dicomWrite";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const mk = (over: Partial<CstoreItemView> = {}): CstoreItemView => ({
  id: 1, name: "f.dcm", sopUid: "1.2.840.10008.5.1.4.1.1.1.1.1", studyUid: "1.2.3",
  status: "pending", statusCode: 0, attempts: 0, lastError: "", lastAttemptAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

// ── 1. DIMSE durum kodu sınıflandırma ──
{
  ok(classifyCstoreStatus(CSTORE_STATUS.SUCCESS) === "success", "0x0000 → success");
  ok(classifyCstoreStatus(CSTORE_STATUS.SUBOPS_COMPLETE) === "success", "0x0210 → success");
  ok(classifyCstoreStatus(CSTORE_STATUS.SUBOPS_COMPLETE_WARNING) === "success", "0x0211 → success (uyarı)");
  ok(classifyCstoreStatus(CSTORE_STATUS.NO_MATCHING_SOP) === "content-rejected", "0x0101 → içerik reddi");
  ok(classifyCstoreStatus(CSTORE_STATUS.ATTRIBUTE_ERROR) === "content-rejected", "0x0801 → içerik reddi");
  ok(classifyCstoreStatus(CSTORE_STATUS.DUPLICATE_INVOCATION) === "transient", "0x0102 → geçici");
  ok(classifyCstoreStatus(CSTORE_STATUS.INVOCATION_LIMIT) === "transient", "0x0103 → geçici");
  ok(classifyCstoreStatus(CSTORE_STATUS.RESOURCE_LIMIT) === "transient", "0x0105 → geçici");
  ok(classifyCstoreStatus(0x9999) === "unknown", "bilinmeyen koda unknown");
  ok(cstoreStatusLabel(CSTORE_STATUS.SUCCESS) === "başarı", "başarı etiketi");
  ok(/PACS/.test(cstoreStatusLabel(CSTORE_STATUS.NO_MATCHING_SOP)), "eşleşme yok etiketi");
}

// ── 2. Yeniden deneme politikası ──
{
  ok(isRetryableCstoreError(CSTORE_STATUS.SUCCESS) === false, "başarı yeniden denmez");
  ok(isRetryableCstoreError(CSTORE_STATUS.NO_MATCHING_SOP) === false, "eşleşme yok yeniden denemEZ");
  ok(isRetryableCstoreError(CSTORE_STATUS.ATTRIBUTE_ERROR) === false, "attribute hatası yeniden denemEZ");
  ok(isRetryableCstoreError(CSTORE_STATUS.DUPLICATE_INVOCATION) === true, "0x0102 yeniden denebilir");
  ok(isRetryableCstoreError(CSTORE_STATUS.INVOCATION_LIMIT) === true, "0x0103 yeniden denebilir");
  ok(isRetryableCstoreError(CSTORE_STATUS.PROCESSING_FAILURE) === true, "0x0901 yeniden denebilir");
  ok(isRetryableCstoreError(0x0000, "HTTP 400 (400) Bad Request") === false, "4xx kalıcı");
  ok(cstoreRetryDelayMs(0) === 30_000, "ilk backoff 30 sn");
  ok(cstoreRetryDelayMs(1) === 60_000, "2. backoff 60 sn");
  ok(cstoreRetryDelayMs(10) === 3_600_000, "1 saatte doygunlaşır");
  ok(dueForCstoreRetry({ attempts: 0, lastError: "" }, null) === true, "denemeyen öge hemen girer");
  ok(dueForCstoreRetry({ attempts: MAX_CSTORE_ATTEMPTS, lastError: "" }, null) === false, "vazgeçilen tekrar girmez");
  ok(dueForCstoreRetry({ attempts: 1, lastError: "" }, new Date()) === false, "backoff gelmez");
  ok(dueForCstoreRetry({ attempts: 1, lastError: "" }, new Date(Date.now() - 61_000)) === true, "süre dolunca girer");
  ok(dueForCstoreRetry({ attempts: 1, lastError: "eşleşme yok", statusCode: CSTORE_STATUS.NO_MATCHING_SOP }, null) === false, "içerik reddi hiç girmez");
}

// ── 3. Doğrulama (tahmin yok) ──
{
  ok(validateCstoreInstance({ name: "a.dcm", studyUid: "1.2.3" }).ok === true, "geçerli öge kabul");
  ok(validateCstoreInstance({ name: "", studyUid: "1.2.3" }).ok === false, "boş isim reddedilir");
  ok(validateCstoreInstance({ name: "a.dcm", studyUid: "abc" }).ok === false, "geçersiz Study UID reddedilir");
  ok(validateCstoreInstance({ name: "a.dcm", studyUid: "1.2.3", sopUid: "x" }).ok === false, "geçersiz SOP UID reddedilir");
  ok(validateCstoreRequest({ batchId: "b", target: { aet: "AET" }, instances: [{ name: "a.dcm", studyUid: "1.2.3" }] }).ok === true, "geçerli talep kabul");
  ok(validateCstoreRequest({ batchId: "b", target: { aet: "" }, instances: [] }).ok === false, "boş AET reddedilir");
  ok(validateCstoreRequest({ batchId: "b", target: { aet: "A" }, instances: [] }).ok === false, "boş instances reddedilir");
  ok(validateCstoreRequest("x").ok === false, "JSON nesnesi değil reddedilir");
}

// ── 4. Dedupe + kuyruk planlama ──
{
  const req = {
    batchId: "b", target: { aet: "AET" },
    instances: [
      { name: "a.dcm", sopUid: "1.2.3", studyUid: "1.2.3", sha256: "s1" },
      { name: "a.dcm", sopUid: "1.2.3", studyUid: "1.2.3", sha256: "s1" },
      { name: "b.dcm", sopUid: "1.2.4", studyUid: "1.2.3", sha256: "s2" },
    ],
  };
  const v = validateCstoreRequest(req);
  ok(v.ok === true, "talep doğrulandı");
  const reqOk = v.ok ? v.request : null;
  ok(reqOk !== null, "talep nesnesi elde");
  const plan = planCstoreQueue(reqOk ?? { batchId: "", target: { aet: "" }, instances: [] });
  ok(plan.accepted.length === 2, `dedupe sonrası ${plan.accepted.length} öge`);
  ok(plan.skipped.length === 1 && plan.skipped[0] === "a.dcm", "yineleyen atlandı");
  ok(cstoreDedupeKey(req.instances[0]) === cstoreDedupeKey(req.instances[0]), "dedupe anahtarı sabit");
  ok(planCstoreQueue(reqOk ?? { batchId: "", target: { aet: "" }, instances: [] }, 1).accepted.length === 1, "sınır kesilir");
}

// ── 5. Outcome + tur + rapor ──
{
  const done = applyCstoreOutcome(mk(), { sopUid: "1.2.3", status: CSTORE_STATUS.SUCCESS });
  ok(done.status === "done" && done.attempts === 1 && done.lastError === "", "başarı → done, hata temiz");
  const rejected = applyCstoreOutcome(mk(), { sopUid: "1.2.3", status: CSTORE_STATUS.NO_MATCHING_SOP, message: "x" });
  ok(rejected.status === "failed" && rejected.attempts === 1 && /eşleşme/.test(rejected.lastError), "eşleşme yok → failed + etiket");

  const items = [
    mk({ id: 1, status: "pending" }),
    mk({ id: 2, status: "pending" }),
    mk({ id: 3, status: "failed", statusCode: CSTORE_STATUS.PROCESSING_FAILURE, attempts: 1, lastError: "0x0901", lastAttemptAt: new Date(Date.now() - 61_000) }),
    mk({ id: 4, status: "failed", statusCode: CSTORE_STATUS.NO_MATCHING_SOP, attempts: 1, lastError: "eşleşme yok" }),
    mk({ id: 5, status: "done" }),
  ];
  const round = planNextCstoreRound(items, { now: Date.now() });
  ok(round.map((i) => i.id).sort().join(",") === "1,2,3", `tur ögeleri 1,2,3 (due failed önce, içerik reddi atlanır)`);
  ok(round.every((i) => i.status === "processing"), "tur ögeleri processing");

  const reported = applyCstoreReport(
    [mk({ id: 1, sopUid: "1.1" }), mk({ id: 2, sopUid: "1.2" })],
    [{ sopUid: "1.1", status: CSTORE_STATUS.SUCCESS }]
  );
  ok(reported[0].status === "done", "rapor applied → done");
  ok(reported[1].status === "pending", "raporda olmayan öge değişmez");
}

// ── 6. İlerleme + hata raporu + görünüm ──
{
  const items = [
    mk({ id: 1, status: "done" }),
    mk({ id: 2, status: "done" }),
    mk({ id: 3, status: "failed", statusCode: CSTORE_STATUS.PROCESSING_FAILURE, lastError: "0x0901" }),
    mk({ id: 4, status: "failed", statusCode: CSTORE_STATUS.NO_MATCHING_SOP, lastError: "eşleşme yok" }),
    mk({ id: 5, status: "pending" }),
  ];
  const s = cstoreProgressSummary(items);
  ok(s.total === 5 && s.done === 2 && s.failed === 2 && s.pending === 1, `özet ${s.done}/${s.failed}/${s.pending}`);
  ok(s.percent === 80, `ilerleme %${s.percent}`);
  ok(s.retryable === 1, "1 yeniden denebilir öge");
  const report = buildCstoreErrorReport(items);
  ok(report.find((g) => g.kind === "content-rejected")?.count === 1, "içerik reddi grubu 1");
  ok(report.find((g) => g.kind === "transient")?.files[0] === "f.dcm", "geçici grup dosya adını taşır");
  const pub = publicCstoreItem(items[2]);
  ok(!("payloadCipher" in pub) && "createdAt" in pub && pub.statusLabel === "işlem hatası", "görüntü payload sızmaz + etiket");
  ok(pub.exhausted === false && publicCstoreItem(mk({ attempts: MAX_CSTORE_ATTEMPTS })).exhausted === true, "deneme sınırı görünür");
}

// ── 7. Köprü: manifest → enqueue body (gerçek DICOM dosya byte'ları) ──
async function main(): Promise<void> {
  const tmp = mkdtempSync(path.join(tmpdir(), "atik-cstore-"));
  try {
    // Gerçek Explicit VR LE DICOM üret (dicomWrite).
    const body = concat([
      str(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.88.11"),
      str(0x0008, 0x0018, "UI", "1.2.840.113619.2.55.3.604688.1.1"),
      str(0x0020, 0x000d, "UI", "1.2.840.113619.2.55.3.604688.1"),
      str(0x0020, 0x000e, "UI", "1.2.840.113619.2.55.3.604688.2"),
    ]);
    const meta = concat([uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1")]);
    const glen = new Uint8Array(4);
    new DataView(glen.buffer).setUint32(0, meta.length, true);
    const dcm = Buffer.from(concat([new Uint8Array(128), new TextEncoder().encode("DICM"), el(0x0002, 0x0000, "UL", glen), meta, body]));
    const file = path.join(tmp, "sr.dcm");
    writeFileSync(file, dcm);
    const manifestPath = path.join(tmp, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      batchId: "b-42",
      target: { aet: "ORTHANC", host: "10.0.0.5", port: 11112 },
      instances: [{ name: "sr.dcm", path: file, sopUid: "1.2.840.113619.2.55.3.604688.1.1", studyUid: "1.2.840.113619.2.55.3.604688.1" }],
    }));
    const m = loadManifest(manifestPath);
    ok(m.batchId === "b-42" && m.target.aet === "ORTHANC", "manifest yüklendi");
    const enq = buildEnqueueBody(m);
    ok(enq.batchId === "b-42" && enq.instances[0].data !== undefined, "enqueue body üretildi");
    ok(enq.instances[0].size === dcm.length, `boyut eşit (${enq.instances[0].size}/${dcm.length})`);
    ok(enq.instances[0].sha256 === createHash("sha256").update(dcm).digest("hex"), "sha256 doğru");
    ok(enq.instances[0].studyUid === "1.2.840.113619.2.55.3.604688.1", "studyUid meta'dan");
    const v = validateCstoreRequest(enq);
    ok(v.ok === true, "enqueue body doğrulandı");

    // cstore-scu çıktı parse
    const out = "[INFO] Sending SOP Class ... SOP Instance UID 1.2.3\n[INFO] done\n";
    const parsed = parseCstoreScuOutput(out);
    ok(parsed.length === 1 && parsed[0].status === CSTORE_STATUS.SUCCESS, "cstore-scu çıktısı başarı");
    const outFail = "[ERROR] SOP Instance UID 1.2.3 rejected\n";
    const parsedFail = parseCstoreScuOutput(outFail);
    ok(parsedFail[0].status === CSTORE_STATUS.PROCESSING_FAILURE, "cstore-scu hata çıktısı");
    ok(parseCstoreScuOutput("garip çıktı").length === 0, "çıkışsız çıktı güvenle boş");

    // bozuk manifest
    writeFileSync(path.join(tmp, "bad.json"), "{ nope");
    let threw = false;
    try { loadManifest(path.join(tmp, "bad.json")); } catch { threw = true; }
    ok(threw, "bozuk manifest hata fırlatır");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log(`\ncstore: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
});
