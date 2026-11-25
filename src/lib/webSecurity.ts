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
    ...(opts.dev ? [] : [["upgrade-insecure-requests", ""] as [string, string]]),
  ];
  return directives.map(([k, v]) => (v ? `${k} ${v}` : k)).join("; ");
}

/** İsteğe bağlı raporlama: CSP ihlalleri standart rapor ucuna gider (açıksa). */
export const CSP_REPORT_PATH = "/api/csp-report";

/** CSP raporu gövdesini doğrular ve günlük satırına indirger. */
export function summarizeCspReport(body: unknown): string {
  const b = (body ?? {}) as { "csp-report"?: Record<string, unknown> } & Record<string, unknown>;
  const r = (b["csp-report"] ?? b) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const blocked = str("blocked-uri") || str("blockedURL");
  const directive = str("violated-directive") || str("effectiveDirective");
  const doc = str("document-uri") || str("documentURL");
  // Yalnız şema+host tutulur: hasta kimliği içeren tam URL günlüğe yazılmaz.
  const host = (() => {
    try { const u = new URL(doc); return u.origin; } catch { return ""; }
  })();
  return [directive, blocked, host].filter(Boolean).join(" | ").slice(0, 300);
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
