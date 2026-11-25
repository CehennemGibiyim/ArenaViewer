import { DATA_DIR } from "./crypto";
import { decryptBuffer, encryptBuffer } from "./crypto";
import { FsStorage, S3Storage, s3FromEnv, type StorageAdapter } from "@/lib/storageAdapter";
import { getSetting } from "./settings";

/**
 * Etkin depolama adaptörü (g-backup-dr).
 *
 * Seçim sırası:
 *  1. Yönetim → Entegrasyon → `storage` ayarı (`{"kind":"s3", ...}`),
 *  2. `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` ortam değişkenleri,
 *  3. yerel disk (`.data/`).
 *
 * Sırlar ayarda AES-256-GCM ile şifreli tutulur (`sealedStorageConfig`).
 * Adaptör her istekte yeniden kurulmaz: süreç ömrü boyunca önbelleklenir ve
 * ayar değiştiğinde `resetStorage()` ile düşürülür.
 */
let cached: StorageAdapter | null = null;

export function setStorage(a: StorageAdapter | null): void {
  cached = a;
}

/** Testler ve ayar değişikliği için önbelleği temizler. */
export function resetStorage(): void {
  cached = null;
}

export function fileStorage(): StorageAdapter {
  if (cached) return cached;
  const env = s3FromEnv();
  cached = env ? new S3Storage(env) : new FsStorage(DATA_DIR);
  return cached;
}

/** Ayar kaydından S3 yapılandırması (şifre çözülmüş). */
export async function loadStorageFromSettings(): Promise<StorageAdapter | null> {
  const raw = (await getSetting("storage", "")).trim();
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, string>;
    if (p.kind !== "s3") return null;
    if (!p.endpoint || !p.bucket || !p.accessKeyId || !p.secretAccessKey) return null;
    return new S3Storage({
      endpoint: p.endpoint,
      bucket: p.bucket,
      accessKeyId: p.accessKeyId,
      secretAccessKey: decryptBuffer(Buffer.from(p.secretAccessKey, "base64")).toString("utf8"),
      region: p.region || "us-east-1",
      forcePathStyle: p.virtualHost !== "1",
    });
  } catch {
    return null;
  }
}

/** Ayar yazımı için: sır AES-GCM ile mühürlenir. */
export function sealSecret(plain: string): string {
  return encryptBuffer(Buffer.from(plain, "utf8")).toString("base64");
}
