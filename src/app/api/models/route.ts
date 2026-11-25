import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelRegistry } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { registrySummary, validateRegistration, type ModelStage, type ModelVersion } from "@/lib/modelRegistry";

export const dynamic = "force-dynamic";

const toModel = (r: typeof modelRegistry.$inferSelect): ModelVersion => ({
  id: r.id, modelKey: r.modelKey, version: r.version, stage: r.stage as ModelStage,
  trafficPct: r.trafficPct, artifactHash: r.artifactHash, notes: r.notes,
  createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/** Kayıt defteri listesi + özet (yönetici). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const rows = (await db.select().from(modelRegistry).orderBy(asc(modelRegistry.modelKey), asc(modelRegistry.createdAt))).map(toModel);
  return NextResponse.json({ models: rows, summary: registrySummary(rows) });
}

/**
 * Yeni sürüm kaydı veya mevcut sürümün güncellenmesi.
 * Aşama/trafik kuralları `validateRegistration` içinde; her değişiklik denetime yazılır.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const v = validateRegistration(await req.json().catch(() => null));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const { modelKey, version, stage, trafficPct, artifactHash, notes } = v.value!;
  const before = (await db.select().from(modelRegistry)
    .where(and(eq(modelRegistry.modelKey, modelKey), eq(modelRegistry.version, version))).limit(1))[0] ?? null;

  const values = { modelKey, version, stage, trafficPct, artifactHash, notes, createdBy: `${a.user.title ? a.user.title + " " : ""}${a.user.fullName}`, updatedAt: new Date() };
  const [saved] = await db.insert(modelRegistry).values(values)
    .onConflictDoUpdate({ target: [modelRegistry.modelKey, modelRegistry.version], set: { stage, trafficPct, artifactHash, notes, updatedAt: new Date() } })
    .returning();

  await audit(a.user, before ? "model_registry.update" : "model_registry.register", "model", `${modelKey}@${version}`, {
    before: before ? { stage: before.stage, trafficPct: before.trafficPct } : null,
    after: { stage, trafficPct },
  });
  return NextResponse.json({ ok: true, model: toModel(saved) }, { status: before ? 200 : 201 });
}
