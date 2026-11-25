/**
 * Önceki tetkikle karşılaştırma (a-prior) — ölçüm farkı.
 *
 * SINIR: Bu, iki serinin piksel/kesit HİZALAMASINI (registration) yapmaz;
 * aynı kategoriden bir bulgunun nicel ölçümlerini (çap/hacim) geçmiş kayıtla
 * karşılaştırır ve insan okunur bir fark cümlesi üretir. Yalnızca görsel/geçmiş
 * rapor tabanlıdır; klinik karar radyologa aittir.
 */
import type { Finding, SavedReport } from "./types";

export const PRIOR_COMPARE_NOTE = "Kayıt (registration) yapılmadan, yalnızca ölçüm karşılaştırması.";

/** Önceki raporlarda, bu bulguyla aynı kategoriden nicelli bulgu. */
export function priorFinding(f: Finding, priors: SavedReport[]): { report: SavedReport; finding: Finding } | null {
  if (!f.metrics || f.category === "Sistem") return null;
  for (const r of priors) {
    const pf = r.findingsJson.find((x) => x.category === f.category && x.metrics && x.source !== "manual");
    if (pf?.metrics) return { report: r, finding: pf };
  }
  return null;
}

/**
 * Bulgunun geçmişe göre değişimi: "Önceki (12.03.2026): çap 5 → 8 mm (+3.0).
 * ..." Not metni null ise karşılaştırılacak ölçüm yoktur.
 */
export function priorDelta(f: Finding, priors: SavedReport[]): string | null {
  const hit = priorFinding(f, priors);
  if (!hit) return null;
  const m = f.metrics!;
  const pm = hit.finding.metrics!;
  const parts: string[] = [];
  if (m.maxDiameterMm !== undefined && pm.maxDiameterMm !== undefined) {
    const d = m.maxDiameterMm - pm.maxDiameterMm;
    parts.push(`çap ${pm.maxDiameterMm.toFixed(0)} → ${m.maxDiameterMm.toFixed(0)} mm (${d >= 0 ? "+" : ""}${d.toFixed(1)})`);
  }
  if (m.volumeMl !== undefined && pm.volumeMl) {
    const pct = ((m.volumeMl - pm.volumeMl) / pm.volumeMl) * 100;
    parts.push(`hacim ${pm.volumeMl} → ${m.volumeMl} mL (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`);
  }
  if (!parts.length) return null;
  return `Önceki (${new Date(hit.report.createdAt).toLocaleDateString("tr-TR")}): ${parts.join(" · ")}. ${PRIOR_COMPARE_NOTE}`;
}
