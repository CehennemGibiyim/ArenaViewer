/**
 * Kurum dikte sözlüğü istemcisi (r-dictate).
 *
 * Sözlük sunucuda (`/api/admin/dictation`, app_settings) tutulur; burada küçük
 * bir bellek önbelleği ile her mikrofon kullanımında ağ çağrısı yapılmasını
 * engeller. Çevrimdışı/demo modda istek başarısız olursa boş liste döner ve
 * dikte normal çalışır (öğrenme devre dışı).
 */

import type { LearnedCorrection } from "./dictationAssist";

let cache: LearnedCorrection[] = [];
let inflight: Promise<LearnedCorrection[]> | null = null;

/** Önbellekteki sözlük (senkron; ilk yüklemeden önce boş). */
export function cachedLexicon(): LearnedCorrection[] {
  return cache;
}

export function setCachedLexicon(list: LearnedCorrection[]): void {
  cache = Array.isArray(list) ? list : [];
}

/** Sözlüğü sunucudan yükler (paralel çağrılar tek isteğe birleşir). */
export async function loadLexicon(force = false): Promise<LearnedCorrection[]> {
  if (inflight) return inflight;
  if (!force && cache.length) return cache;
  inflight = (async () => {
    try {
      const r = await fetch("/api/admin/dictation", { cache: "no-store" });
      if (!r.ok) return cache;
      const d = (await r.json()) as { corrections?: LearnedCorrection[] };
      setCachedLexicon(d.corrections ?? []);
      return cache;
    } catch {
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Öğrenilen düzeltmeyi gönderir (`accept` / `reject` / `remove`).
 * Başarısız olursa yerel önbellek değişmez; hata yutulur (dikte akışı durmaz).
 */
export async function learnCorrection(
  action: "accept" | "reject" | "remove",
  from: string,
  to?: string,
): Promise<LearnedCorrection[]> {
  try {
    const r = await fetch("/api/admin/dictation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, from, to }),
    });
    if (!r.ok) return cache;
    const d = (await r.json()) as { corrections?: LearnedCorrection[] };
    setCachedLexicon(d.corrections ?? []);
    return cache;
  } catch {
    return cache;
  }
}
