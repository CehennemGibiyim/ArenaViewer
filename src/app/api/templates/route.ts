import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportTemplates } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { SEED } from "@/lib/templates";
import { RADREPORT_SEED, isStandardCode } from "@/lib/templateRank";

export const dynamic = "force-dynamic";

/** Şablon listesi; modalite/bölge/endikasyon/protokol alanlarıyla döner. */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  // Tohum şablonlar idempotent biçimde tamamlanır: yeni sürümlerde listeye eklenen
  // şablonlar (ör. MR/US/MG seti) eski kurumlara da geçer; elle eklenenler korunur.
  const existing = await db.select({ name: reportTemplates.name }).from(reportTemplates);
  const names = new Set(existing.map((x) => x.name));
  const missing = SEED.filter((s) => !names.has(s.name));
  if (missing.length > 0) {
    // Tohum şablonlar RadReport kodlarıyla eklenir (r-template): kütüphane
    // izlenebilir olsun; kod yoksa boş kalır ve "kuruma özgü" sayılır.
    await db.insert(reportTemplates).values(missing.map((m) => ({ ...m, radreportCode: RADREPORT_SEED[m.name] ?? "" })));
  }

  const sp = req.nextUrl.searchParams;
  const modality = (sp.get("modality") ?? "").trim().toUpperCase();
  const q = (sp.get("q") ?? "").trim().toLocaleLowerCase("tr-TR");

  let rows = await db.select().from(reportTemplates).orderBy(asc(reportTemplates.id));
  // Kodsuz tohum satırları (önceki sürümde eklenmiş) kodu sonradan kazanır.
  for (const r of rows) {
    const kod = RADREPORT_SEED[r.name];
    if (kod && !isStandardCode(r.radreportCode ?? "") && (r.radreportCode ?? "") !== kod) {
      await db.update(reportTemplates).set({ radreportCode: kod }).where(eq(reportTemplates.id, r.id));
      r.radreportCode = kod;
    }
  }
  rows = rows.filter((r) => !modality || r.modality.toUpperCase() === modality);
  if (q) {
    rows = rows.filter((r) =>
      [r.name, r.bodyPart, r.indication, r.protocol].join(" ").toLocaleLowerCase("tr-TR").includes(q)
    );
  }
  return NextResponse.json(rows.map(({ createdBy: _c, createdAt: _t, ...r }) => r));
}

const clean = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!clean(b.name, 120)) return NextResponse.json({ error: "Şablon adı gerekli" }, { status: 400 });
  const ins = await db.insert(reportTemplates).values({
    name: clean(b.name, 120),
    modality: clean(b.modality, 16),
    bodyPart: clean(b.bodyPart, 120),
    indication: clean(b.indication, 200),
    protocol: clean(b.protocol, 500),
    technique: clean(b.technique),
    findings: clean(b.findings),
    impression: clean(b.impression),
    recommendation: clean(b.recommendation),
    radreportCode: clean(b.radreportCode, 24).toUpperCase(),
    createdBy: a.user.id,
  }).returning({ id: reportTemplates.id });
  await audit(a.user, "template.create", "template", ins[0].id, { name: clean(b.name, 120) });
  return NextResponse.json({ ok: true, id: ins[0].id });
}

export async function PATCH(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as { id?: number } & Record<string, unknown> | null;
  if (!b?.id) return NextResponse.json({ error: "id gerekli" }, { status: 400 });
  const cur = (await db.select().from(reportTemplates).where(eq(reportTemplates.id, b.id)).limit(1))[0];
  if (!cur) return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });

  const set: Record<string, string> = {};
  for (const k of ["name", "modality", "bodyPart", "indication", "protocol", "technique", "findings", "impression", "recommendation", "radreportCode"] as const) {
    if (k === "radreportCode" && typeof b[k] === "string") { set[k] = (b[k] as string).trim().toUpperCase().slice(0, 24); continue; }
    if (typeof b[k] === "string") set[k] = b[k].trim().slice(0, k === "name" ? 120 : k === "bodyPart" ? 120 : k === "protocol" ? 500 : k === "modality" ? 16 : 2000);
  }
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Değişiklik yok" }, { status: 400 });
  await db.update(reportTemplates).set(set).where(eq(reportTemplates.id, cur.id));
  await audit(a.user, "template.update", "template", cur.id, { fields: Object.keys(set) });
  return NextResponse.json({ ok: true });
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
