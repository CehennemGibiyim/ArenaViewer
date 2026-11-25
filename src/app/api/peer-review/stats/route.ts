import { NextRequest, NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { peerReviews, reports } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { discordanceStats, statsHeadline } from "@/lib/radpeer";

export const dynamic = "force-dynamic";

/**
 * Uyuşmazlık istatistikleri (d-peer): kaydedilmiş ikinci okumalardan özet.
 * Değerlendirilmemiş onaylı raporlar uyumlu SAYILMAZ; "kapsam" ayrı raporlanır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;

  const rows = await db
    .select({
      result: peerReviews.result,
      discrepancyType: peerReviews.discrepancyType,
      reviewedByName: peerReviews.reviewedByName,
      createdAt: peerReviews.createdAt,
    })
    .from(peerReviews)
    .limit(5000);

  const approved = await db.select({ n: count() }).from(reports).where(eq(reports.status, "onaylandi"));
  const approvedCount = Number(approved[0]?.n ?? 0);
  const stats = discordanceStats(rows);
  return NextResponse.json({
    ...stats,
    headline: statsHeadline(stats),
    approvedReports: approvedCount,
    coverage: approvedCount ? stats.known / approvedCount : null,
  });
}
