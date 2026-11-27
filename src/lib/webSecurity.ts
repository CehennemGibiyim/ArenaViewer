/**
 * Web sertleştirme çekirdeği (g-webhard) — saf, test edilebilir fonksiyonlar.
 *
 * Üç ayrı savunma katmanı:
 *  1. **Hız sınırı** (`RateLimiter`): kayan pencere sayaçları, IP + kullanıcı
 *     anahtarı. Süreç belleğinde tutulur; tek örnekli kurulumda (bu ürünün
 *     hedefi: tek hastane sunucusu) yeterlidir. Çok örnekli dağıtımda Redis
 *     gerekir — `RateLimiter` arayüzü bunun için `store` enjeksiyonuna açıktır.
 *  2. **CSRF**: çerez tabanlı oturumla birlikte `Origin`/`Sec-Fetch-Site`
 *     doğrulaması + oturum başına senkronizör jetonu (cookie ↔ başlık çifti).
 *  3. **CSP**: nonce üretimi ve başlık kurulumu (strict-dynamic + nonce;
 *     `unsafe-inline` yalnız stil için, çünkü React inline stil kullanır).
 *
 * Neden ayrı dosya: proxy (middleware) Edge çalışma zamanında çalışır ve
 * veritabanına erişemez; bu yüzden burada yalnız Web Crypto ve standart JS var.
 */

// ───────────────────────── Hız sınırı ─────────────────────────

export interface RateRule {
  /** Pencere başına izin verilen istek sayısı. */
  limit: number;
  /** Pencere süresi (ms). */
  windowMs: number;
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  /** Sınır aşıldıysa kaç saniye sonra yeniden deneneceği. */
  retryAfterSec: number;
  limit: number;
}

interface Bucket {
  /** Pencere başlangıçlarına göre istek zaman damgaları (ms). */
  hits: number[];
}

/**
 * Kayan pencere hız sınırlayıcı.
 *
 * `maxKeys` ile bellek şişmesi engellenir: en eski anahtar atılır (LRU'ya yakın
 * davranış; `Map` ekleme sırası korur ve doğrulamada anahtar yeniden eklenir).
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly maxKeys = 5000) {}

  /** Sayaç boyutu (testler ve `/api/health` için). */
  get size(): number {
    return this.buckets.size;
  }

  /** Kaydı olmadan sınırı sorgular (istek sayılmaz). */
  peek(key: string, rule: RateRule, now = Date.now()): RateResult {
    const b = this.buckets.get(key);
    const hits = (b?.hits ?? []).filter((t) => now - t < rule.windowMs);
    const remaining = Math.max(0, rule.limit - hits.length);
    const oldest = hits[0] ?? now;
    // `hit` sayacı artırdıktan sonra sorgular; sınırın "dolduğu" istek hâlâ geçerlidir.
    return {
      ok: hits.length <= rule.limit,
      remaining,
      retryAfterSec: hits.length >= rule.limit ? Math.max(1, Math.ceil((rule.windowMs - (now - oldest)) / 1000)) : 0,
      limit: rule.limit,
    };
  }

  /** Bir istek sayar ve sonucu döndürür. */
  hit(key: string, rule: RateRule, now = Date.now()): RateResult {
    const b = this.buckets.get(key) ?? { hits: [] };
    b.hits = b.hits.filter((t) => now - t < rule.windowMs);
    b.hits.push(now);
    // Anahtarı yeniden ekle: Map sırası LRU tahliyesinde kullanılıyor.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxKeys) {
      const first = this.buckets.keys().next();
      if (first.done) break;
      this.buckets.delete(first.value);
    }
    return this.peek(key, rule, now);
  }

  /** Başarılı girişte sayacı sıfırlar (kullanıcıya ikinci şans). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** Uç sınıfları ve varsayılan kurallar: sıkı olanlar önce eşleşir. */
export const RATE_RULES: { match: RegExp; rule: RateRule; name: string }[] = [
  // Kaba kuvvet: giriş/kurulum/MFA denemeleri
  { name: "auth", match: /^\/api\/auth\/(login|setup|totp)$/, rule: { limit: 10, windowMs: 60_000 } },
  // Yazma uçları: rapor kaydı, ayar değişikliği, paylaşım…
  { name: "write", match: /^\/api\/(reports|settings|users|shares?|studies|notifications|admin|profile|templates|peer-review)\b/, rule: { limit: 120, windowMs: 60_000 } },
  // Yapay zekâ/analiz: pahalı, GPU/CPU tüketir
  { name: "ai", match: /^\/api\/(analyze|multi-analyze|ai|deep-scan)\b/, rule: { limit: 30, windowMs: 60_000 } },
  // PACS/HBYS köprüleri: dış sistemlere giden istekler
  { name: "pacs", match: /^\/api\/(pacs|his)\b/, rule: { limit: 60, windowMs: 60_000 } },
  // CSP rapor ucu: kimliksiz; denetim yazımı zaten CspReportFilter ile sınırlı
  { name: "csp", match: /^\/api\/csp-report$/, rule: { limit: 60, windowMs: 60_000 } },
  // Genel API
  { name: "api", match: /^\/api\//, rule: { limit: 600, windowMs: 60_000 } },
];

/** Yol için kural seçer; eşleşme yoksa null (sayfa istekleri sınırsız). */
export function ruleFor(pathname: string, method = "GET"): { name: string; rule: RateRule } | null {
  // Okuma ağırlıklı uçlarda (GET) yazma kuralını uygulamak gereksiz katı olur.
  const yazma = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  for (const r of RATE_RULES) {
    if (!r.match.test(pathname)) continue;
    if (r.name === "write" && !yazma) continue;
    return { name: r.name, rule: r.rule };
  }
  return null;
}

/**
 * İstemci anahtarı: kimlik doğrulanmış kullanıcı varsa kullanıcı adı, yoksa IP.
 * `x-forwarded-for` yalnız güvenilen bir ters vekil varsa anlamlıdır; yine de
 * ilk değeri alıp sınırlıyoruz (spoof edilebilir ama sınırı yükseltir, düşürmez).
 */
export function clientKey(headers: Headers, user?: string | null): string {
  if (user) return `u:${user}`;
  const xff = headers.get("x-forwarded-for") ?? "";
  const ip = (xff.split(",")[0] || headers.get("x-real-ip") || "").trim();
  return `ip:${ip || "bilinmeyen"}`;
}

// ───────────────────────── CSRF ─────────────────────────

/**
 * Durum değiştiren istekleri korur.
 *
 * Katmanlar:
 *  a) `Origin`/`Referer` aynı kökene ait olmalı (tarayıcı dışı istemciler için
 *     `Sec-Fetch-Site` yoksa başlık yokluğu kabul edilir; token zorunlu olur).
 *  b) Oturum çerezi varsa `x-csrf-token` başlığı `csrf` çereziyle eşleşmeli
 *     (çift gönderim / synchronizer token deseni).
 *
 * `sandboxIframe` ("null" kökeni) önizleme panelleri için kabul edilir; bu
 * durumda token zorunludur — çünkü köken kontrolü zayıflar.
 */
export interface CsrfCheck {
  ok: boolean;
  reason?: string;
  /** Token eksik/yanlışsa istemcinin yenilemesi gerektiğini bildirir. */
  needsToken?: boolean;
}

export const CSRF_COOKIE = "av_csrf";
export const CSRF_HEADER = "x-csrf-token";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/** İstek başlıklarından çerez değeri okur. */
export function cookieValue(cookieHeader: string, name: string): string {
  for (const part of (cookieHeader || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export function checkCsrf(req: {
  method: string;
  headers: Headers;
  /** İsteğin kendi kökeni (proxy'de host üzerinden türetilir). */
  selfOrigin?: string | null;
}): CsrfCheck {
  const method = req.method.toUpperCase();
  if (!STATE_CHANGING.has(method)) return { ok: true };

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  const sandbox = origin === "null";

  // (a) Köken kontrolü — tarayıcı kaynaklı isteklerde.
  if (origin) {
    if (sandbox) {
      // Kısıtlı iframe: köken "null"; aşağıdaki token kontrolü zorunlu olur.
    } else if (req.selfOrigin && origin !== req.selfOrigin) {
      return { ok: false, reason: "Köken uyuşmuyor (CSRF)" };
    }
  } else if (referer && req.selfOrigin) {
    try {
      if (new URL(referer).origin !== req.selfOrigin) return { ok: false, reason: "Kaynak adres uyuşmuyor (CSRF)" };
    } catch {
      return { ok: false, reason: "Geçersiz Referer (CSRF)" };
    }
  } else if (site === "cross-site") {
    return { ok: false, reason: "Çapraz site isteği reddedildi (CSRF)" };
  }

  // (b) Oturum çerezi varsa çift gönderim jetonu.
  const cookie = req.headers.get("cookie") ?? "";
  const cookieToken = cookieValue(cookie, CSRF_COOKIE);
  const headerToken = req.headers.get(CSRF_HEADER) ?? "";
  if (cookieToken || (sandbox && !headerToken)) {
    if (!headerToken || !cookieToken) return { ok: false, reason: "CSRF jetonu eksik", needsToken: true };
    if (!timingSafeEqualStr(headerToken, cookieToken)) return { ok: false, reason: "CSRF jetonu geçersiz", needsToken: true };
  }
  return { ok: true };
}

/** Sabit zamanlı karşılaştırma (Edge'de `crypto.timingSafeEqual` yok). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Rastgele CSRF jetonu (32 bayt → 64 hex). Edge ve Node'da aynı çalışır. */
export function newCsrfToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ───────────────────────── CSP ─────────────────────────

export interface CspOptions {
  nonce?: string;
  /** Geliştirme modunda Next.js HMR `eval` kullanır. */
  dev?: boolean;
  /** WASM çözücüler `blob:` worker ve `wasm-unsafe-eval` ister. */
  wasm?: boolean;
}

/**
 * İçerik güvenliği politikası.
 *
 * Notlar:
 *  - `script-src 'self' 'nonce-…' 'strict-dynamic'`: Next.js inline bootstrap
 *    betiği nonce ile geçer; dinamik olarak yüklenen chunk'lar strict-dynamic
 *    sayesinde güvenilir sayılır.
 *  - `style-src 'self' 'unsafe-inline'`: React stil öznitelikleri kullanılıyor;
 *    stil tabanlı veri sızdırma riski bu uygulamada kabul edilebilir düzeyde.
 *  - `worker-src 'self' blob:`: MPR/AI işleri Web Worker'da çalışır.
 *  - `frame-ancestors 'self'` + sandbox iframe için `null` kökeni ayrıca
 *    başlıkla değil, `frame-ancestors` ile değil — preview iframe aynı kökene
 *    yüklendiği için `'self'` yeterlidir.
 *  - `connect-src 'self'`: LLM/AI worker çağrıları sunucu tarafındadır; tarayıcı
 *    yalnız kendi kökenine konuşur.
 */
export function buildCsp(opts: CspOptions = {}): string {
  const nonce = opts.nonce ? `'nonce-${opts.nonce}'` : "";
  const script = ["'self'", nonce, "'strict-dynamic'", opts.wasm === false ? "" : "'wasm-unsafe-eval'", opts.dev ? "'unsafe-eval'" : ""]
    .filter(Boolean)
    .join(" ");
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    ["script-src", script],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob:"],
    ["font-src", "'self' data:"],
    ["connect-src", "'self'"],
    ["worker-src", "'self' blob:"],
    ["media-src", "'self' blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'self'"],
    // İhlal raporları /api/csp-report'a düşer (aynı köken; ek kimlik istemez).
    // İKİSİ birlikte: `report-uri` eski tarayıcılar için (deprecated), `report-to`
    // yeni tarayıcılar için (`Reporting-Endpoints` başlığıyla eşleşmeli).
    ["report-uri", CSP_REPORT_PATH],
    ["report-to", REPORTING_GROUP],
    ...(opts.dev ? [] : [["upgrade-insecure-requests", ""] as [string, string]]),
  ];
  return directives.map(([k, v]) => (v ? `${k} ${v}` : k)).join("; ");
}

/** İsteğe bağlı raporlama: CSP ihlalleri standart rapor ucuna gider (açıksa). */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * CSP raporu gürültü filtresi (tek örnekli; çok örnekli kurulumda Redis sayacı gerekir):
 * IP başına kayan pencere + aynı satır için 60 sn yinelenme bastırması.
 * Amaç: kimlik doğrulaması olmayan rapor ucu ile denetim zincirini/Şifreli SIEM'i
 * isteyerek/çarpışan CSP gürültüsüyle doldurmak.
 */
export class CspReportFilter {
  private readonly ipHits = new Map<string, number[]>();
  private readonly lineAt = new Map<string, number>();
  constructor(
    private readonly ipPerMinute = 30,
    private readonly lineWindowMs = 60_000,
    private readonly maxTrack = 256,
  ) {}
  /** İzin ver → true (kayıt düşer); bastır → false. */
  allow(ip: string, line: string, now = Date.now()): boolean {
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= this.ipPerMinute) {
      this.ipHits.set(ip, hits);
      return false;
    }
    const last = this.lineAt.get(line);
    // Yinelenme bastırması IP kotasını tüketmez: yalnız gerçekten denetime yazılacak raporlar sayılır.
    if (last !== undefined && now - last < this.lineWindowMs) return false;
    if (this.lineAt.size >= this.maxTrack) this.purge(now);
    this.lineAt.set(line, now);
    this.ipHits.set(ip, [...hits, now]);
    return true;
  }
  private purge(now: number) {
    for (const [k, t] of this.lineAt) if (now - t >= this.lineWindowMs) this.lineAt.delete(k);
    if (this.lineAt.size < this.maxTrack) return;
    const sorted = [...this.lineAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, Math.ceil(this.maxTrack / 4))) this.lineAt.delete(k);
  }
}

/** CSP raporu gövdesini doğrular ve günlük satırına indirger. */
export function summarizeCspReport(body: unknown): string {
  const b = (body ?? {}) as { "csp-report"?: Record<string, unknown> } & Record<string, unknown>;
  const r = (b["csp-report"] ?? b) as Record<string, unknown>;
  // Kontrol karakterleri temizlenir: günlüğe CRLF/log enjeksiyonu yapılamaz.
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "");
  const blocked = str("blocked-uri") || str("blockedURL");
  const directive = str("violated-directive") || str("effectiveDirective");
  const doc = str("document-uri") || str("documentURL");
  // Yalnız şema+host tutulur: hasta kimliği içeren tam URL günlüğe yazılmaz.
  const host = (() => {
    try { const u = new URL(doc); return u.origin; } catch { return ""; }
  })();
  return [directive, blocked, host].filter(Boolean).join(" | ").slice(0, 300);
}

// ───────────────── Paylaşılan hız sınırı deposu (çok örnekli dağıtım) ─────────────────

/**
 * Neden ayrı depo: `RateLimiter` sayaçları **süreç belleğinde** tutar. Ters vekil
 * 2+ örneğe yük dağıttığında her örnek kendi sayacını tutar → gerçek sınır
 * `limit × örnek sayısı` olur (kaba kuvvet koruması seyrelir). Bu arayüz sayaçları
 * **ortak** bir yere taşır.
 *
 * Dürüst sınırlar:
 *  - `MemoryRateStore`: yalnız tek örnekte doğru; çok örnekli kurulumda **yanlış**
 *    (sessizce seyreltir) → `shared=false` ile işaretlenir ve açılışta uyarı verilir.
 *  - `RedisRateStore`: `REDIS_URL` varsa kullanılır. Redis erişilemezse **fail-open**
 *    (istek geçer) — kullanılabilirlik güvenliğe tercih edilir; ancak bu durum
 *    sayılır (`degraded`), `/api/health` ve günlükte görünür. Hasta verisi
 *    sızdırmamak için Redis'e yalnız sayaç anahtarı gider (IP/kullanıcı adı).
 *  - Redis'te kayan pencere **Lua** ile atomiktir; örnekler arasında yarış yoktur.
 */
export interface RateStore {
  /** Bu depo örnekler arasında paylaşılıyor mu. */
  readonly shared: boolean;
  /** Tek adımda say ve sonucu döndür (atomik). */
  hit(key: string, rule: RateRule, now?: number): Promise<RateResult>;
  /** Kaydı sil (başarılı girişte). */
  reset(key: string): Promise<void>;
  /** Depo sağlığı — fail-open durumunu görünür kılar. */
  health(): Promise<{ ok: boolean; kind: "memory" | "redis"; detail: string }>;
}

/** Tek örnek için bellek deposu (mevcut `RateLimiter` davranışı birebir korunur). */
export class MemoryRateStore implements RateStore {
  readonly shared = false;
  private readonly limiter: RateLimiter;
  constructor(maxKeys = 5000) { this.limiter = new RateLimiter(maxKeys); }
  async hit(key: string, rule: RateRule, now = Date.now()): Promise<RateResult> {
    return this.limiter.hit(key, rule, now);
  }
  async reset(key: string): Promise<void> { this.limiter.reset(key); }
  async health() {
    return { ok: true, kind: "memory" as const, detail: "Süreç belleği (tek örnek). Çok örnekli dağıtımda sayaçlar paylaşılmaz." };
  }
}

/**
 * Redis komutlarının ihtiyaç duyduğu en küçük yüzey. Gerçek istemci enjekte edilir;
 * bu modül Redis sürücüsüne bağımlı DEĞİLDİR (bağımlılık eklenmez, test edilebilir).
 */
export interface RedisLike {
  /** `EVAL script numkeys key... arg...` → tek sayı/dizi döndürür. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Basit ping (sağlık). */
  ping?(): Promise<string>;
}

/**
 * Lua: kayan pencere sayacı (atomik).
 * KEYS[1] = sayaç anahtarı · ARGV = now(ms), windowMs, limit
 * Dönen: {sayılan istek, pencere içindeki en eski zaman, toplam}
 */
export const RATE_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local total = redis.call('ZCARD', KEYS[1])
local count = total + 1
redis.call('ZADD', KEYS[1], now, tostring(now) .. ':' .. tostring(count) .. ':' .. tostring(math.random(1000000)))
redis.call('PEXPIRE', KEYS[1], window + 1000)
local oldest = now
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if first and first[2] then oldest = tonumber(first[2]) end
return {count, oldest, limit}
`;

/** Redis destekli depo: sayaçlar örnekler arasında **paylaşılır**. */
export class RedisRateStore implements RateStore {
  readonly shared = true;
  private failCount = 0;
  private lastOkAt = 0;
  constructor(private readonly client: RedisLike, private readonly keyPrefix = "av:rate:") {}

  /** Lua sonucunu `RateResult`'a çevirir (saf; test edilir). */
  static toResult(reply: unknown, rule: RateRule, now: number): RateResult {
    const arr = Array.isArray(reply) ? reply.map((v) => Number(v)) : [];
    const [count, oldest] = arr;
    if (!Number.isFinite(count) || count <= 0) {
      // Beklenmeyen yanıt: isteği geçir (fail-open), kalan bilinmiyor.
      return { ok: true, remaining: rule.limit, retryAfterSec: 0, limit: rule.limit };
    }
    const remaining = Math.max(0, rule.limit - count);
    return {
      ok: count <= rule.limit,
      remaining,
      retryAfterSec: count > rule.limit ? Math.max(1, Math.ceil((rule.windowMs - (now - (oldest || now))) / 1000)) : 0,
      limit: rule.limit,
    };
  }

  async hit(key: string, rule: RateRule, now = Date.now()): Promise<RateResult> {
    try {
      const reply = await this.client.eval(RATE_LUA, 1, this.keyPrefix + key, now, rule.windowMs, rule.limit);
      this.failCount = 0;
      this.lastOkAt = now;
      return RedisRateStore.toResult(reply, rule, now);
    } catch {
      // FAIL-OPEN: Redis yoksa hizmet durmaz; durum sayılır ve health'te görünür.
      this.failCount++;
      return { ok: true, remaining: rule.limit, retryAfterSec: 0, limit: rule.limit };
    }
  }

  async reset(key: string): Promise<void> {
    try { await this.client.eval("redis.call('DEL', KEYS[1]) return 1", 1, this.keyPrefix + key); } catch { this.failCount++; }
  }

  async health() {
    if (this.failCount > 0) {
      return { ok: false, kind: "redis" as const, detail: `Redis erişilemiyor (${this.failCount} hata); hız sınırı FAIL-OPEN — sayaçlar paylaşılmıyor.` };
    }
    try {
      if (this.client.ping) await this.client.ping();
      return { ok: true, kind: "redis" as const, detail: `Sayaçlar Redis'te paylaşılıyor (${this.keyPrefix}); son başarılı sayaç ${this.lastOkAt ? new Date(this.lastOkAt).toISOString() : "—"}.` };
    } catch {
      this.failCount++;
      return { ok: false, kind: "redis" as const, detail: "Redis PING başarısız; hız sınırı FAIL-OPEN." };
    }
  }
}

/**
 * Ortamdan depo seçer: `REDIS_URL` varsa Redis, yoksa bellek.
 *
 * Redis istemcisi **enjekte edilir** (çağıran `createClient`'ı `REDIS_URL` ile kurar);
 * bu fonksiyon yalnız kararı ve uyarı metnini üretir → sürücü bağımlılığı yok.
 */
export function rateStorePlan(env: Record<string, string | undefined> = process.env): {
  kind: "redis" | "memory"; shared: boolean; warning: string | null;
} {
  const url = (env.REDIS_URL ?? "").trim();
  const instances = Number(env.INSTANCE_COUNT ?? "1");
  if (!url) {
    const multi = Number.isFinite(instances) && instances > 1;
    return {
      kind: "memory",
      shared: false,
      warning: multi
        ? `INSTANCE_COUNT=${instances} ama REDIS_URL tanımlı değil: hız sınırı sayaçları her örnekte ayrı tutulur (gerçek sınır ≈ limit × ${instances}).`
        : null,
    };
  }
  if (!/^rediss?:\/\//i.test(url)) {
    return { kind: "memory", shared: false, warning: "REDIS_URL biçimi geçersiz (redis:// veya rediss:// bekleniyor); bellek deposuna düşüldü." };
  }
  return { kind: "redis", shared: true, warning: null };
}

/**
 * Proxy ve testler için **tek karar noktası**: paylaşılan depo varsa ondan,
 * yoksa bellek deposundan say. Böylece "hangi sayaç kullanıldı" kararı koda
 * dağılmaz ve test edilebilir kalır.
 *
 * `shared` alanı yanıt başlığında (`X-RateLimit-Shared`) görünür: ters vekil
 * yanlış yapılandırıldıysa (REDIS_URL yok ama 3 örnek) operatör bunu **canlı**
 * trafikte görebilir, yalnız açılış günlüğüne mahkûm olmaz.
 */
export async function rateHit(
  subject: string,
  rule: RateRule,
  opts: { memory: RateStore; shared?: RateStore; now?: number },
): Promise<RateResult & { shared: boolean }> {
  const store = opts.shared;
  if (store) {
    const r = await store.hit(subject, rule, opts.now);
    return { ...r, shared: true };
  }
  const r = await opts.memory.hit(subject, rule, opts.now);
  return { ...r, shared: opts.memory.shared };
}

// ───────────────────────── Raporlama (report-to) ─────────────────────────

/** `Reporting-Endpoints` başlığında bildirilen grup adı. */
export const REPORTING_GROUP = "csp-endpoint";

/**
 * Modern raporlama başlıkları (CSP `report-to` + `Reporting-Endpoints`).
 *
 * Neden: `report-uri` **eski yöntemdir** (deprecated). Chrome 130+ / Firefox
 * `Report-To` yerine **`Reporting-Endpoints`** kullanıyor; yeni tarayıcılar
 * `report-uri` desteğini küçültüyor. İkisi birlikte gönderilir: eski tarayıcı
 * `report-uri` yolunu, yeni tarayıcı `report-to` + `Reporting-Endpoints` yolunu
 * kullanır; aynı uç her iki gövde biçimini de kabul eder.
 */
export function reportingHeaders(path = CSP_REPORT_PATH): Record<string, string> {
  // Grup tanımı: `grup="url"` (aynı köken; ek kimlik istemez).
  return {
    "Reporting-Endpoints": `${REPORTING_GROUP}="${path}"`,
    // Eski tarayıcı için `Report-To` (JSON) — yeni tarayıcılar bunu yok sayar.
    "Report-To": JSON.stringify({ group: REPORTING_GROUP, max_age: 10886400, endpoints: [{ url: path }] }),
  };
}

/**
 * Rapor gövdesini **tek biçime** indirger.
 *
 * Üç biçim gelir:
 *  1. `application/csp-report` → `{ "csp-report": { ... } }` (klasik)
 *  2. `application/reports+json` → `[{ type: "csp-violation", body: { ... } }, ...]` (Reporting API)
 *  3. `application/report` → `{ type, body }` (eski Reporting API)
 *
 * Dönen: kısa, güvenli özet satırı (yönerge | engellenen | köken). Boşsa `""`.
 * Kontrol karakterleri temizlenir (günlük enjeksiyonu), tam URL yazılmaz (PHI).
 */
export function normalizeReport(body: unknown, contentType = ""): { type: string; line: string } {
  const pick = (o: unknown): { type: string; line: string } => {
    const rec = (o ?? {}) as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "";
    // Reporting API gövdesi `body`, klasik CSP gövdesi kökün kendisi.
    const b = (rec.body ?? rec["csp-report"] ?? rec) as Record<string, unknown>;
    const line = summarizeCspReport({ "csp-report": b });
    if (line) return { type: type || "csp-violation", line };
    // Klasik biçimde kök nesnenin kendisi csp-report olur.
    const direct = summarizeCspReport(rec);
    return { type: type || "csp-violation", line: direct };
  };
  if (Array.isArray(body)) {
    // Çoklu rapor: her öğe ayrı satır; burada ilk dolu olanı döndür (çağıran hepsini işler).
    for (const item of body) {
      const r = pick(item);
      if (r.line) return r;
    }
    return { type: "csp-violation", line: "" };
  }
  const r = pick(body);
  if (r.line) return r;
  return { type: r.type || (contentType.includes("reports+json") ? "report" : "csp-violation"), line: "" };
}

/** Raporda işlenecek tüm satırlar (çoklu `reports+json` dizisi için). */
export function reportLines(body: unknown, max = 5): { type: string; line: string }[] {
  const items = Array.isArray(body) ? body.slice(0, Math.max(1, max)) : [body];
  const out: { type: string; line: string }[] = [];
  for (const it of items) {
    const { type, line } = normalizeReport(it);
    // Deprecation/intervention da kayda değer: yalnız CSP ile sınırlı değiliz.
    if (line) out.push({ type: type || "csp-violation", line });
  }
  return out;
}

// ───────────────────────── TLS / HSTS politikası ─────────────────────────
//
// KVKK/HIPAA maddesi (t-privacy) "TLS zorunluluğu" istiyor. TLS sonlandırma
// genelde ters vekilde (nginx/Caddy/Render) yapılır; uygulama bunu **doğrular**
// ve zorunlu kılabilir. Üç seviye:
//
//  - `off`     : zorunluluk yok (yalnız yerel geliştirme; üretimde önerilmez)
//  - `forward` : ters vekil `x-forwarded-proto: https` bildiriyorsa TLS sayılır
//                (varsayılan: `REQUIRE_TLS=1` iken)
//  - `direct`  : istek gerçekten https ile geldi sayılır (x-forwarded-proto
//                yoksa da kabul; ters vekil https sonlandırıp başlığı
//                iletmiyorsa bu modda yanlış pozitif olmaz, çünkü başlık yoksa ret)
//
// Health uçları ve statik varlıklar muaf: TLS'siz ortamda da canlılık kontrolü
// çalışmalı, ama hasta verisi taşıyan hiçbir yol TLS'siz geçmemeli.

export type TlsMode = "off" | "forward" | "direct";

export interface TlsPolicy {
  mode: TlsMode;
  /** HSTS ömrü (saniye); 0 = başlık yazılmaz. */
  hstsMaxAge: number;
  includeSubDomains: boolean;
  preload: boolean;
}

/**
 * `REQUIRE_TLS` (1/true/forward/direct/0) ve `HSTS_MAX_AGE` ortam değişkenlerinden
 * politika. Varsayılan **kapalı**dır: mevcut kurulumlar (http://localhost, iç ağ)
 * sessizce kilitlenmesin. Üretim dağıtımı `REQUIRE_TLS=1` vermelidir.
 */
export function tlsPolicy(env: Record<string, string | undefined> = process.env): TlsPolicy {
  const raw = (env.REQUIRE_TLS ?? "0").trim().toLowerCase();
  const mode: TlsMode =
    raw === "direct" ? "direct" : raw === "1" || raw === "true" || raw === "forward" || raw === "yes" ? "forward" : "off";
  const hstsRaw = Number(env.HSTS_MAX_AGE ?? "31536000");
  const hstsMaxAge = mode === "off" ? 0 : Number.isFinite(hstsRaw) && hstsRaw >= 0 && hstsRaw <= 63072000 ? Math.floor(hstsRaw) : 31536000;
  return {
    mode,
    hstsMaxAge,
    includeSubDomains: env.HSTS_SUBDOMAINS !== "0",
    preload: env.HSTS_PRELOAD === "1",
  };
}

export interface TlsCheckInput {
  /** `x-forwarded-proto` başlığı (ilk değer). */
  forwardedProto?: string | null;
  /** İsteğin kendi URL protokolü ("https:" / "http:"). */
  protocol?: string | null;
  pathname: string;
}

/** TLS'siz istek zorunlu yollarda reddedilmeli mi? */
export function tlsViolation(input: TlsCheckInput, policy: TlsPolicy = tlsPolicy()): boolean {
  if (policy.mode === "off") return false;
  const p = input.pathname;
  // Statik varlık, sağlık ucu ve PWA dosyaları TLS'siz de servis edilir.
  if (
    p.startsWith("/_next/") ||
    p.startsWith("/codecs/") ||
    p.startsWith("/wasm/") ||
    p.startsWith("/icons/") ||
    p.startsWith("/downloads/") ||
    p === "/api/health" ||
    p.startsWith("/api/health/") ||
    p === "/manifest.webmanifest" ||
    p === "/sw.js" ||
    p === "/offline.html" ||
    p === "/favicon.ico"
  ) {
    return false;
  }
  const forwarded = (input.forwardedProto ?? "").split(",")[0].trim().toLowerCase();
  const direct = (input.protocol ?? "").toLowerCase().replace(/:$/, "");
  if (policy.mode === "direct") {
    // Doğrudan TLS: yalnız gerçek protokol https ise geçer.
    return !(direct === "https" || forwarded === "https");
  }
  // forward: ters vekil bildirmiyorsa uygulama http üzerinden erişilmiş sayılır.
  return forwarded !== "https";
}

/** HSTS başlık değeri; politika kapalıysa null. */
export function hstsHeader(policy: TlsPolicy = tlsPolicy()): string | null {
  if (policy.hstsMaxAge <= 0) return null;
  const parts = [`max-age=${policy.hstsMaxAge}`];
  if (policy.includeSubDomains) parts.push("includeSubDomains");
  if (policy.preload) parts.push("preload");
  return parts.join("; ");
}

/** HTTP isteğini aynı yola https ile yönlendirmek için hedef URL. */
export function httpsUrlFor(originalUrl: string, host?: string | null): string | null {
  try {
    const u = new URL(originalUrl);
    if (host) u.host = host;
    u.protocol = "https:";
    u.port = "";
    return u.toString();
  } catch {
    return null;
  }
}
