import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Alan düzeyi AES-256-GCM şifreleme.
 * Anahtar önceliği: DATA_ENCRYPTION_KEY (base64, 32 bayt) → yoksa .data/enc.key dosyası (otomatik üretilir, 0600).
 * Üretimde anahtarı veritabanından ayrı bir KMS/ortam değişkeninde tutun.
 */
export const ENC_PREFIX = "enc:v1:";
/**
 * Anahtar kimliği taşıyan biçim (g-kms): `enc:v2:<kid>:<base64>`.
 * Rotasyon sonrası eski kayıtlar hangi anahtarla şifrelendiğini kendileri
 * söyler; böylece "eski anahtarla çöz, yeniyle şifrele" yeniden şifreleme
 * sırasında veri kaybı olmaz.
 */
export const ENC_PREFIX_V2 = "enc:v2:";
const KID_RE = /^[0-9a-f]{8}$/;
export const DATA_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), ".data");

let cached: Buffer | null = null;
let source: "env" | "file" = "file";
/**
 * Anahtar halkası (keyring): kimlik → anahtar. `currentKeyId` yazma için
 * kullanılan anahtardır; eski kimlikler yalnız okuma (çözme) içindir.
 * Süreç içi: yönetim paneli rotasyon başlattığında halka yeniden yüklenir.
 */
export interface KeyringEntry {
  kid: string;
  key: Buffer;
  /** Bu anahtarın üretildiği/aktive edildiği zaman (ISO). */
  since: string;
  current: boolean;
}
let keyring: { current: string; keys: Map<string, KeyringEntry> } | null = null;

/** Anahtar kimliği: anahtarın kendisinden türetilir (sır sızdırmaz, 8 hex). */
export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function baseKey(): Buffer {
  if (cached) return cached;
  const env = process.env.DATA_ENCRYPTION_KEY;
  if (env) {
    const b = Buffer.from(env, "base64");
    if (b.length !== 32) throw new Error("DATA_ENCRYPTION_KEY base64 olarak 32 bayt olmalıdır");
    source = "env";
    cached = b;
    return b;
  }
  const file = path.join(DATA_DIR, "enc.key");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(file)) {
    cached = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } else {
    cached = randomBytes(32);
    fs.writeFileSync(file, cached.toString("base64"), { mode: 0o600 });
  }
  source = "file";
  return cached;
}
const getKey = baseKey;

/**
 * Anahtar halkasını kurar.
 *  - `DATA_ENCRYPTION_KEYS` (virgülle ayrılmış base64 anahtarlar; EN SAĞDAKİ yazar),
 *  - `DATA_ENCRYPTION_KEY` (tek anahtar, geriye dönük uyumlu),
 *  - `.data/enc.key` (otomatik üretilen).
 * Eski anahtarlar yalnız çözme için tutulur; rotasyon tamamlanınca kaldırılır.
 */
export function getKeyring(): { current: string; keys: Map<string, KeyringEntry> } {
  if (keyring) return keyring;
  const keys = new Map<string, KeyringEntry>();
  const multi = (process.env.DATA_ENCRYPTION_KEYS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const list: Buffer[] = multi.length
    ? multi.map((b64) => {
        const b = Buffer.from(b64, "base64");
        if (b.length !== 32) throw new Error("DATA_ENCRYPTION_KEYS: her anahtar base64 olarak 32 bayt olmalıdır");
        return b;
      })
    : [baseKey()];
  const now = new Date().toISOString();
  list.forEach((key, i) => {
    const kid = keyId(key);
    keys.set(kid, { kid, key, since: now, current: i === list.length - 1 });
  });
  keyring = { current: keyId(list[list.length - 1]), keys };
  return keyring;
}

/** Rotasyon için anahtar halkasını yeniden okur (test/ayar değişikliği). */
export function resetKeyring(): void {
  keyring = null;
  cached = null;
}

/** Halkadaki anahtarların kimlikleri (sır içermez) — yönetim paneli için. */
export function keyringInfo(): { current: string; keys: { kid: string; since: string; current: boolean }[]; source: "env" | "file" } {
  const r = getKeyring();
  return {
    current: r.current,
    keys: [...r.keys.values()].map(({ kid, since, current }) => ({ kid, since, current })),
    source: keySource(),
  };
}

export function keySource(): "env" | "file" {
  if (process.env.DATA_ENCRYPTION_KEYS || process.env.DATA_ENCRYPTION_KEY) {
    getKeyring();
    return source;
  }
  getKey();
  return source;
}

/** Şifreli metin mi? (v1: tek anahtar, v2: anahtar kimlikli) */
export function isEncrypted(s: string): boolean {
  return s.startsWith(ENC_PREFIX) || s.startsWith(ENC_PREFIX_V2);
}

/**
 * Metni **aktif** anahtarla şifreler.
 *
 * Yeni kayıtlar `enc:v2:<kid>:…` biçimindedir: hangi anahtarla şifrelendiği
 * yazının kendisinde durur. Rotasyon tamamlanana kadar v1 (eski) kayıtlar da
 * okunmaya devam eder; `rexEncryptText` bunları v2'ye taşır.
 */
export function encryptText(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const ring = getKeyring();
  const key = ring.keys.get(ring.current)!.key;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${ENC_PREFIX_V2}${ring.current}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

/** v1 (anahtar kimliksiz) metni herhangi bir halka anahtarıyla çözmeyi dener. */
function decryptV1(tag: string, body: string): string {
  const ring = getKeyring();
  const b = Buffer.from(body, "base64");
  const candidates = [...ring.keys.values()].sort((a, b2) => Number(b2.current) - Number(a.current));
  for (const { key } of candidates) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      void tag;
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    } catch {
      /* sıradaki anahtar */
    }
  }
  return "[çözülemedi]";
}

export function decryptText(s: string): string {
  if (!s || !isEncrypted(s)) return s;
  try {
    if (s.startsWith(ENC_PREFIX_V2)) {
      const rest = s.slice(ENC_PREFIX_V2.length);
      const sep = rest.indexOf(":");
      const kid = rest.slice(0, sep);
      if (sep < 0 || !KID_RE.test(kid)) return "[çözülemedi]";
      const key = getKeyring().keys.get(kid)?.key;
      if (!key) return "[çözülemedi]"; // anahtar artık halkada yok
      const b = Buffer.from(rest.slice(sep + 1), "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    }
    return decryptV1(ENC_PREFIX, s.slice(ENC_PREFIX.length));
  } catch {
    return "[çözülemedi]";
  }
}

/** Kaydın hangi anahtar kimliğiyle şifrelendiğini söyler (v1 → "v1"). */
export function encryptionKeyId(s: string): string {
  if (!isEncrypted(s)) return "";
  if (s.startsWith(ENC_PREFIX_V2)) {
    const rest = s.slice(ENC_PREFIX_V2.length);
    const kid = rest.slice(0, rest.indexOf(":"));
    return KID_RE.test(kid) ? kid : "";
  }
  return "v1";
}

/** Kayıt aktif anahtarla şifrelenmiş mi? Rotasyon ilerlemesi için. */
export function isCurrentKey(s: string): boolean {
  return isEncrypted(s) && encryptionKeyId(s) === getKeyring().current;
}

export function encryptBuffer(buf: Buffer): Buffer {
  const ring = getKeyring();
  const key = ring.keys.get(ring.current)!.key;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/**
 * İkili veri çözümü. Anahtar kimliği olmadan (v1 biçim) halkadaki tüm
 * anahtarlar denenir — rotasyon sırasında eski dosyalar okunabilir kalır.
 */
export function decryptBuffer(buf: Buffer): Buffer {
  const ring = getKeyring();
  const current = ring.keys.get(ring.current)!.key;
  try {
    const d = createDecipheriv("aes-256-gcm", current, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  } catch {
    for (const { key } of ring.keys.values()) {
      if (key === current) continue;
      try {
        const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
      } catch {
        /* sıradaki */
      }
    }
    throw new Error("Şifre çözülemedi (anahtar halkada yok)");
  }
}
