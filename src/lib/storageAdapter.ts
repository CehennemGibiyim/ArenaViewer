/**
 * Depolama adaptörü + yedek/geri yükleme çekirdeği (g-backup-dr).
 *
 * Neden adaptör: bugüne kadar görüntü dosyaları doğrudan `.data/` altına
 * yazılıyordu (tek makineye bağlı, yedeklenmesi zor). Kurumlar S3/MinIO gibi
 * nesne depolama ya da paylaşımlı bir disk (NFS) ister. Bu modül dosya
 * sistemi ve S3 uyumlu depolamayı **aynı arayüzle** sunar; uygulama katmanı
 * hangi arka ucun kullanıldığını bilmez.
 *
 * S3 istemcisi neden elle: `@aws-sdk/client-s3` (~10 MB bağımlılık ağacı)
 * tek bir PUT/GET/DELETE/LIST için ağır. İhtiyacımız olan üç imzalı istek
 * AWS SigV4 ile ~100 satırda yazılabiliyor ve MinIO/AWS/R2/Wasabi ile
 * uyumlu. Yüklenen nesne **zaten şifreli** olduğundan sunucu tarafı şifreleme
 * ayrıca istenmez.
 *
 * Yedek/geri yükleme:
 *  - `createManifest`: dosya adı, boyut, SHA-256, sürüm ve şifreleme biçimi.
 *  - `verifyManifest`: manifest ile gerçek dosyalar arasındaki uyuşmazlıkları
 *    raporlar (DR tatbikatının makine tarafından denetlenebilir hâli).
 *  - `planRestore`: sürümden geri dönüş için hangi dosyaların yazılacağını
 *    ve çakışmaların nasıl çözüleceğini belirler (idempotent geri yükleme).
 */

import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ───────────────────────── Depolama arayüzü ─────────────────────────

export interface StoredObject {
  key: string;
  size: number;
}

export interface StorageAdapter {
  readonly kind: "fs" | "s3";
  /** Nesne yazar (üzerine yazar). */
  put(key: string, body: Buffer): Promise<void>;
  /** Nesneyi okur; yoksa `null`. */
  get(key: string): Promise<Buffer | null>;
  /** Nesne siler; yoksa sessizce geçer. */
  delete(key: string): Promise<void>;
  /** Önek altındaki nesneleri listeler. */
  list(prefix?: string): Promise<StoredObject[]>;
  /** Yapılandırma özeti (günlük/denetim için; sır içermez). */
  describe(): string;
}

/** Anahtar güvenliği: yol kaçışı (`..`) ve mutlak yollar reddedilir. */
export function safeKey(key: string): string {
  const k = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!k || k.split("/").some((p) => p === ".." || p === ".")) throw new Error(`Geçersiz nesne anahtarı: ${key}`);
  if (k.length > 512) throw new Error("Nesne anahtarı çok uzun");
  return k;
}

// ───────────────────────── S3 (SigV4) ─────────────────────────

export interface S3Options {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Yol tarzı adresleme (MinIO için gerekli). */
  forcePathStyle?: boolean;
  /** Test/yerel geliştirme için `fetch` enjeksiyonu. */
  fetchImpl?: typeof fetch;
}

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS SigV4 imzası (S3 için). Testlerde bilinen vektörlerle karşılaştırılabilir. */
export function sigV4(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** Testlerde sabit zaman. */
  amzDate?: string;
}): Record<string, string> {
  const service = opts.service ?? "s3";
  const amzDate = opts.amzDate ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...opts.headers,
    host: opts.url.host,
    "x-amz-content-sha256": opts.payloadHash,
    "x-amz-date": amzDate,
  };
  // İmzalanan başlıklar küçük harfli ve sıralı olmalı.
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === n) ?? n] ?? "").trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.url.pathname || "/",
    // S3 imzası için sorgu parametreleri sıralı ve kodlanmış olmalı.
    [...opts.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const xmlValues = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** S3 ListObjectsV2 XML yanıtını nesne listesine çevirir (saf fonksiyon). */
export function parseS3List(xml: string): StoredObject[] {
  const out: StoredObject[] = [];
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlValues(block[1], "Key")[0];
    const size = Number(xmlValues(block[1], "Size")[0] ?? 0);
    if (key) out.push({ key: xmlUnescape(key), size });
  }
  return out;
}

/**
 * S3 uyumlu (MinIO, AWS, R2, Wasabi) depolama. Yalnız ihtiyaç duyduğumuz
 * dört işlem vardır; multipart upload yok (dosyalar ≤ 300 MB ve tek PUT ile
 * gider; S3 sınırı 5 GB).
 */
export class S3Storage implements StorageAdapter {
  readonly kind = "s3" as const;
  private readonly base: URL;
  constructor(private readonly o: S3Options) {
    const ep = new URL(o.endpoint);
    this.base = new URL(ep.toString().replace(/\/+$/, ""));
  }

  private url(key = "", query?: Record<string, string>): URL {
    const u = new URL(this.base.toString());
    const path = this.o.forcePathStyle === false ? `/${key}` : `/${this.o.bucket}${key ? `/${key}` : ""}`;
    u.pathname = path;
    if (this.o.forcePathStyle === false) u.host = `${this.o.bucket}.${u.host}`;
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private request(method: string, url: URL, body: Buffer = Buffer.alloc(0), extra: Record<string, string> = {}) {
    const headers = sigV4({
      method,
      url,
      headers: extra,
      payloadHash: sha256Hex(body),
      accessKeyId: this.o.accessKeyId,
      secretAccessKey: this.o.secretAccessKey,
      region: this.o.region ?? "us-east-1",
    });
    const f = this.o.fetchImpl ?? fetch;
    return f(url.toString(), { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
  }

  async put(key: string, body: Buffer): Promise<void> {
    const url = this.url(safeKey(key));
    const res = await this.request("PUT", url, body, { "content-type": "application/octet-stream" });
    if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.request("GET", this.url(safeKey(key)));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", this.url(safeKey(key)));
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${res.status}`);
  }

  async list(prefix = ""): Promise<StoredObject[]> {
    const res = await this.request("GET", this.url("", { "list-type": "2", prefix, "max-keys": "1000" }));
    if (!res.ok) throw new Error(`S3 LIST ${res.status}`);
    return parseS3List(await res.text());
  }

  describe(): string {
    return `S3 ${this.base.host}/${this.o.bucket} (${this.o.region ?? "us-east-1"})`;
  }
}

/** Ortam değişkenlerinden S3 yapılandırması (yoksa null). */
export function s3FromEnv(env: Record<string, string | undefined> = process.env): S3Options | null {
  const endpoint = (env.S3_ENDPOINT ?? "").trim();
  const bucket = (env.S3_BUCKET ?? "").trim();
  const accessKeyId = (env.S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.S3_SECRET_ACCESS_KEY ?? "").trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: (env.S3_REGION ?? "us-east-1").trim(),
    // MinIO varsayılan olarak yol tarzı ister; AWS/R2 için `S3_VIRTUAL_HOST=1`.
    forcePathStyle: env.S3_VIRTUAL_HOST !== "1",
  };
}

// ───────────────────────── Yedek/geri yükleme ─────────────────────────

export interface BackupEntry {
  key: string;
  size: number;
  sha256: string;
  /** Dosya depoda AES-GCM ile şifreli mi (yani okurken çözülmeli mi)? */
  encrypted: boolean;
  /**
   * `sha256` hangi içeriğe ait:
   *  - `"plain"`: açık (şifre çözülmüş) içerik — normal durum, taşınabilir yedek,
   *  - `"cipher"`: depodaki şifreli baytlar — anahtar kaybolduğunda (çözülemez
   *    dosyalar) yalnız bütünlük denetimi yapılabilir, içerik doğrulanamaz.
   */
  shaScope: "plain" | "cipher";
}

export interface BackupManifest {
  format: "atikviewer-yedek";
  version: 1;
  createdAt: string;
  appVersion: string;
  /** Kaynak tanımı: "fs:./.data" ya da "s3:host/bucket". */
  source: string;
  entries: BackupEntry[];
  /** Toplam açık (şifre çözülmüş) bayt — kapasite planlaması için. */
  totalBytes: number;
}

/** Manifest oluşturur; girdiler anahtara göre sıralıdır (tekrarlanabilir çıktı). */
export function createManifest(
  files: { key: string; plaintext?: Buffer; encryptedBytes?: Buffer; storeEncrypted?: boolean }[],
  meta: { source: string; appVersion: string; createdAt?: string },
): BackupManifest {
  const entries: BackupEntry[] = files.map((f) => {
    const plain = f.plaintext;
    const enc = f.encryptedBytes;
    if (!plain && !enc) throw new Error(`Dosya içeriği yok: ${f.key}`);
    // Özet her zaman *içerik* kimliğidir: açık içerik varsa ondan hesaplanır,
    // böylece yedek anahtar değişse bile taşınabilir (yeniden şifrelenebilir).
    return {
      key: safeKey(f.key),
      size: (plain ?? enc!).length,
      sha256: sha256Hex(plain ?? enc!),
      encrypted: plain ? f.storeEncrypted === true : true,
      shaScope: plain ? "plain" : "cipher",
    };
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    format: "atikviewer-yedek",
    version: 1,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    appVersion: meta.appVersion,
    source: meta.source,
    entries,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
  };
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checked: number;
}

/**
 * Manifesti gerçek depolama ile karşılaştırır.
 * `read` verilen anahtarın **şifreli** baytlarını döndürür (depodaki hâli).
 * `decrypt` verilirse açık içerik de özetlenebilir; aksi hâlde manifestteki
 * `encrypted` bayrağı beklenir.
 */
export async function verifyManifest(
  manifest: BackupManifest,
  read: (key: string) => Promise<Buffer | null>,
  decrypt?: (buf: Buffer) => Buffer,
): Promise<VerifyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (manifest.format !== "atikviewer-yedek") errors.push("Yedek biçimi tanınmıyor");
  if (manifest.version !== 1) errors.push(`Desteklenmeyen yedek sürümü: ${manifest.version}`);
  let checked = 0;
  for (const e of manifest.entries) {
    const bytes = await read(e.key);
    if (!bytes) { errors.push(`Eksik dosya: ${e.key}`); continue; }
    checked++;
    let content = bytes;
    if (e.shaScope === "plain") {
      if (e.encrypted) {
        if (!decrypt) { errors.push(`Şifre çözücü gerekli ama verilmedi: ${e.key}`); continue; }
        try {
          content = decrypt(bytes);
        } catch {
          errors.push(`Şifre çözülemedi: ${e.key}`);
          continue;
        }
      }
    } else if (decrypt && !e.encrypted) {
      warnings.push(`Açık dosyada şifreli özet: ${e.key}`);
    }
    const got = sha256Hex(content);
    if (got !== e.sha256) errors.push(`Özet uyuşmuyor: ${e.key}`);
    else if (e.size !== content.length) errors.push(`Boyut uyuşmuyor: ${e.key} (${content.length} ≠ ${e.size})`);
  }
  const total = manifest.entries.length;
  if (total === 0) warnings.push("Yedek boş (hiç dosya yok)");
  return { ok: errors.length === 0, errors, warnings, checked };
}

export interface RestorePlan {
  /** Yazılacak dosyalar (depodaki hâliyle). */
  write: string[];
  /** Zaten aynı içerikte olanlar (atlanır — idempotent geri yükleme). */
  skip: string[];
  /** Manifest dışında kalan, silinmeyecek ama raporlanacak dosyalar. */
  extra: string[];
}

/**
 * Geri yükleme planı: hedefte aynı özet varsa atlanır, farklıysa yazılır.
 * Hiçbir zaman silme yapmaz — DR senaryosunda fazladan dosya kaybetmek
 * istemiyoruz; fazlalıklar `extra` olarak raporlanır.
 */
export function planRestore(
  manifest: BackupManifest,
  existing: { key: string; sha256: string }[],
): RestorePlan {
  const have = new Map(existing.map((e) => [e.key, e.sha256]));
  const write: string[] = [];
  const skip: string[] = [];
  for (const e of manifest.entries) {
    const cur = have.get(e.key);
    if (cur === e.sha256) skip.push(e.key);
    else write.push(e.key);
  }
  const wanted = new Set(manifest.entries.map((e) => e.key));
  const extra = existing.map((e) => e.key).filter((k) => !wanted.has(k));
  return { write, skip, extra };
}

/** Manifesti JSON olarak serileştirir (sabit alan sırası). */
export function stringifyManifest(m: BackupManifest): string {
  return JSON.stringify(
    {
      format: m.format,
      version: m.version,
      createdAt: m.createdAt,
      appVersion: m.appVersion,
      source: m.source,
      totalBytes: m.totalBytes,
      entries: m.entries.map((e) => ({ key: e.key, size: e.size, sha256: e.sha256, encrypted: e.encrypted, shaScope: e.shaScope })),
    },
    null,
    2,
  );
}

/** Manifest JSON'unu doğrular (bozuk/elle düzenlenmiş yedek reddedilir). */
export function parseManifest(json: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Yedek manifesti geçerli JSON değil");
  }
  const m = raw as Partial<BackupManifest>;
  if (!m || typeof m !== "object") throw new Error("Yedek manifesti boş");
  if (m.format !== "atikviewer-yedek") throw new Error("Yedek biçimi tanınmıyor");
  if (m.version !== 1) throw new Error(`Desteklenmeyen yedek sürümü: ${String(m.version)}`);
  if (!Array.isArray(m.entries)) throw new Error("Yedek dosya listesi yok");
  const entries = m.entries.map((e) => {
    if (!e || typeof e.key !== "string" || !/^[a-f0-9]{64}$/i.test(String(e.sha256))) throw new Error("Yedek dosya kaydı geçersiz");
    return {
      key: safeKey(e.key),
      size: Number(e.size) || 0,
      sha256: String(e.sha256).toLowerCase(),
      encrypted: e.encrypted !== false,
      // Eski yedeklerde alan yok: varsayılan "plain" (taşınabilir yedek).
      shaScope: (e.shaScope === "cipher" ? "cipher" : "plain") as BackupEntry["shaScope"],
    };
  });
  return {
    format: "atikviewer-yedek",
    version: 1,
    createdAt: String(m.createdAt ?? ""),
    appVersion: String(m.appVersion ?? ""),
    source: String(m.source ?? ""),
    entries,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
  };
}

/** Yedek dosya adı: `yedek-<sürüm>-<tarih>.json` (sıralanabilir). */
export function backupFileName(appVersion: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `yedek-${appVersion.replace(/[^0-9A-Za-z._-]/g, "_")}-${stamp}.json`;
}

/** DR tatbikatı için özet: "412 dosya / 3,2 GB / 2 eksik". */
export function summarizeBackup(m: BackupManifest, verify?: VerifyResult): string {
  const gb = m.totalBytes / 1024 ** 3;
  const boyut = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(m.totalBytes / 1024 ** 2).toFixed(1)} MB`;
  if (!verify) return `${m.entries.length} dosya / ${boyut} (doğrulanmadı)`;
  const eksik = verify.errors.filter((e) => e.startsWith("Eksik")).length;
  return `${m.entries.length} dosya / ${boyut} / ${verify.checked} denetlendi / ${eksik} eksik / ${verify.ok ? "sağlam" : "HATALI"}`;
}

// ───────────────────────── Dosya sistemi adaptörü ─────────────────────────

/**
 * Yerel disk adaptörü (varsayılan). Anahtarlar `DATA_DIR` altına göre çözülür;
 * `safeKey` sayesinde `../` ile dizin dışına çıkılamaz (path traversal).
 */
export class FsStorage implements StorageAdapter {
  readonly kind = "fs" as const;
  constructor(private readonly root: string) {}

  private full(key: string): string {
    return `${this.root.replace(/[\\/]+$/, "")}/${safeKey(key)}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.full(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Atomik yazma: yarım dosya asla görünmesin (DR sırasında yarıda kalma).
    const tmp = `${full}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, full);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.full(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      fs.unlinkSync(this.full(key));
    } catch {
      /* yoksa sessizce geç */
    }
  }

  async list(prefix = ""): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const walk = (dir: string, rel: string) => {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        if (n.endsWith(".tmp-")) continue;
        const abs = path.join(dir, n);
        const r = rel ? `${rel}/${n}` : n;
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(abs, r);
        else if (!prefix || r.startsWith(prefix)) out.push({ key: r, size: st.size });
      }
    };
    walk(this.root, "");
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  describe(): string {
    return `fs:${this.root}`;
  }
}
