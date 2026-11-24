import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * İmzalı oturum çerezi — kullanıcı kimliği bu çerezle taşınır.
 *
 * Çerez: `atik_user = base64url(uid|sonKullanimTarihi) + "." + HMAC-SHA256(imza)`.
 * İmza anahtarı `SESSION_SECRET` ortam değişkeni; tanımsızsa DATA_ENCRYPTION_KEY'e
 * düşer (her ikisi de yoksa imzalı oturum devre dışı kalır → auth.ts demo'ya döner).
 *
 * Neden JWT kütüphanesi yerine HMAC: yalnızca bir alan (uid + süre) imzalanıyor;
 * harici bağımlılık eklemeye gerek yok ve süre sonu sunucuda da kontrol ediliyor.
 */
export const SESSION_COOKIE = "atik_user";
const TTL_MS = 8 * 60 * 60 * 1000; // 8 saat

function secret(): string {
  return process.env.SESSION_SECRET ?? process.env.DATA_ENCRYPTION_KEY ?? "";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Kullanıcı için oturum çerez değeri üretir; gizli anahtar yoksa null. */
export function issueSessionCookie(uid: number): string | null {
  if (!secret()) return null;
  const exp = Date.now() + TTL_MS;
  const payload = Buffer.from(`${uid}.${exp}`, "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Çerez değerini doğrular; geçerliyse uid, değilse null döner. */
export function verifySessionCookie(value: string | undefined | null): number | null {
  if (!value || !secret()) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const want = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const text = Buffer.from(payload, "base64url").toString("utf8");
    const [uidStr, expStr] = text.split(".");
    const uid = Number(uidStr);
    const exp = Number(expStr);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isFinite(exp) || exp < Date.now()) return null;
    return uid;
  } catch {
    return null;
  }
}

/** İstekten oturum kullanıcı id'sini okur. */
export function sessionUserId(req: NextRequest): number | null {
  return verifySessionCookie(req.cookies.get(SESSION_COOKIE)?.value);
}
