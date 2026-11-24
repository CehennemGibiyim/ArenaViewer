import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { SHARE_TTL_HOURS, isShareKind } from "@/lib/share";
import { createShare, listShares } from "@/lib/server/shareRepo";

export const dynamic = "force-dynamic";

/** Paylaşım bağlantısı listesi (yalnızca oluşturan kullanıcı; yönetici tümü). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rows = await listShares(a.user.role === "yonetici" ? "all" : a.user.id);
  return NextResponse.json({ shares: rows });
}

/** Yeni paylaşım bağlantısı: şimdilik rapor (metin + anahtar kesitler). */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (!isShareKind(b.kind)) return NextResponse.json({ error: "Şu an yalnızca 'report' paylaşılabilir" }, { status: 400 });
  const reportId = Number(b.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return NextResponse.json({ error: "Geçersiz rapor kimliği" }, { status: 400 });
  const ttlHours = Number(b.ttlHours ?? 24);
  if (!(SHARE_TTL_HOURS as readonly number[]).includes(ttlHours)) {
    return NextResponse.json({ error: `Süre şunlardan biri olmalı: ${SHARE_TTL_HOURS.join(", ")} saat` }, { status: 400 });
  }

  const r = (await db.select({ id: reports.id, status: reports.status }).from(reports).where(eq(reports.id, reportId)).limit(1))[0];
  if (!r) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  if (r.status !== "onaylandi") return NextResponse.json({ error: "Yalnızca onaylı rapor paylaşılabilir" }, { status: 409 });

  const link = await createShare({
    kind: "report",
    reportId,
    createdBy: a.user.id,
    createdByName: `${a.user.title ? a.user.title + " " : ""}${a.user.fullName}`,
    ttlHours,
  });
  await audit(a.user, "share.create", "report", reportId, { tokenPrefix: link.token.slice(0, 8), ttlHours, expiresAt: link.expiresAt });
  return NextResponse.json({
    ok: true,
    token: link.token,
    url: `/paylas/${link.token}`,
    expiresAt: link.expiresAt,
  }, { status: 201 });
}
