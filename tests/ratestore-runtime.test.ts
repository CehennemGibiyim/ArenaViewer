/**
 * g-webhard — Redis istemcisi (bağımlılıksız RESPB) ve kurulum noktası.
 * Ağa çıkmaz: ayrıştırıcı saf, kurulum `installRateStore` üzerinden sınanır.
 */
import { parseRedisUrl, parseResp, createRedisClient, installRateStore } from "../src/lib/rateStoreRuntime";
import { rateStorePlan } from "../src/lib/webSecurity";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const b = (s: string) => Buffer.from(s, "binary");
const p = (s: string) => { const r = parseResp(b(s)); return r ? r[0] : "INCOMPLETE"; };

function main() {
  // ── URL ayrıştırma ──
  const c1 = parseRedisUrl("redis://cache:6379");
  ok(c1.host === "cache" && c1.port === 6379 && c1.db === 0 && c1.tls === false, "redis://varsayılanlar");
  const c2 = parseRedisUrl("rediss://u:p%40ss@secure.example:6380/3");
  ok(c2.tls === true && c2.port === 6380 && c2.db === 3, "rediss + port + db");
  ok(c2.password === "p@ss", "parola yüzde-kodundan çözülür (yanıta yazılmaz)");
  ok(parseRedisUrl("redis://h/5").db === 5, "db yolu okunur");
  let threw = false;
  try { parseRedisUrl("http://x"); } catch { threw = true; }
  ok(threw, "redis olmayan şema reddedilir");

  // ── RESPB ayrıştırma ──
  ok(p("+PONG\r\n") === "PONG", "basit dize");
  ok(p(":42\r\n") === 42, "tamsayı");
  const err = p("-ERR bad\r\n");
  ok(err instanceof Error && /bad/.test(err.message), "hata yanıtı Error olur");
  ok(p("$5\r\nhello\r\n") === "hello", "toplu dize");
  ok(p("$-1\r\n") === null, "null toplu dize");
  const arr = p("*3\r\n:4\r\n:1700000000\r\n:3\r\n") as number[];
  ok(Array.isArray(arr) && arr[0] === 4 && arr[2] === 3, "Lua dizi yanıtı");
  ok(p("*1\r\n*2\r\n:1\r\n:2\r\n") !== "INCOMPLETE", "iç içe dizi");
  ok(p("*2\r\n:1\r\n") === "INCOMPLETE", "eksik dizi → bekle (kısmi paket)");
  ok(p("$5\r\nhel") === "INCOMPLETE", "eksik toplu dize → bekle");
  ok(p("") === "INCOMPLETE", "boş tampon → bekle");
  const consumed = parseResp(b("*2\r\n:1\r\n:2\r\nEXTRA"))![1];
  ok(consumed === 12, "tüketilen bayt doğru (sonraki yanıt bozulmaz)");
  const errInArr = p("*2\r\n:1\r\n-WRONGTYPE x\r\n");
  ok(errInArr instanceof Error, "dizi içindeki hata yukarı taşınır");

  // ── İstemci sözleşmesi ──
  const client = createRedisClient({ host: "127.0.0.1", port: 1, password: null, db: 0 });
  ok(typeof client.eval === "function" && typeof client.ping === "function", "RedisLike yüzeyi (eval+ping) sağlanır");

  // ── Kurulum ──
  delete (globalThis as { __avRateStore?: unknown }).__avRateStore;
  const memInstall = installRateStore({});
  ok(memInstall.kind === "memory" && /Bellek/.test(memInstall.detail), "REDIS_URL yoksa bellek deposu kurulur");
  ok((globalThis as { __avRateStore?: unknown }).__avRateStore === undefined, "bellek modunda global depo yazılmaz");
  const warnInstall = installRateStore({ INSTANCE_COUNT: "4" });
  ok(warnInstall.kind === "memory" && !!warnInstall.warning, "çok örnek + Redis yok → uyarı kurulumdan geçer");
  const badInstall = installRateStore({ REDIS_URL: "http://nope" });
  ok(badInstall.kind === "memory" && !!badInstall.warning, "geçersiz URL → bellek + uyarı (açılış çökmez)");
  const redisInstall = installRateStore({ REDIS_URL: "redis://cache:6379/2" });
  ok(redisInstall.kind === "redis" && redisInstall.warning === null, "geçerli URL → Redis deposu kurulur");
  ok(!/sır|parola=\w/.test(redisInstall.detail) && redisInstall.detail.includes("cache:6379/2"), "kurulum ayrıntısı hedefi söyler, sır sızdırmaz");
  const installed = (globalThis as { __avRateStore?: { shared?: boolean } }).__avRateStore;
  ok(installed?.shared === true, "globalThis.__avRateStore paylaşılan depoyu gösterir");
  // plan ile kurulum aynı kararı verir
  ok(rateStorePlan({ REDIS_URL: "redis://cache:6379/2" }).kind === redisInstall.kind, "plan ve kurulum tutarlı");

  console.log(`\nratestore-runtime: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
