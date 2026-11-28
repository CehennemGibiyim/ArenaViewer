/**
 * g-webhard — paylaşılan hız sınırı deposunun **kurulum noktası**.
 *
 * Neden ayrı modül: `webSecurity.ts` çekirdek kalsın (tarayıcıda da import
 * edilebilir, sürücü bağımlılığı yok). Redis istemcisi burada, yalnız Node
 * çalışma zamanında kurulur ve `globalThis.__avRateStore` üzerinden proxy'ye
 * görünür (proxy Edge'de de çalışabilir; orada bu modül yüklenmez ve bellek
 * yolu kullanılır).
 *
 * İstemci seçimi bilinçli olarak **bağımlılıksız**: Redis'in RESPB protokolü
 * (inline komut + `$`/`:` yanıt) bizim tek ihtiyacımız olan `EVAL`/`PING` için
 * yeterli. `ioredis`/`redis` paketleri eklenmedi — kilitlenmiş tedarik zinciri
 * ve paket boyutu nedeniyle; ileride gerçek istemci aynı `RedisLike` yüzeyiyle
 * enjekte edilebilir (`installRateStore(client)`), sözleşme değişmez.
 */
import { RedisRateStore, rateStorePlan, type RedisLike, type RateStore } from "./webSecurity";

declare global {
  var __avRateStore: RateStore | undefined;
}

/** `redis://[:parola@]host:port[/db]` → RESPB bağlantı bilgisi. */
export function parseRedisUrl(url: string): { host: string; port: number; db: number; password: string | null; tls: boolean } {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error("REDIS_URL redis:// veya rediss:// olmalı");
  const db = Number((u.pathname || "/0").slice(1) || 0);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number.isFinite(db) ? db : 0,
    password: u.password ? decodeURIComponent(u.password) : null,
    tls: u.protocol === "rediss:",
  };
}

/**
 * RESPB yanıt ayrıştırıcı (saf, test edilir).
 * Döner: `[değer, tüketilen bayt]`; yanıt tamamlanmadıysa `null`.
 * Desteklenenler: `+dize`, `:sayı`, `-hata`, `$toplu`, `*dizi`.
 */
export function parseResp(buf: Buffer): [unknown, number] | null {
  if (buf.length === 0) return null;
  const kind = String.fromCharCode(buf[0]);
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return null;
  const head = buf.subarray(1, nl).toString();
  const after = nl + 2;
  switch (kind) {
    case "+": return [head, after];
    case "-": return [new Error(`Redis: ${head}`), after];
    case ":": return [Number(head), after];
    case "$": {
      const len = Number(head);
      if (len < 0) return [null, after];
      if (buf.length < after + len + 2) return null;
      return [buf.subarray(after, after + len).toString(), after + len + 2];
    }
    case "*": {
      const n = Number(head);
      if (n < 0) return [null, after];
      const out: unknown[] = [];
      let pos = after;
      for (let i = 0; i < n; i++) {
        const item = parseResp(buf.subarray(pos));
        if (!item) return null;
        if (item[0] instanceof Error) return [item[0], pos + item[1]];
        out.push(item[0]);
        pos += item[1];
      }
      return [out, pos];
    }
    default: return [head, after];
  }
}

/** Tek komut → yanıt. Bağlantı komut başına kurulur (yalın; havuz gerekmez). */
export async function respCommand(
  conn: { host: string; port: number },
  args: (string | number)[],
): Promise<unknown> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: conn.host, port: conn.port });
    let buf: Buffer = Buffer.alloc(0);
    const done = (fn: () => void) => { sock.removeAllListeners(); sock.destroy(); fn(); };
    sock.setTimeout(2000, () => done(() => reject(new Error("Redis zaman aşımı"))));
    sock.on("error", (e) => done(() => reject(e)));
    sock.on("connect", () => {
      // RESPB toplu dizi: komutlar ve argümanlar uzunluk önekli yazılır.
      const parts = [`*${args.length}\r\n`];
      for (const a of args) {
        const v = String(a);
        parts.push(`$${Buffer.byteLength(v)}\r\n${v}\r\n`);
      }
      sock.write(parts.join(""));
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseResp(buf);
      if (!parsed) return; // yanıt sürüyor
      const [value] = parsed;
      if (value instanceof Error) return done(() => reject(value));
      done(() => resolve(value));
    });
  });
}

/** `RedisLike` sözleşmesini RESPB üzerinden uygular (bağımlılıksız). */
export function createRedisClient(conn: { host: string; port: number; password: string | null; db: number }): RedisLike {
  return {
    async eval(script, numKeys, ...args) {
      if (conn.password) await respCommand(conn, ["AUTH", conn.password]);
      if (conn.db) await respCommand(conn, ["SELECT", conn.db]);
      return respCommand(conn, ["EVAL", script, numKeys, ...args]);
    },
    async ping() { return String(await respCommand(conn, ["PING"])); },
  };
}

/**
 * Depoyu kurar (idempotent). Dönüş: ne kurulduğu — çağıran günlüğe yazar.
 * Hata durumunda **fırlatmaz**: uygulama bellek yoluyla açılır (fail-open).
 */
export function installRateStore(env: Record<string, string | undefined> = process.env): {
  kind: "redis" | "memory"; warning: string | null; detail: string;
} {
  const plan = rateStorePlan(env);
  if (plan.kind === "memory") {
    return { kind: "memory", warning: plan.warning, detail: "Bellek deposu: sayaçlar yalnız bu süreçte geçerli." };
  }
  try {
    const conn = parseRedisUrl((env.REDIS_URL ?? "").trim());
    const store = new RedisRateStore(createRedisClient(conn));
    globalThis.__avRateStore = store;
    return {
      kind: "redis",
      warning: null,
      detail: `Paylaşılan sayaç: ${conn.tls ? "rediss" : "redis"}://${conn.host}:${conn.port}/${conn.db} (parola yanıta yazılmaz).`,
    };
  } catch (e) {
    return {
      kind: "memory",
      warning: `Redis istemcisi kurulamadı (${e instanceof Error ? e.message : "bilinmeyen hata"}); bellek deposuna düşüldü.`,
      detail: "Bellek deposu: sayaçlar yalnız bu süreçte geçerli.",
    };
  }
}
