import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportTemplates } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { SEED } from "@/lib/templates";

export const dynamic = "force-dynamic";


export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  // Tohum şablonlar idempotent biçimde tamamlanır: yeni sürümlerde listeye eklenen
  // şablonlar (ör. MR/US/MG seti) eski kurumlara da geçer; elle eklenenler korunur.
  const existing = await db.select({ name: reportTemplates.name }).from(reportTemplates);
  const names = new Set(existing.map((x) => x.name));
  const missing = SEED.filter((s) => !names.has(s.name));
  if (missing.length > 0) await db.insert(reportTemplates).values(missing);
  const rows = await db.select().from(reportTemplates).orderBy(asc(reportTemplates.id));
  return NextResponse.json(rows.map(({ createdBy: _c, createdAt: _t, ...r }) => r));
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.name?.trim()) return NextResponse.json({ error: "Şablon adı gerekli" }, { status: 400 });
  const ins = await db.insert(reportTemplates).values({
    name: b.name.trim().slice(0, 120), modality: b.modality ?? "", bodyPart: b.bodyPart ?? "", technique: b.technique ?? "",
    findings: b.findings ?? "", impression: b.impression ?? "", recommendation: b.recommendation ?? "", createdBy: a.user.id,
  }).returning({ id: reportTemplates.id });
  await audit(a.user, "template.create", "template", ins[0].id, { name: b.name });
  return NextResponse.json({ ok: true, id: ins[0].id });
}

export async function DELETE(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const id = Number(req.nextUrl.searchParams.get("id"));
  const t = (await db.select().from(reportTemplates).where(eq(reportTemplates.id, id)).limit(1))[0];
  if (!t) return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });
  if (a.user.role !== "yonetici" && t.createdBy !== a.user.id) return NextResponse.json({ error: "Yalnızca kendi şablonunuzu silebilirsiniz" }, { status: 403 });
  await db.delete(reportTemplates).where(eq(reportTemplates.id, id));
  await audit(a.user, "template.delete", "template", id, { name: t.name });
  return NextResponse.json({ ok: true });
}
