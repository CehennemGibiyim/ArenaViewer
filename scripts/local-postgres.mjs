#!/usr/bin/env node
/**
 * Yerel test PostgreSQL'i — root/docker/apt gerektirmez.
 *
 * Neden: DB'li uçtan uca testler (ölçüm geçmişi, RADPEER, model kayıt defteri,
 * giriş akışı) gerçek PostgreSQL ister. Playwright tarayıcısı gibi, PostgreSQL
 * ikilisi de npm paketiyle gelebilir (`@embedded-postgres/*`).
 *
 * Kurulum (bir kez):
 *   npm i -D @embedded-postgres/linux-x64       # Linux x64
 *   # veya: EMBEDDED_PG_DIR=/path/to/postgres/bin
 *
 * Kullanım:
 *   node scripts/local-postgres.mjs start [--port 5432] [--data /tmp/av-pgdata] [--db atik]
 *   node scripts/local-postgres.mjs stop  [--data /tmp/av-pgdata]
 *   node scripts/local-postgres.mjs status
 *
 * `start` sonrası:
 *   export DATABASE_URL=postgres://atik@127.0.0.1:5432/atik
 *   npx drizzle-kit push --config=drizzle.config.ts
 *   AV_RATE_LIMIT=off npx next start -p 3200 &
 *   npm run test:db-api
 *
 * Veri dizini depo dışında tutulur (varsayılan /tmp/av-pgdata); testler E2E
 * önekli kayıtları kendileri temizler. Bu bir üretim kurulumu DEĞİLDİR:
 * kimlik doğrulaması `trust`tur, yalnız 127.0.0.1'i dinler.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", process.env.PGPORT ?? 5432));
const dataDir = arg("data", process.env.AV_PGDATA ?? "/tmp/av-pgdata");
const database = arg("db", process.env.AV_PGDATABASE ?? "atik");
const user = process.env.AV_PGUSER ?? "atik";

function binDir() {
  if (process.env.EMBEDDED_PG_DIR) return process.env.EMBEDDED_PG_DIR;
  const candidates = [
    path.join(root, "node_modules/@embedded-postgres/linux-x64/native/bin"),
    path.join(root, "node_modules/@embedded-postgres/darwin-arm64/native/bin"),
    path.join(root, "node_modules/@embedded-postgres/darwin-x64/native/bin"),
    path.join(root, "node_modules/@embedded-postgres/windows-x64/native/bin"),
  ];
  for (const c of candidates) if (existsSync(path.join(c, "postgres"))) return c;
  throw new Error(
    "PostgreSQL ikilisi bulunamadı. Kurun: npm i -D @embedded-postgres/linux-x64\n" +
      "  veya EMBEDDED_PG_DIR=<initdb/postgres dizini> verin."
  );
}

function waitPort(ms = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.end(); resolve(true); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > ms) reject(new Error(`PostgreSQL ${port} portunda açılmadı`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function ensureDatabase() {
  let pg;
  try { pg = await import("pg"); } catch { console.log("[pg] 'pg' bulunamadı; veritabanı oluşturma atlandı."); return; }
  const client = new pg.Client({ connectionString: `postgres://${user}@127.0.0.1:${port}/postgres` });
  await client.connect();
  const r = await client.query("select 1 from pg_database where datname=$1", [database]);
  if (!r.rowCount) await client.query(`create database ${database.replace(/[^a-z0-9_]/gi, "")}`);
  await client.end();
  console.log(`[pg] hazır: postgres://${user}@127.0.0.1:${port}/${database}`);
}

function status() {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) { console.log(`[pg] ${dataDir}: çalışmıyor (postmaster.pid yok)`); return; }
  const pid = readFileSync(pidFile, "utf8").split("\n")[0];
  console.log(`[pg] ${dataDir}: postmaster pid ${pid}, port ${port}`);
}

async function start() {
  const bin = binDir();
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`[pg] initdb → ${dataDir}`);
    const r = spawnSync(path.join(bin, "initdb"), ["-D", dataDir, "-U", user, "--auth=trust", "--encoding=UTF8", "--locale=C"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("initdb başarısız");
  }
  const log = path.join(dataDir, "server.log");
  const out = openSync(log, "a");
  const child = spawn(path.join(bin, "postgres"), ["-D", dataDir, "-p", String(port), "-k", "/tmp", "-c", "listen_addresses=127.0.0.1"], {
    detached: true, stdio: ["ignore", out, out],
  });
  child.unref();
  await waitPort();
  console.log(`[pg] dinliyor: 127.0.0.1:${port} (log: ${log})`);
  await ensureDatabase();
}

function stop() {
  const bin = binDir();
  const r = spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "stop", "-m", "fast"], { stdio: "inherit" });
  if (r.status !== 0) console.log("[pg] pg_ctl stop başarısız (zaten kapalı olabilir)");
}

const cmd = process.argv[2] ?? "status";
try {
  if (cmd === "start") await start();
  else if (cmd === "stop") stop();
  else if (cmd === "status") status();
  else { console.error("Kullanım: local-postgres.mjs start|stop|status [--port N] [--data DIR] [--db ADI]"); process.exit(1); }
} catch (e) {
  console.error(`[pg] ${e.message}`);
  process.exit(1);
}
