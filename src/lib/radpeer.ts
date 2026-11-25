/**
 * RADPEER tarzı örnekleme ve uyuşmazlık istatistikleri (d-peer tamamlayıcısı).
 *
 * Neden ayrı dosya: örnekleme kararı (hangi onaylı rapor ikinci okumaya gider)
 * ve istatistik matematiği DB'den bağımsız, test edilebilir olmalı. API katmanı
 * yalnız aday listesini verir; seçim burada deterministik olarak yapılır.
 *
 * Sınırlar:
 * - Örneklem oranı bir hedeftir; aday sayısı azsa hedefe ulaşılamaz (uydurma
 *   rapor üretilmez, "hedefe ulaşılamadı" bilgisi döner).
 * - İstatistikler yalnız kaydedilmiş ikinci okumalardan gelir; değerlendirilmemiş
 *   raporlar uyumlu sayılmaz (yanlış güven üretmemek için).
 * - RADPEER puanı sonuç + fark türünden eşlenir; klinik yargı yerine geçmez.
 */

export interface Candidate {
  reportId: number;
  studyId: number;
  approvedAt: string | Date | null;
  approvedBy: string;
  createdBy: number | null;
  /** Aynı kullanıcı tarafından zaten değerlendirildi mi (API doldurur). */
  reviewedByMe: boolean;
}

/** RADPEER eşlemesi: 1 uyumlu, 2a/2b küçük fark, 3 büyük fark. */
export type RadpeerScore = 1 | "2a" | "2b" | 3;

export function radpeerScore(result: string, discrepancyType: string): RadpeerScore | null {
  if (result === "uyumlu") return 1;
  if (result === "kismen-uyumlu") return "2a";
  if (result !== "uyumsuz") return null;
  // Ölçüm/yerelleştirme veya yanlış yorum = anlamlı (3); eksik/fazladan bulgu
  // ve teknik nedenler küçük fark (2b) kabul edilir.
  if (discrepancyType === "ölçüm/yerelizasyon hatası" || discrepancyType === "yanlış yorum") return 3;
  return "2b";
}

/** Hedef örneklem büyüklüğü: oran × toplam, en az `min`. Tavan `max`. */
export function sampleSize(total: number, ratePct: number, min = 0, max = 50): number {
  if (total <= 0) return 0;
  const rate = Math.min(100, Math.max(0, ratePct)) / 100;
  return Math.min(max, Math.max(min, Math.round(total * rate)));
}

/** Deterministik karma: aynı gün aynı liste aynı örneklemi verir. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface SampleResult {
  picked: Candidate[];
  target: number;
  eligible: number;
  /** Hedefe ulaşılamadıysa açıklama (uydurma yok). */
  note: string;
}

/**
 * Aday havuzundan RADPEER örneklemi seçer.
 *
 * Dışlananlar: kendi raporu (aynı hekim kendi raporunu okuyamaz), hâlihazırda
 * bu kullanıcı tarafından değerlendirilmiş raporlar. Sıralama `seed`e bağlı
 * karmadır (gün + rapor no), böylece aynı gün paneli yenilemek listeyi
 * değiştirmez; ertesi gün yeni örneklem oluşur.
 */
export function pickSample(candidates: Candidate[], ratePct: number, seed: string, min = 0, max = 50): SampleResult {
  const eligible = candidates.filter((c) => !c.reviewedByMe);
  const target = sampleSize(eligible.length, ratePct, min, max);
  const ordered = [...eligible].sort((a, b) => hash(`${seed}:${a.reportId}`) - hash(`${seed}:${b.reportId}`));
  const picked = ordered.slice(0, target);
  const note = target === 0
    ? (eligible.length === 0 ? "İkinci okumaya uygun onaylı rapor yok." : "Örneklem oranı 0 ya da hedef 0.")
    : picked.length < target
      ? `Hedef ${target}, uygun aday ${eligible.length}; hedefe ulaşılamadı (uydurma seçim yapılmaz).`
      : "";
  return { picked, target, eligible: eligible.length, note };
}

export interface DiscordanceInput {
  result: string;
  discrepancyType: string;
  reviewedByName: string;
  createdAt: string | Date;
}

export interface ReviewerStat {
  reviewer: string;
  total: number;
  uyumlu: number;
  kismen: number;
  uyumsuz: number;
  agreementRate: number | null;
}

export interface DiscordanceStats {
  total: number;
  uyumlu: number;
  kismen: number;
  uyumsuz: number;
  known: number;
  agreementRate: number | null;
  majorRate: number | null;
  byType: { type: string; count: number }[];
  byScore: { score: RadpeerScore; count: number }[];
  reviewers: ReviewerStat[];
  /** Kümülatif uyumun %95 Wilson alt–üst sınırı (küçük örnekte geniş). */
  wilson: { low: number; high: number } | null;
}

export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** Uyuşmazlık istatistikleri: kişi, fark türü ve RADPEER puanına göre dağılım. */
export function discordanceStats(rows: DiscordanceInput[]): DiscordanceStats {
  const valid = rows.filter((r) => r.result === "uyumlu" || r.result === "kismen-uyumlu" || r.result === "uyumsuz");
  const uyumlu = valid.filter((r) => r.result === "uyumlu").length;
  const kismen = valid.filter((r) => r.result === "kismen-uyumlu").length;
  const uyumsuz = valid.filter((r) => r.result === "uyumsuz").length;
  const known = valid.length;

  const typeMap = new Map<string, number>();
  const scoreMap = new Map<RadpeerScore, number>();
  for (const r of valid) {
    const s = radpeerScore(r.result, r.discrepancyType);
    if (s !== null) scoreMap.set(s, (scoreMap.get(s) ?? 0) + 1);
    if (r.result !== "uyumlu") {
      const t = r.discrepancyType.trim() || "belirtilmemiş";
      typeMap.set(t, (typeMap.get(t) ?? 0) + 1);
    }
  }

  const reviewers = new Map<string, ReviewerStat>();
  for (const r of valid) {
    const name = r.reviewedByName.trim() || "bilinmeyen";
    const st = reviewers.get(name) ?? { reviewer: name, total: 0, uyumlu: 0, kismen: 0, uyumsuz: 0, agreementRate: null };
    st.total++;
    if (r.result === "uyumlu") st.uyumlu++;
    else if (r.result === "kismen-uyumlu") st.kismen++;
    else st.uyumsuz++;
    st.agreementRate = st.total ? (st.uyumlu + st.kismen) / st.total : null;
    reviewers.set(name, st);
  }

  return {
    total: rows.length,
    uyumlu, kismen, uyumsuz, known,
    agreementRate: known ? (uyumlu + kismen) / known : null,
    majorRate: known ? uyumsuz / known : null,
    byType: [...typeMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byScore: ([1, "2a", "2b", 3] as RadpeerScore[]).map((score) => ({ score, count: scoreMap.get(score) ?? 0 })),
    reviewers: [...reviewers.values()].sort((a, b) => b.total - a.total),
    wilson: wilsonInterval(uyumlu + kismen, known),
  };
}

/** Panel özeti (tek satır); oranlar yüzde olarak, bilinmiyorsa "—". */
export function statsHeadline(s: DiscordanceStats): string {
  const pct = (v: number | null) => (v === null ? "—" : `%${(v * 100).toFixed(1)}`);
  const ci = s.wilson ? ` (%95 GA ${pct(s.wilson.low)}–${pct(s.wilson.high)})` : "";
  return `${s.known} değerlendirme · uyum ${pct(s.agreementRate)}${ci} · büyük fark ${pct(s.majorRate)}`;
}
