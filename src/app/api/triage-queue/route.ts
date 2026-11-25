import { NextRequest, NextResponse } from "next/server";
import { desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { studies, users } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { mapStudyRow } from "@/lib/server/studyRepo";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
const LIMIT = 500;

/** Araştırma amaçlı sıra: mevcut çalışma skoru, iş durumu ve son rapor durumu. */
export async function GET(req: NextRequest) {
  const auth = await authorize(req);
  if ("error" in auth) return auth.error;
  // Filtre ve sıralama limitten önce uygulanır; onaylı iş durumu kuyruk dışıdır.
  const rows = await db.select({ s: studies, assignedName: users.fullName })
    .from(studies).leftJoin(users, eq(users.id, studies.assignedTo))
    .where(ne(studies.workStatus, "onayli"))
    .orderBy(desc(studies.triageScore), desc(studies.updatedAt), desc(studies.id))
    .limit(LIMIT + 1);
  const latest = await db.execute(sql`select distinct on (study_id) study_id, status from reports order by study_id, id desc`);
  const statuses = new Map((latest.rows as { study_id: number; status: string }[]).map(r => [r.study_id, r.status]));
  return NextResponse.json({
    items: rows.slice(0, LIMIT).map(r => mapStudyRow(r.s, r.assignedName, statuses.get(r.s.id) ?? null)),
    truncated: rows.length > LIMIT,
  }, { headers: { "Cache-Control": "no-store" } });
}
