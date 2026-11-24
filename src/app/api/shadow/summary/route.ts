import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { shadowFindings } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { summarizeShadow } from "@/lib/shadowMode";

export const dynamic = "force-dynamic";

/** Gölge mod özeti: motor/model bazında kayıt ve bulgu sayısı (yalnızca yönetici). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;

  try {
    const rows = await db
      .select({
        engine: shadowFindings.engine,
        model: shadowFindings.model,
        finding_count: shadowFindings.findingCount,
        createdAt: shadowFindings.createdAt,
      })
      .from(shadowFindings)
      .orderBy(desc(shadowFindings.id))
      .limit(500);
    return NextResponse.json({ ok: true, total: rows.length, summary: summarizeShadow(rows) });
  } catch (e) {
    return NextResponse.json(
      { error: `gölge özeti alınamadı: ${e instanceof Error ? e.message : "hata"}` },
      { status: 500 },
    );
  }
}
