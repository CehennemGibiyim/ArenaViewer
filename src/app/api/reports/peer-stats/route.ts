import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { peerReviews, reports } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { getSetting } from "@/lib/server/settings";
import { peerStats, samplingTarget, shouldSampleReport, type PeerReviewRow } from "@/lib/peerReview";

export const dynamic = "force-dynamic";

/**
 * İkinci okuma gözetim panosu (d-peer).
 *
 * GET /api/reports/peer-stats → RADPEER dağılımı, uyum oranı, hekim başına
 * kırılım, uyuşmazlık türleri, örneklem hedefi ve örnekleme listesi (deterministik).
 *
 * Örneklem oranı `peerReviewSamplePct` ayarından gelir (varsayılan %5); hastaya
 * ait metin dönmez, yalnız sayaçlar ve rapor kimlikleri.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;

  const rows = await db
    .select({
      id: peerReviews.id,
      reportId: peerReviews.reportId,
      result: peerReviews.result,
      discrepancyType: peerReviews.discrepancyType,
      note: peerReviews.note,
      reviewedBy: peerReviews.reviewedBy,
      reviewedByName: peerReviews.reviewedByName,
      contentHash: peerReviews.contentHash,
      createdAt: peerReviews.createdAt,
    })
    .from(peerReviews)
    .orderBy(desc(peerReviews.createdAt))
    .limit(5000);

  const list: PeerReviewRow[] = rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString() ?? "" }));
  const stats = peerStats(list);

  // Onaylı raporlar: örneklem hedefi ve hangi raporların okunması gerektiği.
  const approved = await db
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.status, "onaylandi"))
    .limit(5000);
  const ratePct = Number(await getSetting("peerReviewSamplePct", "5")) || 0;
  const reviewedIds = new Set(list.map((r) => r.reportId));
  const target = samplingTarget(approved.length, ratePct, reviewedIds.size);
  const queue = approved
    .filter((r) => shouldSampleReport(r.id, ratePct) && !reviewedIds.has(r.id))
    .map((r) => r.id)
    .slice(0, 50);

  return NextResponse.json({
    stats,
    target,
    samplePct: ratePct,
    approvedReports: approved.length,
    queue,
    note: "RADPEER: puan 1–2 uyumlu sayılır. Örnekleme deterministiktir (aynı rapor her zaman aynı sonuca düşer); oran Yönetim → İş akışı bölümünden değiştirilir.",
  });
}
