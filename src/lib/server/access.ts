import type { NextRequest } from "next/server";

/**
 * İsteğe bağlı tek erişim anahtarı (ACCESS_TOKEN).
 *
 * Boş tanımlıysa kapı açıktır (demo varsayılanı): herkes her şeyi görür.
 * Tanımlıysa middleware tüm sayfa/API isteklerini bu anahtara bağlar; doğru
 * oturum çerezine sahip olmayanlar /giris sayfasına yönlendirilir.
 *
 * Not: Bu, tek kullanıcılı/tek anahtarlı bir kapıdır; gerçek çok kullanıcılı
 * yetkilendirme (rol/SSO/MFA) için kurumsal kimlik doğrulama gereklidir.
 */

const TOKEN = process.env.ACCESS_TOKEN ?? "";

export const ACCESS_COOKIE = "atik_session";

export const accessEnabled = () => TOKEN.length > 0;

/** Uzunluk farkı dahil sabit zamanlı karşılaştırma (edge middleware uyumlu). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkToken(token: string): boolean {
  return accessEnabled() && safeEqual(token, TOKEN);
}

/** İstekteki Authorization: Bearer veya oturum çerezi anahtarı doğrular. */
export function checkAccess(req: NextRequest): boolean {
  if (!accessEnabled()) return true;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && checkToken(auth.slice(7).trim())) return true;
  return checkToken(req.cookies.get(ACCESS_COOKIE)?.value ?? "");
}
