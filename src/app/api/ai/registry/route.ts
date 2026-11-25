import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiModelRegistry } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import {
  assignModel, registryIssues, stageChangeNote, stageSummary, validateEntry,
  type ModelStage, type RegistryEntry,
} from "@/lib/modelRegistry";

export const dynamic = "force-dynamic";

const MAX_ROWS = 200;

const toEntry = (r: typeof aiModelRegistry.$inferSelect): RegistryEntry => ({
  id: r.id,
  name: r.name,
  version: r.version,
  modality: r.modality,
  task: r.task,
  stage: (r.stage as ModelStage) ?? "aday",
  trafficPercent: r.trafficPercent,
  fingerprint: r.fingerprint,
  notes: r.notes,
  updatedAt: r.updatedAt?.toISOString(),
});

/**
 * Model kayıt defteri (a-modelops).
 *
 * GET  /api/ai/registry            → tüm kayıtlar + aşama sayımı + tutarlılık uyarıları
 * GET  /api/ai/registry?task=…&seed=… → deterministik A/B ataması (hangi model)
 * POST /api/ai/registry            → kayıt ekle/güncelle (yalnız yönetici, denetim izli)
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const rows = await db
    .select()
    .from(aiModelRegistry)
    .orderBy(asc(aiModelRegistry.task), asc(aiModelRegistry.name), asc(aiModelRegistry.version))
    .limit(MAX_ROWS);
  const entries = rows.map(toEntry);
  const sp = req.nextUrl.searchParams;
  const seed = sp.get("seed");
  const task = sp.get("task") ?? "";
  const assignment = seed
    ? assignModel(entries, { seed, task: task || undefined })
    : null;
  return NextResponse.json({
    entries,
    summary: stageSummary(entries),
    issues: registryIssues(entries),
    assignment: assignment
      ? { name: assignment.model?.name ?? null, version: assignment.model?.version ?? null, bucket: assignment.bucket, reason: assignment.reason }
      : null,
  });
}

interface Body {
  name?: string; version?: string; modality?: string; task?: string;
  stage?: string; trafficPercent?: number | string; fingerprint?: string; notes?: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(",", ".")) : NaN);

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b) return NextResponse.json({ error: "Eksik veri" }, { status: 400 });
  const stage = (b.stage ?? "aday") as ModelStage;
  const candidate: Partial<RegistryEntry> = {
    name: (b.name ?? "").trim().slice(0, 80),
    version: (b.version ?? "").trim().slice(0, 40),
    modality: (b.modality ?? "").trim().slice(0, 20),
    task: (b.task ?? "").trim().slice(0, 60),
    stage,
    trafficPercent: num(b.trafficPercent),
    fingerprint: (b.fingerprint ?? "").trim().slice(0, 200),
    notes: (b.notes ?? "").trim().slice(0, 500),
  };
  const issues = validateEntry(candidate);
  if (issues.length > 0) return NextResponse.json({ error: issues[0], issues }, { status: 400 });

  const existing = (await db
    .select()
    .from(aiModelRegistry)
    .where(and(eq(aiModelRegistry.name, candidate.name!), eq(aiModelRegistry.version, candidate.version!)))
    .limit(1))[0];

  const values = {
    name: candidate.name!,
    version: candidate.version!,
    modality: candidate.modality ?? "",
    task: candidate.task ?? "",
    stage,
    trafficPercent: candidate.trafficPercent as number,
    fingerprint: candidate.fingerprint ?? "",
    notes: candidate.notes ?? "",
    updatedBy: a.user.id,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(aiModelRegistry).set(values).where(eq(aiModelRegistry.id, existing.id));
  } else {
    await db.insert(aiModelRegistry).values({ ...values, createdBy: a.user.id });
  }
  const prevStage = (existing?.stage as ModelStage | undefined) ?? null;
  await audit(a.user, stage === "aktif" && prevStage !== "aktif" ? "model.activate" : "model.register", "ai_model", `${values.name}@${values.version}`, {
    stage,
    trafficPercent: values.trafficPercent,
    change: stageChangeNote(prevStage, stage),
  }).catch(() => undefined);

  const rows = await db.select().from(aiModelRegistry).orderBy(asc(aiModelRegistry.task), asc(aiModelRegistry.name)).limit(MAX_ROWS);
  const entries = rows.map(toEntry);
  return NextResponse.json({ ok: true, entries, summary: stageSummary(entries), issues: registryIssues(entries) });
}
