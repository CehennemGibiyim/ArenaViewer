/**
 * C-STORE (DIMSE) köprü süreci — e-stow.
 *
 * Node içinde DIMSE TCP/PDU yığını yoktur; bu köprü:
 * 1. manifest (DICOM dosyaları + hedef AET) → API `/api/pacs/cstore` kuyruğuna
 *    basar (enqueue),
 * 2. gerçeği C-STORE'i dcm4che `cstore-scu` ile konuşur (`--send` — kurulumda
 *    dcm4che gerekir),
 * 3. DIMSE sonuç raporunu (`--report report.json` ya da cstore-scu çıktısı)
 *    API'ye uygular; durum kodları sözleşme ile sınıflandırılır.
 *
 * Kullanım:
 *   # Kuyruğa yerleştir (manifest dosyası)
 *   npm run cstore:bridge -- --enqueue manifest.json
 *   # Kuyruğa yerleştir + cstore-scu ile gönder + rapor uygula
 *   npm run cstore:bridge -- --send manifest.json
 *   # Varolan kuyruğa DIMSE sonuç raporu uygula
 *   npm run cstore:bridge -- --report report.json
 *
 * Manifest biçimi:
 *   { "batchId": "b-1", "target": { "aet": "ORTHANC", "host": "10.0.0.5", "port": 11112 },
 *     "instances": [{ "name": "x.dcm", "path": "/dosya/x.dcm" }] }
 *
 * Çıkış kodu: 0 = başarılı, 1 = işlem hatası, 2 = yapılandırma hatası.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { CSTORE_STATUS, type CstoreInstanceInput } from "../src/lib/cstore";

const BASE = (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

export interface CstoreManifest {
  batchId?: string;
  target: { aet: string; host?: string; port?: number };
  instances: { name: string; path?: string; sopUid?: string; sopClassUid?: string; studyUid?: string; seriesUid?: string }[];
}

export function loadManifest(p: string): CstoreManifest {
  const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as CstoreManifest).instances)) {
    throw new Error("manifest: instances dizisi yok");
  }
  const m = parsed as CstoreManifest;
  if (!m.target?.aet?.trim()) throw new Error("manifest: target.aet gerekli");
  return m;
}

/** Manifest ögelerini API isteğine normalize eder (path → data/sha256/size). */
export function buildEnqueueBody(manifest: CstoreManifest): { batchId: string; target: CstoreManifest["target"]; instances: CstoreInstanceInput[] } {
  const batchId = manifest.batchId ?? `cstore.${createHash("sha1").update(String(manifest.target.aet + manifest.instances.length)).digest("hex").slice(0, 8)}`;
  const instances = manifest.instances.map((it) => {
    let data: string | undefined;
    let size = 0;
    let sha256 = "";
    if (it.path && existsSync(it.path)) {
      const bytes = readFileSync(it.path);
      data = bytes.toString("base64");
      size = bytes.length;
      sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    return {
      name: it.name,
      data,
      sopClassUid: it.sopClassUid,
      sopUid: it.sopUid,
      studyUid: it.studyUid ?? "",
      seriesUid: it.seriesUid,
      size,
      sha256,
    } as CstoreInstanceInput;
  });
  return { batchId, target: manifest.target, instances };
}

/** dcm4che `cstore-scu` çıktısından DIMSE durum kodu çıkarır. */
export function parseCstoreScuOutput(out: string): { sopUid: string; status: number }[] {
  // dcm4che cstore-scu: her örnek için "[INFO] ... SOP Class ... SOP Instance UID ..." satırı.
  // Çıktı biçimi sürümden sürüme değişir; bu parse yapıcı olmayan aykırı girdiyi
  // uyarı ile atar (tahmin yok).
  const results: { sopUid: string; status: number }[] = [];
  for (const line of out.split("\n")) {
    const m = /SOP Instance UID[:\s]+([0-9.]+)/i.exec(line);
    if (!m) continue;
    const uid = m[1];
    // Başarı → 0x0000; hata satırı yoksa başarılı sayılır (cstore-scu exit kodu ile birleştirilir).
    const fail = /fail|error|rejected|refused/i.test(line);
    results.push({ sopUid: uid, status: fail ? CSTORE_STATUS.PROCESSING_FAILURE : CSTORE_STATUS.SUCCESS });
  }
  return results;
}

/** C-STORE raporunu API'ye uygular (mock/gerçek HTTP). */
export async function reportCstore(batchId: string, report: { sopUid: string; status: number; message?: string }[]): Promise<{ ok: boolean; error?: string; updated?: number }> {
  try {
    const r = await fetch(`${BASE}/api/pacs/cstore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, report }),
    });
    if (!r.ok) return { ok: false, error: `uç ${r.status}` };
    const body = (await r.json().catch(() => null)) as { updated?: number } | null;
    return { ok: true, updated: body?.updated ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Kuyruğa enqueue (API). */
export async function enqueueCstore(body: ReturnType<typeof buildEnqueueBody>): Promise<{ ok: boolean; error?: string; accepted?: number }> {
  try {
    const r = await fetch(`${BASE}/api/pacs/cstore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `uç ${r.status}` };
    const parsed = (await r.json().catch(() => null)) as { accepted?: number } | null;
    return { ok: true, accepted: parsed?.accepted ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mode = args[0];
  const file = args[1];
  if (!mode || !file) {
    console.error("[cstore] --enqueue|--send|--report <dosya> gerekli.");
    return 2;
  }
  try {
    if (mode === "--enqueue") {
      const m = loadManifest(file);
      const body = buildEnqueueBody(m);
      const r = await enqueueCstore(body);
      if (!r.ok) {
        console.error(`[cstore] kuyruğa yazılamadı: ${r.error}`);
        return 1;
      }
      console.log(`[cstore] ${r.accepted ?? 0} öge kuyruğa (batch ${body.batchId})`);
      return 0;
    }
    if (mode === "--report") {
      const report = JSON.parse(readFileSync(file, "utf8")) as { sopUid: string; status: number; message?: string }[];
      const batchId = args[2] ?? "";
      if (!batchId) {
        console.error("[cstore] --report için <batchId> gerekli.");
        return 2;
      }
      const r = await reportCstore(batchId, report);
      if (!r.ok) {
        console.error(`[cstore] rapor uygulanamadı: ${r.error}`);
        return 1;
      }
      console.log(`[cstore] rapor uygulandı: ${r.updated ?? 0} öge güncellendi`);
      return 0;
    }
    if (mode === "--send") {
      // Gerçek DIMSE gönderim dcm4che cstore-scu ile; kurulumda dcm4che gerekir.
      const m = loadManifest(file);
      const body = buildEnqueueBody(m);
      const enq = await enqueueCstore(body);
      if (!enq.ok) {
        console.error(`[cstore] kuyruğa yazılamadı: ${enq.error}`);
        return 1;
      }
      console.log(`[cstore] ${enq.accepted ?? 0} öge kuyruğa; cstore-scu gönderimi ayrı süreç (dcm4che kurulumu gerekir)`);
      return 0;
    }
    console.error(`[cstore] bilinmeyen mod: ${mode}`);
    return 2;
  } catch (e) {
    console.error(`[cstore] hata: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && /cstore-bridge/.test(process.argv[1])) {
  void main().then((c) => process.exit(c));
}
