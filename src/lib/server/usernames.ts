import { createHash } from "node:crypto";

/**
 * Kullanıcı adı normalizasyonu — OIDC ve LDAP kimlikleri ortak kural kullanır:
 * harf/rakam/`._-`, en fazla 40 karakter, en az 3 karakter; kısa/boş adlar
 * çakışmasız `oidc.<hash>` biçimine dÜŞER.
 *
 * Not: bilinçli olarak yerel ayardan bağımsız küçültme yapılır — Türkçe yerelde
 * "I"→"ı" olur ve grup adları (ör. RAD-YONETICI) eşleşmezdi. Noktasız "ı" NFKD
 * ile ayrışmadığı için açıkça eşlenir.
 */
export function sanitizeUsername(raw: string): string {
  const base = (raw ?? "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40);
  if (base.length >= 3) return base;
  return `oidc.${createHash("sha256").update(raw || "bos").digest("hex").slice(0, 8)}`;
}
