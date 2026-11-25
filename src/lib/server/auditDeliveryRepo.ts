import { createHmac } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditDelivery } from "@/db/schema";
import { cefLine } from "@/lib/server/cef";
import { afterAttempt, DELIVERY_BATCH, dueForDelivery, MAX_DELIVERY_ATTEMPTS, siemEvent, signatureHeader, type DeliveryStatus } from "@/lib/server/auditDelivery";

/**
 * Denetim → SIEM teslimat deposu (w-audit).
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır (mevcut
 * `ensureTrigger()` deseniyle aynı): kurulumda ek geçiş adımı gerekmez.
 */
let tableReady = false;

export async function ensureDeliveryTable() {
  if (tableReady) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS audit_delivery (
    id serial PRIMARY KEY,
    audit_id integer,
    payload text NOT NULL,
    status text NOT NULL DEFAULT 'bekliyor',
    attempts integer NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT '',
    last_attempt_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS audit_delivery_status_idx ON audit_delivery (status)`));
  tableReady = true;
}

/** Denetim kaydını teslimat kuyruğuna ekler (denetim satırıyla aynı işlemde çağrılır). */
export async function enqueueDelivery(tx: { insert: typeof db.insert }, auditId: number | null, cef: string) {
  await ensureDeliveryTable();
  await tx.insert(auditDelivery).values({ auditId, payload: cef, status: "bekliyor" });
}

export interface DeliveryRun {
  configured: boolean;
  tried: number;
  sent: number;
  failed: number;
  error?: string;
}

/**
 * Kuyruktaki olayları SIEM'e gönderir. `AUDIT_SIEM_URL` yoksa hiçbir şey yapmaz
 * (kuyruk birikir; kayıt kaybolmaz). `AUDIT_SIEM_SECRET` varsa gövde HMAC ile imzalanır.
 * Dönen özet yönetici ekranında ve denetim kaydında görünür.
 */
export async function deliverPending(limit = DELIVERY_BATCH): Promise<DeliveryRun> {
  const url = process.env.AUDIT_SIEM_URL;
  if (!url) return { configured: false, tried: 0, sent: 0, failed: 0 };
  await ensureDeliveryTable();
  const rows = await db.select().from(auditDelivery).where(sql`${auditDelivery.status} in ('bekliyor','denendi')`).orderBy(asc(auditDelivery.id)).limit(limit);
  const now = Date.now();
  const due = rows.filter((r) => dueForDelivery({ status: r.status as DeliveryStatus, attempts: r.attempts }, r.lastAttemptAt, now));
  const secret = process.env.AUDIT_SIEM_SECRET ?? "";
  let sent = 0, failed = 0;
  let lastError = "";

  for (const r of due) {
    const body = JSON.stringify({ source: "ArenaViewer", cef: r.payload, auditId: r.auditId });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-Atik-Signature"] = signatureHeader(createHmac("sha256", secret).update(body).digest("hex"));
    let ok = false;
    let err = "";
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
      ok = res.ok;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const next = afterAttempt({ attempts: r.attempts }, ok, err);
    await db.update(auditDelivery).set({ status: next.status, attempts: next.attempts, lastError: next.lastError, lastAttemptAt: new Date() }).where(eq(auditDelivery.id, r.id));
    if (ok) sent++; else { failed++; lastError = err; }
  }
  return { configured: true, tried: due.length, sent, failed, ...(lastError ? { error: lastError.slice(0, 300) } : {}) };
}

/** Kuyruk durumu: yönetici ekranı için özet (vazgeçilenler dahil). */
export async function deliveryStats(): Promise<{ pending: number; failed: number; sent: number; abandoned: number; configured: boolean; maxAttempts: number }> {
  await ensureDeliveryTable();
  const rows = await db.select({ status: auditDelivery.status }).from(auditDelivery);
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    pending: count("bekliyor"),
    failed: count("denendi"),
    sent: count("gonderildi"),
    abandoned: count("vazgecildi"),
    configured: !!process.env.AUDIT_SIEM_URL,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
  };
}

export { cefLine, siemEvent };
