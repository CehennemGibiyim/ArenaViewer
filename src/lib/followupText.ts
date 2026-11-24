/**
 * Takip önerisi metninden görev bilgisi üretme (DB'siz, test edilebilir).
 *
 * Hem istemci hem sunucu tarafından kullanılır: onaylı raporun “Öneri” metni tek bir
 * takip görevine dönüştürülürken önerilen süre ve görev başlığı buradan alınır.
 */

/** Öneri metninden süreyi (gün/hafta/ay/yıl) gün cinsinden ayıklar; bulunamazsa null. */
export function parseIntervalDays(text: string): number | null {
  if (!text) return null;
  const t = text.toLocaleLowerCase("tr-TR");
  const m = t.match(/(\d{1,4})\s*(gün|hafta|ay|yıl)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
  const unit = m[2];
  if (unit === "gün") return n;
  if (unit === "hafta") return n * 7;
  if (unit === "ay") return Math.round(n * 30);
  return n * 365;
}

/** Görev başlığı: metnin ilk 90 karakteri (bozuk kelime yarıda kesilmez). */
export function followupTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 90) return clean;
  const cut = clean.slice(0, 87);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}
