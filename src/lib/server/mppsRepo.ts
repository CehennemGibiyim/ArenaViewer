/**
 * MPPS olaylarının çalışma kaydına uygulanması (e-hl7-mwl).
 *
 * Klinik kural: MPPS **COMPLETED**, çalışmayı "yapıldı" işaretler ama **onaylamaz**;
 * okuma iş akışı ("bekliyor") başlar. DISCONTINUED (cihaz iptali) çalışma listesine
 * düşmemeli; bu yüzden iptal edilen adım için çalışma **oluşturulmaz**, varsa
 * yalnızca durum alanına "iptal" yazılır ve denetim kaydı bırakılır.
 *
 * Çalışma bulma: MPPS Study Instance UID taşır (birincil anahtar eşleşmesi);
 * taşımıyorsa accession ile eşleşir. İkisi de yoksa olay **reddedilir** —
 * "en yakın çalışmaya yaz" gibi bir tahmin yanlış hastayı işaretler.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { decideMppsEffect, type MppsReadResult } from "@/lib/mpps";

export interface MppsApplyResult {
  applied: boolean;
  /** Eşleşen çalışma id'si (yoksa null). */
  studyId: number | null;
  workStatus: string;
  reason: string;
}

export async function applyMppsEvent(ev: MppsReadResult, actor = "mpps-bridge"): Promise<MppsApplyResult> {
  // Eşleşecek çalışma yoksa karar verilemez; UID/erişim numarası zorunlu.
  let row: { id: number; workStatus: string } | undefined;
  if (ev.studyUid) {
    row = (await db.select({ id: studies.id, workStatus: studies.workStatus }).from(studies).where(eq(studies.studyUid, ev.studyUid)).limit(1))[0];
  }
  if (!row && ev.accession) {
    row = (await db.select({ id: studies.id, workStatus: studies.workStatus }).from(studies).where(eq(studies.accession, ev.accession)).limit(1))[0];
  }
  if (!row) {
    if (ev.status === "DISCONTINUED") {
      await audit(null, "mpps.discontinued", "study", ev.studyUid || ev.accession, { accession: ev.accession, actor });
      return { applied: false, studyId: null, workStatus: "", reason: "Adım iptal (DISCONTINUED) — çalışma oluşturulmadı" };
    }
    const probe = decideMppsEffect("", ev);
    return { applied: false, studyId: null, workStatus: probe.workStatus, reason: `Eşleşen çalışma yok (studyUid=${ev.studyUid || "-"}, accession=${ev.accession || "-"})` };
  }

  const decision = decideMppsEffect(row.workStatus, ev);
  if (!decision.apply) {
    await audit(null, ev.status === "DISCONTINUED" ? "mpps.discontinued" : "mpps.ignored", "study", row.id, {
      status: ev.status, workStatus: row.workStatus, reason: decision.reason, actor,
    });
    return { applied: false, studyId: row.id, workStatus: row.workStatus, reason: decision.reason };
  }
  await db.update(studies).set({ workStatus: decision.workStatus, updatedAt: new Date() }).where(eq(studies.id, row.id));
  await audit(null, "mpps.update", "study", row.id, { status: ev.status, workStatus: decision.workStatus, mppsUid: ev.mppsUid, actor });
  return { applied: true, studyId: row.id, workStatus: decision.workStatus, reason: decision.reason };
}
