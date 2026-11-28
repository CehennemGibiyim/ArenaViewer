/**
 * HBYS/RIS sonuç çekimi kuyruğu DB katmanı (d-followup).
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır
 * (`cstoreQueueRepo`/`batchImportRepo` deseni): kurulumda ek geçiş adımı
 * gerekmez; `his_results` tablosu drizzle şemasında da tanımlıdır.
 *
 * Sonuç metinleri DB'ye **AES-256-GCM şifreli** (`encryptText`) olarak yazılır;
 * listeleme ucu payload'ı asla döndürmez. Köprü süreçleri (HL7 MLLP sunucusu /
 * FHIR çekim köprüsü) sonuçları `/api/his/results` ucuna iletir; uç
 * `applyResultMatches` ile çekilen sonuca pas three verir: açık takip görevleri
 * eşlenir (belirsizse eşleşme YAPILMAZ) ve kapatılır (denetim: notify.followup_outcome).
 */
import { decryptText, encryptText } from "@/lib/server/crypto";
import {
  planResultMatches,
  planResultQueue,
  resultPullSummary,
  resultTextSummary,
  type ResultItemView,
  type ResultRecordInput,
} from "@/lib/resultPull";
import type { FollowupTask } from "@/lib/followupQueue";

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

export async function ensureResultTable(): Promise<void> {
  if (tableReady) return;
  const { sql } = await import("drizzle-orm");
  const d = await db();
  await d.execute(sql.raw(`CREATE TABLE IF NOT EXISTS his_results (
    id serial PRIMARY KEY,
    batch_id text NOT NULL,
    source text NOT NULL DEFAULT 'hl7',
    patient_id text NOT NULL DEFAULT '',
    accession_number text NOT NULL,
    modality text NOT NULL DEFAULT '',
    body_part text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    text_cipher text NOT NULL,
    at_text text NOT NULL DEFAULT '',
    study_uid text NOT NULL DEFAULT '',
    fhir_source text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    matched_task_id integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now()
  )`));
  await d.execute(sql.raw(`CREATE INDEX IF NOT EXISTS his_results_batch_idx ON his_results (batch_id, status)`));
  tableReady = true;
}

/** Sonuç kaydını doğrular + kuyruğa yazar (dedupe, şifreli metin). */
export async function enqueueResults(
  inputs: ResultRecordInput[],
  batchId: string
): Promise<{ ok: true; accepted: number; skipped: string[]; batchId: string } | { ok: false; error: string }> {
  if (!Array.isArray(inputs)) return { ok: false, error: "results dizisi gerekli" };
  const plan = planResultQueue(inputs);
  if (plan.accepted.length) {
    await ensureResultTable();
    const t = await schema();
    const d = await db();
    await d.insert(t.hisResults)
      .values(
        plan.accepted.map((r) => ({
          batchId,
          source: r.source,
          patientId: r.patientId ?? "",
          accessionNumber: r.accessionNumber,
          modality: r.modality ?? "",
          bodyPart: r.bodyPart ?? "",
          description: r.description ?? "",
          textCipher: encryptText(r.text),
          atText: r.at ?? "",
          studyUid: r.studyUid ?? "",
          fhirSource: r.fhirSource ?? "",
          createdAt: new Date(),
        }))
      )
      .onConflictDoNothing();
  }
  return { ok: true, accepted: plan.accepted.length, skipped: plan.skipped, batchId };
}

/** Kuyruk ögelerini döndürür (batch bazlı, id artan sırada); metin çözülür. */
export async function listResultItems(batchId: string): Promise<ResultItemView[]> {
  await ensureResultTable();
  const { asc, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const rows = await d.select().from(t.hisResults).where(eq(t.hisResults.batchId, batchId)).orderBy(asc(t.hisResults.id));
  return rows.map((r) => ({
    id: r.id,
    batchId: r.batchId,
    source: r.source as ResultItemView["source"],
    patientId: r.patientId,
    accessionNumber: r.accessionNumber,
    modality: r.modality,
    bodyPart: r.bodyPart,
    description: r.description,
    text: decryptText(r.textCipher),
    at: r.atText,
    studyUid: r.studyUid,
    fhirSource: r.fhirSource,
    status: r.status as ResultItemView["status"],
    matchedTaskId: r.matchedTaskId,
    createdAt: r.createdAt,
  }));
}

/** Sonuç metni (kuyruk öge) → çözülür; payload eksikse hata fırlatır. */
export function readResultText(cipher: string): string {
  if (!cipher) throw new Error("kuyruk ögesinde sonuç metni yok");
  return decryptText(cipher);
}

/** Açık takip görevlerini (notifications, kind=followup) döndürür. */
export async function openFollowupTasks(): Promise<FollowupTask[]> {
  const { and, desc, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const rows = await d.select().from(t.notifications)
    .where(and(eq(t.notifications.kind, "followup"), eq(t.notifications.status, "acik")))
    .orderBy(desc(t.notifications.id))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind ?? "followup",
    status: (r.status ?? "acik") as FollowupTask["status"],
    dueDate: r.dueDate ?? "",
    severity: r.severity,
    message: r.message,
    modality: r.modality,
    bodyRegion: r.bodyRegion,
    studyUid: r.studyUid,
    reportId: r.reportId ?? null,
  }));
}

/** Kuyruktaki pending ögeleri eşler + açık görevleri kapatır (denetim ile). */
export async function applyResultMatches(
  batchId: string,
  actor = ""
): Promise<{ matched: number; unmatched: number; summary: ReturnType<typeof resultPullSummary> }> {
  const items = await listResultItems(batchId);
  const pending = items.filter((i) => i.status === "pending");
  const tasks = await openFollowupTasks();
  const plan = planResultMatches(pending, tasks);

  const { and, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();

  // Kapatılan görevler: durum + sonuç tarihçesi + denetim.
  for (const m of plan.matches) {
    const stamp = new Date(m.task.completedAt ?? Date.now());
    await d.update(t.notifications)
      .set({
        status: "tamamlandi",
        completedAt: stamp,
        // Sonuç metni görev kaydına eklenir (ayrı sütun yok; tarihçe mesajda tutulur).
        message: `${m.task.message}\n---\nSonuç (${stamp.toISOString().slice(0, 16).replace("T", " ")}): ${m.task.outcome ?? ""}`.slice(0, 8000),
      })
      .where(and(eq(t.notifications.kind, "followup"), eq(t.notifications.id, m.task.id)));
    const a = await audit();
    await a(null, "notify.followup_outcome", "notification", m.task.id, {
      batch: batchId,
      match: m.reason,
      source: m.item.source,
      accession: m.item.accessionNumber,
      chars: (m.task.outcome ?? "").length,
      actor,
    });
  }

  // Kuyruk öge durumu: eşleşti → matched (kapatıldı), eşleşmedi → unmatched.
  for (const item of items) {
    const hit = plan.matches.find((m) => m.item.id === item.id);
    const next = hit ? "matched" : item.status === "pending" ? "unmatched" : item.status;
    if (next === item.status) continue;
    await d.update(t.hisResults)
      .set({ status: next, matchedTaskId: hit ? hit.task.id : 0 })
      .where(and(eq(t.hisResults.batchId, batchId), eq(t.hisResults.id, item.id)));
  }

  const final = await listResultItems(batchId);
  return {
    matched: plan.matches.length,
    unmatched: plan.unmatched.length,
    summary: resultPullSummary(final),
  };
}

/** Kuyruk özeti (ilerleme + sonuç metni özeti) — listeleme ucu bu görünümü kullanır. */
export async function resultProgress(batchId: string) {
  const items = await listResultItems(batchId);
  return {
    summary: resultPullSummary(items),
    items: items.map((it) => ({
      id: it.id,
      source: it.source,
      patientId: it.patientId,
      accessionNumber: it.accessionNumber,
      modality: it.modality,
      bodyPart: it.bodyPart,
      status: it.status,
      matchedTaskId: it.matchedTaskId,
      text: resultTextSummary(it.text),
      at: it.at,
      createdAt: it.createdAt.toISOString(),
    })),
  };
}
