import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { peerReviews, reports } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { peerAdvice, summarizePeerReviews, validatePeerReview, type PeerReviewRow } from "@/lib/peerReview";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Raporun ikinci okuma kayıtları. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  const rows = await db.select().from(peerReviews).where(eq(peerReviews.reportId, id)).orderBy(desc(peerReviews.id));
  await audit(a.user, "report.peer_review_view", "report", id, { count: rows.length });
  return NextResponse.json({ reviews: rows as PeerReviewRow[], summary: summarizePeerReviews(rows as PeerReviewRow[]) });
}

/**
 * İkinci okuma kaydı oluşturur (D-peer). Yalnızca onaylı rapora yapılabilir ve
 * raporu oluşturan kişi kendi raporunu değerlendiremez.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const id = Number((await params).id);

  const r = (await db.select({ status: reports.status, createdBy: reports.createdBy, contentHash: reports.contentHash }).from(reports).where(eq(reports.id, id)).limit(1))[0];
  if (!r) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  if (r.status !== "onaylandi") return NextResponse.json({ error: "İkinci okuma yalnızca onaylı rapora uygulanır" }, { status: 409 });
  if (r.createdBy && r.createdBy === a.user.id) return NextResponse.json({ error: "Raporu oluşturan kişi aynı raporu ikinci okuyamaz" }, { status: 403 });

  const v = validatePeerReview(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const ins = await db.insert(peerReviews).values({
    reportId: id,
    result: v.value.result,
    discrepancyType: v.value.discrepancyType,
    note: v.value.note,
    reviewedBy: a.user.id,
    reviewedByName: `${a.user.title ? a.user.title + " " : ""}${a.user.fullName}`,
    contentHash: r.contentHash,
  }).returning({ id: peerReviews.id });

  await audit(a.user, "report.peer_review", "report", id, { result: v.value.result, discrepancy: v.value.discrepancyType, id: ins[0].id });
  return NextResponse.json({ ok: true, id: ins[0].id, advice: peerAdvice(v.value.result) }, { status: 201 });
}
