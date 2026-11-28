/**
 * g-webhard — paylaşılan (çok örnekli) hız sınırı + modern raporlama (report-to).
 *
 * Kapsam:
 *  1) `rateStorePlan`: REDIS_URL/INSTANCE_COUNT kararı ve UYARI (sessiz seyreltme yok)
 *  2) `RedisRateStore`: Lua yanıt çevirisi, atomik sayaç davranışı, reset, FAIL-OPEN
 *  3) `rateHit`: paylaşılan depo tercih edilir, `shared` bayrağı doğru
 *  4) `MemoryRateStore` davranışının `RateLimiter` ile aynı olduğu (regresyon)
 *  5) `reportingHeaders` + `buildCsp` `report-to` eşleşmesi
 *  6) `normalizeReport`/`reportLines`: üç gövde biçimi (klasik, reports+json, report)
 *  7) Uç + proxy sözleşmesi (statik)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REPORTING_GROUP, RedisRateStore, MemoryRateStore, rateHit, rateStorePlan,
  reportingHeaders, normalizeReport, reportLines, buildCsp, CSP_REPORT_PATH,
  type RateRule, type RedisLike,
} from "../src/lib/webSecurity";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const rule: RateRule = { limit: 3, windowMs: 1000 };

/** Sahte Redis: Lua'yı YORUMLAMAZ; sözleşmeyi (EVAL → [count, oldest, limit]) taklit eder. */
function fakeRedis(opts: { failEval?: boolean; failPing?: boolean } = {}) {
  const counters = new Map<string, number[]>();
  const calls: { script: string; key: string }[] = [];
  const client: RedisLike = {
    async eval(script: string, _numKeys: number, ...args) {
      if (opts.failEval) throw new Error("ECONNREFUSED");
      const key = String(args[0]);
      const now = Number(args[1]);
      const window = Number(args[2]);
      const limit = Number(args[3]);
      calls.push({ script, key });
      if (script.includes("DEL")) { counters.delete(key); return 1; }
      const hits = (counters.get(key) ?? []).filter((t) => now - t < window);
      hits.push(now);
      counters.set(key, hits);
      return [hits.length, hits[0], limit];
    },
    async ping() { if (opts.failPing) throw new Error("PING failed"); return "PONG"; },
  };
  return { client, calls, counters };
}

async function main() {
  // ── 1) Depo seçimi ──
  const mem = rateStorePlan({});
  ok(mem.kind === "memory" && mem.shared === false, "REDIS_URL yoksa bellek deposu");
  ok(mem.warning === null, "tek örnekte uyarı yok (gürültü yapmaz)");
  const multiNoRedis = rateStorePlan({ INSTANCE_COUNT: "3" });
  ok(multiNoRedis.kind === "memory" && !!multiNoRedis.warning, "çok örnek + Redis yok → UYARI");
  ok(/limit × 3|≈ limit/.test(multiNoRedis.warning ?? ""), "uyarı gerçek sınırın kaç katına çıktığını söyler");
  const withRedis = rateStorePlan({ REDIS_URL: "redis://cache:6379" });
  ok(withRedis.kind === "redis" && withRedis.shared && withRedis.warning === null, "REDIS_URL → paylaşılan depo");
  ok(rateStorePlan({ REDIS_URL: "rediss://secure:6380" }).kind === "redis", "rediss:// (TLS) kabul edilir");
  const bad = rateStorePlan({ REDIS_URL: "http://x" });
  ok(bad.kind === "memory" && !!bad.warning, "geçersiz URL → belleğe düş + uyar");
  ok(rateStorePlan({ REDIS_URL: "  " }).kind === "memory", "boşluklu değer yok sayılır");

  // ── 2) Redis deposu ──
  const { client, calls } = fakeRedis();
  const store = new RedisRateStore(client);
  ok(store.shared === true, "Redis deposu paylaşıldığını bildirir");
  const t0 = 1_000_000;
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await store.hit("ip:1.2.3.4", rule, t0 + i));
  ok(results.slice(0, 3).every((r) => r.ok), "ilk 3 istek geçer (limit 3)");
  ok(results[3].ok === false && results[3].remaining === 0, "4. istek engellenir, kalan 0");
  ok(results[3].retryAfterSec >= 1, "Retry-After hesaplanır");
  ok(calls[0].key === "av:rate:ip:1.2.3.4", "anahtar öneki + özne (Redis'e yalnız sayaç anahtarı gider)");
  const afterWindow = await store.hit("ip:1.2.3.4", rule, t0 + 2000);
  ok(afterWindow.ok, "pencere kayınca yeniden izin");
  await store.reset("ip:1.2.3.4");
  ok((await store.hit("ip:1.2.3.4", rule, t0 + 2001)).ok, "reset sonrası sayaç temiz");

  // Lua yanıt çevirisi (saf)
  ok(RedisRateStore.toResult([2, t0, 3], rule, t0).ok === true, "toResult: sınır altı geçer");
  const over = RedisRateStore.toResult([4, t0, 3], rule, t0 + 500);
  ok(over.ok === false && over.retryAfterSec === 1, "toResult: sınır üstü engellenir, retry ≥1 sn");
  ok(RedisRateStore.toResult(null, rule, t0).ok === true, "toResult: beklenmeyen yanıt FAIL-OPEN (istek geçer)");
  ok(RedisRateStore.toResult(["x", "y", "z"], rule, t0).ok === true, "toResult: sayısal olmayan yanıt FAIL-OPEN");

  // FAIL-OPEN + sağlık görünürlüğü
  const broken = fakeRedis({ failEval: true });
  const brokenStore = new RedisRateStore(broken.client);
  const degraded = await brokenStore.hit("k", rule, t0);
  ok(degraded.ok === true, "Redis hatasında istek GEÇER (fail-open, hizmet durmaz)");
  const h = await brokenStore.health();
  ok(h.ok === false && /FAIL-OPEN/.test(h.detail), "sağlık FAIL-OPEN'ı açıkça bildirir");
  ok((await new RedisRateStore(fakeRedis().client).health()).ok === true, "sağlıklı Redis health ok");

  // ── 3) rateHit: paylaşılan depo tercih edilir ──
  const memStore = new MemoryRateStore();
  const sharedSpy = fakeRedis();
  const shared = new RedisRateStore(sharedSpy.client);
  const r1 = await rateHit("k", rule, { memory: memStore, shared, now: t0 });
  ok(r1.shared === true, "paylaşılan depo varsa o kullanılır (shared=true)");
  ok(sharedSpy.calls.length === 1, "paylaşılan depoya gerçekten yazıldı");
  const r2 = await rateHit("k", rule, { memory: memStore, now: t0 });
  ok(r2.shared === false, "paylaşılan depo yoksa bellek (shared=false — yanıtta görünür)");
  const mem2 = new MemoryRateStore();
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await rateHit("k", rule, { memory: mem2, now: t0 + i }));
  ok(seq.slice(0, 3).every((x) => x.ok) && !seq[3].ok, "bellek yolu sınırı doğru uygular");

  // ── 4) Bellek deposu RateLimiter ile aynı davranış ──
  const a = new MemoryRateStore();
  const b = new MemoryRateStore();
  for (let i = 0; i < 3; i++) await a.hit("x", rule, t0 + i);
  ok((await a.hit("x", rule, t0 + 3)).ok === false, "MemoryRateStore: sınır uygulanır");
  ok((await b.hit("x", rule, t0 + 1001)).ok === true, "MemoryRateStore: pencere kayınca izin");
  await a.reset("x");
  ok((await a.hit("x", rule, t0 + 4)).ok === true, "MemoryRateStore: reset");

  // ── 5) Raporlama başlıkları ──
  const rh = reportingHeaders();
  ok(!!rh["Reporting-Endpoints"] && rh["Reporting-Endpoints"].includes(REPORTING_GROUP), "Reporting-Endpoints grup tanımı");
  ok(rh["Reporting-Endpoints"].includes(`"${CSP_REPORT_PATH}"`), "grup URL'i rapor ucunu gösterir");
  const rto = JSON.parse(rh["Report-To"]) as { group: string; endpoints: { url: string }[] };
  ok(rto.group === REPORTING_GROUP && rto.endpoints[0].url === CSP_REPORT_PATH, "Report-To (eski) aynı grubu tanımlar");
  const csp = buildCsp({ nonce: "n1" });
  ok(/report-to csp-endpoint/.test(csp), "CSP `report-to` yönergesini taşır");
  ok(/report-uri \/api\/csp-report/.test(csp), "CSP geriye uyum için `report-uri` de taşır");
  ok(csp.indexOf("report-uri") < csp.indexOf("report-to"), "report-uri yeni direktiften önce (biçim tutarlılığı)");

  // ── 6) Gövde normalizasyonu ──
  const klassik = normalizeReport({ "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://evil.example/x.js", "document-uri": "https://app.local/hasta/42" } });
  ok(/script-src/.test(klassik.line) && /evil\.example/.test(klassik.line), "klasik biçim: yönerge + engellenen");
  ok(!klassik.line.includes("42") && !klassik.line.includes("/hasta/"), "tam URL yazılmaz (host'a indirgenir — PHI korunur)");
  const reporting = normalizeReport([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data:image/png", documentURL: "https://app.local/a" } }]);
  ok(/img-src/.test(reporting.line) && /data:image/.test(reporting.line), "reports+json: diziden normalleştirilir");
  const tekil = normalizeReport({ type: "csp-violation", body: { effectiveDirective: "connect-src", blockedURL: "https://x.example" } });
  ok(/connect-src/.test(tekil.line), "tekil `application/report` biçimi");
  ok(normalizeReport({}).line === "", "boş gövde satır üretmez");
  ok(normalizeReport(null).line === "", "null gövde satır üretmez");
  const ctrl = normalizeReport({ body: { effectiveDirective: "script-src\u0000\r\nINJECT", blockedURL: "x" } });
  ok(!/[\u0000\r\n]/.test(ctrl.line), "kontrol karakterleri temizlenir (günlük enjeksiyonu)");
  const many = reportLines([{ type: "csp-violation", body: { effectiveDirective: "a-src" } }, { type: "csp-violation", body: { effectiveDirective: "b-src" } }, { type: "csp-violation", body: {} }], 5);
  ok(many.length === 2, "dizide boş öğeler atlanır, dolu satırlar döner");
  ok(reportLines([{ body: { effectiveDirective: "x" } }], 1).length === 1, "max sınırı uygulanır");
  ok(reportLines(undefined).length === 0, "gövde yoksa satır yok");

  // ── 7) Uç + proxy sözleşmesi ──
  const route = read("src/app/api/csp-report/route.ts");
  ok(/reportLines/.test(route), "uç üç biçimi de işler");
  ok(/type/.test(route), "rapor türü denetime taşınır");
  const proxy = read("src/proxy.ts");
  ok(/reportingHeaders/.test(proxy), "proxy Reporting-Endpoints başlığını yazar");
  ok(/X-RateLimit-Shared/.test(proxy), "paylaşımsız kurulum 429 yanıtında görünür (X-RateLimit-Shared)");
  ok(/rateStorePlan/.test(proxy), "proxy depo planını kullanır ve uyarı verir");
  ok(!/await store\.hit/.test(proxy), "proxy senkron kaldı (Edge uyumu)");
  const ws = read("src/lib/webSecurity.ts");
  ok(/RATE_LUA/.test(ws) && /ZREMRANGEBYSCORE/.test(ws), "Redis'te kayan pencere Lua ile atomik");
  ok(/FAIL-OPEN/.test(ws), "fail-open davranışı kodda belgeli");

  // ── 8) Sağlık görünürlüğü + kurulum ──
  const healthRoute = read("src/app/api/admin/health/route.ts");
  ok(/rateStorePlan\(\)/.test(healthRoute), "sağlık ucu depo planını raporlar (sessiz kalmaz)");
  ok(/__avRateStore/.test(healthRoute) && /\.health\(\)/.test(healthRoute), "sağlık ucu kurulu deponun health()'ini okur");
  ok(/id: "rate-store"/.test(healthRoute) && /kritik/.test(healthRoute), "paylaşımsız + çok örnek → kritik bulgu");
  ok(!/REDIS_URL\s*[,)]/.test(healthRoute), "REDIS_URL değeri yanıta konmaz (yalnız plan kararı)");
  const panel = read("src/components/AdminPanel.tsx");
  ok(/Hız sınırı deposu/.test(panel), "panelde depo kartı var");
  ok(/health\.rateStore\.shared/.test(panel) && /FAIL-OPEN/.test(panel) && /REDIS_URL/.test(panel), "kart paylaşım, fail-open ve çözüm önerisini gösterir");
  const inst = read("src/instrumentation.ts");
  ok(/installRateStore/.test(inst) && /NEXT_RUNTIME/.test(inst), "kurulum yalnız nodejs çalışma zamanında");

  console.log(`\nwebhard-shared: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
