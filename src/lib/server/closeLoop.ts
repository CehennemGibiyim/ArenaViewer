import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { followupTitle, parseIntervalDays } from "@/lib/followupText";

export { followupTitle, parseIntervalDays };

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
  const days = parseIntervalDays(rec);
  const due = days ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) : "";
  const ins = await db
    .insert(notifications)
    .values({
      ...notificationDefaults(),
      kind: "followup",
      severity: "bilgi",
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

/** Takip görevi durumu (acik/tamamlandi/iptal). */
export async function setFollowupStatus(id: number, status: "acik" | "tamamlandi" | "iptal"): Promise<void> {
  const done = status !== "acik";
  await db.update(notifications).set({ status, completedAt: done ? new Date() : null }).where(eq(notifications.id, id));
}
