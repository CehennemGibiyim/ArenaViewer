/**
 * Toplu model değerlendirme (h-model-eval).
 *
 * POST /api/ai/evaluate — yalnız yönetici.
 * Gövde: { name, version, cases: [{ id?, score, label }], applyToCard?: boolean }
 *   - name/version kayıt defterinde (ai_model_registry) bulunmalıdır
 *   - cases: 0–1 skor + 0/1 referans etiketi; en çok 5000 satır
 * Yanıt: { ok, model, summary, report, appliedToCard }
 *
 * Sonuçlar denetim kaydına (`model.evaluate`) yazılır; `applyToCard=true` ve
 * n ≥ EVAL_MIN_CASES ise kayıt defteri notuna `[EVAL …]` satırı eklenir
 * (mevcut not KORUNUR, 500 karakter sınırına budanır). n küçükse rapora
 * uyarı eklenir ama karta YAZILMAZ.
 *
 * SINIR: çıkarım bu uçta çalışmaz; skorlar çağıranın (ai-worker validate
 * betikleri, Workstation, etiketli batch işi) ürettiği listeden alınır.
 * Rapor örneklem-içi metriktir; dış doğrulama yapılmaz.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiModelRegistry } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import {
  appendEvalToNotes,
  evaluateBatch,
  formatMetricSummary,
  parseEvalCases,
  EVAL_MIN_CASES,
} from "@/lib/modelEvaluate";

export const dynamic = "force-dynamic";

interface Body {
  name?: string;
  version?: string;
  cases?: unknown;
  applyToCard?: boolean;
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b) return NextResponse.json({ error: "Eksik veri" }, { status: 400 });
  const name = (b.name ?? "").trim().slice(0, 80);
  const version = (b.version ?? "").trim().slice(0, 40);
  if (!name || !version) return NextResponse.json({ error: "name ve version zorunlu." }, { status: 400 });

  const parsed = parseEvalCases(b.cases);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const rows = await db
    .select()
    .from(aiModelRegistry)
    .where(and(eq(aiModelRegistry.name, name), eq(aiModelRegistry.version, version)))
    .limit(1);
  const entry = rows[0];
  if (!entry) {
    return NextResponse.json(
      { error: `«${name}@${version}» kayıt defterinde yok — önce /api/ai/registry ile aday olarak kaydedin.` },
      { status: 404 },
    );
  }

  const report = evaluateBatch(parsed.cases);
  const summary = formatMetricSummary(report);

  let appliedToCard = false;
  if (b.applyToCard === true && report.n >= EVAL_MIN_CASES) {
    const dateISO = new Date().toISOString().slice(0, 10);
    const nextNotes = appendEvalToNotes(entry.notes ?? "", report, dateISO);
    await db
      .update(aiModelRegistry)
      .set({ notes: nextNotes, updatedBy: a.user.id, updatedAt: new Date() })
      .where(eq(aiModelRegistry.id, entry.id));
    appliedToCard = true;
  }

  await audit(a.user, "model.evaluate", "ai_model", `${name}@${version}`, {
    n: report.n,
    positives: report.positives,
    auc: report.auc,
    brier: report.brier,
    ece: report.ece,
    at05: {
      sensitivity: report.at[1].sensitivity,
      specificity: report.at[1].specificity,
      ppv: report.at[1].ppv,
      f1: report.at[1].f1,
    },
    appliedToCard,
    warning: report.warning,
  }).catch(() => undefined);

  return NextResponse.json({
    ok: true,
    model: { name, version },
    summary,
    report,
    appliedToCard,
    applyToCardRefused: b.applyToCard === true && report.n < EVAL_MIN_CASES ? `n=${report.n} < ${EVAL_MIN_CASES}; karta yazılmadı` : null,
  });
}
