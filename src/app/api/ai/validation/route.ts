import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reports, shadowFindings, studies } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import {
  acceptanceCheck,
  ageBand,
  DEFAULT_THRESHOLD,
  fairnessScan,
  groupMetric,
  normSex,
  parseDicomAge,
  shadowPerformance,
  subgroupMetrics,
  validationFingerprint,
  type AcceptanceThreshold,
  type ValidationCase,
} from "@/lib/modelValidation";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Klinik doğrulama panosu (t-validation).
 *
 * GET → alt grup (yaş/cinsiyet/modalite) performansı, yanlılık taraması, kabul
 * eşiği değerlendirmesi ve gölge mod özeti.
 *
 * Veri kaynağı **hekim kararlarıdır**: bir AI bulgusu onaylandıysa model pozitif
 * ve referans pozitif sayılır (TP); reddedildiyse model pozitiftir ama referans
 * negatiftir (FP). Duyarlılık (FN) yalnızca hekimin "AI kaçırdı" olarak elle
 * eklediği bulguyla kestirilebilir; bu yüzden yanıt duyarlılığı "vekili" olarak
 * işaretler ve kontrollü çalışmanın yerini tutmadığını açıkça yazar.
 *
 * Demo modunda (hekim etiketi yok) sonuç boş döner — uydurma metrik üretilmez.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const threshold: AcceptanceThreshold = {
    ...DEFAULT_THRESHOLD,
    minSensitivity: Number(sp.get("minSens") ?? DEFAULT_THRESHOLD.minSensitivity),
    minSpecificity: Number(sp.get("minSpec") ?? DEFAULT_THRESHOLD.minSpecificity),
    minN: Math.max(1, Number(sp.get("minN") ?? DEFAULT_THRESHOLD.minN)),
  };
  const version = (sp.get("version") ?? "").trim();

  const rows = await db
    .select({
      f: reports.findingsJson,
      ap: reports.findingsApproval,
      engine: reports.engine,
      studyId: reports.studyId,
      age: studies.patientAge,
      sex: studies.patientSex,
      modality: studies.modality,
    })
    .from(reports)
    .leftJoin(studies, eqStudy());

  const cases: ValidationCase[] = [];
  let examples = 0;
  for (const r of rows) {
    const findings = (r.f as Finding[]) ?? [];
    const ap = (r.ap as Record<string, FindingApprovalStatus>) ?? {};
    const model = (r.engine || "?").slice(0, 40);
    if (version && model !== version) continue;
    const groups = {
      yas: ageBand(parseDicomAge(r.age)),
      cinsiyet: normSex(r.sex),
      modalite: (r.modality || "?").slice(0, 16),
    };
    for (const f of findings) {
      const st = ap[f.id];
      if (st !== "onaylandi" && st !== "reddedildi") continue;
      examples++;
      cases.push({
        caseId: `${r.studyId}:${f.id}`,
        modelVersion: model,
        predicted: true,
        actual: st === "onaylandi",
        groups,
      });
    }
    // Hekimin elle eklediği bulgu = AI'nın kaçırdığı olgu (yalnızca aynı tetkikte
    // AI hiç bulgu üretmediyse anlamlı; bu yüzden FN ayrı raporlanır).
    if (findings.some((f) => f.source === "manual")) {
      cases.push({ caseId: `${r.studyId}:missed`, modelVersion: model, predicted: false, actual: true, groups });
    }
  }

  const metrics = subgroupMetrics(cases, ["yas", "cinsiyet", "modalite"]);
  const fairness = fairnessScan(metrics, threshold);
  const acceptance = acceptanceCheck(cases, threshold);

  const shadows = await db
    .select({ studyUid: shadowFindings.studyUid, findingCount: shadowFindings.findingCount, findingsJson: shadowFindings.findingsJson })
    .from(shadowFindings)
    .limit(2000);
  const shadow = shadowPerformance(
    shadows.map((s) => ({ studyUid: s.studyUid, findingCount: s.findingCount, reviewed: false, confirmed: 0 })),
    cases.filter((c) => !c.predicted && c.actual).length,
  );

  return NextResponse.json({
    threshold,
    cases: cases.length,
    labeledFindings: examples,
    metrics,
    fairness,
    acceptance,
    shadow,
    fingerprint: cases.length ? validationFingerprint(cases, threshold) : "",
    versionFilter: version || null,
    note:
      "Metrikler hekim etiketlerinden türetilir: onay = TP, red = FP, elle eklenen bulgu = FN. " +
      "Bu bir izleme panelidir; kontrollü klinik doğrulama çalışmasının (ardışık örneklem, körleme, bağımsız referans) yerini tutmaz. " +
      "n < 20 olan alt gruplar 'gösterge' olarak işaretlenir.",
  });
}

// Drizzle eşitlik yardımcısı (reports.studyUid = studies.studyUid)
import { eq } from "drizzle-orm";
function eqStudy() {
  return eq(studies.id, reports.studyId);
}

/** Tek alt grup değeri (ör. ?group=modalite&value=CR) — hızlı bakış. */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as { group?: string; value?: string; cases?: ValidationCase[] };
  if (!b.group) return NextResponse.json({ error: "group gerekli" }, { status: 400 });
  const cases = b.cases ?? [];
  return NextResponse.json({ metric: groupMetric(b.group, b.value ?? "", cases), count: cases.length });
}
