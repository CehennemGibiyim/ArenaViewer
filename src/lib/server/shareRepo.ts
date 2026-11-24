import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, shareLinks, studies } from "@/db/schema";
import { mapReport } from "@/lib/server/studyRepo";
import { isUsable, ttlToExpiresAt, type ShareKind, type ShareRow, type SharedPayload } from "@/lib/share";

/** 192 bitlik öngörülemez token (hex). */
export const newShareToken = () => randomBytes(24).toString("hex");

export interface CreateShareInput {
  kind: ShareKind;
  reportId?: number;
  studyId?: number;
  createdBy: number | null;
  createdByName: string;
  ttlHours: number;
}

/** Yeni paylaşım bağlantısı oluşturur. */
export async function createShare(input: CreateShareInput): Promise<ShareRow> {
  const [row] = await db
    .insert(shareLinks)
    .values({
      token: newShareToken(),
      kind: input.kind,
      reportId: input.reportId ?? null,
      studyId: input.studyId ?? null,
      createdBy: input.createdBy,
      createdByName: input.createdByName,
      expiresAt: ttlToExpiresAt(input.ttlHours),
    })
    .returning();
  return row as unknown as ShareRow;
}

/** Kullanıcının (veya tüm) bağlantıları. */
export async function listShares(userId: number | "all" = "all"): Promise<ShareRow[]> {
  const q = db.select().from(shareLinks).orderBy(desc(shareLinks.id));
  const rows = userId === "all" ? await q : await q.where(eq(shareLinks.createdBy, userId));
  return rows as unknown as ShareRow[];
}

/** Bağlantıyı kapatır; zaten kapalıysa son kaydı döndürür. */
export async function revokeShare(token: string, actorId: number | null): Promise<ShareRow | null> {
  const cur = (await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0];
  if (!cur) return null;
  if (cur.revokedAt || (actorId !== null && cur.createdBy !== null && cur.createdBy !== actorId)) return cur as unknown as ShareRow;
  const [row] = await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.token, token)).returning();
  return row as unknown as ShareRow;
}

export type OpenResult =
  | { ok: true; payload: SharedPayload; state: string }
  | { ok: false; status: number; error: string };

/**
 * Token ile paylaşım yükünü üretir. Erişim sayacı ve son erişim zamanı yalnızca
 * geçerli (süresi dolmamış, kapatılmamış) bağlantılarda artar.
 */
export async function openShare(token: string, now = new Date()): Promise<OpenResult> {
  const link = (await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0] as ShareRow | undefined;
  if (!link) return { ok: false, status: 404, error: "Bağlantı bulunamadı." };
  if (link.revokedAt) return { ok: false, status: 410, error: "Bu paylaşım bağlantısı kapatılmış." };
  if (!isUsable(link, now)) return { ok: false, status: 410, error: "Bu paylaşım bağlantısının süresi dolmuş." };

  // Geçerli erişim: sayacı artır (okuma-yazma tutarlılığı tek satırda).
  await db.update(shareLinks).set({ accessCount: link.accessCount + 1, lastAccessAt: now }).where(eq(shareLinks.token, token));

  if (!link.reportId) return { ok: false, status: 410, error: "Paylaşılan rapor artık mevcut değil." };
  const rr = (await db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id)).where(eq(reports.id, link.reportId)).limit(1))[0];
  if (!rr) return { ok: false, status: 410, error: "Paylaşılan rapor artık mevcut değil." };
  const rep = mapReport(rr.r, rr.s);
  // Anahtar kesit tek veri URL'i olarak saklanır (boş olabilir).
  const ki = rep.keyImageDataUrl.trim();
  const keyImages = /^data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+$/i.test(ki) ? [ki] : [];

  return {
    ok: true,
    state: "aktif",
    payload: {
      kind: link.kind,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      patient: { name: rep.patientName, id: rep.patientId, sex: rep.patientSex, age: rep.patientAge },
      modality: rep.modality,
      studyDate: rep.studyDate,
      report: {
        status: rep.status,
        technique: rep.technique,
        findings: rep.findingsText,
        impression: rep.impression,
        recommendation: rep.recommendation,
        approvedBy: rep.approvedBy,
        doctorTitle: rep.doctorTitle,
        approvedAt: rep.approvedAt,
        findingCount: rep.findingsJson.length,
      },
      keyImages,
      watermark: "",
    } satisfies SharedPayload,
  };
}
