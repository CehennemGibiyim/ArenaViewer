/**
 * MWL DIMSE C-FIND köprüsü — HTTP köprüsü.
 *
 * Node.js'te olgun bir DIMSE (DICOM ağ protokolü) yığını yok; `dicom` paketi
 * çalışma zamanında `net` üzerinden elle kurulmuş bir C-ECHO/C-FIND istemcisi
 * gerektiriyor ve bakımı zor. Bu nedenle Node tarafında yalnız ince bir köprü
 * tutuyoruz:
 *
 *   ArenaViewer (/api/his/mwl) ──HTTP──▶ bu süreç ──DIMSE──▶ PACS/MWL SCP
 *
 * Bu süreç, aşağıdaki "upstream" komutla DIMSE C-FIND yapan bir yardımcıya
 * devreder (`MWL_BACKEND`, varsayılan: `dcm4che`'nin `findscu` aracı):
 *
 *   findscu -W -k "0008,0052=SCHEDULED" \
 *           -k "0008,0060=CT" -k "0040,0002-0040,0003=20260115-20260115" \
 *           -- PACS 104 -- json-out -
 *
 * `findscu --json-out` (dcm4che 5.24+) MWL yanıtlarını **DICOM JSON dizisi**
 * olarak verir; ArenaViewer `mwlFromDicomJson()` ile bunu doğrudan okur, yani
 * dönüşüm yapmaya gerek yok. `findscu` yoksa (veya `MWL_BACKEND=bin` ile ikili
 * çıktı üretiliyorsa) bu köprü ham Implicit VR baytlarını da kabul eder ve
 * `parseImplicitVr()` + `datasetToDicomJson()` ile JSON'a çevirir.
 *
 * Çalıştırma:
 *   MWL_PACS_HOST=10.0.0.20 MWL_PACS_PORT=104 MWL_PACS_AET=ORTHANC \
 *   MWL_CALLING_AET=ARENAVIEWER MWL_BACKEND=findscu npm run mwl:cfind
 *
 * Ortam değişkenleri:
 *   MWL_LISTEN_PORT  HTTP dinleme portu (varsayılan 2580)
 *   MWL_LISTEN_HOST  dinlenecek adres (varsayılan 127.0.0.1)
 *   MWL_PACS_HOST    PACS/MWL SCP adresi (zorunlu)
 *   MWL_PACS_PORT    SCP portu (varsayılan 104)
 *   MWL_PACS_AET     SCP AE Title (zorunlu)
 *   MWL_CALLING_AET  çağıran AE Title (varsayılan ARENAVIEWER)
 *   MWL_BACKEND      `findscu` (varsayılan) | `bin` (ham bayt üreten komut)
 *   MWL_BIN          `bin` kipinde çalıştırılacak komut (stdout: ham C-FIND yanıtı)
 *   MWL_QUERY_MODEL  sorgu modeli (varsayılan: MWL)
 *
 * Güvenlik: yalnız `127.0.0.1`e bağlanır; `/api/his/mwl` dışarıya açık olsa da
 * köprüye erişim aynı makinedeki ArenaViewer süreciyle sınırlıdır.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { datasetToDicomJson, parseImplicitVr } from "../src/lib/mwl";

const LISTEN_PORT = Number(process.env.MWL_LISTEN_PORT || 2580);
const LISTEN_HOST = process.env.MWL_LISTEN_HOST || "127.0.0.1";
const PACS_HOST = process.env.MWL_PACS_HOST || "";
const PACS_PORT = Number(process.env.MWL_PACS_PORT || 104);
const PACS_AET = process.env.MWL_PACS_AET || "";
const CALLING_AET = process.env.MWL_CALLING_AET || "ARENAVIEWER";
const BACKEND = process.env.MWL_BACKEND || "findscu";
const BIN = process.env.MWL_BIN || "";
const TIMEOUT_MS = Number(process.env.MWL_TIMEOUT_MS || 20000);

if (!PACS_HOST || !PACS_AET) {
  console.error("[mwl] MWL_PACS_HOST ve MWL_PACS_AET tanımlı olmalı — köprü başlatılmadı.");
  process.exit(1);
}

/** DICOM DA ("20260115") ya da "20260115-20260116" aralığını olduğu gibi geçirir. */
const cleanDa = (s: string) => (/^\d{8}(-\d{8})?$/.test(s) ? s : "");

interface FindArgs {
  modality: string;
  date: string;
  stationAE: string;
  limit: number;
}

function findscuArgs(q: FindArgs): string[] {
  const args = ["-W", '-k', "0008,0052=SCHEDULED"];
  if (q.modality) args.push("-k", `0008,0060=${q.modality}`);
  if (q.date) args.push("-k", `0040,0002-0040,0003=${q.date}`);
  if (q.stationAE) args.push("-k", `0040,0001=${q.stationAE}`);
  args.push("-k", "0040,0100", "-k", "0010,0010", "-k", "0010,0020", "-k", "0008,0050", "-k", "0020,000D");
  args.push("-k", "0008,0060", "-k", "0040,0007", "-k", "0040,0009", "-k", "0040,0020");
  args.push("--limit", String(q.limit), "--", PACS_HOST, String(PACS_PORT), "--json-out", "-");
  return args;
}

function run(cmd: string, args: string[], input?: string): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MWL arka ucu ${Math.round(TIMEOUT_MS / 1000)} sn içinde yanıt vermedi`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`MWL arka ucu ${code} koduyla çıktı: ${err.trim().slice(0, 300)}`));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

/** Yanıt JSON mu, ham Implicit VR mı? İkisini de kabul et. */
function toResults(buf: Buffer): unknown[] {
  const text = buf.toString("utf8").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (buf.length === 0) return [];
  // Ham bayt: birden çok veri kümesi peş peşe gelebilir; hepsini tek veri kümesi
  // olarak okumak yeterli (C-FIND yanıtları (0008,0005) ile başlar).
  return [datasetToDicomJson(parseImplicitVr(new Uint8Array(buf)))];
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "Yalnız GET desteklenir" });
  const url = new URL(req.url ?? "/", `http://${LISTEN_HOST}:${LISTEN_PORT}`);
  if (url.pathname !== "/cfind") return send(404, { error: "Yol bulunamadı (beklenen: /cfind)" });

  const q: FindArgs = {
    modality: (url.searchParams.get("modality") ?? "").slice(0, 16),
    date: cleanDa(url.searchParams.get("scheduled-date") ?? ""),
    stationAE: (url.searchParams.get("stationAE") ?? "").slice(0, 16),
    limit: Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100)),
  };

  try {
    const out = BACKEND === "bin"
      ? await run(BIN || "mwl-cfind", [JSON.stringify({ ...q, host: PACS_HOST, port: PACS_PORT, aet: PACS_AET, calling: CALLING_AET })])
      : await run("findscu", findscuArgs(q));
    const items = toResults(out.stdout);
    console.log(`[mwl] ${items.length} öge (${q.modality || "tüm modaliteler"} ${q.date || "tarih yok"})`);
    return send(200, items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mwl] hata: ${msg}`);
    return send(502, { error: msg });
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : LISTEN_PORT;
  // Port 0 verildiğinde işletim sisteminin atadığı port yazılır (test bunu bekler).
  console.log(`[mwl] C-FIND köprüsü: http://${LISTEN_HOST}:${port}/cfind → ${PACS_AET}@${PACS_HOST}:${PACS_PORT} (${BACKEND})`);
});
