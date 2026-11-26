/**
 * Canlı akış beslemesi: `GET /api/ingest/feed?studyUid=…&after=<fileId>`
 *
 * Oturum açmış kullanıcıya, depolanmış çalışma için `after`'dan sonra eklenen
 * dosyaları döner (id artan sırada). Workstation "Canlı XA/US" modunda ~2 sn'de
 * bir yoklar; gelen dosyaları çekip açık XA/US serisine ekler.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { storedFiles, studies } from "@/db/schema";
import { authorize } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const studyUid = (sp.get("studyUid") ?? "").trim();
  const after = Number(sp.get("after") ?? "0");
  if (!studyUid) return NextResponse.json({ error: "studyUid gerekli" }, { status: 400 });
  if (!Number.isFinite(after) || after < 0) return NextResponse.json({ error: "after geçersiz" }, { status: 400 });

  const st = await db.select({ id: studies.id }).from(studies).where(eq(studies.studyUid, studyUid)).limit(1);
  if (!st[0]) return NextResponse.json({ files: [], hasMore: false });

  const files = await db
    .select({ id: storedFiles.id, name: storedFiles.name, size: storedFiles.size })
    .from(storedFiles)
    .where(and(eq(storedFiles.studyId, st[0].id), gt(storedFiles.id, after)))
    .orderBy(asc(storedFiles.id))
    .limit(200);
  return NextResponse.json({ files, hasMore: files.length === 200 });
}
