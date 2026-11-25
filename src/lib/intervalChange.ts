/**
 * Önceki tetkike göre interval değişim özeti (a-prior).
 *
 * Neden ayrı modül: `priorCompare.priorDelta` tek bulgu için tek cümle üretir.
 * Radyologun asıl ihtiyacı **çalışma düzeyinde** bir tablodur: hangi lezyon
 * büyüdü, hangisi küçüldü, hangisi yeni, hangisi kayboldu, ne kadar sürede?
 * Bu modül bunu üretir ve kararları **kurala bağlar** (RECIST 1.1 mantığıyla
 * uyumlu eşikler), böylece "belirgin değişim" ifadesi keyfî olmaz.
 *
 * Sınırlar (bilinçli):
 *  - Kayıt (registration) yapılmaz; eşleştirme anatomi + konum metni ile olur.
 *  - Yalnızca raporlarda **ölçülmüş** değerler karşılaştırılır; ölçüm yoksa
 *    "ölçüm yok" denir, tahmin üretilmez.
 *  - Eşikler gösterge niteliğindedir; tedavi kararı hekimindir.
 */

import { matchLesions, type LesionRecord } from "./lesionTracking";

/** Değişim sınıfı: yön + büyüklük bir arada. */
export type ChangeKind = "buyume" | "kuculme" | "stabil" | "yeni" | "kayboldu" | "olculemedi";

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  buyume: "Büyüme",
  kuculme: "Küçülme",
  stabil: "Stabil",
  yeni: "Yeni",
  kayboldu: "Kayboldu",
  olculemedi: "Ölçüm yok",
};

/** Satır rengi için sınıf anahtarı (arayüz katmanı eşler). */
export const CHANGE_TONE: Record<ChangeKind, "kirmizi" | "yesil" | "gri" | "mor" | "sari" | "notr"> = {
  buyume: "kirmizi",
  kuculme: "yesil",
  stabil: "gri",
  yeni: "mor",
  kayboldu: "sari",
  olculemedi: "notr",
};

/**
 * Eşikler (mm ve yüzde). RECIST 1.1 "belirgin değişim" mantığından türetildi:
 * en uzun çapta ≥ 5 mm VE ≥ %20 artış büyüme; ≥ 5 mm VE ≥ %30 azalma küçülme
 * sayılır. Bu ikisinin arası "stabil"dir. Tek başına yüzde veya tek başına
 * mutlak değer yeterli değildir (küçük lezyonda 2→2,4 mm %20'dir ama anlamsız).
 */
export const INTERVAL_THRESHOLDS = {
  /** Büyüme: en az bu kadar mm VE yüzde. */
  growthMm: 5,
  growthPct: 20,
  /** Küçülme: en az bu kadar mm VE yüzde. */
  shrinkMm: 5,
  shrinkPct: 30,
} as const;

export interface IntervalRow {
  /** Satır anahtarı (kaynak lezyon kimliği). */
  id: string;
  anatomy: string;
  location: string;
  kind: ChangeKind;
  /** Önceki ve şimdiki ölçüm (mm). */
  beforeMm: number | null;
  afterMm: number | null;
  /** Mutlak fark (mm) ve yüzde değişim; hesaplanamıyorsa null. */
  deltaMm: number | null;
  deltaPct: number | null;
  /** Kullanıcıya gösterilecek kısa gerekçe: "6 → 9 mm (+3 mm, +%50)". */
  text: string;
}

export interface IntervalSummary {
  /** Karşılaştırmanın yapıldığı iki tarih. */
  fromDate: string;
  toDate: string;
  /** İki tarih arasındaki gün sayısı. */
  days: number;
  /** "3 ay 12 gün" gibi okunur süre. */
  intervalText: string;
  rows: IntervalRow[];
  counts: Record<ChangeKind, number>;
  /** Ölçülebilir lezyonlarda toplam çap değişimi (RECIST özet ölçüsü). */
  sumBeforeMm: number;
  sumAfterMm: number;
  sumDeltaPct: number | null;
  /** Tek cümlelik özet: "12 Mart 2026'ya göre (198 gün): 2 lezyon büyüdü…". */
  headline: string;
  /** Karşılaştırılabilir lezyon yoksa neden. */
  warning: string | null;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" });

/** İki tarih arasındaki gün (takvim günü, saat dilimi kaymasından bağımsız). */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  if (db < da) return -Math.round((da - db) / 86400_000);
  return Math.round((db - da) / 86400000);
}

/** Gün → "1 yıl 2 ay 3 gün" (Türkçe, kaba ama okunur). */
export function intervalText(days: number): string {
  const d = Math.abs(Math.round(days));
  if (d === 0) return "aynı gün";
  const y = Math.floor(d / 365);
  const m = Math.floor((d % 365) / 30);
  const r = d % 30;
  const parts: string[] = [];
  if (y) parts.push(`${y} yıl`);
  if (m) parts.push(`${m} ay`);
  if (r) parts.push(`${r} gün`);
  if (!parts.length) parts.push(`${d} gün`);
  return parts.slice(0, 2).join(" ") + (days < 0 ? " önce" : "");
}

/**
 * Tek ölçüm çiftini sınıflandırır.
 * `before`/`after` null ise "ölçüm yok"; sıfır/negatif ölçümler geçersiz sayılır.
 */
export function classifyChange(before: number | null | undefined, after: number | null | undefined): {
  kind: ChangeKind;
  deltaMm: number | null;
  deltaPct: number | null;
} {
  const b = before !== null && before !== undefined && Number.isFinite(before) && before > 0 ? before : null;
  const a = after !== null && after !== undefined && Number.isFinite(after) && after > 0 ? after : null;
  if (b === null || a === null) return { kind: "olculemedi", deltaMm: null, deltaPct: null };
  const diff = a - b;
  const pct = ((a - b) / b) * 100;
  if (diff >= INTERVAL_THRESHOLDS.growthMm && pct >= INTERVAL_THRESHOLDS.growthPct) return { kind: "buyume", deltaMm: diff, deltaPct: pct };
  if (-diff >= INTERVAL_THRESHOLDS.shrinkMm && -pct >= INTERVAL_THRESHOLDS.shrinkPct) return { kind: "kuculme", deltaMm: diff, deltaPct: pct };
  return { kind: "stabil", deltaMm: diff, deltaPct: pct };
}

const mmText = (v: number | null) => (v === null ? "—" : `${v % 1 === 0 ? v : v.toFixed(1)} mm`);

/** Satır metni: "6 → 9 mm (+3 mm, +%50)". */
export function rowText(row: Pick<IntervalRow, "kind" | "beforeMm" | "afterMm" | "deltaMm" | "deltaPct">): string {
  if (row.kind === "yeni") return `Yeni ölçüm: ${mmText(row.afterMm)}`;
  if (row.kind === "kayboldu") return `Bu tetkikte ölçülmedi (önceki: ${mmText(row.beforeMm)})`;
  if (row.kind === "olculemedi") return "Ölçüm yok (karşılaştırılamaz)";
  const d = row.deltaMm ?? 0;
  const p = row.deltaPct ?? 0;
  const sign = (n: number) => `${n > 0 ? "+" : ""}${n % 1 === 0 ? n : n.toFixed(1)}`;
  return `${mmText(row.beforeMm)} → ${mmText(row.afterMm)} (${sign(d)} mm, ${sign(Math.round(p))}%)`;
}

/** Rapordaki bulgulardan izlenebilir lezyon kaydı üretir (ölçü varsa). */
export function lesionsFromFindings(
  findings: { id: string; label: string; category: string; anatomicalLocation: string; metrics?: { maxDiameterMm?: number; volumeMl?: number } }[],
  date: string,
): LesionRecord[] {
  const out: LesionRecord[] = [];
  for (const f of findings) {
    if (!f.metrics || f.category === "Sistem") continue;
    const mm = f.metrics.maxDiameterMm;
    if (mm === undefined || !Number.isFinite(mm) || mm <= 0) continue;
    out.push({ id: f.id, anatomy: f.category, location: f.anatomicalLocation, date, longMm: mm });
  }
  return out;
}

/**
 * İki tetkikin ölçülmüş lezyonlarını karşılaştırır.
 *
 * Eşleştirme `matchLesions` ile (anatomi + konum) yapılır; eşleşmeyen izlem
 * lezyonu "yeni", eşleşmeyen önceki lezyon "kayboldu" olarak raporlanır.
 * Yeni lezyon RECIST açısından PD işaretidir; bu yüzden headline'da öne çıkar.
 */
export function compareInterval(
  prior: { date: string; findings: Parameters<typeof lesionsFromFindings>[0] },
  current: { date: string; findings: Parameters<typeof lesionsFromFindings>[0] },
): IntervalSummary {
  const before = lesionsFromFindings(prior.findings, prior.date);
  const after = lesionsFromFindings(current.findings, current.date);
  const match = matchLesions(before, after);

  const rows: IntervalRow[] = [];
  for (const m of match.matched) {
    const { kind, deltaMm, deltaPct } = classifyChange(m.baseline.longMm, m.followUp.longMm);
    const row: IntervalRow = {
      id: m.followUp.id,
      anatomy: m.followUp.anatomy,
      location: m.followUp.location,
      kind,
      beforeMm: m.baseline.longMm ?? null,
      afterMm: m.followUp.longMm ?? null,
      deltaMm,
      deltaPct,
      text: "",
    };
    row.text = rowText(row);
    rows.push(row);
  }
  for (const n of match.newOnes) {
    const row: IntervalRow = {
      id: n.id, anatomy: n.anatomy, location: n.location, kind: "yeni",
      beforeMm: null, afterMm: n.longMm ?? null, deltaMm: null, deltaPct: null, text: "",
    };
    row.text = rowText(row);
    rows.push(row);
  }
  for (const d of match.disappeared) {
    const row: IntervalRow = {
      id: d.id, anatomy: d.anatomy, location: d.location, kind: "kayboldu",
      beforeMm: d.longMm ?? null, afterMm: null, deltaMm: null, deltaPct: null, text: "",
    };
    row.text = rowText(row);
    rows.push(row);
  }

  // Sıralama: en dikkat çekici üstte (yeni → büyüme → kayboldu → küçülme → stabil → ölçüm yok),
  // eşit önemde büyüme yüzdesine göre.
  const rank: Record<ChangeKind, number> = { yeni: 0, buyume: 1, kayboldu: 2, kuculme: 3, stabil: 4, olculemedi: 5 };
  rows.sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    // Büyümede en hızlı artış üstte; diğer gruplarda mutlak yüzde büyük olan üstte.
    return a.kind === "buyume" ? (b.deltaPct ?? 0) - (a.deltaPct ?? 0) : Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0);
  });

  const counts: Record<ChangeKind, number> = { buyume: 0, kuculme: 0, stabil: 0, yeni: 0, kayboldu: 0, olculemedi: 0 };
  for (const r of rows) counts[r.kind]++;

  const measured = rows.filter((r) => r.beforeMm !== null && r.afterMm !== null);
  const sumBeforeMm = measured.reduce((n, r) => n + (r.beforeMm ?? 0), 0);
  const sumAfterMm = measured.reduce((n, r) => n + (r.afterMm ?? 0), 0);
  const sumDeltaPct = sumBeforeMm > 0 ? ((sumAfterMm - sumBeforeMm) / sumBeforeMm) * 100 : null;

  const days = daysBetween(prior.date, current.date);
  const warning =
    before.length === 0 && after.length === 0
      ? "İki raporda da ölçülmüş lezyon yok; karşılaştırma yapılamadı."
      : before.length === 0
        ? "Önceki raporda ölçüm yok; yalnızca yeni lezyonlar listelenebilir."
        : after.length === 0
          ? "Bu raporda ölçüm yok; yalnızca önceki ölçümler gösteriliyor."
          : null;

  return {
    fromDate: prior.date,
    toDate: current.date,
    days,
    intervalText: intervalText(days),
    rows,
    counts,
    sumBeforeMm: Math.round(sumBeforeMm * 10) / 10,
    sumAfterMm: Math.round(sumAfterMm * 10) / 10,
    sumDeltaPct: sumDeltaPct === null ? null : Math.round(sumDeltaPct),
    headline: headlineOf(prior.date, days, counts, sumDeltaPct === null ? null : Math.round(sumDeltaPct)),
    warning,
  };
}

/** Tek cümlelik özet: "12 Mart 2026'ya göre (198 gün): 2 büyüme, 1 yeni lezyon." */
export function headlineOf(fromDate: string, days: number, counts: Record<ChangeKind, number>, sumDeltaPct: number | null): string {
  const parcalar: string[] = [];
  if (counts.yeni) parcalar.push(`${counts.yeni} yeni lezyon`);
  if (counts.buyume) parcalar.push(`${counts.buyume} büyüme`);
  if (counts.kayboldu) parcalar.push(`${counts.kayboldu} kayboldu`);
  if (counts.kuculme) parcalar.push(`${counts.kuculme} küçülme`);
  if (counts.stabil) parcalar.push(`${counts.stabil} stabil`);
  if (counts.olculemedi) parcalar.push(`${counts.olculemedi} ölçümsüz`);
  const toplam = sumDeltaPct === null ? "" : ` · toplam çap ${sumDeltaPct > 0 ? "+" : ""}${sumDeltaPct}%`;
  const bas = `${fmtDate(fromDate)} tarihli tetkike göre (${intervalText(days)})`;
  return parcalar.length ? `${bas}: ${parcalar.join(", ")}${toplam}.` : `${bas}: karşılaştırılabilir ölçüm yok.`;
}

/** CSV: raporda/toplantıda tablo olarak kullanılabilir (Türkçe ondalık). */
export function intervalCsv(s: IntervalSummary): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["Anatomi", "Konum", "Değişim", "Önce (mm)", "Sonra (mm)", "Fark (mm)", "Yüzde", "Açıklama"];
  const satirlar = s.rows.map((r) =>
    [
      q(r.anatomy),
      q(r.location),
      q(CHANGE_LABEL[r.kind]),
      r.beforeMm === null ? "" : String(r.beforeMm).replace(".", ","),
      r.afterMm === null ? "" : String(r.afterMm).replace(".", ","),
      r.deltaMm === null ? "" : String(r.deltaMm).replace(".", ","),
      r.deltaPct === null ? "" : `${Math.round(r.deltaPct)}%`,
      q(r.text),
    ].join(";"),
  );
  const ozet = `# ${s.fromDate} → ${s.toDate} (${s.days} gün) · toplam çap ${s.sumBeforeMm} → ${s.sumAfterMm} mm`;
  return [ozet, head.join(";"), ...satirlar].join("\n") + "\n";
}

/** Karşılaştırma için en uygun önceki raporu seçer (aynı modalite önce). */
export function pickPriorReport<T extends { createdAt: string; modality: string; studyUid: string }>(
  reports: T[],
  current: { studyUid: string; modality: string },
): T | null {
  const candidates = reports
    .filter((r) => r.studyUid !== current.studyUid)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!candidates.length) return null;
  return candidates.find((r) => r.modality === current.modality) ?? candidates[0];
}
