/**
 * g-audit-export — denetim arşivini **gerçekten** yazan/doğrulayan yürütücü.
 *
 * İki kısıt birlikte çalışır:
 *  1. Denetim tablosu DB tetikleyicisiyle **DELETE'e kapalıdır** (değiştirilemezlik).
 *     Bu yüzden fiziksel silme yapılmaz: kayıtlar **arşive kopyalanır** (şifreli,
 *     imzalı manifestolu) ve istenirse partisyon/saklama politikası DB tarafında
 *     uygulanır. Canlı tablodan silmeye çalışmak sessizce başarısız olurdu — bu
 *     modül o tuzağa düşmez, `purge` seçeneği verilse bile `blocked` döndürür.
 *  2. Arşiv **doğrulanabilir**: manifesto HMAC ile imzalı, içerik AES-256-GCM
 *     (`encryptBuffer`) ile şifreli, `cipherSha256` içerik kanıtı. Doğrulama
 *     şifreyi çözer, satır hash'lerini `computeAuditHash` ile yeniden üretir.
 */
import { createHash } from "node:crypto";
import { asc, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { getKeyring } from "@/lib/server/crypto";
import { decryptBuffer, encryptBuffer } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";
import type { StorageAdapter } from "@/lib/storageAdapter";
import {
  cutoffIso, manifestName, retentionConfig, selectForArchive, sha256Hex, signManifest,
  toJsonl, verifyArchive, verifyManifest, type ArchiveManifest, type ArchiveRow, type ChainStatus,
} from "@/lib/auditArchivePlan";
import { verifyChain } from "@/lib/server/audit";

/** Denetim satır hash'ini yeniden üretir (arşiv doğrulaması buna dayanır). */
export function computeAuditHash(r: {
  ts: Date | string; userId: number | null; username: string; action: string;
  entityType: string; entityId: string; details: string;
}, prev: string): string {
  const ts = (r.ts instanceof Date ? r.ts : new Date(r.ts)).toISOString();
  return createHash("sha256")
    .update([prev, ts, r.userId ?? "", r.username, r.action, r.entityType, r.entityId, r.details].join("|"))
    .digest("hex");
}

/** İmza anahtarı: `AUDIT_ARCHIVE_KEY` yoksa mevcut ana halkadan türetilir (ayrı sır gerekmez). */
export function archiveKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const explicit = (env.AUDIT_ARCHIVE_KEY ?? "").trim();
  if (explicit) return Buffer.from(explicit, "utf8");
  try {
    const cur = getKeyring().current;
    return Buffer.from(`audit-archive:${cur}`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Bağımlılık enjeksiyonu (test/gömülü kullanım): DB, depo, anahtar ve zincir
 * doğrulayıcı dışarıdan verilebilir. Üretimde varsayılanlar kullanılır; testte
 * gerçek dosya sistemi + gerçek AES ile DB taklidi birleştirilebilsin diye var.
 */
export interface ArchiveDeps {
  db?: typeof db;
  storage?: StorageAdapter;
  key?: Buffer | null;
  chain?: () => Promise<ChainStatus>;
}

export interface ArchiveRun {
  enabled: boolean;
  days: number;
  dir: string;
  /** Taşınan (arşive yazılan) kayıt sayısı. */
  archived: number;
  /** Silme istendiyse neden yapılmadığı. */
  purge: "kapali" | "istendi-ama-engellendi" | "uygulanmadi";
  manifest: ArchiveManifest | null;
  signature: string | null;
  summary: string;
}

function rowToArchive(r: typeof auditLogs.$inferSelect): ArchiveRow {
  return {
    id: r.id, ts: r.ts, username: r.username, action: r.action, entityType: r.entityType,
    entityId: r.entityId, details: r.details, hash: r.hash, prevHash: r.prevHash,
  };
}

/**
 * Saklama koşusu: eşik dışındaki **bitişik en eski blok** şifreli arşive yazılır.
 * Zincir bozuksa yazmaz (delil korunur) ve neden döner.
 */
export async function runArchive(now = new Date(), deps: ArchiveDeps = {}): Promise<ArchiveRun> {
  const conn = deps.db ?? db;
  const cfg = retentionConfig();
  const base: ArchiveRun = { enabled: cfg.days > 0, days: cfg.days, dir: cfg.dir, archived: 0, purge: "uygulanmadi", manifest: null, signature: null, summary: "" };
  if (!cfg.days) return { ...base, purge: "kapali", summary: "Saklama politikası kapalı (AUDIT_RETENTION_DAYS yok)." };

  const cutoff = cutoffIso(cfg, now)!;
  const chain = (deps.chain ? await deps.chain() : await verifyChain()) as ChainStatus;
  if (!chain.ok) {
    return { ...base, summary: `Zincir bozuk (id ${chain.brokenAtId ?? "?"}) — arşivleme yapılmadı, delil korundu.` };
  }

  // Adaylar: eşikten eski, artan sırada, parti sınırı kadar.
  const candidates = await conn.select().from(auditLogs).where(lte(auditLogs.ts, new Date(cutoff))).orderBy(asc(auditLogs.id)).limit(cfg.batch);
  const rows = selectForArchive(candidates.map(rowToArchive), cutoff, cfg.batch, chain);
  if (rows.length === 0) return { ...base, summary: `Arşivlenecek kayıt yok (eşik ${cutoff}).` };

  const jsonl = toJsonl(rows);
  const cipher = encryptBuffer(Buffer.from(jsonl, "utf8"));
  const name = manifestName(now, rows[rows.length - 1].id);
  const storage = deps.storage ?? fileStorage();
  const key = `${cfg.dir}/${name}`;
  await storage.put(key, cipher);

  const manifest: ArchiveManifest = {
    version: 1, createdAt: now.toISOString(), cutoff, count: rows.length,
    firstId: rows[0].id, lastId: rows[rows.length - 1].id,
    prevHash: rows[0].prevHash, lastHash: rows[rows.length - 1].hash,
    cipherSha256: sha256Hex(cipher), dir: cfg.dir, name,
  };
  const k = deps.key !== undefined ? deps.key : archiveKey();
  const signature = k ? signManifest(manifest, k) : null;
  // Manifesto ayrı nesne: arşiv dosyası değişirse `cipherSha256` doğrulamada yakalar.
  await storage.put(`${cfg.dir}/${name}.manifest.json`, Buffer.from(JSON.stringify({ manifest, signature }), "utf8"));

  return {
    ...base, archived: rows.length, purge: "istendi-ama-engellendi", manifest, signature,
    summary: `${rows.length} kayıt şifreli arşive yazıldı (${key}). Canlı tablodan SİLME YAPILMADI: denetim tablosu değiştirilemezlik tetikleyicisiyle DELETE'e kapalı — saklama DB tarafında (partisyon/bakım penceresi) uygulanmalı.`,
  };
}

export interface ArchiveVerify {
  ok: boolean;
  reason: string;
  /** Doğrulanan arşivler ve satır sayıları. */
  archives: { name: string; rows: number; signatureOk: boolean; chainOk: boolean }[];
  summary: string;
}

/** Depodaki arşivleri doğrular: imza → şifre çözme → içerik hash'i → satır zinciri. */
export async function verifyArchiveDir(deps: ArchiveDeps = {}): Promise<ArchiveVerify> {
  const cfg = retentionConfig();
  const storage = deps.storage ?? fileStorage();
  const docs = "docs/YEDEK_VE_DR.md";
  let objects;
  try {
    objects = await storage.list(`${cfg.dir}/`);
  } catch (e) {
    return { ok: false, reason: `Arşiv listelenemedi: ${e instanceof Error ? e.message : "bilinmeyen hata"}`, archives: [], summary: `Arşiv deposu okunamadı (${docs}).` };
  }
  const manifests = objects.filter((o) => o.key.endsWith(".manifest.json"));
  const key = deps.key !== undefined ? deps.key : archiveKey();
  if (manifests.length === 0) return { ok: true, reason: "", archives: [], summary: "Arşiv yok (politika kapalı ya da henüz koşmadı)." };

  const out: ArchiveVerify["archives"] = [];
  for (const m of manifests) {
    const raw = await storage.get(m.key);
    if (!raw) { out.push({ name: m.key, rows: 0, signatureOk: false, chainOk: false }); continue; }
    let parsed: { manifest: ArchiveManifest; signature: string | null };
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      out.push({ name: m.key, rows: 0, signatureOk: false, chainOk: false });
      continue;
    }
    const sig = parsed.signature;
    // İmza yoksa/anahtar yoksa "geçerli" DENMEZ.
    const sigOk = !!sig && verifyManifest(parsed.manifest, sig, key).ok;
    const cipher = await storage.get(`${parsed.manifest.dir}/${parsed.manifest.name}`);
    if (!cipher) { out.push({ name: parsed.manifest.name, rows: 0, signatureOk: sigOk, chainOk: false }); continue; }
    if (sha256Hex(cipher) !== parsed.manifest.cipherSha256) { out.push({ name: parsed.manifest.name, rows: 0, signatureOk: sigOk, chainOk: false }); continue; }
    let rows: ArchiveRow[] = [];
    try {
      const text = decryptBuffer(cipher).toString("utf8");
      rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ArchiveRow);
    } catch {
      out.push({ name: parsed.manifest.name, rows: 0, signatureOk: sigOk, chainOk: false });
      continue;
    }
    const chainOk = verifyArchive(rows, null).ok;
    out.push({ name: parsed.manifest.name, rows: rows.length, signatureOk: sigOk, chainOk });
  }
  const okAll = out.every((a) => a.signatureOk && a.chainOk);
  return {
    ok: okAll, reason: okAll ? "" : "En az bir arşivde imza veya zincir doğrulanamadı.",
    archives: out,
    summary: okAll
      ? `${out.length} arşiv doğrulandı (imza + içerik + zincir).`
      : `${out.filter((a) => !(a.signatureOk && a.chainOk)).length}/${out.length} arşiv doğrulanamadı — inceleme gerekli.`,
  };
}

/** Arşiv durumu (panel): politikayı ve son arşivleri döner. */
export async function archiveStatus(deps: ArchiveDeps = {}) {
  const cfg = retentionConfig();
  const storage = deps.storage ?? fileStorage();
  let list: { key: string; size: number }[] = [];
  try {
    list = (await storage.list(`${cfg.dir}/`)).filter((o) => o.key.endsWith(".enc")).map((o) => ({ key: o.key, size: o.size }));
  } catch {
    list = [];
  }
  return { days: cfg.days, batch: cfg.batch, dir: cfg.dir, archives: list.slice(-10), storage: storage.describe() };
}
