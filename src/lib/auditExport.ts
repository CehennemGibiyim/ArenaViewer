/**
 * Denetim kaydı dışa aktarımı — imzalı, doğrulanabilir paket (w-audit).
 *
 * Neden: "dışa aktardım" demek yeterli değil; kurum dışı denetçi (veya SIEM)
 * paketin **değiştirilmediğini** kanıtlayabilmelidir. Paket üç parçadan oluşur:
 *
 *  1. `events` — seçili aralıktaki denetim satırları (zincir hash'leriyle).
 *  2. `manifest` — sayı, ilk/son hash, zaman aralığı, biçim sürümü ve
 *     **önceki satırın hash'i** (`prevAnchor`): paket başka bir zincire ekleme
 *     yapıldığını da gösterir.
 *  3. `signature` — manifest + olayların HMAC-SHA256 imzası (`AUDIT_EXPORT_SECRET`).
 *     Sır yoksa imza alanı boş ve paket "imzasız" olarak işaretlenir; imzasız
 *     paket denetim kanıtı olarak kabul edilmez.
 *
 * Doğrulama iki katmanlıdır: (a) satırlardaki zincir hash'leri yeniden
 * hesaplanır, (b) manifest imzası kontrol edilir. Herhangi biri düşerse paket
 * reddedilir — kısmi doğruluk "geçti" sayılmaz.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface AuditEventLike {
  id: number;
  ts: string | Date;
  userId: number | null;
  username: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
  prevHash: string;
  hash: string;
}

export interface AuditManifest {
  version: 1;
  count: number;
  firstId: number | null;
  lastId: number | null;
  from: string;
  to: string;
  /** Paketten önceki zincirin son hash'i (süreklilik kanıtı). */
  prevAnchor: string;
  /** Paketin son hash'i. */
  lastHash: string;
  /** Satır hash'lerinin özeti (sıra bağımlı). */
  digest: string;
  signed: boolean;
  exportedAt: string;
  exportedBy: string;
}

export interface AuditPackage {
  manifest: AuditManifest;
  events: AuditEventLike[];
  signature: string;
}

/** Zincir hash'i (sunucudaki `computeHash` ile aynı biçim). */
export function chainHash(
  prev: string,
  ts: Date | string,
  userId: number | null,
  username: string,
  action: string,
  entityType: string,
  entityId: string,
  details: string,
  sha256: (s: string) => string,
): string {
  const iso = typeof ts === "string" ? ts : ts.toISOString();
  return sha256([prev, iso, userId ?? "", username, action, entityType, entityId, details].join("|"));
}

/** Satır hash'lerinden sıra bağımlı özet (dışa aktarımda hızlı karşılaştırma). */
export function eventsDigest(rows: AuditEventLike[], sha256: (s: string) => string): string {
  return sha256(rows.map((r) => `${r.id}:${r.hash}`).join("\n"));
}

/** Manifest üretir (imzasız). */
export function buildManifest(
  rows: AuditEventLike[],
  meta: { exportedBy: string; prevAnchor: string; exportedAt?: string; signed: boolean },
  sha256: (s: string) => string,
): AuditManifest {
  const first = rows[0] ?? null;
  const last = rows[rows.length - 1] ?? null;
  return {
    version: 1,
    count: rows.length,
    firstId: first?.id ?? null,
    lastId: last?.id ?? null,
    // Zaman aralığı: satır yoksa boş (uydurma tarih yazılmaz).
    from: first ? isoOf(first.ts) : "",
    to: last ? isoOf(last.ts) : "",
    prevAnchor: meta.prevAnchor || "GENESIS",
    lastHash: last?.hash ?? (meta.prevAnchor || "GENESIS"),
    digest: eventsDigest(rows, sha256),
    signed: meta.signed,
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    exportedBy: meta.exportedBy.slice(0, 80),
  };
}

const isoOf = (ts: string | Date) => (typeof ts === "string" ? ts : ts.toISOString());

/** Manifest + olayların imza metni (alan sırası sabit — doğrulama aynı metni üretir). */
export function signaturePayload(manifest: AuditManifest, rows: AuditEventLike[]): string {
  return [
    "v1",
    manifest.count,
    manifest.firstId ?? "",
    manifest.lastId ?? "",
    manifest.from,
    manifest.to,
    manifest.prevAnchor,
    manifest.lastHash,
    manifest.digest,
    rows.map((r) => r.hash).join(","),
  ].join("|");
}

/** HMAC-SHA256 imzası (sır varsa). */
export function signPackage(manifest: AuditManifest, rows: AuditEventLike[], secret: string): string {
  if (!secret) return "";
  return createHmac("sha256", secret).update(signaturePayload(manifest, rows)).digest("hex");
}

/** İmzayı sabit zamanlı karşılaştırmayla doğrular. */
export function verifySignature(manifest: AuditManifest, rows: AuditEventLike[], signature: string, secret: string): boolean {
  if (!secret) return false;
  const expected = signPackage(manifest, rows, secret);
  if (!signature || !expected) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface VerifyResult {
  ok: boolean;
  /** Düşen kontrolün kodu; ok ise boş. */
  reason: string;
  count: number;
  signed: boolean;
}

/**
 * Paketi doğrular: zincir sürekliliği, satır hash'leri, manifest sayı/hash
 * tutarlılığı ve (varsa) imza. İmzasız paket `ok:false` döner çünkü denetim
 * kanıtı olarak kullanılamaz — çağıran bunu "imzasız ama tutarlı" olarak
 * raporlayabilir (`reason` = imza yok).
 */
export function verifyPackage(
  pkg: AuditPackage,
  opts: { secret?: string; sha256: (s: string) => string },
): VerifyResult {
  const rows = pkg.events ?? [];
  const m = pkg.manifest;
  if (!m || m.version !== 1) return { ok: false, reason: "Bilinmeyen paket biçimi", count: rows.length, signed: false };
  if (m.count !== rows.length) return { ok: false, reason: `Satır sayısı uyuşmuyor (manifest ${m.count}, paket ${rows.length})`, count: rows.length, signed: m.signed };
  if (rows.length) {
    if (rows[0].id !== m.firstId || rows[rows.length - 1].id !== m.lastId) {
      return { ok: false, reason: "İlk/son satır kimliği manifest ile uyuşmuyor", count: rows.length, signed: m.signed };
    }
    // 1) Zincir sürekliliği ve satır hash'leri
    let prev = m.prevAnchor;
    for (const r of rows) {
      if (r.prevHash !== prev) return { ok: false, reason: `Zincir kopuk (satır ${r.id}): önceki hash uyuşmuyor`, count: rows.length, signed: m.signed };
      const h = chainHash(prev, r.ts, r.userId, r.username, r.action, r.entityType, r.entityId, r.details, opts.sha256);
      if (h !== r.hash) return { ok: false, reason: `Satır ${r.id} içeriği hash ile uyuşmuyor (değiştirilmiş)`, count: rows.length, signed: m.signed };
      prev = r.hash;
    }
    if (prev !== m.lastHash) return { ok: false, reason: "Son hash manifest ile uyuşmuyor", count: rows.length, signed: m.signed };
    if (eventsDigest(rows, opts.sha256) !== m.digest) return { ok: false, reason: "Satır özeti (digest) uyuşmuyor", count: rows.length, signed: m.signed };
    // 2) İmza
    if (!m.signed || !pkg.signature) {
      return { ok: false, reason: "Paket imzasız — denetim kanıtı olarak kullanılamaz", count: rows.length, signed: false };
    }
    if (!opts.secret) return { ok: false, reason: "İmza doğrulaması için sunucuda AUDIT_EXPORT_SECRET tanımlı değil", count: rows.length, signed: true };
    if (!verifySignature(m, rows, pkg.signature, opts.secret)) {
      return { ok: false, reason: "İmza geçersiz (paket değiştirilmiş ya da farklı sırla imzalanmış)", count: rows.length, signed: true };
    }
  } else if (m.signed) {
    // Boş paket de imzalanır; imzasız boş paket "boş ama tutarlı" demektir.
    if (!opts.secret || !verifySignature(m, [], pkg.signature, opts.secret)) {
      return { ok: false, reason: "Boş paketin imzası geçersiz", count: 0, signed: true };
    }
  }
  return { ok: true, reason: "", count: rows.length, signed: m.signed };
}

/** Kurum denetçisi için okunur doğrulama raporu (tek paragraf). */
export function verifyReport(r: VerifyResult): string {
  if (r.ok) {
    return `Paket doğrulandı: ${r.count} olay, zincir sürekli${r.signed ? " ve imza geçerli" : " (imza yok)"}.`;
  }
  return `Paket REDDEDİLDİ: ${r.reason} (${r.count} olay).`;
}

/** Üretim modu kapısı: denetim açısından hesap modu zorunlu mu? */
export function authModeGate(env: Record<string, string | undefined>): { ok: boolean; mode: string; warning: string | null } {
  const mode = (env.AUTH_MODE ?? "").trim().toLowerCase();
  const prod = env.NODE_ENV === "production" || env.APP_ENV === "production";
  const hesap = mode === "hesap" || mode === "account";
  if (!prod) return { ok: true, mode: mode || "demo", warning: null };
  if (hesap) return { ok: true, mode: "hesap", warning: null };
  if (env.AUTH_MODE_REQUIRED === "0") {
    return { ok: true, mode: mode || "demo", warning: "Üretimde demo kimlik modu: denetim izi tüm işlemleri tek operatöre atfeder (AUTH_MODE_REQUIRED=0 ile bilinçli olarak izin verildi)." };
  }
  return {
    ok: false,
    mode: mode || "demo",
    warning: "Üretimde denetim izi için AUTH_MODE=hesap zorunlu. Bilinçli istisna için AUTH_MODE_REQUIRED=0 ayarlayın.",
  };
}
