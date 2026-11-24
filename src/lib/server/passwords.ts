import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Parola saklama ve doğrulama — scrypt (N=16384, r=8, p=1).
 *
 * `hashPassword` çıktısı: `scrypt$<salt.hex>$<hash.hex>`; doğrulama sabit zamanlıdır.
 * "-" gibi özel değerler "parolasız" satır (demo operatörü) anlamına gelir ve
 * asla kabul edilmez.
 */
const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain.normalize("NFKC"), salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Kaba metin karşılaştırması yerine uzunluk + sabit zamanlı doğrulama. */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const want = Buffer.from(parts[2], "hex");
    const got = scryptSync(plain.normalize("NFKC"), salt, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
