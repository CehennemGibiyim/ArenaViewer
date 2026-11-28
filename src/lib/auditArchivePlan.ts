/**
 * g-audit-export — denetim arşivi ve saklama (retention) politikası.
 *
 * Neden saf modül: arşiv/silme kararı **tek yerde** ve test edilebilir olmalı.
 * Route yalnızca sınırları (DB, dosya sistemi, şifreleme) bağlar; "hangi kayıt
 * arşivlenir, hangisi silinir, zincir nasıl korunur" mantığı burada durur.
 *
 * Tasarım kararları:
 *  1. **Saklama süresi ülke/mevzuata göre değişir**; bu yüzden varsayılan yoktur,
 *     `AUDIT_RETENTION_DAYS` tanımlı değilse hiçbir şey silinmez (yanlışlıkla veri
 *     kaybı, KVKK/HIPAA ihlalinden daha büyük bir hatadır).
 *  2. **Silme yerine arşivle:** pencere dışı kayıtlar şifreli arşive taşınır; canlı
 *     tablodan çıkarılır. Böylece zincir "arşiv manifestosu" üzerinden hâlâ
 *     doğrulanabilir (hash + prevHash + sıra).
 *  3. **Zincir bütünlüğü bozuksa silme yapılmaz** — bozuk zincir arşive taşınıp
 *     canlı tablodan silinirse delil kaybı olur; önce `verifyChain()` yeşil olmalı.
 *  4. **Manifesto imzalıdır** (HMAC-SHA256); arşiv dosyasının kendisi AES ile
 *     şifrelenir (`encryptBuffer`). Anahtar/parola asla manifestoya yazılmaz.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ArchiveRow {
  id: number;
  ts: string | Date;
  username: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
  hash: string;
  prevHash: string;
}

export interface RetentionConfig {
  /** 0 = kapalı (hiçbir şey silinmez/arşivlenmez). */
  days: number;
  /** Bir koşuda en çok taşınacak kayıt (bellek/DB kilidi koruması). */
  batch: number;
  /** Arşiv dosyalarının yazıldığı sanal dizin (storage adaptörü içinde). */
  dir: string;
}

export const MAX_ARCHIVE_BATCH = 5000;

/**
 * Ortamdan saklama yapılandırmasını okur. `AUDIT_RETENTION_DAYS` yoksa kapalıdır;
 * değer sayı değilse yine kapalı (sessizce "0 gün = hepsini sil" tehlikesi olmaz).
 */
export function retentionConfig(env: Record<string, string | undefined> = process.env): RetentionConfig {
  const raw = (env.AUDIT_RETENTION_DAYS ?? "").trim();
  const n = Number(raw);
  const days = raw === "" || !Number.isFinite(n) || n <= 0 ? 0 : Math.floor(n);
  const batchRaw = Number(env.AUDIT_ARCHIVE_BATCH ?? "1000");
  const batch = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(Math.floor(batchRaw), MAX_ARCHIVE_BATCH) : 1000;
  return { days, batch, dir: (env.AUDIT_ARCHIVE_DIR ?? "audit-archive").trim() || "audit-archive" };
}

/** Saklama sınırı: bu andan **önce** oluşturulmuş kayıtlar arşivlenir. `null` = kapalı. */
export function cutoffIso(cfg: RetentionConfig, now = new Date()): string | null {
  if (!cfg.days) return null;
  return new Date(now.getTime() - cfg.days * 86_400_000).toISOString();
}

/** Kayıt pencere dışında mı? (`cutoff` null ise hiçbiri dışarıda değil.) */
export function isExpired(row: { ts: string | Date }, cutoff: string | null): boolean {
  if (!cutoff) return false;
  const t = row.ts instanceof Date ? row.ts.getTime() : Date.parse(row.ts);
  return Number.isFinite(t) && t < Date.parse(cutoff);
}

export interface ChainStatus { ok: boolean; brokenAtId?: number | null }

/**
 * Taşınacakları seçer. Güvenlik kuralları:
 *  - Zincir bozuksa **hiçbir şey** taşınmaz (delil korunur).
 *  - Yalnız kesintisiz **ön ek** taşınır: canlı tabloda en eski kayıttan başlayarak
 *    bitişik pencere-dışı blok. Arada pencere içi bir kayıt varsa orada durulur;
 *    böylece canlı tabloda `prevHash` zinciri kopuk bir "ilk satır" kalmaz —
 *    `prevHash`'i arşivdeki son hash'e bağlanan bir **çapa** satırı üretilir.
 *  - `batch` sınırı aşılmaz.
 */
export function selectForArchive(
  rows: ArchiveRow[],
  cutoff: string | null,
  batch: number,
  chain: ChainStatus,
): ArchiveRow[] {
  if (!cutoff || chain.ok === false) return [];
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const out: ArchiveRow[] = [];
  for (const r of ordered) {
    if (!isExpired(r, cutoff)) break;
    out.push(r);
    if (out.length >= Math.max(1, batch)) break;
  }
  return out;
}

/** Manifesto: arşiv dosyasının ne içerdiğini kanıtlar (imzalı). */
export interface ArchiveManifest {
  version: 1;
  createdAt: string;
  cutoff: string;
  count: number;
  firstId: number | null;
  lastId: number | null;
  /** Arşivlenen ilk kaydın `prevHash`'i (canlı tabloda kalan çapa). */
  prevHash: string;
  /** Arşivlenen son kaydın `hash`'i — çapa satırının `prevHash`'i olur. */
  lastHash: string;
  /** Arşiv dosyasının şifreli hâlinin SHA-256'sı (içerik kanıtı). */
  cipherSha256: string;
  dir: string;
  name: string;
}

export function manifestName(now: Date, lastId: number | null): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `audit-${stamp}-${lastId ?? 0}.jsonl.enc`;
}

/** Kayıtları JSONL'e çevirir (deterministik alan sırası → imza tekrarlanabilir). */
export function toJsonl(rows: ArchiveRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        id: r.id,
        ts: (r.ts instanceof Date ? r.ts : new Date(r.ts)).toISOString(),
        username: r.username,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        details: r.details,
        hash: r.hash,
        prevHash: r.prevHash,
      }),
    )
    .join("\n") + (rows.length ? "\n" : "");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Manifesto gövdesi (imza dışındaki alanlar) — kanonik sıra. */
export function manifestBody(m: Omit<ArchiveManifest, "cipherSha256"> & { cipherSha256: string }): string {
  return JSON.stringify([
    m.version, m.createdAt, m.cutoff, m.count, m.firstId, m.lastId, m.prevHash, m.lastHash, m.cipherSha256, m.dir, m.name,
  ]);
}

export function signManifest(m: ArchiveManifest, key: string | Buffer): string {
  return createHmac("sha256", key).update(manifestBody(m)).digest("hex");
}

/** İmza doğrulama (sabit zamanlı). Anahtar yoksa `false` — "doğrulanamaz" != "geçerli". */
export function verifyManifest(m: ArchiveManifest, sig: string, key: string | Buffer | null): { ok: boolean; reason: string } {
  if (!key) return { ok: false, reason: "imza anahtarı tanımlı değil (AUDIT_ARCHIVE_KEY)" };
  const want = Buffer.from(signManifest(m, key), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(sig, "hex");
  } catch {
    return { ok: false, reason: "imza biçimi geçersiz" };
  }
  if (want.length !== got.length) return { ok: false, reason: "imza uzunluğu farklı" };
  return timingSafeEqual(want, got) ? { ok: true, reason: "" } : { ok: false, reason: "imza eşleşmiyor" };
}

/**
 * Arşiv zincirini doğrular: satırlar `prevHash` ile birbirine bağlı olmalı ve
 * manifesto aralığıyla tutarlı olmalı. `anchor`, canlı tabloda kalan ilk kaydın
 * `prevHash`'idir (varsa). Boş arşiv geçerlidir (0 satır).
 */
export function verifyArchive(
  rows: ArchiveRow[],
  expectedPrevHash: string | null,
): { ok: boolean; reason: string } {
  if (rows.length === 0) return { ok: true, reason: "" };
  if (expectedPrevHash !== null && rows[0].prevHash !== expectedPrevHash) {
    return { ok: false, reason: `ilk kaydın prevHash'i çapaya uymuyor (${rows[0].prevHash.slice(0, 12)} ≠ ${expectedPrevHash.slice(0, 12)})` };
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].prevHash !== rows[i - 1].hash) {
      return { ok: false, reason: `zincir ${rows[i - 1].id} → ${rows[i].id} arasında kopuk` };
    }
    if (rows[i].id <= rows[i - 1].id) return { ok: false, reason: `sıra bozuk (${rows[i - 1].id} → ${rows[i].id})` };
  }
  return { ok: true, reason: "" };
}

/** İnsan okur özet (panel/log). */
export function describeRetention(cfg: RetentionConfig): string {
  if (!cfg.days) return "Saklama politikası kapalı: hiçbir denetim kaydı arşivlenmez veya silinmez (AUDIT_RETENTION_DAYS tanımlayın).";
  return `Denetim kayıtları ${cfg.days} gün canlı tutulur; daha eski kayıtlar şifreli arşive taşınır (${cfg.dir}, koşu başına en çok ${cfg.batch}).`;
}
