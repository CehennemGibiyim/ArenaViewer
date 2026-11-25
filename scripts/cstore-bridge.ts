/**
 * DIMSE C-STORE köprüsü — HTTP köprüsü (e-stow).
 *
 * Node içinde olgun bir DIMSE yığını yok (MWL C-FIND köprüsüyle aynı gerekçe).
 * Bu süreç, aldığı DICOM nesnelerini geçici dosyalara yazıp bir yardımcıya
 * (`storescu`, dcm4che 5.24+) devreder ve durum kodlarını JSON olarak döndürür.
 *
 *   ArenaViewer (/api/pacs/cstore) ──HTTP──▶ bu süreç ──DIMSE──▶ PACS (C-STORE SCP)
 *
 * Çalıştırma:
 *   CSTORE_HOST=10.0.0.20 CSTORE_PORT=104 CSTORE_AET=ORTHANC \
 *   CSTORE_CALLING_AET=ARENAVIEWER npm run cstore:bridge
 *
 * Ortam değişkenleri:
 *   CSTORE_LISTEN_PORT  HTTP dinleme portu (varsayılan 2590)
 *   CSTORE_LISTEN_HOST  dinlenecek adres (varsayılan 127.0.0.1)
 *   CSTORE_HOST         PACS C-STORE SCP adresi (zorunlu; istekte de gelebilir)
 *   CSTORE_PORT         SCP portu (varsayılan 104)
 *   CSTORE_AET          hedef AE Title
 *   CSTORE_CALLING_AET  çağıran AE Title (varsayılan ARENAVIEWER)
 *   CSTORE_BACKEND      `storescu` (varsayılan) | `bin` (CSTORE_BIN komutu)
 *   CSTORE_BIN          `bin` kipinde çalıştırılacak komut (argv: JSON istek yolu)
 *   CSTORE_TIMEOUT_MS   istek zaman aşımı (varsayılan 60000)
 *
 * Güvenlik: yalnız `127.0.0.1`e bağlanır; gövde boyutu ve nesne sayısı sınırlıdır,
 * geçici dosyalar iş bitince silinir.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const LISTEN_PORT = Number(process.env.CSTORE_LISTEN_PORT || 2590);
const LISTEN_HOST = process.env.CSTORE_LISTEN_HOST || "127.0.0.1";
const PACS_HOST = process.env.CSTORE_HOST || "";
const PACS_PORT = Number(process.env.CSTORE_PORT || 104);
const PACS_AET = process.env.CSTORE_AET || "";
const CALLING_AET = process.env.CSTORE_CALLING_AET || "ARENAVIEWER";
const BACKEND = process.env.CSTORE_BACKEND || "storescu";
const BIN = process.env.CSTORE_BIN || "";
const TIMEOUT_MS = Number(process.env.CSTORE_TIMEOUT_MS || 60000);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_ITEMS = 20;

interface Body {
  target?: { host?: string; port?: number; calledAe?: string; callingAe?: string; tls?: boolean };
  items?: { name?: string; data?: string; sopInstanceUid?: string }[];
}

const AE_RE = /^[A-Z0-9 _-]{1,16}$/;

function storeArgs(target: { host: string; port: number; calledAe: string; callingAe: string }, dir: string): string[] {
  const args = ["-aec", target.calledAe, "-aet", target.callingAe];
  args.push("-connect-timeout", "10", "-send-timeout", "20");
  args.push("--", target.host, String(target.port), dir);
  return args;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`C-STORE arka ucu ${Math.round(TIMEOUT_MS / 1000)} sn içinde yanıt vermedi`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // storescu: 0 = tümü başarılı, 1 = bazı/ tümü başarısız (ayrıntı stderr'de)
      if (code === 0 || code === 1) resolve({ stdout: out, stderr: err });
      else reject(new Error(`C-STORE arka ucu ${code} koduyla çıktı: ${err.trim().slice(0, 300)}`));
    });
  });
}

/** storescu çıktısından durum kodları: "Status: 0x0000" satırları veya dosya başına hata. */
function parseStatuses(text: string): { status?: string; error?: string }[] {
  const out: { status?: string; error?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const st = /Status:\s*(0x[0-9A-Fa-f]{4})/i.exec(line);
    if (st) out.push({ status: st[1] });
    else if (/^Error|failed|Unable/i.test(line.trim())) out.push({ error: line.trim().slice(0, 200) });
  }
  if (out.length === 0) {
    // storescu -q sessizse "0 failures" / "N failures" satırını oku
    const m = /(\d+)\s+failures?/i.exec(text);
    if (m) return [{ status: Number(m[1]) === 0 ? "0x0000" : "0x0110" }];
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET") return send(200, { ok: true, backend: BACKEND, target: PACS_HOST ? `${PACS_AET}@${PACS_HOST}:${PACS_PORT}` : null });
  if (req.method !== "POST") return send(405, { error: "Yalnız GET/POST desteklenir" });
  const url = new URL(req.url ?? "/", `http://${LISTEN_HOST}:${LISTEN_PORT}`);
  if (url.pathname !== "/cstore") return send(404, { error: "Yol bulunamadı (beklenen: /cstore)" });

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) { req.destroy(); return send(413, { error: "Gövde çok büyük" }); }
      chunks.push(c as Buffer);
    }
  } catch {
    return send(400, { error: "Gövde okunamadı" });
  }

  let body: Body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body; } catch { return send(400, { error: "JSON çözülemedi" }); }

  const host = (body.target?.host || PACS_HOST).trim();
  const port = Number(body.target?.port || PACS_PORT);
  const calledAe = (body.target?.calledAe || PACS_AET).trim().toUpperCase();
  const callingAe = (body.target?.callingAe || CALLING_AET).trim().toUpperCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return send(400, { error: "Hedef adres/port geçersiz" });
  if (!AE_RE.test(calledAe) || !AE_RE.test(callingAe)) return send(400, { error: "AE Title geçersiz" });

  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (items.length === 0) return send(400, { error: "Nesne yok" });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atik-cstore-"));
  try {
    const files: { name: string; file: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = (it?.name ?? `nesne-${i + 1}.dcm`).slice(0, 120);
      const b64 = (it?.data ?? "").replace(/^data:[^;]+;base64,/, "");
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 132 || buf.toString("latin1", 128, 132) !== "DICM") {
        return send(400, { error: `${name}: DICOM imzası yok` });
      }
      const file = path.join(dir, `i${String(i).padStart(3, "0")}.dcm`);
      await fs.writeFile(file, buf);
      files.push({ name, file });
    }

    const target = { host, port, calledAe, callingAe };
    const results: { name: string; status?: string; error?: string }[] = [];
    for (const f of files) {
      try {
        const out = BACKEND === "bin"
          ? await run(BIN || "cstore", [JSON.stringify({ ...target, file: f.file })])
          : await run("storescu", storeArgs(target, f.file));
        const st = parseStatuses(`${out.stdout}\n${out.stderr}`);
        results.push({ name: f.name, ...(st[0] ?? {}) });
      } catch (e) {
        results.push({ name: f.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
      console.log(`[cstore] ${f.name} → ${calledAe}@${host}:${port}`);
    }
    return send(200, { results });
  } catch (e) {
    return send(502, { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : LISTEN_PORT;
  console.log(`[cstore] C-STORE köprüsü: http://${LISTEN_HOST}:${port}/cstore → ${PACS_AET || "(istekten)"}@${PACS_HOST || "(istekten)"}:${PACS_PORT} (${BACKEND})`);
});
