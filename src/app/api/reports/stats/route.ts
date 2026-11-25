import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { summarizeStats, tatAlerts, tatTarget, weeklyTrend } from "@/lib/workflowStats";

export const dynamic = "force-dynamic";

/**
 * Rapor iş akışı istatistikleri (F4): durum/modalite dağılımı, onaylanan raporların
 * turnaround süresi (medyan/p90) ve hekim başına kırılım. Radyolog ve yönetici görür.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rows = await db
    .select({
      status: reports.status,
      modality: studies.modality,
      createdAt: reports.createdAt,
      approvedAt: reports.approvedAt,
      approvedBy: reports.approvedBy,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id));

  const stats = summarizeStats(rows);
  // Hedef TAT: yönetici ayarı yoksa 24 saat (f-tat). ?targetHours= ile sorgulanabilir.
  const targetParam = Number(req.nextUrl.searchParams.get("targetHours") ?? "");
  const targetHours = Number.isFinite(targetParam) && targetParam > 0 ? Math.min(720, targetParam) : 24;
  const modality = (req.nextUrl.searchParams.get("modality") ?? "").trim();
  const weekly = weeklyTrend(rows, 8, new Date(), modality || undefined);
  const target = tatTarget(stats.medianHours, targetHours);
  return NextResponse.json({
    stats,
    weekly,
    target,
    alerts: tatAlerts(weekly, target, stats.staleDrafts.count),
    trendModality: modality,
    note: "TAT = onaylanma − oluşturulma; eksik/negatif ölçümler dışlanır. Haftalık trend onaylanma tarihine göredir.",
  });
}
