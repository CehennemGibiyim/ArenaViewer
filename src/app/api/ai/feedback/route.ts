/**
 * Hekim geri bildirim döngüsü (a-feedback) — duyarlılık / özgüllük / yanlış pozitif.
 *
 * GET /api/ai/feedback — yalnız radyolog/yönetici.
 *
 * Veri kaynakları (uydurma yok, hepsi kayıtlı gerçek kararlardan):
 *  - `reports.findings_json`  → AI adayları (`source` ≠ manual) ve hekimin elle eklediği
 *    "AI kaçırdı" bulguları (`source: "manual"`, `category: "Hekim"`).
 *  - `reports.findings_approval` + `findings_reason` → onay/ret/düzenleme ve gerekçe.
 *  - `reports.triage_level` / bulgu sayısı → **yerel proxy**: iki okuma arasında bulgu
 *    çıkmamış çalışmalar "temiz çalışma" adayıdır (aşağıdaki uyarıya bakın).
 *
 * ÖZGÜLLÜK HAKKINDA DÜRÜST NOT: sistemde patoloji/takip altın standardı yoktur.
 * "Temiz çalışma" burada çalışmanın **onaylı raporunda hiç bulgu olmaması** olarak
 * tanımlanır; hekim gözden kaçırmışsa bu bir yanlış negatiftir ve özgüllüğü
 * olduğundan yüksek gösterir. Bu yüzden yanıt `specificitySource` alanıyla bunu
 * açıkça işaretler ve pano aynı uyarıyı gösterir.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import {
  summarizeFeedback,
  type CleanCase,
  type FeedbackFinding,
  type ReviewDecision,
} from "@/lib/feedbackLoop";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `findings_json` kategorileri arasında AI olmayan (sistem/muhasebe) satırlar. */
const NON_AI_CATEGORIES = new Set(["Sistem", "ROI", "Hekim"]);

/** DB satırı → geri bildirim satırları. Saf dönüşüm (test edilir). */
export function rowsToFeedback(rows: {
  id: number;
  findings: unknown;
  approval: unknown;
  reasons: unknown;
  engine: string | null;
  studyId: number;
  approvedAt: Date | string | null;
}[]): { findings: FeedbackFinding[]; clean: CleanCase[] } {
  const findings: FeedbackFinding[] = [];
  const clean: CleanCase[] = [];
  for (const r of rows) {
    const list = (Array.isArray(r.findings) ? r.findings : []) as Finding[];
    const ap = (r.approval as Record<string, FindingApprovalStatus> | null) ?? {};
    const rs = (r.reasons as Record<string, string> | null) ?? {};
    const engine = (r.engine || "?").trim() || "?";
    const studyRef = `#${r.id}`;
    const at = r.approvedAt ? new Date(r.approvedAt).toISOString() : undefined;

    let aiShown = 0;
    let anyFinding = 0;
    for (const f of list) {
      if (!f || typeof f !== "object") continue;
      const isManual = f.source === "manual";
      if (isManual) {
        // Yalnız hekimin "AI kaçırdı" olarak eklediği bulgular duyarlılığa girer.
        if (f.category !== "Hekim") continue;
        findings.push({
          id: String(f.id ?? ""),
          engine,
          category: (f.category || "Hekim").trim(),
          label: f.label ?? "",
          manual: true,
          score: null,
          decision: "onaylandi",
          slice: Number.isFinite(f.sliceIndex) ? f.sliceIndex + 1 : undefined,
          studyRef,
          at,
        });
        anyFinding++;
        continue;
      }
      if (NON_AI_CATEGORIES.has(f.category)) continue;
      aiShown++;
      anyFinding++;
      const decision: ReviewDecision = ap[f.id] ?? "bekliyor";
      findings.push({
        id: String(f.id ?? ""),
        engine,
        category: (f.category || "?").trim(),
        label: f.label ?? "",
        manual: false,
        score: f.confidenceKind === "none" || !Number.isFinite(f.confidence) ? null : f.confidence,
        decision,
        reason: rs[f.id] ?? undefined,
        slice: Number.isFinite(f.keySliceNumber) ? f.keySliceNumber : undefined,
        studyRef,
        at,
      });
    }
    // Temiz çalışma: onaylı rapor + hiç AI adayı + hiç hekim bulgusu.
    // (Taslak raporlar özgüllüğe katılmaz: okunmamış çalışma "negatif" sayılamaz.)
    if (anyFinding === 0) clean.push({ engine, category: "—", clean: true });
  }
  return { findings, clean };
}

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;

  const limit = Math.max(50, Math.min(20_000, Number(req.nextUrl.searchParams.get("limit") ?? 5000) || 5000));
  const rs = await db
    .select({
      id: reports.id,
      findings: reports.findingsJson,
      approval: reports.findingsApproval,
      reasons: reports.findingsReason,
      engine: reports.engine,
      studyId: reports.studyId,
      approvedAt: reports.approvedAt,
      status: reports.status,
      triageLevel: reports.triageLevel,
    })
    .from(reports)
    .limit(limit);

  // Yalnız onaylı raporlar "karar verilmiş" sayılır; taslaklar duyarlılık/özgüllüğe girmez.
  const decidedRows = rs.filter((r) => r.status === "onaylandi");
  const { findings, clean } = rowsToFeedback(
    decidedRows.map((r) => ({
      id: r.id,
      findings: r.findings,
      approval: r.approval,
      reasons: r.reasons,
      engine: r.engine,
      studyId: r.studyId,
      approvedAt: r.approvedAt,
    })),
  );
  // Temiz çalışmalar motor bilgisiyle eşleşmeli: rapor motoru boşsa "?" kovasına düşer.
  const report = summarizeFeedback(findings, clean);

  await audit(a.user, "ai.feedback_view", "report", undefined, {
    reports: decidedRows.length,
    findings: findings.length,
    cleanStudies: clean.length,
  });

  return NextResponse.json({
    ...report,
    generatedAt: new Date().toISOString(),
    sample: {
      reportsScanned: rs.length,
      reportsApproved: decidedRows.length,
      findings: findings.length,
      cleanStudies: clean.length,
      limit,
    },
    specificitySource: clean.length > 0 ? "onaylı-raporda-bulgu-yok (yerel proxy)" : "yok",
    note:
      report.note +
      " Özgüllük 'onaylı raporda bulgu yok' proxy'siyle hesaplanır; altın standart (patoloji/takip) verisi yoktur.",
  });
}
