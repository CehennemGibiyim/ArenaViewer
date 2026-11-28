/**
 * t-privacy — satır düzeyi erişim + saklama (retention) DB katmanı.
 *
 * `visibleReportsFor`: kullanıcının görebileceği rapor satırlarını (satır düzeyi
 * rol matrisi) veritabanında filtreler; `/api/reports` ve `/api/reports/[id]`
 * bu görünüme bağlanır.
 *
 * `retentionSweep`: saklama politikasıyla pencere dışı kayıtları siler;
 * korunaklı (imzalı) raporlar silinmez, her silme denetim kaydına yazılır.
 * Tablo çalışma anında `CREATE INDEX IF NOT EXISTS` ile hazırlanır.
 */
import {
  canViewReport,
  planRetentionSweep,
  retentionPolicyFromEnv,
  retentionSummary,
} from "@/lib/privacyPolicy";
import type { UserInfo } from "@/lib/types";

let indexReady = false;
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

export async function ensurePrivacyIndexes(): Promise<void> {
  if (indexReady) return;
  const { sql } = await import("drizzle-orm");
  const d = await db();
  await d.execute(sql.raw(`CREATE INDEX IF NOT EXISTS reports_created_by_idx ON reports (created_by)`));
  await d.execute(sql.raw(`CREATE INDEX IF NOT EXISTS studies_assigned_to_idx ON studies (assigned_to)`));
  indexReady = true;
}

/**
 * Kullanıcının görebileceği tam rapor satırları (satır düzeyi matrisiyle).
 * Veritabanında filtrelenir: radyolog yalnızca createdBy/assignedTo eşleşmeleri,
 * teknisyen hiç rapor görmez; saf karar çekirdeği ile ikinci kontrol de yapılır.
 * `studyUid` varsa SQL seviyesinde filtre (sayısal sınırlandırma tutarlılığı).
 */
export async function visibleReportsFor(
  user: UserInfo,
  studyUid = ""
): Promise<Array<{ r: typeof import("@/db/schema").reports.$inferSelect; s: typeof import("@/db/schema").studies.$inferSelect }>> {
  const { asc, eq, or, and } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const base = d.select({ r: t.reports, s: t.studies })
    .from(t.reports)
    .innerJoin(t.studies, eq(t.reports.studyId, t.studies.id));

  const conditions = [];
  if (user.role === "radyolog") {
    conditions.push(or(eq(t.reports.createdBy, user.id), eq(t.studies.assignedTo, user.id)));
  } else if (user.role === "teknisyen") {
    // Teknisyen hiç rapor görmez → eşleşme sağlayacak koşul yok.
    conditions.push(eq(t.reports.id, -1));
  }
  if (studyUid) {
    conditions.push(eq(t.studies.studyUid, studyUid));
  }
  const query = conditions.length ? base.where(and(...conditions)) : base;
  const rows = await query.orderBy(asc(t.reports.id));
  // Saf karar çekirdeği ile de ikinci kontrol (DB koruması + tutarlılık).
  return rows.filter((x) => canViewReport(user, x.r, x.s));
}

/** Belirli bir rapora erişim (uç `/api/reports/[id]`). */
export async function reportAccessFor(
  user: UserInfo,
  reportId: number
): Promise<{ ok: true; row: { r: typeof import("@/db/schema").reports.$inferSelect; s: typeof import("@/db/schema").studies.$inferSelect } } | { ok: false; reason: string }> {
  const { eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const row = (await d.select({ r: t.reports, s: t.studies }).from(t.reports)
    .innerJoin(t.studies, eq(t.reports.studyId, t.studies.id))
    .where(eq(t.reports.id, reportId))
    .limit(1))[0];
  if (!row) return { ok: false, reason: "Rapor bulunamadı" };
  if (!canViewReport(user, row.r, row.s)) {
    return { ok: false, reason: "Bu rapora erişiminiz yok" };
  }
  return { ok: true, row };
}

/**
 * Saklama sweep'i: politika açıksa pencere dışı kayıtlar silinir.
 * Korunaklı (imzalı) raporlar silinmez; her silme `privacy.retention_delete`
 * denetimiyle kaydedilir. Kapalı politika → hiçbir şey silinmez (sessiz).
 */
export async function retentionSweep(
  actor: UserInfo,
  policy: ReturnType<typeof retentionPolicyFromEnv> = retentionPolicyFromEnv()
) {
  const { desc, eq } = await import("drizzle-orm");
  const t = await schema();
  const d = await db();
  const a = await audit();
  const summary = retentionSummary({ toDelete: [], protected: [], kept: [] });

  // Gerçek sweep: politika kapalıysa hiç çalışmaz.
  if (
    retentionDaysFor(policy, "report") <= 0 &&
    retentionDaysFor(policy, "share") <= 0 &&
    retentionDaysFor(policy, "notification") <= 0
  ) {
    return { ...summary, policy: retentionPolicyFromEnv(), deleted: { report: 0, share: 0, notification: 0 } };
  }

  const deleted = { report: 0, share: 0, notification: 0 };

  // Report sweep: imzalı olanlar korunaklı.
  if (retentionDaysFor(policy, "report") > 0) {
    const cutoff = Date.now() - policy.reportDays * 86_400_000;
    const rows = await d.select({
      id: t.reports.id,
      status: t.reports.status,
      signatureMeta: t.reports.signatureMeta,
      createdAt: t.reports.createdAt,
    })
      .from(t.reports)
      .orderBy(desc(t.reports.createdAt))
      .limit(2000);
    const candidates = rows
      .filter((r) => r.createdAt.getTime() < cutoff && !(r.signatureMeta && r.signatureMeta.trim()))
      .map((r) => ({ id: r.id, kind: "report" as const, createdAt: r.createdAt, immutable: false }));
    const plan = planRetentionSweep(candidates, policy);
    for (const item of plan.toDelete) {
      await d.delete(t.reports).where(eq(t.reports.id, item.id));
      deleted.report++;
    }
    if (plan.toDelete.length) {
      await a(actor, "privacy.retention_delete", "report", "", {
        kind: "report", count: plan.toDelete.length, days: policy.reportDays, ids: plan.toDelete.slice(0, 50).map((x) => x.id),
      });
    }
  }

  // Share sweep.
  if (retentionDaysFor(policy, "share") > 0) {
    const cutoff = Date.now() - policy.shareDays * 86_400_000;
    const rows = await d.select({ id: t.shareLinks.id, createdAt: t.shareLinks.createdAt })
      .from(t.shareLinks)
      .orderBy(desc(t.shareLinks.createdAt))
      .limit(2000);
    const candidates = rows
      .filter((r) => r.createdAt.getTime() < cutoff)
      .map((r) => ({ id: r.id, kind: "share" as const, createdAt: r.createdAt }));
    const plan = planRetentionSweep(candidates, policy);
    for (const item of plan.toDelete) {
      await d.delete(t.shareLinks).where(eq(t.shareLinks.id, item.id));
      deleted.share++;
    }
    if (plan.toDelete.length) {
      await a(actor, "privacy.retention_delete", "share_link", "", {
        kind: "share", count: plan.toDelete.length, days: policy.shareDays,
      });
    }
  }

  // Notification sweep.
  if (retentionDaysFor(policy, "notification") > 0) {
    const cutoff = Date.now() - policy.notificationDays * 86_400_000;
    const rows = await d.select({ id: t.notifications.id, createdAt: t.notifications.createdAt })
      .from(t.notifications)
      .orderBy(desc(t.notifications.createdAt))
      .limit(2000);
    const candidates = rows
      .filter((r) => r.createdAt.getTime() < cutoff)
      .map((r) => ({ id: r.id, kind: "notification" as const, createdAt: r.createdAt }));
    const plan = planRetentionSweep(candidates, policy);
    for (const item of plan.toDelete) {
      await d.delete(t.notifications).where(eq(t.notifications.id, item.id));
      deleted.notification++;
    }
    if (plan.toDelete.length) {
      await a(actor, "privacy.retention_delete", "notification", "", {
        kind: "notification", count: plan.toDelete.length, days: policy.notificationDays,
      });
    }
  }

  return {
    ...summary,
    deleted,
    policy,
  };
}

function retentionDaysFor(policy: ReturnType<typeof retentionPolicyFromEnv>, kind: "report" | "share" | "notification"): number {
  return kind === "report" ? policy.reportDays : kind === "share" ? policy.shareDays : policy.notificationDays;
}
