/**
 * RECIST 1.1 — hedef lezyon yanıtı hesabı.
 *
 * Kullanım: aynı hastanın zaman içindeki en uzun çap ölçümlerinden bazal ve
 * izlem toplamlarını hesaplar, yüzde değişimi ve yanıt kategorisini döndürür.
 *
 * Ölçütler (Eisenhauer ve ark., Eur J Cancer 2009):
 *   CR  — tüm hedef lezyonlar kayboldu
 *   PR  — hedef lezyon çapları toplamında ≥ %30 azalma (bazala göre)
 *   PD  — ≥ %20 artış VE ≥ 5 mm mutlak artış; veya yeni lezyon
 *   SD  — PR/PD ölçütleri karşılanmıyor
 *
 * SINIRLILIK (raporda da yazılır): bu hesap yalnız girilen çaplara dayanır;
 * hedef lezyon seçimi, organ sayısı (≤5/organ, ≤10 toplam), lenf nodu
 * ölçümleri (kısa eksen), yeni lezyon onayı ve non-hedef lezyon değerlendirmesi
 * hekim tarafından yapılır. Klinik karar aracı değildir.
 */

export interface RecistPoint {
  date: string;
  diameterMm: number;
}

export interface RecistTrackLike {
  id: string;
  label: string;
  points: RecistPoint[];
}

export type RecistResponse = "CR" | "PR" | "SD" | "PD" | "NONE";

export interface RecistLesion {
  label: string;
  baselineMm: number | null;
  followUpMm: number | null;
  deltaPct: number | null;
  /** Bazal ölçümü yok — toplamlara girmez */
  notAtBaseline: boolean;
}

export interface RecistResult {
  baselineDate: string;
  followUpDate: string;
  baselineSumMm: number;
  followUpSumMm: number;
  deltaMm: number;
  deltaPct: number | null;
  response: RecistResponse;
  responseLabel: string;
  criteria: string;
  lesions: RecistLesion[];
  targetCount: number;
  /** RECIST sınırı: organ başına ≤5, toplam ≤10 hedef lezyon */
  overLimit: boolean;
  newLesion: boolean;
  allDisappeared: boolean;
}

export const RECIST_LABELS: Record<Exclude<RecistResponse, "NONE">, string> = {
  CR: "CR — Tam Yanıt",
  PR: "PR — Parçalı Yanıt",
  SD: "SD — Stabil Hastalık",
  PD: "PD — İlerleme",
};

const num = (s: string) => {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

/**
 * Hedef lezyonların bazal/izlem çap toplamlarını ve RECIST 1.1 yanıtını hesaplar.
 * @param tracks  hedef lezyonların zaman serileri
 * @param opts.newLesion      izlemde yeni lezyon var (hekim işareti) → PD
 * @param opts.allDisappeared tüm hedef lezyonlar kayboldu → CR
 * @returns iki ayrı zaman noktası yoksa null
 */
export function recist11(
  tracks: RecistTrackLike[],
  opts: { newLesion?: boolean; allDisappeared?: boolean } = {},
): RecistResult | null {
  const dates = new Set<string>();
  for (const t of tracks) for (const p of t.points) if (p.diameterMm > 0) dates.add(p.date);
  const sorted = [...dates].sort();
  if (sorted.length < 2) return null;

  const baselineDate = sorted[0];
  const followUpDate = sorted[sorted.length - 1];

  const valueAt = (pts: RecistPoint[], date: string): number | null => {
    const exact = pts.filter((p) => p.date === date && p.diameterMm > 0);
    if (exact.length) return Math.max(...exact.map((p) => p.diameterMm));
    return null;
  };

  const lesions: RecistLesion[] = [];
  let baselineSum = 0;
  let followUpSum = 0;

  for (const t of [...tracks].sort((a, b) => a.label.localeCompare(b.label, "tr"))) {
    const pts = t.points.filter((p) => p.diameterMm > 0);
    if (!pts.length) continue;
    const b = valueAt(pts, baselineDate);
    const f = valueAt(pts, followUpDate);
    if (b === null && f === null) continue;

    const notAtBaseline = b === null;
    const deltaPct = b !== null && b > 0 && f !== null ? ((f - b) / b) * 100 : null;
    lesions.push({ label: t.label, baselineMm: b, followUpMm: f, deltaPct, notAtBaseline });

    // RECIST: yalnız bazal ve izlemde ölçülen lezyonlar toplama girer
    if (b !== null && f !== null) {
      baselineSum += b;
      followUpSum += f;
    }
  }

  if (!lesions.length || baselineSum <= 0) return null;

  // GÜVENLİK: izlem ölçümü OLMAMASI "kayboldu" anlamına gelmez. Veri yetersizse
  // hesap yapılmaz; CR yalnız hekim "tümü kayboldu" işaretiyle verilir.
  const anyFollowUp = lesions.some((l) => l.followUpMm !== null);
  if (!anyFollowUp && opts.allDisappeared !== true) return null;

  const deltaMm = followUpSum - baselineSum;
  const deltaPct = (deltaMm / baselineSum) * 100;
  const newLesion = opts.newLesion === true;
  const allDisappeared = opts.allDisappeared === true;

  let response: RecistResponse;
  let criteria: string;
  if (allDisappeared && !newLesion) {
    response = "CR";
    criteria = "Tüm hedef lezyonlar kayboldu (ölçülebilir hastalık yok).";
  } else if (newLesion || (deltaPct >= 20 && deltaMm >= 5)) {
    response = "PD";
    criteria = newLesion
      ? "İzlemde yeni lezyon saptandı → PD (ölçüm artışından bağımsız)."
      : `Bazala göre ≥ %20 artış ve ≥ 5 mm mutlak artış (${deltaMm.toFixed(1)} mm).`;
  } else if (deltaPct <= -30) {
    response = "PR";
    criteria = `Bazala göre ≥ %30 azalma (${deltaPct.toFixed(1)} %).`;
  } else {
    response = "SD";
    criteria = "Ne PR ne PD ölçütleri karşılandı (aradaki değişiklik).";
  }

  const targetCount = lesions.filter((l) => !l.notAtBaseline).length;

  return {
    baselineDate,
    followUpDate,
    baselineSumMm: baselineSum,
    followUpSumMm: followUpSum,
    deltaMm,
    deltaPct,
    response,
    responseLabel: RECIST_LABELS[response],
    criteria,
    lesions,
    targetCount,
    overLimit: targetCount > 10,
    newLesion,
    allDisappeared,
  };
}

/** CSV satırları — nodül takibi CSV'sine eklenir. */
export function recistCsv(r: RecistResult): string {
  const rows = [
    ["RECIST 1.1", ""],
    ["Bazal tarih", r.baselineDate],
    ["İzlem tarih", r.followUpDate],
    ["Bazal toplam (mm)", r.baselineSumMm.toFixed(1)],
    ["İzlem toplam (mm)", r.followUpSumMm.toFixed(1)],
    ["Değişim (mm)", r.deltaMm.toFixed(1)],
    ["Değişim (%)", r.deltaPct === null ? "" : r.deltaPct.toFixed(1)],
    ["Yanıt", r.responseLabel],
    ["Ölçüt", r.criteria],
    ["Yeni lezyon", r.newLesion ? "evet" : "hayır"],
    ["Hedef lezyon sayısı", String(r.targetCount)],
    ["", ""],
    ["Lezyon", "Bazal mm", "İzlem mm", "Değişim %"],
    ...r.lesions.map((l) => [
      l.label,
      l.baselineMm === null ? "yok" : l.baselineMm.toFixed(1),
      l.followUpMm === null ? "yok" : l.followUpMm.toFixed(1),
      l.deltaPct === null ? "" : l.deltaPct.toFixed(1),
    ]),
  ];
  return rows.map((r2) => r2.join(";")).join("\n");
}

/** `num` dışa aktarımı test/araç kullanımı için. */
export const parseDiameter = num;
