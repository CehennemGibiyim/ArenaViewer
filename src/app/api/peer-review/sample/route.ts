import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { peerReviews, reports, studies } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { pickSample, type Candidate } from "@/lib/radpeer";

export const dynamic = "force-dynamic";

/**
 * RADPEER örneklemi (d-peer): onaylı raporlardan günlük deterministik örneklem.
 *
 * - Kendi raporun ve bu kullanıcının zaten değerlendirdiği raporlar aday değildir.
 * - Oran `rate` parametresiyle gelir (varsayılan %5, 1–100 arası kırpılır);
 *   hedefe ulaşılamazsa yanıtta `note` ile açıkça söylenir, uydurma seçim yapılmaz.
 * - Seçim güne bağlı karmayla yapılır: aynı gün panel yenilense de liste aynı kalır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rate = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("rate") ?? 5) || 5));

  const rows = await db
    .select({
      reportId: reports.id,
      studyId: reports.studyId,
      approvedAt: reports.approvedAt,
      approvedBy: reports.approvedBy,
      createdBy: reports.createdBy,
      patientName: studies.patientName,
      patientId: studies.patientId,
      modality: studies.modality,
      studyDate: studies.studyDate,
      seriesDescription: studies.seriesDescription,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id))
    .where(eq(reports.status, "onaylandi"))
    .orderBy(desc(reports.approvedAt))
    .limit(500);

  const myReviews = await db
    .select({ reportId: peerReviews.reportId })
    .from(peerReviews)
    .where(and(eq(peerReviews.reviewedBy, a.user.id)))
    .limit(2000);
  const mine = new Set(myReviews.map((r) => r.reportId));

  const candidates: Candidate[] = rows
    .filter((r) => r.createdBy !== a.user.id) // kendi raporu ikinci okunamaz
    .map((r) => ({
      reportId: r.reportId,
      studyId: r.studyId,
      approvedAt: r.approvedAt,
      approvedBy: r.approvedBy,
      createdBy: r.createdBy,
      reviewedByMe: mine.has(r.reportId),
    }));

  const day = new Date().toISOString().slice(0, 10);
  const sample = pickSample(candidates, rate, day, 1, 50);
  const byId = new Map(rows.map((r) => [r.reportId, r]));
  return NextResponse.json({
    rate, target: sample.target, eligible: sample.eligible, note: sample.note,
    items: sample.picked.map((c) => {
      const r = byId.get(c.reportId)!;
      return {
        reportId: c.reportId, studyId: c.studyId, approvedAt: c.approvedAt, approvedBy: c.approvedBy,
        patientName: r.patientName, patientId: r.patientId, modality: r.modality,
        studyDate: r.studyDate, seriesDescription: r.seriesDescription,
      };
    }),
  });
}
