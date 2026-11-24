import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { summarizeStats } from "@/lib/workflowStats";

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

  return NextResponse.json({
    stats: summarizeStats(rows),
    note: "TAT = onaylanma − oluşturulma; eksik/negatif ölçümler dışlanır.",
  });
}
