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
import {
  CALIB_MIN_CASES, chooseThreshold, calibrationQuality, fitIsotonic,
  reviewDecision, type CalibCase,
} from "@/lib/calibration";
import { calibrationBins, expectedCalibrationError } from "@/lib/modelOps";
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
}[]): { findings: FeedbackFinding[]; clean: CleanCase[]; calib: CalibCase[] } {
  const findings: FeedbackFinding[] = [];
  const clean: CleanCase[] = [];
  /** Kalibrasyon için skor + hekim etiketi (düzenlenen/bekleyen dışarıda). */
  const calib: CalibCase[] = [];
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
      // Kalibrasyon etiketi: yalnız net kararlar. Düzenlenen bulgu (içerik değişti)
      // ve bekleyen (karar yok) dışarıda — belirsiz etiketle eğri öğrenilmez.
      if (f.confidenceKind !== "none" && Number.isFinite(f.confidence)) {
        calib.push({
          score: f.confidence,
          label: decision === "onaylandi" ? 1 : decision === "reddedildi" ? 0 : null,
        });
      }
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
  return { findings, clean, calib };
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
  const { findings, clean, calib } = rowsToFeedback(
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

  // ── Kalibrasyon (a-uncert): ısotonik eşleme + ECE + eşik önerisi ──
  const calibLabeled = calib.filter((c) => c.label !== null);
  const calibration = fitIsotonic(calibLabeled);
  // ECE: bölme tabanlı (modelOps) — ısotonik eşlemenin "öncesi" kalitesini gösterir.
  const bins = calibrationBins(
    calibLabeled.filter((c) => c.label !== null).map((c) => ({ score: c.score, approved: c.label === 1 })),
    10,
  );
  const ece = expectedCalibrationError(bins);
  const quality = calibrationQuality(ece);
  const thresholdChoice = chooseThreshold(calibLabeled, calibration);
  // Düşük güven kuyruğu: skoru olan AI adaylarından "hekim incelesin" kararına
  // düşenler. Karar verilmiş adaylar da listelenir: kalibrasyon sonrası geriye
  // dönük inceleme listesi (yanlış pozitif avı) olarak işe yarar.
  const lowConfidence = findings
    .filter((f) => !f.manual && f.score !== null)
    .map((f) => ({ f, d: reviewDecision(f.score as number, calibration) }))
    .filter((x) => x.d.action === "incele")
    .slice(0, 50)
    .map(({ f, d }) => ({
      engine: f.engine, category: f.category, label: f.label,
      raw: d.raw, calibrated: d.calibrated, why: d.why,
      slice: f.slice ?? null, studyRef: f.studyRef ?? null,
    }));

  await audit(a.user, "ai.feedback_view", "report", undefined, {
    reports: decidedRows.length,
    findings: findings.length,
    cleanStudies: clean.length,
    calibrationOk: calibration.ok,
  });

  return NextResponse.json({
    ...report,
    calibration: {
      ...calibration,
      ece,
      quality: quality.level,
      qualityNote: quality.note,
      cases: calibLabeled.length,
      minCases: CALIB_MIN_CASES,
    },
    thresholds: {
      chosen: thresholdChoice,
      showAt: thresholdChoice?.threshold ?? 0.7,
      inspectAt: Math.max(0.3, (thresholdChoice?.threshold ?? 0.7) - 0.3),
      note: thresholdChoice
        ? `Kesinlik ≥ %${Math.round(thresholdChoice.precision * 100)} hedefiyle en yüksek duyarlılığı veren eşik ${thresholdChoice.threshold.toFixed(2)}. ÖNERİDİR — üretim eşiği değişikliği klinik onay gerektirir.`
        : `Eşik önerisi için en az ${CALIB_MIN_CASES} etiketli bulgu gerekir (şu an ${calibLabeled.length}).`,
    },
    lowConfidence,
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
