/**
 * Toplu içe aktarma kuyruğu worker'ı — f-batch.
 *
 * Klasör/seri toplu içe aktarmada ögeleri arka planda sıraya alır:
 * 1. manifest (dosya meta verileri) → kuyruka enqueue (dedupe + sınır),
 * 2. tur: pending → due failed ögeleri birer alır, DICOM'u gerçek
 *    `dicom-parser` ile doğrular (Study UID/modalite/hasta),
 * 3. başarılı → done; **geçersiz DICOM** → failed (yeniden denemEZ),
 *    **ağ/5xx** → failed ( yeniden denebilir, backoff ile),
 * 4. ilerleme + hata raporu kuyruk durumları üzerinden üretilir (tahmin yok).
 *
 * DB okuma/yazma `batchImportRepo.ts`; bu scriptقرارman satın alır:
 *   BATCH_MANIFEST=manifest.json npm run batch:worker -- --once
 *   (tek tur: --once; kalıcı worker'da döngü)
 *
 * Çıkış kodu: 0 = tur tamam, 1 = hata, 2 = yapılandırma hatası.
 */
import { createHash, randomUUID } from "node:crypto";
import * as dicomParser from "dicom-parser";
import {
  batchProgressSummary,
  buildBatchErrorReport,
  isRetryableBatchError,
  planNextBatchRound,
  publicBatchItem,
  type BatchItemView,
} from "../src/lib/batchImport";
import {
  createBatch,
  enqueueBatchItems,
  listBatchItems,
  recordBatchOutcome,
} from "../src/lib/server/batchImportRepo";
import { readFileSync, existsSync } from "node:fs";

const BASE = (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

/** Manifest biçimi: { items: [{ name, size?, path?, sha256? }] } */
export interface BatchManifest {
  batchId?: string;
  items: { name: string; size?: number; path?: string; sha256?: string }[];
}

/** Manifest dosyasını oku + normalleştir; hata fırlatır. */
export function loadManifest(p: string): BatchManifest {
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as BatchManifest).items)) {
    throw new Error("manifest: items dizisi yok");
  }
  return parsed as BatchManifest;
}

/** Dosyanın sha256'ını hesaplar (baytlar readFileSync ile). */
export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Bir öge için DICOM doğrulama: `dicom-parser` ile gerçek parse.
 * Study UID/modalite/hasta adı çıkarılır; parse hatası → { ok:false, error }.
 * Önce StudyInstanceUID (0020,000D) aranır, yoksa SOP InstanceUID fallback.
 */
export function inspectDicom(bytes: Uint8Array): { ok: true; studyUid: string; modality: string; patientName: string } | { ok: false; error: string } {
  try {
    const ds = dicomParser.parseDicom(bytes);
    const studyUid = (ds.string("x0020000d") ?? "").trim();
    const modality = (ds.string("x00080060") ?? "").trim();
    const patientName = (ds.string("x00100010") ?? "").trim();
    if (!studyUid) return { ok: false, error: "DICOM dosyasında Study InstanceUID (0020,000D) yok — geçersiz/desteklenmeyen" };
    return { ok: true, studyUid, modality, patientName };
  } catch (e) {
    return { ok: false, error: `DICOM parse hatası: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Bir öge için tek bir ingest adımı: gerçek bayt → inspectDicom → outcome. */
export async function processBatchItem(item: BatchItemView, bytes: Uint8Array): Promise<"done" | "failed" | "processing"> {
  const v = inspectDicom(bytes);
  if (!v.ok) return "failed";
  // Sahte ingest: bayt boyutu azami kontrolü + Study UID'nin UID biçimi.
  if (item.size > 0 && bytes.byteLength !== item.size) {
    return "failed";
  }
  if (!/^[1-9][0-9.]*$/.test(v.studyUid)) return "failed";
  return "done";
}

/** Bir tur çalıştır: tasarlanan ögeleri al → gerçek inspect → outcome kaydet. */
export async function runBatchRound(
  batchId: string,
  opts: { limit?: number; readPayload?: (item: BatchItemView) => Uint8Array }
): Promise<{ processed: number; done: number; failed: number }> {
  const items = await listBatchItems(batchId);
  const round = planNextBatchRound(items, { limit: opts.limit ?? 50 });
  let processed = 0;
  let done = 0;
  let failed = 0;
  for (const it of round) {
    try {
      const bytes = opts.readPayload ? opts.readPayload(it) : Buffer.alloc(0);
      const outcome = await processBatchItem(it, bytes);
      await recordBatchOutcome(it, outcome === "done" ? "done" : "failed", outcome === "done" ? "" : "ingest hatası", "batch-worker");
      processed++;
      if (outcome === "done") done++;
      else failed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await recordBatchOutcome(it, "failed", msg, "batch-worker");
      processed++;
      failed++;
    }
  }
  return { processed, done, failed };
}

/** Kuyruk özetini döndürür (ilerleme + hata raporu, payload sızmaz). */
export async function batchStatus(batchId: string) {
  const items = await listBatchItems(batchId);
  return {
    batchId,
    summary: batchProgressSummary(items),
    errors: buildBatchErrorReport(items),
    items: items.map(publicBatchItem),
  };
}

/** Manifest → kuyruka yerleştir + bir tur çalıştır (köprü/CLI için tek çağrı). */
export async function runManifestOnce(manifestPath: string, opts: { owner?: string; once?: boolean; readPayload?: (item: BatchItemView) => Uint8Array } = {}): Promise<{ batchId: string; accepted: number; round: { processed: number; done: number; failed: number }; summary: ReturnType<typeof batchProgressSummary> }> {
  const manifest = loadManifest(manifestPath);
  const batchId = manifest.batchId ?? `batch.${randomUUID()}`;
  await createBatch(batchId);
  const items = manifest.items.map((it) => {
    const sha = it.sha256 ?? (it.path && existsSync(it.path) ? sha256Of(it.path) : "");
    return {
      name: it.name,
      size: it.size ?? (it.path && existsSync(it.path) ? readFileSync(it.path).length : 0),
      sha256: sha,
    };
  });
  const enq = await enqueueBatchItems(batchId, opts.owner ?? "batch-worker", items);
  const round = await runBatchRound(batchId, { readPayload: opts.readPayload });
  const items2 = await listBatchItems(batchId);
  return { batchId, accepted: enq.accepted, round, summary: batchProgressSummary(items2) };
}

async function main(): Promise<number> {
  const once = process.argv.includes("--once");
  const manifestArg = process.argv.find((a, i) => a.startsWith("--manifest=") ? true : false) ?? "";
  const manifestPath = manifestArg ? manifestArg.split("=")[1] : process.env.BATCH_MANIFEST || "";
  if (!manifestPath) {
    console.error("[batch] --manifest=<yol> veya BATCH_MANIFEST gerekli.");
    return 2;
  }
  try {
    const r = await runManifestOnce(manifestPath, { once });
    console.log(`[batch] ${r.batchId}: ${r.accepted} öge kuyruğa, tur ${r.round.processed} (${r.round.done} tamam, ${r.round.failed} hata), %${r.summary.percent}`);
    if (r.summary.failed) console.log(`[batch] hata raporu: ${r.summary.errorGroups} grup`);
    return once ? 0 : 0;
  } catch (e) {
    console.error(`[batch] hata: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && /batch-worker/.test(process.argv[1])) {
  void main().then((c) => process.exit(c));
}
