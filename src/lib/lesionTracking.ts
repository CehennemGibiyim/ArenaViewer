/**
 * Lezyon izleme/şen grubu (RECIST tamamlayıcıları):
 *  - Çalışmalar arası otomatik lezyon eşleştirme (anatomi + yakın konum imzası)
 *  - Lenf nodu ölçüm tablosu (kısa eksen)
 *  - Non-hedef lezyon durumu ve yeni/kayboldu sinyali
 *
 * SINIRLILAMA: Eşleştirme anatomi/konum metnine dayalı kurallı bir yardımcıdır;
 * hangi lezyonların hedef olarak sayılacağı (RECIST sınırları: organ başına ≤5,
 * toplam ≤10) hekim kararıdır. Ölçümler radyolog tarafından yapılır.
 */

export interface LesionRecord {
  id: string;
  /** Örn. "akciğer", "karaciğer", "lenf nodu" */
  anatomy: string;
  /** Yakın konum ifadesi: segment, lob, seviye vb. */
  location: string;
  date: string;
  longMm?: number | null;
  /** Kısa eksen — lenf nodu değerlendirmesi için zorunlu. */
  shortMm?: number | null;
}

const norm = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/[^a-zçğıöşü0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Lezyonun karşılaştırma imzası: anatomi + konum. */
export function lesionSignature(r: Pick<LesionRecord, "anatomy" | "location">): string {
  return `${norm(r.anatomy)}|${norm(r.location)}`;
}

/**
 * Aynı anatomide konum benzerliği.
 *
 * Sayı içeren ifadelerde (ör. "segment 8" vs "segment 7") yalnız birebir eşleşme
 * kabul edilir; aksi halde farklı segmentler yanlışlıkla aynı lezyon sayılır.
 * Sayı içermeyen ifadelerde tam sözcük kümesi örtüşmesi yeterlidir.
 */
function sameRegion(a: string, b: string): boolean {
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (/\d/.test(na) || /\d/.test(nb)) return false;
  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  if (!wa.length || !wb.length) return false;
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return small.every((x) => x.length >= 3 && big.includes(x));
}

export interface LesionMatch {
  baseline: LesionRecord;
  followUp: LesionRecord;
}

export interface TrackingResult {
  matched: LesionMatch[];
  newOnes: LesionRecord[];
  disappeared: LesionRecord[];
  note: string;
}

/** Bazal ve izlem lezyonlarını eşleştirir; yeni/kaybolanları ayırır. */
export function matchLesions(baseline: LesionRecord[], followUp: LesionRecord[]): TrackingResult {
  const used = new Set<string>();
  const matched: LesionMatch[] = [];

  for (const b of baseline) {
    const c = followUp.find(
      (f) => !used.has(f.id) && norm(f.anatomy) === norm(b.anatomy) && sameRegion(f.location, b.location),
    );
    if (c) { used.add(c.id); matched.push({ baseline: b, followUp: c }); }
  }

  const newOnes = followUp.filter((f) => !used.has(f.id));
  const matchedBase = new Set(matched.map((m) => m.baseline.id));
  const disappeared = baseline.filter((b) => !matchedBase.has(b.id));

  const note =
    newOnes.length > 0
      ? "Yeni lezyon(lar) PD işareti taşır (RECIST 1.1)."
      : disappeared.length > 0
        ? "Bazaldaki bazı lezyonlar izlemde saptanmadı; kaybolduğu anlamına gelebilir (ölçüm/kararsızlık notuyla)."
        : "Tüm lezyonlar eşleşti.";

  return { matched, newOnes, disappeared, note };
}

/** Anatomi adı lenf nodu mu? */
export function isLymphNode(anatomy: string): boolean {
  return /lenf|nodu|nod|nodal/i.test(anatomy ?? "");
}

export interface LymphNodeRow {
  id: string;
  label: string;
  shortAxisMm: number | null;
  category: "normal" | "takip" | "patolojik" | "bilinmiyor";
}

/** RECIST lenf nodu kriteri: kısa eksen <10 mm normal, ≥15 mm patolojik, ara takip. */
export function lymphNodeCategory(shortAxisMm: number | null): LymphNodeRow["category"] {
  if (shortAxisMm === null || !Number.isFinite(shortAxisMm)) return "bilinmiyor";
  if (shortAxisMm < 10) return "normal";
  if (shortAxisMm < 15) return "takip";
  return "patolojik";
}

export function lymphNodeTable(rows: Array<{ id: string; anatomy: string; location: string; shortMm?: number | null }>): LymphNodeRow[] {
  return rows.filter((r) => isLymphNode(r.anatomy)).map((r) => ({
    id: r.id,
    label: `${r.anatomy}${r.location ? ` ${r.location}` : ""}`,
    shortAxisMm: r.shortMm ?? null,
    category: lymphNodeCategory(r.shortMm ?? null),
  }));
}

export type NonTargetStatus = "kalici" | "artis" | "kayboldu" | "belirsiz";

/** Non-hedef lezyon durumu (RECIST: tümü kayboldu → CR bile olsa hedefe bağlıdır). */
export function nonTargetStatus(baseShortMm: number | null, followShortMm: number | null): NonTargetStatus {
  if (baseShortMm === null || followShortMm === null) return "belirsiz";
  if (followShortMm <= 0) return "kayboldu";
  const delta = followShortMm - baseShortMm;
  if (delta >= 5 || (baseShortMm > 0 && delta / baseShortMm >= 0.2)) return "artis";
  return "kalici";
}

/** Lezyon listesini CSV satırına çevirir. */
export function trackingCsv(t: TrackingResult, nodes: LymphNodeRow[] = []): string {
  const rows: string[][] = [["Lezyon izleme", ""]];
  rows.push(["Eşleşen", String(t.matched.length)]);
  rows.push(["Yeni", t.newOnes.map((r) => r.anatomy + (r.location ? ` ${r.location}` : "")).join(", ") || "yok"]);
  rows.push(["Kaybolan", t.disappeared.map((r) => r.anatomy + (r.location ? ` ${r.location}` : "")).join(", ") || "yok"]);
  rows.push(["Not", t.note]);
  rows.push(["", ""]);
  rows.push(["Lenf nodu", "Kısa eksen mm", "Kategori"]);
  for (const n of nodes) rows.push([n.label, n.shortAxisMm === null ? "" : String(n.shortAxisMm), n.category]);
  return rows.map((r) => r.join(";")).join("\n");
}
