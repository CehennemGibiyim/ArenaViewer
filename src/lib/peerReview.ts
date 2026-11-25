/**
 * İkinci okuma / peer review (D): RADPEER tarzı uyum kaydı.
 *
 * Bu modül yalnızca veri modeli ve hesaplama içerir; DB/API katmanı ayrıştırılmıştır.
 * Değerlendirme üç sonuçla sınırlıdır; "uyumsuz" raporun klinik açıklaması zorunludur.
 */

export const PEER_RESULTS = ["uyumlu", "kismen-uyumlu", "uyumsuz"] as const;
export type PeerResult = (typeof PEER_RESULTS)[number];

/** Uyuşmazlığın klinik etki düzeyi (RADPEER fark kategorisi). */
export const DISCREPANCY_TYPES = [
  "", "eksik bulgu", "fazladan bulgu", "ölçüm/yerelizasyon hatası", "yanlış yorum", "teknik/kalite", "diğer",
] as const;

export interface PeerReviewRow {
  id: number;
  reportId: number;
  result: string;
  discrepancyType: string;
  note: string;
  reviewedBy: number | null;
  reviewedByName: string;
  contentHash: string;
  createdAt: string | Date;
}

export const RESULT_LABELS: Record<PeerResult, string> = {
  "uyumlu": "Uyumlu — ikinci okuma önceki yorumu doğruladı",
  "kismen-uyumlu": "Kısmen uyumlu — klinik olarak anlamlı olmayan küçük fark",
  "uyumsuz": "Uyumsuz — klinik açıdan anlamlı fark",
};

export function isPeerResult(v: unknown): v is PeerResult {
  return typeof v === "string" && (PEER_RESULTS as readonly string[]).includes(v);
}

export interface PeerSummary {
  total: number;
  uyumlu: number;
  kismen: number;
  uyumsuz: number;
  /** İkinci okumaların uyum oranı (0–1); kayıt yoksa null */
  agreementRate: number | null;
  lastResult: PeerResult | null;
}

/** Kayıtlardan özet üretir; bilinmeyen sonuçlar "uyumsuz" sayılmaz. */
export function summarizePeerReviews(rows: PeerReviewRow[]): PeerSummary {
  const uyumlu = rows.filter((r) => r.result === "uyumlu").length;
  const kismen = rows.filter((r) => r.result === "kismen-uyumlu").length;
  const uyumsuz = rows.filter((r) => r.result === "uyumsuz").length;
  const known = uyumlu + kismen + uyumsuz;
  const sorted = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return {
    total: rows.length,
    uyumlu,
    kismen,
    uyumsuz,
    agreementRate: known ? (uyumlu + kismen) / known : null,
    lastResult: sorted.length && isPeerResult(sorted[0].result) ? sorted[0].result : null,
  };
}

/** Sonuca göre eylem önerisi; rapor metninde doğrudan kullanılabilir. */
export function peerAdvice(result: PeerResult): string {
  if (result === "uyumlu") return "İkinci okuma uyumlu görüldü; ek işlem gerekmez.";
  if (result === "kismen-uyumlu") return "Küçük fark not edildi; izlenim cümlesini gözden geçirmeniz yeterli olabilir.";
  return "Klinik açıdan anlamlı fark — farkı raporlayan notu inceleyin; gerekirse raporu düzeltip yeniden onaylatın ve addendum ekleyin.";
}

/** Girdi doğrulaması: geçersiz durumda hata mesajı, geçerliyse temizlenmiş değer. */
export function validatePeerReview(input: unknown): { ok: true; value: { result: PeerResult; discrepancyType: string; note: string } } | { ok: false; error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!isPeerResult(o.result)) return { ok: false, error: "Sonuç uyumlu/kısmen-uyumlu/uyumsuz olmalı" };
  const type = typeof o.discrepancyType === "string" ? o.discrepancyType.trim().slice(0, 40) : "";
  if (!(DISCREPANCY_TYPES as readonly string[]).includes(type)) return { ok: false, error: "Geçersiz uyuşmazlık türü" };
  const note = typeof o.note === "string" ? o.note.trim().slice(0, 4000) : "";
  if (o.result === "uyumsuz" && note.length < 5) return { ok: false, error: "Uyumsuz değerlendirmede açıklama zorunludur" };
  return { ok: true, value: { result: o.result, discrepancyType: type, note } };
}

// ───────── RADPEER puanlama, örnekleme ve istatistik (d-peer) ─────────

/**
 * RADPEER uyum puanları: 1 = uyumlu, 2 = uyumlu (klinik olarak anlamsız fark),
 * 3 = uyumsuz (klinik olarak anlamlı fark). Puanlar ACR RADPEER tanımının
 * basitleştirilmiş karşılığıdır; kurum politikası farklı eşleme kullanabilir.
 */
export const RADPEER_SCORE: Record<PeerResult, 1 | 2 | 3> = {
  "uyumlu": 1,
  "kismen-uyumlu": 2,
  "uyumsuz": 3,
};

export const RADPEER_LABELS: Record<1 | 2 | 3, string> = {
  1: "1 — uyumlu",
  2: "2 — uyumlu (anlamsız fark)",
  3: "3 — uyumsuz (anlamlı fark)",
};

/** Sonucu RADPEER puanına çevirir; bilinmeyen sonuçta null. */
export function radpeerScore(result: unknown): 1 | 2 | 3 | null {
  return isPeerResult(result) ? RADPEER_SCORE[result] : null;
}

/** FNV-1a 32 bit tohum özeti (örnekleme için deterministik). */
export function peerSeedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Rapor ikinci okuma örneklemine giriyor mu? Aynı rapor kimliği her zaman aynı
 * sonucu verir (deterministik), böylece "hangi raporlar denetlendi" tekrar
 * üretilebilir. `ratePct` 0 → hiçbiri, 100 → tümü.
 */
export function shouldSampleReport(reportId: number, ratePct: number, salt = "peer"): boolean {
  if (!Number.isFinite(ratePct) || ratePct <= 0) return false;
  if (ratePct >= 100) return true;
  const bucket = peerSeedHash(`${salt}:${reportId}`) % 10000;
  return bucket < Math.round(ratePct * 100);
}

export interface SamplingTarget {
  ratePct: number;
  /** Onaylı rapor sayısına göre beklenen ikinci okuma sayısı */
  expected: number;
  reviewed: number;
  /** Hedefe kalan (negatifse hedef aşılmış) */
  remaining: number;
  met: boolean;
  note: string;
}

/** Örneklem hedefini karşılaştırır (kurum için "kaç rapor daha okunmalı"). */
export function samplingTarget(totalReports: number, ratePct: number, reviewed: number): SamplingTarget {
  const rate = Number.isFinite(ratePct) ? Math.min(100, Math.max(0, ratePct)) : 0;
  const expected = Math.ceil((Math.max(0, totalReports) * rate) / 100);
  const remaining = Math.max(0, expected - Math.max(0, reviewed));
  const met = reviewed >= expected;
  return {
    ratePct: rate,
    expected,
    reviewed,
    remaining,
    met,
    note: met
      ? `Örneklem hedefi karşılandı (${reviewed}/${expected} rapor; hedef %${rate}).`
      : `Örneklem hedefi için ${remaining} rapor daha ikinci okumaya alınmalı (hedef %${rate}).`,
  };
}

export interface PeerReviewerStat {
  name: string;
  count: number;
  /** Uyumsuz (puan 3) sayısı */
  disagreements: number;
  /** Uyumsuz / değerlendirme */
  disagreementRate: number | null;
}

export interface PeerReviewStats {
  total: number;
  agreementRate: number | null;
  /** RADPEER 1/2/3 dağılımı */
  byScore: { score: 1 | 2 | 3; label: string; count: number; pct: number }[];
  byDiscrepancy: { type: string; count: number }[];
  byReviewer: PeerReviewerStat[];
  /** Takip gerektiren (uyumsuz) kayıtlar (en yeni önce, en fazla 10) */
  needsFollowUp: PeerReviewRow[];
  note: string;
}

/**
 * Toplu ikinci okuma kayıtlarından gözetim istatistikleri.
 * RADPEER tanımı gereği puan 1 ve 2 **uyumlu** sayılır; oran yalnız bilinen
 * sonuçlar üzerinden hesaplanır. Boş kümede oran null döner.
 */
export function peerStats(rows: readonly PeerReviewRow[], maxFollowUp = 10): PeerReviewStats {
  const summary = summarizePeerReviews([...rows]);
  const byScoreCount: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  const byType = new Map<string, number>();
  const byReviewer = new Map<string, { count: number; disagreements: number }>();
  for (const r of rows) {
    const score = radpeerScore(r.result);
    if (score) byScoreCount[score]++;
    const type = r.discrepancyType?.trim();
    if (type && score === 3) byType.set(type, (byType.get(type) ?? 0) + 1);
    const name = r.reviewedByName?.trim() || "(isimsiz)";
    const cur = byReviewer.get(name) ?? { count: 0, disagreements: 0 };
    cur.count++;
    if (score === 3) cur.disagreements++;
    byReviewer.set(name, cur);
  }
  const known = summary.uyumlu + summary.kismen + summary.uyumsuz;
  const pct = (n: number) => (known ? Number(((n / known) * 100).toFixed(1)) : 0);
  const needsFollowUp = rows
    .filter((r) => r.result === "uyumsuz")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(0, maxFollowUp));
  return {
    total: rows.length,
    agreementRate: summary.agreementRate,
    byScore: ([1, 2, 3] as const).map((score) => ({
      score,
      label: RADPEER_LABELS[score],
      count: byScoreCount[score],
      pct: pct(byScoreCount[score]),
    })),
    byDiscrepancy: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byReviewer: [...byReviewer.entries()]
      .map(([name, v]) => ({
        name,
        count: v.count,
        disagreements: v.disagreements,
        disagreementRate: v.count ? Number((v.disagreements / v.count).toFixed(3)) : null,
      }))
      .sort((a, b) => b.count - a.count),
    needsFollowUp,
    note: known === 0
      ? "Henüz ikinci okuma kaydı yok."
      : `RADPEER uyum oranı %${((summary.agreementRate ?? 0) * 100).toFixed(1)} (puan 1–2 uyumlu sayılır; ${known} değerlendirme).`,
  };
}
