/**
 * HESAP KİLİTLEME İLKESİ (w-auth) — saf yardımcılar, veritabanı gerektirmez.
 *
 * Art arda `AUTH_LOCK_MAX_FAILURES` (varsayılan 5) başarısız giriş denemesinden
 * sonra hesap `AUTH_LOCK_MINUTES` (varsayılan 15) dakika kilitlenir. Değerler
 * ortam değişkeniyle kuruma göre ayarlanabilir; aralık dışı değerler güvenli
 * varsayılana düşer (0/negatif/sayı olmayan değer kilidi kapatmaz).
 */
export interface LockoutPolicy {
  /** Kilit için gereken art arda başarısız deneme sayısı. */
  max: number;
  /** Kilit süresi (dakika). */
  minutes: number;
}

export function lockoutPolicy(): LockoutPolicy {
  const max = Math.trunc(Number(process.env.AUTH_LOCK_MAX_FAILURES ?? 5));
  const minutes = Math.trunc(Number(process.env.AUTH_LOCK_MINUTES ?? 15));
  return {
    max: Number.isFinite(max) && max >= 1 ? Math.min(max, 50) : 5,
    minutes: Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, 1440) : 15,
  };
}

/** Kilit bitişine kaç dakika kaldı (en az 1; kilit geçmişse 0). */
export function lockRemainingMinutes(until: Date | null | undefined, now = Date.now()): number {
  if (!until) return 0;
  const ms = until.getTime() - now;
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 60_000));
}

/** Kilit hâlâ etkin mi? */
export function isLocked(until: Date | null | undefined, now = Date.now()): boolean {
  return !!until && until.getTime() > now;
}
