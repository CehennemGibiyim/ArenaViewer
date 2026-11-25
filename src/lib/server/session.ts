import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * İmzalı oturum çerezi — kullanıcı kimliği ve (varsa) sunucu oturum kimliği bu
 * çerezle taşınır.
 *
 * Çerez: `atik_user = base64url(uid.sonKullanımTarihi[.oturumKimliği]) + "." + HMAC-SHA256(imza)`.
 * İmza anahtarı `SESSION_SECRET` ortam değişkeni; tanımsızsa DATA_ENCRYPTION_KEY'e
 * düşer (her ikisi de yoksa imzalı oturum devre dışı kalır → auth.ts demo'ya döner).
 *
 * Üçüncü alan (oturum kimliği) sunucudaki `sessions` satırına işaret eder ve
 * "aktif oturumlar" ekranından iptal edilebilir. Üçüncü alanı olmayan eski
 * çerezler (iki alan) süresi dolana kadar geçerli kalır; iptal edilemezler ama
 * çerez 8 saatlik ömürle zaten kendiliğinden düşer.
 *
 * Neden JWT kütüphanesi yerine HMAC: yalnızca birkaç alan imzalanıyor; harici
 * bağımlılık gerekmiyor ve süre sonu sunucuda da kontrol ediliyor.
 */
export const SESSION_COOKIE = "atik_user";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 saat

/** Sunucu oturum kimliği biçimi: 16 bayt rastgele → 32 hex. */
export const SESSION_ID_RE = /^[a-f0-9]{32}$/;

export interface SessionRef {
  uid: number;
  /** Sunucu oturum kaydı kimliği; eski (iki alanlı) çerezlerde boş dize. */
  sid: string;
  /** Son kullanma zamanı (epoch ms). */
  exp: number;
}

function secret(): string {
  return process.env.SESSION_SECRET ?? process.env.DATA_ENCRYPTION_KEY ?? "";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Kullanıcı için oturum çerez değeri üretir; gizli anahtar yoksa null. */
export function issueSessionCookie(uid: number, sid?: string): string | null {
  if (!secret()) return null;
  const exp = Date.now() + SESSION_TTL_MS;
  const raw = sid && SESSION_ID_RE.test(sid) ? `${uid}.${exp}.${sid}` : `${uid}.${exp}`;
  const payload = Buffer.from(raw, "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Çerez değerini doğrular; geçerliyse kimlik/süre/oturum bilgisi döner. */
export function verifySessionRef(value: string | undefined | null): SessionRef | null {
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
    const [uidStr, expStr, sid = ""] = text.split(".");
    const uid = Number(uidStr);
    const exp = Number(expStr);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isFinite(exp) || exp < Date.now()) return null;
    if (sid && !SESSION_ID_RE.test(sid)) return null;
    return { uid, sid, exp };
  } catch {
    return null;
  }
}

/** Çerez değerini doğrular; geçerliyse uid, değilse null döner. */
export function verifySessionCookie(value: string | undefined | null): number | null {
  return verifySessionRef(value)?.uid ?? null;
}

/** İstekten oturum kullanıcı id'sini okur. */
export function sessionUserId(req: NextRequest): number | null {
  return verifySessionRef(req.cookies.get(SESSION_COOKIE)?.value)?.uid ?? null;
}

/** İstekten tam oturum bilgisini (uid + sunucu oturum kimliği) okur. */
export function sessionRef(req: NextRequest): SessionRef | null {
  return verifySessionRef(req.cookies.get(SESSION_COOKIE)?.value);
}
