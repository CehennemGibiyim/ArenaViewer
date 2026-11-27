/**
 * STOW yeniden deneme kuyruğunun DB katmanı (A0.3 / seg-stow-return).
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır (auditDelivery
 * deseni): kurulumda ek geçiş adımı gerekmez; `stow_queue` tablosu drizzle
 * şemasında da tanımlıdır (`src/db/schema.ts`).
 *
 * Hasta kimliği içeren DICOM baytları DB'ye YALNIZ AES-256-GCM şifreli
 * (`crypto.encryptText`) olarak yazılır; listeleme ucu payload'ı asla döndürmez.
 * Kullanım kapsamı: `yonetici` tümünü görür/dener/siler; diğer roller yalnız
 * kendi kuyruk nesnelerini görür/dener/siler. Her gönderim ve silme denetime yazılır.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { stowQueue } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { decryptText, encryptText } from "@/lib/server/crypto";
import { loadPacsConfig } from "@/lib/server/pacsConfig";
import { stowInstance } from "@/lib/server/pacs";
import { validateDerivedDicomBytes, type DerivedKind } from "@/lib/derivedStow";
import { dueForStowRetry, isRetryableStowError, publicRow, STOW_BATCH } from "@/lib/server/stowQueue";
import type { UserInfo } from "@/lib/types";
import type { PacsConfig } from "@/lib/pacsPresets";

let tableReady = false;

export async function ensureStowQueueTable(): Promise<void> {
  if (tableReady) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS stow_queue (
    id serial PRIMARY KEY,
    kind text NOT NULL,
    study_uid text NOT NULL,
    file_name text NOT NULL DEFAULT '',
    payload_cipher text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT '',
    last_attempt_at timestamp,
    owner text NOT NULL DEFAULT '',
    created_at timestamp NOT NULL DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS stow_queue_owner_idx ON stow_queue (owner, created_at)`));
  tableReady = true;
}

/** Başarısız PACS gönderimini kuyruğa yazar (yalnız yeniden denenebilir hatalar için çağrılır). */
export async function enqueueStow(input: { kind: DerivedKind; studyUid: string; fileName: string; bytes: Uint8Array; owner: string }): Promise<number> {
  await ensureStowQueueTable();
  const rows = await db.insert(stowQueue).values({
    kind: input.kind,
    studyUid: input.studyUid,
    fileName: input.fileName.slice(0, 200),
    payloadCipher: encryptText(Buffer.from(input.bytes).toString("base64")),
    owner: input.owner.slice(0, 64),
  }).returning({ id: stowQueue.id });
  return rows[0]?.id ?? 0;
}

export interface StowQueueRow {
  id: number;
  kind: string;
  studyUid: string;
  fileName: string;
  attempts: number;
  lastError: string;
  lastAttemptAt: Date | null;
  createdAt: Date;
  owner: string;
  payloadCipher: string;
}

/**
 * Kuyruktaki tek nesneyi göndermeyi dener (DB yazmaz — karar flushQueue'ya aittir).
 * Testler gerçek ağ (mock PACS) ile bu fonksiyonu doğrudan çağırır.
 */
export async function attemptQueuedSend(row: Pick<StowQueueRow, "kind" | "studyUid" | "payloadCipher">, cfg: PacsConfig): Promise<void> {
  const b64 = decryptText(row.payloadCipher);
  if (!b64 || b64.includes("[çözülemedi]")) throw new Error("Kuyruk nesnesi çözülemedi (şifreleme anahtarı değişmiş olabilir)");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    throw new Error("Kuyruk nesnesi bozuk (base64 çözümlenemedi)");
  }
  const kind: DerivedKind = row.kind === "rtstruct" ? "rtstruct" : "seg";
  const check = validateDerivedDicomBytes(bytes, kind, row.studyUid);
  if (!check.ok) throw new Error(check.error ?? "Kuyruk nesnesi doğrulanamadı");
  await stowInstance(cfg, bytes); // hata fırlatır: ağ/5xx/zaman aşımı/PACS reddi
}

/** Kullanıcının görebileceği bekleyen nesneler (yonetici: tümü). Payload döndürülmez. */
export async function listStowQueue(user: UserInfo) {
  await ensureStowQueueTable();
  const own = user.role === "yonetici" ? null : user.username;
  const rows = own
    ? await db.select().from(stowQueue).where(eq(stowQueue.owner, own)).orderBy(asc(stowQueue.id)).limit(200)
    : await db.select().from(stowQueue).orderBy(asc(stowQueue.id)).limit(200);
  return { items: rows.map((r) => publicRow({ ...r, createdAt: r.createdAt })) };
}

export interface FlushRun {
  configured: boolean;
  tried: number;
  sent: number;
  failed: number;
  lastError?: string;
}

/** Kuyruktaki nesneleri PACS'a yazar; başarılıları siler, başarısızların deneme sayısını artırır. */
export async function flushStowQueue(user: UserInfo, limit = STOW_BATCH): Promise<FlushRun> {
  const cfg = await loadPacsConfig();
  if (!cfg) return { configured: false, tried: 0, sent: 0, failed: 0 };
  await ensureStowQueueTable();
  const own = user.role === "yonetici" ? null : user.username;
  const rows = own
    ? await db.select().from(stowQueue).where(eq(stowQueue.owner, own)).orderBy(asc(stowQueue.id)).limit(limit)
    : await db.select().from(stowQueue).orderBy(asc(stowQueue.id)).limit(limit);
  const due = rows.filter((r) => dueForStowRetry(r, r.lastAttemptAt));
  let sent = 0, failed = 0;
  let lastError = "";
  for (const r of due) {
    try {
      await attemptQueuedSend(r, cfg);
      await db.delete(stowQueue).where(eq(stowQueue.id, r.id));
      await audit(user, "pacs.queue_retry", "study", r.studyUid, { kind: r.kind, result: "sent" });
      sent++;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const retryable = isRetryableStowError(msg);
      await db.update(stowQueue)
        .set({ attempts: r.attempts + 1, lastError: msg, lastAttemptAt: new Date() })
        .where(eq(stowQueue.id, r.id));
      await audit(user, "pacs.queue_retry", "study", r.studyUid, { kind: r.kind, result: "failed", retryable, error: msg.slice(0, 200) });
      failed++;
      lastError = msg;
    }
  }
  return { configured: true, tried: due.length, sent, failed, ...(lastError ? { lastError: lastError.slice(0, 300) } : {}) };
}

/** Kuyruktaki nesneyi siler (kullanıcı vazgeçti). yonetici tümüne müdahale edebilir. */
export async function discardStow(id: number, user: UserInfo): Promise<{ ok: boolean; error?: string }> {
  await ensureStowQueueTable();
  const r = (await db.select().from(stowQueue).where(eq(stowQueue.id, id)).limit(1))[0];
  if (!r) return { ok: false, error: "Kuyruk nesnesi bulunamadı" };
  if (user.role !== "yonetici" && r.owner !== user.username) return { ok: false, error: "Yalnızca kendi kuyruk nesnenizi silebilirsiniz" };
  await db.delete(stowQueue).where(eq(stowQueue.id, id));
  await audit(user, "pacs.queue_discard", "study", r.studyUid, { kind: r.kind });
  return { ok: true };
}
