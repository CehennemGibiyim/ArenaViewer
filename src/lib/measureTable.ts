/**
 * Ölçüm metni → sütunlu tablo satırları (r-struct).
 *
 * İstasyondaki ölçümler tek satır metin olarak üretilir:
 *   `Kesit 12 · Uzunluk: 34.5 mm`
 *   `Kesit 5 · Dikdörtgen ROI: A 1234.5 mm² · ç 150.2 mm · ort 42±8 HU · min/maks 10/90`
 * Raporun «Ölçümler» bölümü bu satırları **sütunlu tablo** olarak basmak zorunda; bu
 * modül satırları ayrıştırır (kesit, ölçüm türü, birincil değer, ayrıntı) ve okunabilir
 * bir özet üretir.
 *
 * Sınırlar:
 *  - Ayrıştırma biçim tabanlıdır: elle yazılmış/serbest metin satırları «ölçüm» olarak
 *    sayılmaz, tabloya `kind: ""` ile düşer (bilgi kaybı olmaz, uydurma değer olmaz).
 *  - Ondalık virgül/nokta olduğu gibi korunur; sayı yeniden biçimlendirilmez.
 */

export interface MeasureRow {
  /** 1 tabanlı kesit numarası; satırda yoksa null. */
  slice: number | null;
  /** Ölçüm türü (ör. "Uzunluk", "Dikdörtgen ROI"); bilinmiyorsa boş dize. */
  kind: string;
  /** Birincil değer (ör. "34.5 mm"); yoksa boş dize. */
  value: string;
  /** Kalan ayrıntılar (ROI istatistikleri, SUV…); yoksa boş dize. */
  detail: string;
  /** Ayrıştırılamayan satırın özgün metni. */
  raw: string;
}

const SLICE_RE = /^\s*kesit\s*(\d{1,4})\s*[·•:.\-]\s*/i;

/** Tek satırı tablo satırına çevirir; boş satırda null. */
export function parseMeasureLine(line: string): MeasureRow | null {
  const raw = line.trim();
  if (!raw) return null;
  const sliceMatch = raw.match(SLICE_RE);
  const slice = sliceMatch ? Number(sliceMatch[1]) : null;
  const body = sliceMatch ? raw.slice(sliceMatch[0].length) : raw;

  // "Uzunluk: 34.5 mm" ya da "Uzunluk 34.5 mm" (iki nokta yoksa ilk parça tür sayılır)
  const colon = body.indexOf(":");
  let kind = "";
  let rest = body;
  if (colon > 0) {
    kind = body.slice(0, colon).trim();
    rest = body.slice(colon + 1).trim();
  } else {
    const m = body.match(/^([\p{L}\s/]+?)\s+(?=[\d⌀])/u);
    if (m) {
      kind = m[1].trim();
      rest = body.slice(m[0].length).trim();
    }
  }

  const parts = rest.split(/\s*·\s*/).filter((p) => p.trim().length > 0);
  const value = parts.shift() ?? "";
  return { slice, kind, value, detail: parts.join(" · "), raw };
}

/** Çok satırlı ölçüm metnini tablo satırlarına çevirir (boş satırlar atlanır). */
export function parseMeasurements(text: string): MeasureRow[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map(parseMeasureLine)
    .filter((r): r is MeasureRow => r !== null);
}

export interface MeasureSummary {
  rows: number;
  /** Farklı kesit sayısı (kesiti olmayan satırlar sayılmaz). */
  slices: number;
  /** Ölçüm türü → adet (türü bilinmeyen satırlar "—"). */
  kinds: { kind: string; count: number }[];
}

/** Tablo başlığında gösterilecek özet (ör. "9 ölçüm · 4 kesit · Uzunluk 5, ROI 4"). */
export function measureSummary(rows: MeasureRow[]): MeasureSummary {
  const sliceSet = new Set<number>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.slice !== null) sliceSet.add(r.slice);
    const k = r.kind || "—";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {
    rows: rows.length,
    slices: sliceSet.size,
    kinds: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind, "tr")),
  };
}

/** Özet satırı (tablo altı/açıklaması). */
export function measureSummaryText(s: MeasureSummary): string {
  if (s.rows === 0) return "Ölçüm yok";
  const kinds = s.kinds.map((k) => `${k.kind} ${k.count}`).join(" · ");
  return `${s.rows} ölçüm · ${s.slices} kesit · ${kinds}`;
}
