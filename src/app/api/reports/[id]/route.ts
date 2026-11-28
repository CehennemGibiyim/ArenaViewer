import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportAddenda, reportVersions } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { mapReport } from "@/lib/server/studyRepo";
import { reportAccessFor } from "@/lib/server/privacyRepo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const id = Number((await params).id);
  // Satır düzeyi erişim matrisi (t-privacy): erişim olmayan kullanıcı 404 alır
  // (varlığın sızıntısı önlenir — "bulunamadı" ile aynı yanıt).
  const acc = await reportAccessFor(a.user, id);
  if (!acc.ok) {
    return NextResponse.json({ error: acc.reason }, { status: 404 });
  }
  const rr = acc.row;
  const versions = await db
    .select({ id: reportVersions.id, versionNo: reportVersions.versionNo, action: reportVersions.action, createdByName: reportVersions.createdByName, createdAt: reportVersions.createdAt, snapshot: reportVersions.snapshot })
    .from(reportVersions).where(eq(reportVersions.reportId, id)).orderBy(desc(reportVersions.versionNo));
  const addenda = await db
    .select({ id: reportAddenda.id, text: reportAddenda.text, createdByName: reportAddenda.createdByName, createdAt: reportAddenda.createdAt })
    .from(reportAddenda).where(eq(reportAddenda.reportId, id)).orderBy(desc(reportAddenda.id));
  await audit(a.user, "report.view", "report", id);
  return NextResponse.json({ report: mapReport(rr.r, rr.s), versions, addenda });
}
