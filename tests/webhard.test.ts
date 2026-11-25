/**
 * g-webhard: hız sınırı, CSRF ve CSP testleri.
 *
 * Proxy (middleware) Edge'de çalışır ve veritabanı gerektirir; bu yüzden
 * savunmanın kendisi saf fonksiyonlarda (`src/lib/webSecurity.ts`) sınanır,
 * ardından proxy kaynağının bu fonksiyonları gerçekten bağladığı kaynak
 * sözleşmesiyle doğrulanır. İstemci yardımcısı (`csrfClient`) da taklit bir
 * `document`/`fetch` ile test edilir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildCsp,
  checkCsrf,
  clientKey,
  cookieValue,
  CSRF_COOKIE,
  CSRF_HEADER,
  hstsHeader,
  httpsUrlFor,
  isStateChanging,
  newCsrfToken,
  tlsPolicy,
  tlsViolation,
  RateLimiter,
  ruleFor,
  summarizeCspReport,
  timingSafeEqualStr,
} from "../src/lib/webSecurity";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

async function main() {
  // ── 1) Kayan pencere hız sınırı ────────────────────────────────────────
  const rl = new RateLimiter();
  const rule = { limit: 3, windowMs: 1000 };
  const t0 = 1_000_000;
  assert.deepEqual([0, 1, 2].map((i) => rl.hit("k", rule, t0 + i).ok), [true, true, true], "ilk 3 istek geçer");
  const blocked = rl.hit("k", rule, t0 + 3);
  assert.equal(blocked.ok, false, "4. istek engellenir");
  assert.equal(blocked.remaining, 0, "kalan 0");
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 1 + 1, `Retry-After makul (${blocked.retryAfterSec})`);
  // Pencere kayınca yeniden izin verilir.
  assert.equal(rl.hit("k", rule, t0 + 1001).ok, true, "pencere kayınca izin");
  // Anahtarlar bağımsız.
  assert.equal(rl.hit("baska", rule, t0 + 1002).ok, true, "ayrı anahtar ayrı sayaç");
  // peek saymaz.
  const before = rl.peek("peek", rule, t0).remaining;
  const after = rl.peek("peek", rule, t0).remaining;
  assert.equal(before, after, "peek sayaç artırmaz");
  // reset
  rl.hit("sifirla", rule, t0);
  rl.reset("sifirla");
  assert.equal(rl.peek("sifirla", rule, t0).remaining, 3, "reset sayacı temizler");
  console.log("PASS kayan pencere hız sınırı (blok + pencere kayması + reset)");

  // Bellek sınırı: en eski anahtar atılır.
  const small = new RateLimiter(2);
  small.hit("a", rule, t0);
  small.hit("b", rule, t0);
  small.hit("c", rule, t0);
  assert.equal(small.size, 2, "anahtar sayısı sınırlı (LRU tahliyesi)");
  assert.equal(small.peek("a", rule, t0).remaining, 3, "en eski anahtar tahliye edilir");
  console.log("PASS hız sınırı bellek sınırı (LRU tahliye)");

  // ── 2) Kural seçimi ────────────────────────────────────────────────────
  assert.equal(ruleFor("/api/auth/login", "POST")?.name, "auth", "giriş sıkı kural");
  assert.equal(ruleFor("/api/auth/login", "GET")?.name, "auth", "giriş ucu yöntemden bağımsız sıkı");
  assert.equal(ruleFor("/api/analyze", "POST")?.name, "ai", "analiz kuralı");
  assert.equal(ruleFor("/api/pacs/studies", "GET")?.name, "pacs", "PACS kuralı");
  assert.equal(ruleFor("/api/reports", "POST")?.name, "write", "yazma kuralı");
  assert.equal(ruleFor("/api/reports", "GET")?.name, "api", "yazma kuralı GET'e uygulanmaz → genel api");
  assert.equal(ruleFor("/api/studies", "GET")?.name, "api", "genel API kuralı");
  assert.equal(ruleFor("/", "GET"), null, "sayfalar sınırsız");
  assert.equal(ruleFor("/_next/static/x.js", "GET"), null, "statik varlık sınırsız");
  console.log("PASS uç sınıfları ve kurallar");

  // ── 3) İstemci anahtarı ────────────────────────────────────────────────
  assert.equal(clientKey(new Headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" })), "ip:10.0.0.1", "XFF ilk değeri");
  assert.equal(clientKey(new Headers({ "x-real-ip": "10.0.0.9" })), "ip:10.0.0.9", "x-real-ip yedeği");
  assert.equal(clientKey(new Headers(), "dr.ahmet"), "u:dr.ahmet", "kullanıcı anahtarı IP'yi ezer");
  assert.equal(clientKey(new Headers()), "ip:bilinmeyen", "başlık yoksa sabit anahtar");
  console.log("PASS istemci anahtarı");

  // ── 4) CSRF: köken + jeton ─────────────────────────────────────────────
  const self = "https://rad.ornek.hastane";
  const stateChanging = (headers: Record<string, string>, method = "POST") =>
    checkCsrf({ method, headers: new Headers(headers), selfOrigin: self });

  assert.equal(stateChanging({}, "GET").ok, true, "GET korumasız");
  assert.equal(stateChanging({}, "HEAD").ok, true, "HEAD korumasız");
  assert.equal(stateChanging({ origin: self }).ok, true, "aynı köken (çerez yok) geçer");
  assert.equal(stateChanging({ origin: "https://kotu.example" }).ok, false, "farklı köken reddedilir");
  assert.match(stateChanging({ origin: "https://kotu.example" }).reason ?? "", /Köken/, "gerekçe köken");
  assert.equal(stateChanging({ referer: `${self}/rapor/1` }).ok, true, "aynı köken Referer geçer");
  assert.equal(stateChanging({ referer: "https://kotu.example/x" }).ok, false, "farklı Referer reddedilir");
  assert.equal(stateChanging({ referer: "bozuk-url" }).ok, false, "bozuk Referer reddedilir");
  assert.equal(stateChanging({ "sec-fetch-site": "cross-site" }).ok, false, "cross-site Sec-Fetch-Site reddedilir");
  assert.equal(stateChanging({ "sec-fetch-site": "same-origin" }).ok, true, "same-origin başlığı geçer");

  const token = newCsrfToken();
  assert.equal(token.length, 64, "jeton 32 bayt (64 hex)");
  assert.notEqual(token, newCsrfToken(), "jetonlar benzersiz");
  const withCookie = (t: string, header?: string) => ({
    cookie: `${CSRF_COOKIE}=${t}`,
    ...(header === undefined ? {} : { [CSRF_HEADER]: header }),
    origin: self,
  });
  assert.equal(stateChanging(withCookie(token, token)).ok, true, "jeton eşleşirse geçer");
  const noHeader = stateChanging(withCookie(token));
  assert.equal(noHeader.ok, false, "jeton başlığı yoksa reddedilir");
  assert.equal(noHeader.needsToken, true, "istemciye yenileme sinyali");
  const wrong = stateChanging(withCookie(token, newCsrfToken()));
  assert.equal(wrong.ok, false, "yanlış jeton reddedilir");
  assert.equal(wrong.needsToken, true, "yanlış jeton → yenileme sinyali");
  // Sandbox iframe ("null" kökeni): köken kontrolü zayıflar → jeton zorunlu.
  const sandboxNoToken = checkCsrf({ method: "POST", headers: new Headers({ origin: "null" }), selfOrigin: self });
  assert.equal(sandboxNoToken.ok, false, "sandbox kökeninde jeton zorunlu");
  const sandboxToken = checkCsrf({
    method: "DELETE",
    headers: new Headers({ origin: "null", cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token }),
    selfOrigin: self,
  });
  assert.equal(sandboxToken.ok, true, "sandbox + jeton geçer");
  assert.equal(isStateChanging("patch"), true, "küçük harf yöntem");
  assert.equal(isStateChanging("OPTIONS"), false, "OPTIONS durum değiştirmez");
  assert.equal(cookieValue("a=1; av_csrf=xyz; b=2", CSRF_COOKIE), "xyz", "çerez okuma");
  assert.equal(cookieValue("av_csrfx=1", CSRF_COOKIE), "", "benzer ad yanlış eşleşmez");
  assert.equal(cookieValue("av_csrf=%41%42", CSRF_COOKIE), "AB", "çerez URL çözümü");
  assert.equal(timingSafeEqualStr("abc", "abc"), true, "sabit zamanlı eşitlik");
  assert.equal(timingSafeEqualStr("abc", "abd"), false, "farklı uzunluk/içerik");
  console.log("PASS CSRF (köken + çift gönderim jetonu + sandbox)");

  // ── 5) CSP ─────────────────────────────────────────────────────────────
  const csp = buildCsp({ nonce: "abc123" });
  assert.match(csp, /script-src 'self' 'nonce-abc123' 'strict-dynamic' 'wasm-unsafe-eval'/, "nonce + strict-dynamic + wasm");
  assert.match(csp, /object-src 'none'/, "object-src kapalı");
  assert.match(csp, /frame-ancestors 'self'/, "çerçeveleme aynı kökene kısıtlı");
  assert.match(csp, /connect-src 'self'/, "bağlantılar kendi kökenle sınırlı");
  assert.match(csp, /worker-src 'self' blob:/, "web worker (MPR/AI) izinli");
  assert.match(csp, /upgrade-insecure-requests/, "üretimde https yükseltmesi");
  // `'wasm-unsafe-eval'` ayrı bir anahtar sözcüktür; JS `eval` izni değildir.
  assert.doesNotMatch(csp, /'unsafe-eval'/, "üretimde JS eval yok");
  assert.match(buildCsp({ dev: true }), /'unsafe-eval'/, "geliştirmede HMR için eval");
  assert.doesNotMatch(buildCsp({ dev: true }), /upgrade-insecure-requests/, "geliştirmede yükseltme yok");
  assert.doesNotMatch(buildCsp({ wasm: false }), /wasm-unsafe-eval/, "wasm kapatılabilir");
  assert.doesNotMatch(buildCsp({}), /'nonce-/, "nonce yoksa nonce yönergesi eklenmez");
  // Rapor özeti: tam URL (hasta bağlamı) günlüğe yazılmaz, yalnız köken.
  const line = summarizeCspReport({
    "csp-report": {
      "violated-directive": "img-src",
      "blocked-uri": "https://cdn.example/a.png",
      "document-uri": "https://rad.ornek.hastane/hasta/12345?ad=AHMET",
    },
  });
  assert.equal(line, "img-src | https://cdn.example/a.png | https://rad.ornek.hastane", `CSP rapor özeti: ${line}`);
  assert.doesNotMatch(line, /AHMET|12345/, "hasta bağlamı günlüğe sızmaz");
  assert.equal(summarizeCspReport(null), "", "boş rapor");
  assert.equal(summarizeCspReport({ "csp-report": {} }), "", "boş alanlar");
  console.log("PASS CSP (nonce/strict-dynamic/wasm + rapor özeti)");

  // ── 6) Proxy ve istemci bağlantısı (kaynak sözleşmesi) ─────────────────
  const proxy = read("src/proxy.ts");
  assert.ok(proxy.includes("RateLimiter") && proxy.includes("limiter.hit("), "proxy hız sınırını uygular");
  assert.ok(proxy.includes("checkCsrf(") && proxy.includes("isStateChanging(req.method)"), "proxy CSRF kontrolü yapar");
  assert.ok(proxy.includes("buildCsp(") && proxy.includes("Content-Security-Policy"), "proxy CSP başlığını yazar");
  assert.ok(proxy.includes("X-Frame-Options"), "proxy X-Frame-Options yazar");
  assert.ok(proxy.includes("Retry-After") && proxy.includes("429"), "hız sınırı 429 + Retry-After");
  assert.ok(proxy.includes("res.cookies.set(CSRF_COOKIE"), "CSRF çerezi kurulur");
  assert.ok(proxy.includes('AV_RATE_LIMIT === "off"'), "test/ölçüm için kapatma anahtarı");
  assert.ok(proxy.includes("tlsViolation(") && proxy.includes("httpsUrlFor("), "proxy TLS zorunluluğunu uygular");
  assert.ok(proxy.includes("Strict-Transport-Security") && proxy.includes("hstsHeader("), "proxy HSTS başlığını yazar");
  assert.ok(proxy.includes("426") && proxy.includes("tlsRequired"), "TLS'siz API isteği 426 ile reddedilir");
  // CSP nonce'u belge başlığına geçirilir (Next.js bunu okuyup inline betiğe ekler).
  assert.ok(proxy.includes('"x-csp-nonce"'), "nonce başlığı iletilir");

  const client = read("src/lib/csrfClient.ts");
  assert.ok(client.includes('CSRF_HEADER = "x-csrf-token"') && client.includes('CSRF_COOKIE = "av_csrf"'), "istemci çerez/başlık adları sunucuyla aynı");
  assert.ok(client.includes("needsCsrfToken"), "istemci 403 sinyalini işler");

  // İstemci sarmalayıcısı: jeton eklenir, GET'e eklenmez.
  const g = globalThis as unknown as { document?: unknown; fetch?: unknown };
  const calls: { url: string; headers: Headers }[] = [];
  g.document = { cookie: "diger=1; av_csrf=jeton123" };
  g.fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const { apiFetch } = await import("../src/lib/csrfClient");
  await apiFetch("/api/reports", { method: "POST", body: "{}" });
  assert.equal(calls[0].headers.get(CSRF_HEADER), "jeton123", "POST'a jeton eklenir");
  await apiFetch("/api/reports");
  assert.equal(calls[1].headers.get(CSRF_HEADER), null, "GET'e jeton eklenmez");
  // 403 + needsCsrfToken → bir kez yeniden denenir.
  let n = 0;
  g.fetch = async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: "CSRF jetonu eksik", needsCsrfToken: true }), { status: 403, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 200 });
  };
  const retried = await apiFetch("/api/reports", { method: "PATCH", body: "{}" });
  assert.equal(retried.status, 200, "jeton sinyalinde yeniden denenir");
  assert.ok(n >= 2, "yeniden deneme yapıldı");
  delete g.document;
  delete g.fetch;
  console.log("PASS proxy + istemci bağlantısı ve yeniden deneme");

  // ── 7) CSP rapor ucu ───────────────────────────────────────────────────
  const reportRoute = read("src/app/api/csp-report/route.ts");
  assert.ok(reportRoute.includes("summarizeCspReport"), "rapor ucu özeti kullanır");
  assert.ok(reportRoute.includes("16_384"), "gövde sınırı var");
  assert.ok(reportRoute.includes("status: 204"), "her durumda 204 (rapor döngüsü kırılmaz)");
  assert.ok(!reportRoute.includes("authorize("), "kimlik doğrulaması yok (tarayıcı raporları çerezsiz gelir)");
  console.log("PASS CSP rapor ucu");

  // ── 8) next.config: statik başlıklar hâlâ yerinde ──────────────────────
  const cfg = read("next.config.ts");
  for (const h of ["X-Content-Type-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "Permissions-Policy"]) {
    assert.ok(cfg.includes(h), `statik başlık korunur: ${h}`);
  }
  console.log("PASS statik güvenlik başlıkları korunuyor");

  console.log("Tüm g-webhard (hız sınırı + CSRF + CSP) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});

// ── TLS / HSTS politikası (t-privacy) ──────────────────────────────────────
{
  assert.equal(tlsPolicy({}).mode, "off", "varsayılan kapalı: mevcut kurulum sessizce kilitlenmez");
  assert.equal(tlsPolicy({ REQUIRE_TLS: "1" }).mode, "forward");
  assert.equal(tlsPolicy({ REQUIRE_TLS: "direct" }).mode, "direct");
  assert.equal(tlsPolicy({ REQUIRE_TLS: "0" }).mode, "off");

  assert.equal(tlsPolicy({ REQUIRE_TLS: "1" }).mode, "forward");
  assert.equal(tlsPolicy({ REQUIRE_TLS: "direct" }).mode, "direct");
  assert.equal(tlsPolicy({ REQUIRE_TLS: "0" }).mode, "off");

  const forward = tlsPolicy({ REQUIRE_TLS: "1" });
  assert.equal(tlsViolation({ forwardedProto: "https", pathname: "/api/patients" }, forward), false);
  assert.equal(tlsViolation({ forwardedProto: "http", pathname: "/api/patients" }, forward), true, "http API reddedilmeli");
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/" }, forward), true, "bildirilmemiş protokol TLS sayılmaz");
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/api/health" }, forward), false, "sağlık ucu muaf");
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/api/health/ready" }, forward), false);
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/_next/static/a.js" }, forward), false);
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/wasm/jpx.wasm" }, forward), false);
  assert.equal(tlsViolation({ forwardedProto: null, pathname: "/sw.js" }, forward), false);

  const direct = tlsPolicy({ REQUIRE_TLS: "direct" });
  assert.equal(tlsViolation({ protocol: "https:", pathname: "/api/x" }, direct), false);
  assert.equal(tlsViolation({ protocol: "http:", pathname: "/api/x" }, direct), true);
  // direct modda ters vekil başlığı yoksa URL protokolü belirleyici.
  assert.equal(tlsViolation({ protocol: "http:", forwardedProto: "https", pathname: "/api/x" }, direct), false);

  assert.equal(hstsHeader(tlsPolicy({})), null, "TLS kapalıyken HSTS yazılmaz");
  assert.equal(hstsHeader(tlsPolicy({ REQUIRE_TLS: "1" })), "max-age=31536000; includeSubDomains");
  assert.match(hstsHeader(tlsPolicy({ REQUIRE_TLS: "1", HSTS_MAX_AGE: "600", HSTS_PRELOAD: "1" }))!, /max-age=600; includeSubDomains; preload/);
  assert.equal(hstsHeader(tlsPolicy({ REQUIRE_TLS: "1", HSTS_MAX_AGE: "abc" })), "max-age=31536000; includeSubDomains", "geçersiz ömür varsayılana döner");
  assert.equal(httpsUrlFor("http://hastane.local/api/x?a=1", "hastane.local"), "https://hastane.local/api/x?a=1");
  assert.equal(httpsUrlFor("http://hastane.local:3000/x"), "https://hastane.local/x", "port düşürülür");
  assert.equal(httpsUrlFor("bozuk-url"), null);
  console.log("PASS TLS/HSTS: zorunluluk modları, muaf yollar, HSTS başlığı ve https yönlendirmesi.");
}
