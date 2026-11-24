/**
 * Akciğer grafisi (CXR) teknik kalite (QC) ve projeksiyon tanımı.
 *
 * Bu modül tanısal sınıflandırma yapmaz; yalnızca radyografi kalitesini teknik
 * olarak ölçülebilen üç kriteri değerlendirir:
 *   - projeksiyon (PA / AP / yandan)
 *   - inspirasyon (görünen ön kosta sayısı)
 *   - rotasyon (medial klavya uçları farkı, mm)
 *   - penetrasyon (kalp arkası vertebra görünürlüğü)
 *
 * Ölçümler hekim/görüntü tekniği bildirimine dayanır; sonuç rapora "teknik not"
 * olarak yazılır, tanı içermez ve klinik karar yerine geçmez.
 */

export type CxrProjection = "PA" | "AP" | "yandan" | "belirsiz";

/** DICOM etiketlerinden projeksiyonu tanır; belirsizse "belirsiz" (tahmin yok). */
export function cxrProjection(input: { viewPosition?: string; patientOrientation?: string; bodyPart?: string; description?: string }): CxrProjection {
  const txt = [input.viewPosition, input.patientOrientation, input.bodyPart, input.description]
    .filter(Boolean)
    .join(" ")
    .toLocaleUpperCase("tr-TR");
  if (/(LATERAL|YANDAN|SIDE)/.test(txt)) return "yandan";
  if (/(\bPORT\b|PORTATIF|AP|SUPINE|YATAN|SEDATO)/.test(txt)) return "AP";
  if (/(\bPA\b|POSTERO.?ANTERIOR|AKCİĞER GRAFİSİ$)/.test(txt)) return "PA";
  return "belirsiz";
}

export interface CxrQcInput {
  /** Görünen ön kosta sayısı (0–12); bilinmiyorsa null. */
  anteriorRibs?: number | null;
  /** Medial klavya uçları arası mesafe farkı (mm); bilinmiyorsa null. */
  rotationMm?: number | null;
  /** Kalp arkasında vertebra görünüyor mu (penetrasyon yeterli mi). */
  penetrationAdequate?: boolean | null;
  projection?: CxrProjection | null;
}

export interface CxrQcResult {
  /** 0 = yetersiz, 1 = sınırda, 2 = yeterli (değerlendirilen kriterlere göre) */
  level: 0 | 1 | 2;
  findings: string[];
  advice: string;
  note: string;
}

const n = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Teknik kalite özeti; eksik ölçümler puanlamadan düşürülmez, yalnızca "değerlendirilemedi" notuna düşer. */
export function cxrQuality(input: CxrQcInput): CxrQcResult {
  const findings: string[] = [];
  let worst: 0 | 1 | 2 = 2;
  const drop = (lvl: 0 | 1 | 2) => { if (lvl < worst) worst = lvl; };

  const ribs = n(input.anteriorRibs);
  if (ribs === null) findings.push("İnspirasyon: ön kosta sayısı bildirilmedi.");
  else if (ribs >= 6) findings.push(`İnspirasyon: ${Math.round(ribs)} ön kosta görünüyor — yeterli.`);
  else if (ribs >= 4) { findings.push(`İnspirasyon: ${Math.round(ribs)} ön kosta — sınırda; klinik gerekirse derin inspirasyon tekrarı düşünülmeli.`); drop(1); }
  else { findings.push(`İnspirasyon: ${Math.round(ribs)} ön kosta — yetersiz; eksik inspirasyon tekrar gerektirir.`); drop(0); }

  const rot = n(input.rotationMm);
  if (rot === null) findings.push("Rotasyon: medial klavya farkı bildirilmedi.");
  else if (rot <= 15) findings.push(`Rotasyon: ${rot.toFixed(1)} mm fark — kabul edilebilir (≤15 mm).`);
  else if (rot <= 25) { findings.push(`Rotasyon: ${rot.toFixed(1)} mm fark — sınırda (15–25 mm).`); drop(1); }
  else { findings.push(`Rotasyon: ${rot.toFixed(1)} mm fark — belirgin rotasyon (>25 mm); medikal yapılar simetrik dağılmaz.`); drop(0); }

  if (input.penetrationAdequate === true) findings.push("Penetrasyon: kalp arkası vertebra görünüyor — yeterli.");
  else if (input.penetrationAdequate === false) { findings.push("Penetrasyon: kalpte vertebra ayırt edilemiyor — zayıf penetrasyon."); drop(0); }
  else findings.push("Penetrasyon: bilgi yok.");

  const proj = input.projection ?? "belirsiz";
  const projNote = proj === "PA"
    ? "Projeksiyon PA: CTR ve kardiyomegali yorumu güvenilirdir."
    : proj === "AP"
      ? "Projeksiyon AP/portatif: kardiyal boyut abartılabilir; PA ile kıyas önerilir."
      : proj === "yandan"
        ? "Yandan grafi: kardiyotorasik oran ve mediasten yorumu sınırlıdır."
        : "Projeksiyon belirsiz: lokalizasyon/kalite notu yetersizdir.";

  const advice =
    worst === 2 ? "Teknik kalite yeterli görünüyor." :
    worst === 1 ? "Teknik kalite sınırda; bulgular bu sınırla yorumlanmalı, gerekirse tetkik tekrarı istenmelidir." :
    "Teknik kalite yetersiz; serinin klinik kullanımı sınırlı — tekrar alınması düşünülmelidir.";

  return {
    level: worst,
    findings,
    advice,
    note: `${findings.join(" ")} ${projNote} ${advice}`,
  };
}

/** Rapor için hazır teknik satır (QC etiketi taşır). */
export function cxrQualityLine(q: CxrQcResult): string {
  const tag = q.level === 2 ? "Teknik kalite: yeterli" : q.level === 1 ? "Teknik kalite: sınırda" : "Teknik kalite: yetersiz";
  return `${tag}. ${q.findings.join(" ")} (Otomatik/yapılandırılmış kalite notu — ölçüm ve hekim onayına tabidir.)`;
}
