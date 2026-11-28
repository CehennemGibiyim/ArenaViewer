/**
 * Toplu içe aktarma kuyruğunun DB katmanı (f-batch).
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır
 * (`auditDelivery`/`stowQueueRepo` deseni): kurulumda ek geçiş adımı gerekmez;
 * `batch_import_queue` tablosu drizzle şemasında da tanımlıdır.
 *
 * Dosya **baytları** DB'ye şifreli (`encryptText`) olarak yazılır; listeleme
 * ucu payload'ı asla döndürmez (sızıntı önleme). Kuyruk ögeleri dosya meta
 * verilerini (isim/boyut/sha/studyUid/modality) taşır. DB import'u dinamik
 * (testler DB olmadan saf karar katmanını sınar).
 */
import { decryptText, encryptText } from "@/lib/server/crypto";
import {
  applyBatchItemOutcome,
  batchProgressSummary,
  buildBatchErrorReport,
  planBatchImport,
  planNextBatchRound,
  type BatchItemInput,
  type BatchItemView,
} from "@/lib/batchImport";

let tableReady = false;
let dbRef: typeof import("@/db")["db"] | null = null;
let schemaRef: typeof import("@/db/schema") | null = null;

async function db() {
  if (!dbRef) dbRef = (await import("@/db")).db;
  return dbRef;
}
async function schema() {
  if (!schemaRef) schemaRef = await import("@/db/schema");
  return schemaRef;
}
async function audit() {
  return (await import("@/lib/server/audit")).audit;
}

export async function ensureBatchQueueTable(): Promise<void> {
  if (tableReady) return;
  const { asc, eq, sql } = await import("drizzle-orm");
  const d = await db();
  void asc; void eq;
  await d.execute(sql.raw(`CREATE TABLE IF NOT EXISTS batch_import_queue (\n    id serial PRIMARY KEY,\n    batch_id text NOT NULL,\n    name text NOT NULL,\n    size integer NOT NULL,\n    sha256 text NOT NULL DEFAULT '',\n    study_uid text NOT NULL DEFAULT '',\n    modality text NOT NULL DEFAULT '',\n    status text NOT NULL DEFAULT 'pending',\n    attempts integer NOT NULL DEFAULT 0,\n    last_error text NOT NULL DEFAULT '',\n    payload_cipher text,\n    owner text NOT NULL DEFAULT '',\n    last_attempt_at timestamp,\n    created_at timestamp NOT NULL DEFAULT now()\n  )`));
  await d.execute(sql.raw(`CREATE INDEX IF NOT EXISTS batch_queue_batch_idx ON batch_import_queue (batch_id, status)`));
  tableReady = true;
}

/** Yeni bir kuyruk (batch) tanır; tablo çalışma anında hazırlanır, header satırı gerekmez. */
export async function createBatch(batchId: string): Promise<void> {
  await ensureBatchQueueTable();
  void batchId;
}

/** Kuyruğa ögeleri ekler; aynı sha+isim dedupe edilir (saf karar planBatchImport). */
export async function enqueueBatchItems(
  batchId: string,
  owner: string,
  items: BatchItemInput[]
): Promise<{ accepted: number; skippedDuplicates: string[] }> {
  await ensureBatchQueueTable();
  const { accepted, skippedDuplicates } = planBatchImport(items);
  if (accepted.length) {
    const t = await schema();
    const d = await db();
    await d.insert(t.batchImportQueue)
      .values(
        accepted.map((it) => ({
          batchId,
          name: it.name,
          size: it.size,
          sha256: it.sha256 ?? "",
          studyUid: it.studyUid ?? "",
          modality: it.modality ?? "",
          owner,
          createdAt: new Date(),
        }))
      )
      .onConflictDoNothing();
  }
  return { accepted: accepted.length, skippedDuplicates };
}

/** Kuyruk ögelerini döndürür (batch bazlı, id artan sırada). */
export async function listBatchItems(batchId: string): Promise<BatchItemView[]> {
  await ensureBatchQueueTable();
  const { asc, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const rows = await d.select().from(t.batchImportQueue).where(eq(t.batchImportQueue.batchId, batchId)).orderBy(asc(t.batchImportQueue.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    size: r.size,
    sha256: r.sha256,
    studyUid: r.studyUid,
    modality: r.modality,
    status: r.status as BatchItemView["status"],
    attempts: r.attempts,
    lastError: r.lastError,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
  }));
}

/** Bir ögenin baytlarını (şifreli kayıt) çözer; payload eksikse hata fırlatır. */
export function readBatchPayload(cipher: string): Uint8Array {
  if (!cipher) throw new Error("kuyruk ögesinde payload yok");
  return Buffer.from(decryptText(cipher), "base64");
}

/** Kuyruk ögelerini arındırılmış görünümde listeler (payload sızmaz). */
export async function publicBatchItems(batchId: string) {
  const items = await listBatchItems(batchId);
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    size: it.size,
    studyUid: it.studyUid,
    modality: it.modality,
    status: it.status,
    attempts: it.attempts,
    lastError: it.lastError,
    exhausted: it.attempts >= 6,
    createdAt: it.createdAt.toISOString(),
  }));
}

/** Bir öge için tur sonucunu kaydet (done/failed + denetim). */
export async function recordBatchOutcome(
  item: BatchItemView,
  outcome: "done" | "failed",
  error = "",
  owner = ""
): Promise<BatchItemView> {
  const next = applyBatchItemOutcome(item, outcome, new Date(), error);
  const { eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  await d.update(t.batchImportQueue)
    .set({
      status: next.status,
      attempts: next.attempts,
      lastError: next.lastError,
      lastAttemptAt: next.lastAttemptAt,
    })
    .where(eq(t.batchImportQueue.id, next.id));
  const a = await audit();
  await a(null, "batch.item_outcome", "batch_queue", next.id, {
    batch: item.name,
    outcome: next.status,
    attempts: next.attempts,
    error: next.lastError.slice(0, 300),
    owner,
  });
  return next;
}

/** Bir turun tasarlanan ögelerini (pending → due failed) döndürür. */
export async function planBatchRound(batchId: string, limit = 50): Promise<BatchItemView[]> {
  const items = await listBatchItems(batchId);
  return planNextBatchRound(items, { limit });
}

/** Kuyruk özeti (ilerleme + hata raporu) — listeleme ucu bu görünümü kullanır. */
export async function batchProgress(batchId: string) {
  const items = await listBatchItems(batchId);
  return {
    summary: batchProgressSummary(items),
    errors: buildBatchErrorReport(items),
  };
}
