/**
 * C-STORE (DIMSE) kuyruğunun DB katmanı (e-stow).
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır
 * (`stowQueueRepo`/`batchImportRepo` deseni): kurulumda ek geçiş adımı
 * gerekmez; `cstore_queue` tablosu drizzle şemasında da tanımlıdır.
 *
 * DICOM baytları DB'ye **AES-256-GCM şifreli** (`encryptText`) olarak yazılır;
 * listeleme ucu payload'ı asla döndürmez. Köprü süreci (dcm4che `cstore-scu`)
 * gerçeği C-STORE'i konuşur; API sonucu `applyCstoreReport` ile sınıflandırır.
 */
import { decryptText, encryptText } from "@/lib/server/crypto";
import {
  applyCstoreOutcome,
  cstoreProgressSummary,
  buildCstoreErrorReport,
  planCstoreQueue,
  planNextCstoreRound,
  validateCstoreRequest,
  type CstoreInstanceInput,
  type CstoreItemView,
  type CstoreResultEntry,
} from "@/lib/cstore";

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

export async function ensureCstoreTable(): Promise<void> {
  if (tableReady) return;
  const { sql } = await import("drizzle-orm");
  const d = await db();
  await d.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cstore_queue (\n    id serial PRIMARY KEY,\n    batch_id text NOT NULL,\n    aet text NOT NULL DEFAULT '',\n    name text NOT NULL,\n    sop_class text NOT NULL DEFAULT '',\n    sop_uid text NOT NULL DEFAULT '',\n    study_uid text NOT NULL,\n    series_uid text NOT NULL DEFAULT '',\n    size integer NOT NULL DEFAULT 0,\n    sha256 text NOT NULL DEFAULT '',\n    payload_cipher text,\n    status text NOT NULL DEFAULT 'pending',\n    status_code integer NOT NULL DEFAULT 0,\n    attempts integer NOT NULL DEFAULT 0,\n    last_error text NOT NULL DEFAULT '',\n    owner text NOT NULL DEFAULT '',\n    last_attempt_at timestamp,\n    created_at timestamp NOT NULL DEFAULT now()\n  )`));
  await d.execute(sql.raw(`CREATE INDEX IF NOT EXISTS cstore_queue_batch_idx ON cstore_queue (batch_id, status)`));
  tableReady = true;
}

/** C-STORE isteğini doğrular + kuyruğa yazar (dedupe, şifreli payload). */
export async function enqueueCstore(
  body: unknown,
  owner: string
): Promise<{ ok: true; accepted: number; skipped: string[]; batchId: string } | { ok: false; error: string }> {
  const v = validateCstoreRequest(body);
  if (!v.ok) return { ok: false, error: v.error };
  await ensureCstoreTable();
  const { accepted, skipped } = planCstoreQueue(v.request);
  if (accepted.length) {
    const t = await schema();
    const d = await db();
    await d.insert(t.cstoreQueue)
      .values(
        accepted.map((it) => ({
          batchId: v.request.batchId,
          aet: v.request.target.aet,
          name: it.name,
          sopClass: it.sopClassUid ?? "",
          sopUid: it.sopUid ?? "",
          studyUid: it.studyUid,
          seriesUid: it.seriesUid ?? "",
          size: it.size ?? 0,
          sha256: it.sha256 ?? "",
          payloadCipher: it.data ? encryptText(it.data) : null,
          owner,
          createdAt: new Date(),
        }))
      )
      .onConflictDoNothing();
  }
  return { ok: true, accepted: accepted.length, skipped, batchId: v.request.batchId };
}

/** Kuyruk ögelerini döndürür (batch bazlı, id artan sırada). */
export async function listCstoreItems(batchId: string): Promise<CstoreItemView[]> {
  await ensureCstoreTable();
  const { asc, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const rows = await d.select().from(t.cstoreQueue).where(eq(t.cstoreQueue.batchId, batchId)).orderBy(asc(t.cstoreQueue.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sopUid: r.sopUid,
    studyUid: r.studyUid,
    status: r.status as CstoreItemView["status"],
    statusCode: r.statusCode,
    attempts: r.attempts,
    lastError: r.lastError,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
  }));
}

/** Bir ögenin baytlarını (şifreli kayıt) çözer; payload eksikse hata fırlatır. */
export function readCstorePayload(cipher: string): Uint8Array {
  if (!cipher) throw new Error("kuyruk ögesinde payload yok");
  return Buffer.from(decryptText(cipher), "base64");
}

/** Köprüden gelen C-STORE sonucu raporunu işler: öge durumları güncellenir + denetim. */
export async function applyCstoreReportToQueue(
  batchId: string,
  report: CstoreResultEntry[],
  owner = ""
): Promise<{ updated: number; summary: ReturnType<typeof cstoreProgressSummary> }> {
  const items = await listCstoreItems(batchId);
  const updated = items.map((it) => {
    const r = report.find((x) => x.sopUid === it.sopUid);
    return r ? applyCstoreOutcome(it, r) : it;
  });
  const { eq, and } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const changed = updated.filter((it) => it.status !== items.find((x) => x.id === it.id)?.status || it.attempts !== items.find((x) => x.id === it.id)?.attempts);
  for (const it of changed) {
    await d.update(t.cstoreQueue)
      .set({
        status: it.status,
        statusCode: it.statusCode,
        attempts: it.attempts,
        lastError: it.lastError,
        lastAttemptAt: it.lastAttemptAt,
      })
      .where(and(eq(t.cstoreQueue.batchId, batchId), eq(t.cstoreQueue.id, it.id)));
  }
  const a = await audit();
  await a(null, "cstore.report", "cstore_queue", "", { batch: batchId, report: report.length, updated: changed.length, owner });
  const final = await listCstoreItems(batchId);
  return { updated: changed.length, summary: cstoreProgressSummary(final) };
}

/** Bir turun tasarlanan ögeleri (pending → due failed). */
export async function planCstoreRound(batchId: string, limit = 50): Promise<CstoreItemView[]> {
  const items = await listCstoreItems(batchId);
  return planNextCstoreRound(items, { limit });
}

/** Kuyruk özeti (ilerleme + hata raporu) — listeleme ucu bu görünümü kullanır. */
export async function cstoreProgress(batchId: string) {
  const items = await listCstoreItems(batchId);
  return {
    summary: cstoreProgressSummary(items),
    errors: buildCstoreErrorReport(items),
    items: items.map((it) => ({
      id: it.id,
      name: it.name,
      sopUid: it.sopUid,
      studyUid: it.studyUid,
      status: it.status,
      statusCode: it.statusCode,
      attempts: it.attempts,
      lastError: it.lastError,
      exhausted: it.attempts >= 8,
      createdAt: it.createdAt.toISOString(),
    })),
  };
}
