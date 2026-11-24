/**
 * Yapılandırılmış radyoloji skorlama motoru (Lung-RADS, TI-RADS, BI-RADS,
 * PI-RADS v2.1, ACR meme yoğunluğu).
 *
 * Bu modül **klinik karar aracı değildir**: skorlar yalnızca hekimin bildirdiği
 * bulgu/ölçü özelliklerine göre hesaplanır ve rapora "öneri" niteliğinde eklenir;
 * nihai sınıflandırma ve yönetim radyologa aittir.
 *
 * Kaynaklar:
 *  - ACR Lung-RADS v1.1 (2019)
 *  - ACR TI-RADS (2017)
 *  - ACR BI-RADS Atlas (5. baskı)
 *  - PI-RADS v2.1 (2019)
 */

export type ScoreSystemId =
  | "lungRads"
  | "tiRads"
  | "biRads"
  | "piRads"
  | "acrDensity"
  | "agatston"
  | "boneDensity"
  | "cxr";

export interface ScoreSystemMeta {
  id: ScoreSystemId;
  title: string;
  modality: string;
  bodyPart: string;
  source: string;
  /** Raporunda geçecek sorumluluk reddi */
  disclaimer: string;
}

export const SCORE_SYSTEMS: ScoreSystemMeta[] = [
  {
    id: "lungRads", title: "Lung-RADS 1.1 (akciğer nodülü)", modality: "CT",
    bodyPart: "TORAKS", source: "ACR Lung-RADS v1.1",
    disclaimer: "Skor yalnız solid nodül çapına dayanır; kalsifikasyon, büyüme ve komşuluk özellikleri hekim tarafından değerlendirilmelidir.",
  },
  {
    id: "tiRads", title: "TI-RADS (tiroid nodülü)", modality: "US",
    bodyPart: "TROID", source: "ACR TI-RADS (2017)",
    disclaimer: "Puanlama ultrason bulgularına göredir; elastografi ve ince iğne aspirasyonu klinik kararla yönlendirilir.",
  },
  {
    id: "biRads", title: "BI-RADS (meme değerlendirme)", modality: "MG",
    bodyPart: "MEME", source: "ACR BI-RADS Atlas, 5. baskı",
    disclaimer: "Mamografi + US + klinik buluşların birleşimi raporlanmalıdır; tek bulgu ile kategori verilmez.",
  },
  {
    id: "piRads", title: "PI-RADS v2.1 (prostat)", modality: "MR",
    bodyPart: "PELVIS", source: "PI-RADS v2.1 (2019)",
    disclaimer: "Skor T2/DWI/DCE sekans kalitesi ve klinik (PSA) verisine bağlıdır; biyopsi kararı hekime aittir.",
  },
  {
    id: "acrDensity", title: "ACR meme yoğunluğu (a–d)", modality: "MG",
    bodyPart: "MEME", source: "ACR BI-RADS Atlas, 5. baskı",
    disclaimer: "Yoğunluk görsel tahmindir; otomatik yoğunluk ölçümü cihaz/modele özgüdür.",
  },
  {
    id: "agatston", title: "Agatston kalsiyum skoru (kalp BT)", modality: "CT",
    bodyPart: "KALP", source: "Agatston/ACC-AHA (kontrastsız kalp BT)",
    disclaimer: "Skor, hekimin ölçtüğü piksel/HU alanlarına dayanır; hastanın yaş/cinsiyet ve kardiyovasküler risk faktörleri klinik yorumda birlikte değerlendirilmelidir.",
  },
  {
    id: "boneDensity", title: "Kemik yoğunluğu (oportünist HU)", modality: "CT",
    bodyPart: "OMURGA", source: "ACR/ISCD oportünist kriter (T-skor DEXA onaylıdır)",
    disclaimer: "BT HU ölçümü DEXA T-skoru değildir; osteoporoz tanısı DEXA ile konur.",
  },
  {
    id: "cxr", title: "Akciğer grafisi nicel ölçümler (CTR)", modality: "CR",
    bodyPart: "TORAKS", source: "Standart PA lateral ölçüm",
    disclaimer: "Kardiyomegali göstergesi PA filmde anlamlıdır; AP/portatif serilerde güvenilirlik düşer.",
  },
];

/** Agatston ağırlığı: lezyondaki en yüksek HU'ya göre (≥130 HU eşiği). */
export function agatstonWeight(peakHu: number): number | null {
  if (!Number.isFinite(peakHu) || peakHu < 130) return null;
  if (peakHu < 200) return 1;
  if (peakHu < 300) return 2;
  if (peakHu < 400) return 3;
  return 4;
}

export interface CalciumLesion {
  vessel: "LM" | "LAD" | "LCx" | "RCA" | "diger";
  /** Lezyon içindeki en yüksek HU (130 üzeri sayılır) */
  peakHu: number;
  /** Lezyon alanı mm² (en az 3 komşu piksel / ≥1 mm² olmalı) */
  areaMm2: number;
}

export const CALCIUM_VESSELS = ["LM", "LAD", "LCx", "RCA"] as const;

export interface AgatstonResult extends ScoreResult {
  total: number;
  perVessel: Record<string, number>;
  ignored: number;
}

/**
 * Agatston kalsiyum skoru: Σ (alan × HU ağırlığı).
 * Eksik/geçersiz lezyonlar toplama girmez ve raporlanır.
 */
export function agatston(lesions: CalciumLesion[]): AgatstonResult {
  const perVessel: Record<string, number> = {};
  let total = 0;
  let ignored = 0;
  for (const l of lesions) {
    const w = agatstonWeight(l.peakHu);
    const area = Number.isFinite(l.areaMm2) ? l.areaMm2 : 0;
    if (w === null || area <= 0) { ignored++; continue; }
    // Skor eşiği: alan < 1 mm² olan odaklar skora girmez.
    if (area < 1) { ignored++; continue; }
    const s = Math.round(area * w);
    perVessel[l.vessel] = (perVessel[l.vessel] ?? 0) + s;
    total += s;
  }

  let category: string; let advice: string; let days: number | null = 365;
  if (total === 0) { category = "0"; advice = "Kalsiyum skoru 0: koronaryum kalsifikasyonu yok. Kardiyovasküler risk yine de klinik risk faktörlerine göre değerlendirilmelidir."; }
  else if (total < 10) { category = "1–9 (minimal)"; advice = "Minimal kalsifiye (1–9): düşük şiddet; yaşam tarzı önerileri ve risk faktörü kontrolü."; }
  else if (total < 100) { category = "10–99 (hafif)"; advice = "Hafif kalsifiye (10–99): statin endikasyonu ve diyet/egzersiz önerisi; ASCVD riskinin yüksek olduğu durumlarda agresif risk faktörü tedavisi."; days = 180; }
  else if (total < 300) { category = "100–299 (orta)"; advice = "Orta şiddette kalsifiye (100–299): statin tedavisi genelde önerilir; semptomatikse iskemi değerlendirmesi."; days = 180; }
  else { category = "≥300 (ağır)"; advice = "Ağır kalsifiye (≥300): yüksek koronary yük; kardiyoloji konsültasyonu ve gerekirse fonksiyonel/anjiyografik değerlendirme."; days = 90; }

  const order = ["LM", "LAD", "LCx", "RCA"];
  const detail = Object.keys(perVessel).length
    ? `Damar bazlı skor: ${order.filter((v) => perVessel[v]).map((v) => `${v} ${perVessel[v]}`).join(", ")}${perVessel.diger ? `, diğer ${perVessel.diger}` : ""}`
    : "Ölçülebilir kalsifikasyon yok";

  return {
    system: "agatston", label: `Agatston ${total}`, category,
    weight: Math.min(0.95, total / 400), advice,
    basis: `${detail}; toplam ${total} (≥130 HU, alan ≥1 mm²)`, followUpDays: days, tissueSampling: false,
    total, perVessel, ignored,
  };
}

/** Oportünist kemik yoğunluğu: L1–L4 trabeküler ortalama HU. */
export function boneDensity(meanHu: number | null): ScoreResult {
  const hu = meanHu ?? NaN;
  let label: string; let advice: string; let category: string; let weight: number;
  if (!Number.isFinite(hu)) { label = "HU yetersiz"; advice = "L1–L4 trabeküler HU ortalaması girin."; category = "—"; weight = 0; }
  else if (hu >= 160) { label = "Normal (HU ≥160)"; category = "normal"; weight = 0.15; advice = "Trabeküler HU ≥160: oportünist kriterlere göre normal sınırlarda; klinik risk faktörleri yine de değerlendirilmeli."; }
  else if (hu >= 120) { label = "Sınırda (120–159)"; category = "sinirda"; weight = 0.45; advice = "Trabeküler HU 120–159: osteopeni riski; DEXA ile ölçüm ve klinik risk faktörlerine göre tedavi kararı önerilir."; }
  else { label = "Osteoporoz riski (HU <120)"; category = "yuksek-risk"; weight = 0.75; advice = "Trabeküler HU <120: osteoporoz riski taşıyan sınır; kesin tanı için DEXA önerilir."; }
  return {
    system: "boneDensity", label, category, weight, advice,
    basis: `Trabeküler ortalama HU: ${Number.isFinite(hu) ? hu.toFixed(0) : "—"}`,
    followUpDays: Number.isFinite(hu) && hu < 160 ? 365 : null, tissueSampling: false,
  };
}

/** Akciğer grafisi kardiyotorasik oran (PA). */
export function cxrCardiothoracicRatio(cardiacMm: number | null, thoracicMm: number | null): ScoreResult {
  const c = cardiacMm ?? NaN; const t = thoracicMm ?? NaN;
  if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) {
    return { system: "cxr", label: "CTR ?", category: "?", weight: 0, advice: "Kardiyal ve torasik çapları girin.", basis: "ölçüm eksik", followUpDays: null, tissueSampling: false };
  }
  const ratio = c / t;
  let label: string; let advice: string; let weight: number;
  if (ratio > 0.55) { label = `CTR ${ratio.toFixed(2)} — belirgin artmış`; advice = "PA filmde kardiyotorasik oran >0.55: kardiyomegali göstergesi; klinik/EKO korelasyonu önerilir."; weight = 0.6; }
  else if (ratio > 0.5) { label = `CTR ${ratio.toFixed(2)} — sınırda/artmış`; advice = "PA filmde CTR >0.5: kardiyomegali göstergesi; AP/portatif seride bu bulgu abartılabilir."; weight = 0.4; }
  else { label = `CTR ${ratio.toFixed(2)} — normal sınır`; advice = "CTR ≤0.5: PA filmde normal sınırda."; weight = 0.1; }
  return {
    system: "cxr", label, category: ratio.toFixed(2), weight, advice,
    basis: `En geniş kardiyal çap ${c.toFixed(1)} mm / iç torasik çap ${t.toFixed(1)} mm`, followUpDays: ratio > 0.5 ? 180 : null,
    tissueSampling: false,
  };
}

const mm = (s: string): number | null => {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
};

// ─────────────── LUNG-RADS 1.1 ───────────────

export interface LungRadsInput {
  /** En büyük solid komponent çapı (mm) */
  solidMm?: number | null;
  /** Kısmi solid: en büyük solid komponent (mm) */
  partSolidMm?: number | null;
  /** Non-solid (ground-glass) boyutu (mm) */
  nonsolidMm?: number | null;
  calcification?: "none" | "benign" | "malignant";
  /** Belirgin şüpheli özellik: spikülasyon, büyüme, kavitasyon vb. (hekim işareti) */
  suspiciousFeature?: boolean;
}

export interface ScoreResult {
  system: ScoreSystemId;
  /** Özet etiket — örn. "Lung-RADS 4A" */
  label: string;
  category: string;
  /** 0–1 arası görsel önem/güvenlik göstergesi (dokümantasyon amaçlı) */
  weight: number;
  /** Kılavuz önerisi */
  advice: string;
  /** Hesabın dayandığı girdiler */
  basis: string;
  /** Önerilen takip süresi (gün); uygun değilse null */
  followUpDays: number | null;
  /** Biyopsi/doku örneklemesi öneriliyor mu (takip görev tipi için) */
  tissueSampling: boolean;
}

export function lungRads(i: LungRadsInput): ScoreResult {
  const solid = i.solidMm ?? null;
  const partSolid = i.partSolidMm ?? null;
  const nonsolid = i.nonsolidMm ?? null;

  // Kalsifiye “iy Huysuz” morfoloji: benign görünümlü
  if ((i.calcification === "benign" || i.calcification === "malignant") && !solid) {
    return {
      system: "lungRads", label: "Lung-RADS 2", category: "2",
      weight: 0.2,
      advice: "İyi huylu kalsifikasyon/görünüm: rutin yıllık düşük doz BT (12 ay) önerilir.",
      basis: "Kalsifikasyon tipi benign olarak işaretlendi; ölçülebilir solid komponent yok.",
      followUpDays: 365, tissueSampling: false,
    };
  }

  const basis: string[] = [];
  let label: string;
  let advice: string;
  let days: number | null = null;
  let sampling = false;

  if (partSolid !== null) {
    basis.push(`kısmi solid: solid komponent ${partSolid} mm`);
    if (partSolid < 6) { label = "Lung-RADS 2"; advice = "Kısmi solid nodül <6 mm solid komponent: 12 ay sonra düşük doz BT."; days = 365; }
    else if (partSolid < 8) { label = "Lung-RADS 3"; advice = "Kısmi solid nodül 6–<8 mm solid komponent: 6 ay sonra düşük doz BT."; days = 180; }
    else { label = "Lung-RADS 4A"; advice = "Kısmi solid nodül ≥8 mm solid komponent: 3 ay sonra BT; PET-BT/iletim gerekiyorsa ilgili branşa yönlendirme."; days = 90; sampling = true; }
  } else if (nonsolid !== null) {
    basis.push(`non-solid (ground-glass) ${nonsolid} mm`);
    if (nonsolid < 6) { label = "Lung-RADS 2"; advice = "Non-solid odak <6 mm: izlem önerilmez ya da rutin 12 ay BT."; days = 365; }
    else if (nonsolid < 30) { label = "Lung-RADS 2"; advice = "Non-solid odak 6–<30 mm: 6 ay sonra BT ile stabilitet kontrolü."; days = 180; }
    else { label = "Lung-RADS 3"; advice = "Non-solid odak ≥30 mm: 3–6 ay BT; persistans halinde cerrahi/pediatrik değerlendirme düşünülür."; days = 120; }
  } else if (solid !== null) {
    basis.push(`solid nodül ${solid} mm`);
    if (solid < 6) { label = "Lung-RADS 2"; advice = "Solid nodül <6 mm: 12 ay sonra rutin düşük doz BT."; days = 365; }
    else if (solid < 8) { label = "Lung-RADS 3"; advice = "Solid nodül 6–<8 mm: 6 ay sonra düşük doz BT."; days = 180; }
    else { label = "Lung-RADS 4A"; advice = "Solid nodül ≥8 mm: 3 ay sonra BT; ≥8 mm ise PET-BT değerlendirilebilir."; days = 90; sampling = true; }
  } else {
    label = "Lung-RADS 1"; advice = "Sınıflandırılabilir ölçüm yok."; days = null;
  }

  if (i.suspiciousFeature && label !== "Lung-RADS 1") {
    basis.push("şüpheli özellik (spikülasyon/büyüme/kavitasyon) işaretlendi");
    if (label === "Lung-RADS 2") { label = "Lung-RADS 4X"; days = 30; sampling = true; }
    else if (label === "Lung-RADS 3") { label = "Lung-RADS 4B"; days = 30; sampling = true; }
    else if (label === "Lung-RADS 4A") { label = "Lung-RADS 4B"; days = 30; sampling = true; }
    advice += " Şüpheli özellik nedeniyle 4B/4X yükselmesi önerilir; PET-BT ve doku örneklemesi iletilmelidir.";
  }

  const w = label.endsWith("1") ? 0.05 : label.endsWith("2") ? 0.15 : label.endsWith("3") ? 0.4 : label.endsWith("4A") ? 0.65 : label.endsWith("4X") ? 0.8 : 0.9;

  return {
    system: "lungRads", label, category: label.replace("Lung-RADS ", ""),
    weight: w, advice, basis: basis.join("; "), followUpDays: days, tissueSampling: sampling,
  };
}

// ─────────────── ACR TI-RADS ───────────────

export interface TiRadsInput {
  composition?: "cystic" | "spongiform" | "mixed" | "solid";
  echogenicity?: "anechoic" | "hyperIso" | "hypoechoic" | "veryHypoechoic";
  shape?: "wider" | "taller";
  margin?: "smooth" | "illDefined" | "lobulated" | "extrathyroidal";
  foci?: Array<"none" | "cometTail" | "macrocalc" | "rim" | "punctate">;
}

const TI_POINTS = {
  composition: { cystic: 0, spongiform: 0, mixed: 1, solid: 2 },
  echogenicity: { anechoic: 0, hyperIso: 1, hypoechoic: 2, veryHypoechoic: 3 },
  shape: { wider: 0, taller: 1 },
  margin: { smooth: 0, illDefined: 0, lobulated: 2, extrathyroidal: 3 },
} as const;

export function tiRads(i: TiRadsInput): ScoreResult {
  let pts = 0;
  const parts: string[] = [];
  if (i.composition) { const p = TI_POINTS.composition[i.composition]; pts += p; parts.push(`kompozisyon ${p} p`); }
  if (i.echogenicity) { const p = TI_POINTS.echogenicity[i.echogenicity]; pts += p; parts.push(`ekojenisite ${p} p`); }
  if (i.shape) { const p = TI_POINTS.shape[i.shape]; pts += p; parts.push(`şekil ${p} p`); }
  if (i.margin) { const p = TI_POINTS.margin[i.margin]; pts += p; parts.push(`sınır ${p} p`); }
  if (i.foci?.length) {
    const best = Math.max(...i.foci.map((f) => (f === "punctate" ? 3 : f === "rim" ? 2 : f === "macrocalc" ? 1 : 0)));
    pts += best;
    parts.push(`ekojenik fokus ${best} p`);
  }

  let label: string; let advice: string; let days: number | null = null; let sampling = false;
  if (pts === 0) { label = "TR1"; advice = "Tiroid nodülü benign (TR1): izlem önerilmez."; }
  else if (pts <= 2) { label = "TR2"; advice = "TR2 (puan ≤2): malignite riski çok düşük; izlem önerilmez."; }
  else if (pts === 3) { label = "TR3"; advice = "TR3 (3 puan): ≥1.5 cm ise ince iğne aspirasyonu (FNAB); ≥2.5 cm ise US ile 12–24 ay izlem."; days = 365; sampling = true; }
  else if (pts <= 6) { label = "TR4"; advice = "TR4 (4–6 puan): ≥1.0 cm ise FNAB; ≥1.5 cm ise US ile 12 ay izlem."; days = 365; sampling = true; }
  else { label = "TR5"; advice = "TR5 (≥7 puan): ≥0.5 cm ise FNAB; ≥1.0 cm ise US ile 12 ay izlem."; days = 365; sampling = true; }

  return {
    system: "tiRads", label, category: `${pts} puan`,
    weight: Math.min(0.9, pts / 8),
    advice, basis: parts.join(", ") || "bulgu girilmedi",
    followUpDays: days, tissueSampling: sampling,
  };
}

// ─────────────── BI-RADS + ACR yoğunluk ───────────────

export function biRads(category: string): ScoreResult {
  const map: Record<string, { label: string; advice: string; days: number | null; sampling: boolean; weight: number }> = {
    "0": { label: "BI-RADS 0", advice: "Yetersiz değerlendirme: ek mamografi projeksiyonu/ultrason/MRI önerilir.", days: 30, sampling: false, weight: 0.3 },
    "1": { label: "BI-RADS 1", advice: "Negatif: rutin 12 ay tarama izlemi.", days: 365, sampling: false, weight: 0.05 },
    "2": { label: "BI-RADS 2", advice: "Benign bulgu: rutin 12 ay tarama izlemi.", days: 365, sampling: false, weight: 0.1 },
    "3": { label: "BI-RADS 3", advice: "Muhtemelen benign: 6 ay sonra kısa süreli izlem (daha sonra 12/24 ay); 2 yıl stabil ise BI-RADS 2'ye inilir.", days: 180, sampling: false, weight: 0.4 },
    "4": { label: "BI-RADS 4", advice: "Şüpheli: doku örneklemesi (biyopsi) önerilir; 4A/4B/4C alt kategorisi belirtilmelidir.", days: 30, sampling: true, weight: 0.7 },
    "5": { label: "BI-RADS 5", advice: "Kuvvetle malign: doku örneklemesi ve onkolojik yönlendirme önerilir.", days: 14, sampling: true, weight: 0.9 },
    "6": { label: "BI-RADS 6", advice: "Patolojik tanı konmuş malignite: tedavi planlaması ve yönlendirme.", days: 14, sampling: true, weight: 0.95 },
  };
  const m = map[category] ?? { label: "BI-RADS ?", advice: "Geçerli bir BI-RADS kategorisi seçin (0–6).", days: null, sampling: false, weight: 0 };
  return {
    system: "biRads", label: m.label, category, weight: m.weight, advice: m.advice,
    basis: `BI-RADS ${category} kategorisi hekim bildirimi`, followUpDays: m.days, tissueSampling: m.sampling,
  };
}

export function acrDensity(density: "a" | "b" | "c" | "d"): ScoreResult {
  const map: Record<string, { text: string; advice: string; weight: number }> = {
    a: { text: "a — neredeyse tamamen yağlı", advice: "Yağlı doku mamografiyi iyice geçirir; ek tetkik gerekmez.", weight: 0.1 },
    b: { text: "b — dağınık fibroglandüler doku", advice: "Dağınık densite; rutin tarama yeterlidir.", weight: 0.3 },
    c: { text: "c — heterojen yoğun doku", advice: "Heterojen yoğun doku taramayı gizleyebilir; tomosentez/US ek değerlendirme düşünülmelidir.", weight: 0.6 },
    d: { text: "d — son derece yoğun doku", advice: "Ek yoğunluk nedeniyle tarama hassasiyeti düşer; tamamlayıcı US/MRI tartışılmalıdır.", weight: 0.8 },
  };
  const m = map[density] ?? { text: "?", advice: "a–d arası seçim yapın.", weight: 0 };
  return {
    system: "acrDensity", label: `ACR yoğunluk ${m.text.split(" ")[0]}`, category: density.toUpperCase(),
    weight: m.weight, advice: m.advice, basis: `Meme yoğunluğu: ${m.text}`, followUpDays: null, tissueSampling: false,
  };
}

// ─────────────── PI-RADS v2.1 ───────────────

export interface PiRadsInput {
  zone: "TZ" | "PZ";
  t2?: number | null;
  dwi?: number | null;
  dce?: boolean | null;
}

export function piRadsV2(i: PiRadsInput): ScoreResult {
  const clamp = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.max(1, Math.min(5, Math.round(v))));
  const t2 = clamp(i.t2);
  const dwi = clamp(i.dwi);

  let score: number;
  let dominant: string;
  if (i.zone === "PZ") {
    if (dwi === null) return { system: "piRads", label: "PI-RADS ?", category: "?", weight: 0, advice: "Periferal zon skoru DWI puanına göre belirlenir; DWI puanı girin.", basis: "DWI eksik", followUpDays: null, tissueSampling: false };
    score = dwi;
    dominant = "DWI (periferal zon baskın sekans)";
    if (i.dce === true && score === 3) { score = 4; dominant += "; DCE pozitif yükseltmesi (3→4)"; }
  } else {
    if (t2 === null) return { system: "piRads", label: "PI-RADS ?", category: "?", weight: 0, advice: "Geçiş zonu skoru T2 puanına göre belirlenir; T2 puanı girin.", basis: "T2 eksik", followUpDays: null, tissueSampling: false };
    score = t2;
    dominant = "T2 (geçiş zonu baskın sekans)";
    if (dwi !== null && dwi >= 4 && score === 3) { score = 4; dominant += "; DWI ≥4 yükseltmesi (3→4)"; }
  }

  const label = `PI-RADS ${score}`;
  const advice = score <= 2
    ? "Düşük şüphe: biyopsi önerilmez; klinik/PSA izlemi."
    : score === 3
      ? "Orta şüphe: multiparametrik değerlendirme ve gerekirse hedefli biyopsi tartışılır."
      : "Yüksek şüphe: hedefli ± sistematik biyopsi önerilir.";
  return {
    system: "piRads", label, category: String(score), weight: 0.2 + score * 0.15,
    advice, basis: `${dominant}; zona göre baskın sekans`, followUpDays: score >= 4 ? 30 : score === 3 ? 90 : null,
    tissueSampling: score >= 4,
  };
}

// ─────────────── Rapor satırı ───────────────

/** Skoru rapora eklenecek Türkçe satıra çevirir (hekim önerisi niteliğinde). */
export function scoreToText(r: ScoreResult): string {
  return `[${r.label}] ${r.basis}. Öneri: ${r.advice} (Otomatik/yapılandırılmış skor — hekim onayına tabidir.)`;
}

/** Sistem meta bilgisini id ile döndürür. */
export function scoreSystem(id: ScoreSystemId): ScoreSystemMeta {
  return SCORE_SYSTEMS.find((s) => s.id === id) ?? SCORE_SYSTEMS[0];
}
