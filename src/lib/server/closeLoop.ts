import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { audit } from "@/lib/server/audit";
import { escalationMessage, loopAuditDetails, loopStatus } from "@/lib/closeLoopRules";
import { notifications } from "@/db/schema";
import {
  BIOPSY_FOLLOWUP_DAYS, followupSeverityFor, followupTitle, isBiopsySuggestion, parseIntervalDays,
} from "@/lib/followupText";

export { followupTitle, parseIntervalDays, isBiopsySuggestion, followupSeverityFor };

/**
 * Kritik bulgu kapanış döngüsü (D1) ve takip önerisi görevi (D2) sunucu katmanı.
 *
 * D1: “alındı” yetmez; bildirimin iletildiği kanıt (`relayedTo`/`relayedAt`) ve
 *     gerekirse eskalasyon kaydı tutulur. Her adım denetim izine yazılır.
 * D2: onaylı rapordaki takip önerisi, modalite/bölge/süre/durum içeren bir göreve
 *     dönüşür ve tamamlanana dek açık kalır.
 */

/** Yeni kayıtlar için varsayılan alanlar (eski kayıtlar NULL/default ile uyumludur). */
export function notificationDefaults(): Record<string, unknown> {
  return {
    kind: "finding",
    severity: "kritik",
    relayedTo: "",
    escalated: false,
    modality: "",
    bodyRegion: "",
    recommendedIntervalDays: null,
    dueDate: "",
    status: "acik",
    reportId: null,
  };
}

/** Rapor onaylanınca çağrılır: “Öneri” metnini tek bir takip görevine çevirir. */
export async function createFollowupFromReport(p: {
  studyUid: string;
  reportId: number;
  modality: string;
  bodyPart: string;
  recommendation: string;
}): Promise<number | null> {
  const rec = (p.recommendation ?? "").trim();
  if (rec.length < 3) return null;
  let days = parseIntervalDays(rec);
  if (days === null && isBiopsySuggestion(rec)) days = BIOPSY_FOLLOWUP_DAYS;
  const due = days ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) : "";
  const severity = followupSeverityFor(rec);
  const ins = await db
    .insert(notifications)
    .values({
      ...notificationDefaults(),
      kind: "followup",
      severity,
      studyUid: (p.studyUid ?? "").slice(0, 64),
      message: followupTitle(rec),
      modality: (p.modality ?? "").slice(0, 16),
      bodyRegion: (p.bodyPart ?? "").slice(0, 120),
      recommendedIntervalDays: days,
      dueDate: due,
      status: "acik",
      reportId: p.reportId,
    })
    .returning({ id: notifications.id });
  return ins[0]?.id ?? null;
}

/** Kapanış döngüsü: iletildi kanıtı / eskalasyon. */
export async function closeLoopUpdate(
  id: number,
  patch: { relayedTo?: string; escalate?: boolean }
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (typeof patch.relayedTo === "string" && patch.relayedTo.trim()) {
    set.relayedTo = patch.relayedTo.trim().slice(0, 160);
    set.relayedAt = new Date();
  }
  if (patch.escalate) {
    set.escalated = true;
    set.escalatedAt = new Date();
  }
  if (Object.keys(set).length > 0) await db.update(notifications).set(set).where(eq(notifications.id, id));
}

/**
 * Süresi dolan kritik bildirimleri tarar ve eskalasyon kaydı açar (d-close-loop).
 * - `escalate`: alınmamış ve eskalasyon süresi geçmiş bildirimler eskalasyon
 *   hedefine iletilir (relayedTo + escalated + escalatedAt yazılır).
 * - `remind`: yalnız sayım döner (bildirim gönderimi çağıran katmana aittir).
 * Her işlem `notify.escalate` olarak denetim izine yazılır.
 */
export async function sweepCloseLoop(p: {
  target: { role: string; contact: string };
  actor: { id: number; username: string; fullName: string } | null;
  now?: number;
}): Promise<{ scanned: number; overdue: number; escalated: number; details: { id: number; state: string; ageMinutes: number }[] }> {
  const rows = await db.select().from(notifications).orderBy(desc(notifications.id)).limit(500);
  const now = p.now ?? Date.now();
  const out: { id: number; state: string; ageMinutes: number }[] = [];
  let escalated = 0;
  for (const r of rows) {
    if (r.status !== "acik") continue;
    const st = loopStatus(
      { id: r.id, severity: r.severity, createdAt: r.createdAt, ackAt: r.ackAt, relayedAt: r.relayedAt, escalated: r.escalated, escalatedAt: r.escalatedAt },
      now,
    );
    if (!st.remind) continue;
    out.push({ id: r.id, state: st.state, ageMinutes: st.ageMinutes });
    if (st.state === "eskalasyon-gerekli") {
      const msg = escalationMessage(
        { id: r.id, severity: r.severity, createdAt: r.createdAt, ackAt: r.ackAt, relayedAt: r.relayedAt, escalated: r.escalated, escalatedAt: r.escalatedAt },
        st, p.target,
      );
      await db.update(notifications).set({
        escalated: true,
        escalatedAt: new Date(now),
        relayedTo: `eskalasyon:${p.target.role}${p.target.contact ? `:${p.target.contact}` : ""}`.slice(0, 160),
        relayedAt: new Date(now),
        message: r.message.endsWith(msg) ? r.message : `${r.message}\n---\n${msg}`.slice(0, 8000),
      }).where(eq(notifications.id, r.id));
      await audit(p.actor, "notify.escalate", "notification", r.id, loopAuditDetails(
        { id: r.id, severity: r.severity, createdAt: r.createdAt, ackAt: r.ackAt, relayedAt: r.relayedAt, escalated: true },
        st,
      ));
      escalated++;
    }
  }
  return { scanned: rows.filter((r) => r.status === "acik").length, overdue: out.length, escalated, details: out };
}

/** Takip görevi durumu (acik/tamamlandi/iptal). */
export async function setFollowupStatus(id: number, status: "acik" | "tamamlandi" | "iptal"): Promise<void> {
  const done = status !== "acik";
  await db.update(notifications).set({ status, completedAt: done ? new Date() : null }).where(eq(notifications.id, id));
}
