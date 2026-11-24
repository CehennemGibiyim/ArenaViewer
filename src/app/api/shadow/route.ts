import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { shadowFindings } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import type { ShadowRecord } from "@/lib/shadowMode";

export const dynamic = "force-dynamic";

/**
 * Gölge mod kaydı: AI çıktısı rapora girilmeden veritabanına yazılır.
 *
 * POST /api/shadow  { engine, model, studyUid, modality, findingCount, findings[] }
 *  - Yalnızca oturum gerektirir; kimlik denetimi authorize() ile yapılır.
 *  - Yanıt her zaman kısa tutulur; bulgu metni içerisinde hasta adı/kimliği olmamalıdır
 *    (istemci tarafı yalnızca id/etiket/şiddet/skor/sliceIndex gönderir).
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;

  const body = (await req.json().catch(() => null)) as Partial<ShadowRecord> | null;
  if (!body || typeof body.engine !== "string" || !body.engine.trim()) {
    return NextResponse.json({ error: "engine gerekli" }, { status: 400 });
  }
  if (!Array.isArray(body.findings)) {
    return NextResponse.json({ error: "findings dizisi gerekli" }, { status: 400 });
  }
  const record: ShadowRecord = {
    engine: body.engine.trim().slice(0, 64),
    model: String(body.model ?? "").slice(0, 128),
    studyUid: String(body.studyUid ?? "").slice(0, 64),
    modality: String(body.modality ?? "").slice(0, 8),
    findingCount: body.findings.length,
    findings: body.findings.slice(0, 64).map((f, i) => ({
      id: String(f?.id ?? `s${i}`).slice(0, 32),
      label: String(f?.label ?? "").slice(0, 200),
      severity: String(f?.severity ?? "bilinmiyor").slice(0, 16),
      confidence: Number(f?.confidence) || 0,
      sliceIndex: typeof f?.sliceIndex === "number" ? Math.trunc(f.sliceIndex) : null,
    })),
  };
  try {
    await db.insert(shadowFindings).values({
      engine: record.engine,
      model: record.model,
      studyUid: record.studyUid,
      modality: record.modality,
      findingCount: record.findingCount,
      findingsJson: record.findings,
      createdBy: a.user.id,
    });
  } catch (e) {
    // Kayıt hatası kullanıcının akışını durdurmamalı ama görünür olmalı.
    return NextResponse.json(
      { error: `gölge kaydı yazılamadı: ${e instanceof Error ? e.message : "hata"}` },
      { status: 500 },
    );
  }

  try {
    await audit(a.user, "ai.shadow_record", "study", record.studyUid, {
      engine: record.engine,
      findings: record.findingCount,
    });
  } catch { /* denetim zorunlu değil */ }

  return NextResponse.json({ ok: true, saved: record.findingCount });
}
