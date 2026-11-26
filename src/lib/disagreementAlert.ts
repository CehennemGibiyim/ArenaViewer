/**
 * AI uyuşmazlığında yönetici uyarısı (t-automation).
 *
 * Karar sayısı yeterliyken (varsayılan: ≥10 karar) bir kategori için uyuşmazlık
 * oranı %30'u geçerse uyarı üretir. Kanallara gönderim ve denetim kaydı
 * `src/lib/server/disagreementAlert.ts` içindedir; bu dosya saf karardır.
 *
 * Gerekçe metinleri serbesttir; "modele geri besleme" için kaba sınıflara
 * ayrılır (kural tabanlı TR/EN anahtar sözcükler, LLM kullanılmaz). Sınıflar,
 * model sahibinin inceleyeceği kompakt bir özet verir; modeli kendisi yeniden
 * eğitmez ve klinik doğruluk ÖLÇMEZ.
 */
import type { CategoryDisagreement, ReasonDigestEntry } from "./aiDisagreement";

export const DISAGREEMENT_THRESHOLD = 0.3;
export const MIN_DECIDED = 10;

export interface DisagreementAlert {
  engine: string;
  category: string;
  decided: number;
  rejected: number;
  edited: number;
  /** 0..1 */
  disagreementRate: number;
}

/** Eşiği aşan kategoriler (en yüksek oran önce). */
export function findDisagreementAlerts(
  rows: CategoryDisagreement[],
  threshold = DISAGREEMENT_THRESHOLD,
  minDecided = MIN_DECIDED
): DisagreementAlert[] {
  return rows
    .filter((r) => r.disagreementRate !== null && r.decided >= minDecided && r.disagreementRate >= threshold)
    .map((r) => ({
      engine: r.engine,
      category: r.category,
      decided: r.decided,
      rejected: r.rejected,
      edited: r.edited,
      disagreementRate: r.disagreementRate as number,
    }))
    .sort((a, b) => b.disagreementRate - a.disagreementRate || b.decided - a.decided || a.category.localeCompare(b.category, "tr"));
}

export type ReasonClass = "artefakt" | "kalibrasyon" | "yanlis-pozitif" | "anatomi-varyant" | "teknik" | "diger";

export const REASON_CLASS_LABEL: Record<ReasonClass, string> = {
  "artefakt": "Artefakt/hareket",
  "kalibrasyon": "Kalibrasyon/HU/SUV",
  "yanlis-pozitif": "Yanlış pozitif",
  "anatomi-varyant": "Anatomik varyant",
  "teknik": "Teknik/protokol",
  "diger": "Diğer",
};

const RULES: Array<[ReasonClass, RegExp]> = [
  ["artefakt", /artefakt|artifact|hareket|motion|metal|implant|gürültü|noise|çizgi|streak|beam.?harden|seviye kayd/i],
  ["kalibrasyon", /kalibr|calibrat|\bhu\b|dansite|yoğunluk|suv\b|window|pencere|ölçek|scale|standardiz/i],
  ["yanlis-pozitif", /yanlış pozitif|yanlis pozitif|false positive|normal|fizyolojik|patolojik değil|temiz|bulgu yok|hastalık yok/i],
  ["anatomi-varyant", /varyant|varyasyon|anatomik|anatomic|aksesuar|anomal|konjenital|variant/i],
  ["teknik", /teknik|protocol|protokol|kesit|çekim|kontrast|enjeksiyon|pozisyon|doz|mAs|kVp|kalite|blur/i],
];

/** Serbest metni kaba sınıfa ayırır (LLM yok; eşleşmezse "diger"). */
export function classifyReason(reason: string): ReasonClass {
  const t = (reason ?? "").trim();
  if (!t) return "diger";
  for (const [cls, re] of RULES) if (re.test(t)) return cls;
  return "diger";
}

export interface ReasonClassDigestEntry {
  cls: ReasonClass;
  label: string;
  count: number;
}

/** Gerekçe sınıflarının sayımı (çoktan aza). `limit` en çok kaç sınıf dönsün. */
export function summarizeReasonClasses(reasons: ReasonDigestEntry[], limit = 6): ReasonClassDigestEntry[] {
  const counts = new Map<ReasonClass, number>();
  for (const r of reasons ?? []) {
    const cls = classifyReason(r.reason);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cls, count]) => ({ cls, label: REASON_CLASS_LABEL[cls], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "tr"))
    .slice(0, Math.max(0, limit));
}

/** Uyarı metninde kullanılacak gerekçe özeti (tek satır). */
export function reasonClassDigestText(digest: ReasonClassDigestEntry[]): string {
  if (digest.length === 0) return "gerekçe metni yok";
  return digest.map((d) => `${d.label} ${d.count}`).join(", ");
}
