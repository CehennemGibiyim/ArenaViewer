/**
 * İstemci tarafı CSRF yardımcısı (g-webhard).
 *
 * Sunucu, oturum çerezi olan durum değiştiren isteklerde `x-csrf-token`
 * başlığını `av_csrf` çereziyle karşılaştırır (çift gönderim deseni). Bu modül
 * çerezden jetonu okur ve başlığı ekler; `fetch` çağrılarını tek satırda
 * sarmalamak için `apiFetch` verilir.
 *
 * Çerez HttpOnly değildir (jetonun okunabilmesi gerekir) ama `SameSite=Strict`
 * olduğundan üçüncü taraf sitelerden gönderilmez; asıl koruma köken kontrolü
 * + jeton eşleşmesidir.
 */

export const CSRF_COOKIE = "av_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** Tarayıcı çerezinden CSRF jetonunu okur (SSR'de boş döner). */
export function csrfToken(): string {
  if (typeof document === "undefined") return "";
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === CSRF_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * `fetch` sarmalayıcısı: durum değiştiren isteklerde CSRF başlığını ekler.
 * Sunucu 403 + `needsCsrfToken` dönerse çerez henüz kurulmamıştır; bir kez
 * yeniden denenir (ilk sayfa yüklemesinde çerez yarışı olabilir).
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const withToken = (extra = true): RequestInit => {
    if (!extra || !STATE_CHANGING.has(method)) return init;
    const token = csrfToken();
    if (!token) return init;
    const headers = new Headers(init.headers);
    headers.set(CSRF_HEADER, token);
    return { ...init, headers, credentials: init.credentials ?? "same-origin" };
  };
  // Next.js sunucu bileşenleri `fetch`'i mutasyon için de çağırabilir; yalnız
  // tarayıcıda jeton ekliyoruz (sunucuda `document` yoktur).
  if (typeof document === "undefined") return fetch(input, init);
  const res = await fetch(input, withToken());
  if (res.status !== 403) return res;
  // Gövdeyi okumadan yeniden denemek için klonluyoruz.
  const clone = res.clone();
  const body = (await clone.json().catch(() => ({}))) as { needsCsrfToken?: boolean };
  if (!body.needsCsrfToken) return res;
  // Çerezi tazelemek için bir GET at, sonra tekrar dene.
  await fetch("/api/health", { credentials: "same-origin" }).catch(() => null);
  return fetch(input, withToken());
}
