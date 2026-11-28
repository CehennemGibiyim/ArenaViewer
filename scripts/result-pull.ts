/**
 * Sonuç çekim köprüsü — kurum FHIR sunucusu → ArenaViewer (d-followup).
 *
 * Node süreci FHIR'in tam OAuth akışını (Authorization Code/PKCE) taşımaz; bu
 * köprü **Bearer token** (client-credentials/PAT) veya Basic kimliği ile
 * `DiagnosticReport` serilerini çeker, ham FHIR JSON'unu `diagnosticReportToResult`
 * ile sonuç yüküne çevirip `/api/his/results` ucuna iletir (push). Doğrulama/uygulama
 * ucun entegre katmanında kalır; köprü makul bir şekilde HTTPS + token ile çalışır.
 *
 * Kullanım:
 *   FHIR_URL=https://fhir.kurum/fhir/r4 FHIR_TOKEN=xxx npm run result:pull
 *   FHIR_URL=... FHIR_USER=admin FHIR_PASSWORD=xxx npm run result:pull
 *   RESULT_INTERVAL=300 npm run result:pull   # 300s'de bir çek
 *   HIS_BASE_URL=http://... HIS_API_KEY=... (varsayılan: 127.0.0.1:3000)
 *
 * Çıkış kodu: 0 = başarılı çekim, 2 = yapılandırma hatası, 3 = çekim hatası.
 */
import { fetchFhirRaw, fhirQueryUrl, type FhirConfig } from "../src/lib/server/fhirRepo";
import { diagnosticReportToResult, validateResultConfig, type ResultPullConfig, type ResultRecordInput } from "../src/lib/resultPull";

/** Uç adresi + anahtar: her çekimde env'den okunur (testler env'i değiştirebilir). */
const baseUrl = () => (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = () => process.env.HIS_API_KEY || "";

export function cfgFromEnv(): ResultPullConfig {
  return {
    baseUrl: (process.env.FHIR_URL || "").trim().replace(/\/+$/, ""),
    token: process.env.FHIR_TOKEN?.trim() || "",
    username: process.env.FHIR_USER?.trim() || "",
    password: process.env.FHIR_PASSWORD || "",
    timeoutMs: Number(process.env.FHIR_TIMEOUT_MS || 15000) || 15000,
    defaultModality: process.env.FHIR_DEFAULT_MODALITY?.trim() || "",
  };
}

/** FHIRConfig → ResultPullConfig (köprü başvuru tipi). */
export function toResultConfig(cfg: FhirConfig): ResultPullConfig {
  return { baseUrl: cfg.baseUrl, token: cfg.token, username: cfg.username, password: cfg.password, timeoutMs: cfg.timeoutMs, defaultModality: cfg.defaultModality };
}

/** ResultPullConfig → FHIRConfig (çekim köprüsü FHIR katmanını kullanır). */
export function toFhirConfig(cfg: ResultPullConfig): FhirConfig {
  return { baseUrl: cfg.baseUrl, token: cfg.token, username: cfg.username, password: cfg.password, timeoutMs: cfg.timeoutMs, defaultModality: cfg.defaultModality };
}

export function validateEnv(cfg: ResultPullConfig): string | null {
  return validateResultConfig(cfg);
}

/** DiagnosticReport bundle'ı → sonuç yükü listesi (saf çıkarma, ucun kabulü). */
export function bundleToResults(bundle: unknown): { results: ResultRecordInput[]; skipped: string[] } {
  const results: ResultRecordInput[] = [];
  const skipped: string[] = [];
  const b = bundle as { entry?: { resource?: Record<string, unknown> }[] };
  if (!b || typeof b !== "object" || !Array.isArray(b.entry)) {
    return { results, skipped: ["Bundle.entry dizisi yok"] };
  }
  for (const entry of b.entry) {
    const res = entry?.resource;
    if (!res || res.resourceType !== "DiagnosticReport") continue;
    const out = diagnosticReportToResult(res);
    if (!out) {
      skipped.push(`DiagnosticReport/${String(res.id ?? "?")}: conclusion eksik`);
      continue;
    }
    results.push({
      source: "fhir",
      patientId: out.patientId,
      accessionNumber: out.accessionNumber,
      modality: out.modality,
      bodyPart: out.bodyPart,
      description: out.description,
      text: out.text,
      at: out.at,
      studyUid: out.studyUid,
      fhirSource: out.fhirSource,
    });
  }
  return { results, skipped };
}

/** Tek çekim döngüsü; DiagnosticReport serilerini ucun eşlemesine bırakır. */
export async function pullOnce(cfg: ResultPullConfig, log: (m: string) => void = console.log): Promise<{ ok: boolean; error?: string }> {
  const err = validateEnv(cfg);
  if (err) return { ok: false, error: err };
  try {
    const bundle = await fetchFhirRaw(toFhirConfig(cfg), fhirQueryUrl(cfg.baseUrl, "DiagnosticReport"));
    const { results, skipped } = bundleToResults(bundle);
    for (const s of skipped) log(`[result] atlandı: ${s}`);
    if (!results.length) {
      log("[result] çekilen DiagnosticReport yok");
      return { ok: true };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs + 5000);
    try {
      const res = await fetch(`${baseUrl()}/api/his/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
        body: JSON.stringify({ source: "fhir", results }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `uç ${res.status}: ${text.slice(0, 200)}` };
      }
      const data = (await res.json().catch(() => null)) as { accepted?: number; batchId?: string } | null;
      log(`[result] ${results.length} sonuç iletildi (batch ${data?.batchId ?? "?"}, kabul ${data?.accepted ?? 0})`);
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── main: ödüllü çalışma zamanı ──────────────────────────────────────────────
async function main(): Promise<void> {
  const cfg = cfgFromEnv();
  const err = validateEnv(cfg);
  if (err) {
    console.error(`[result] yapılandırma hatası: ${err}`);
    process.exit(2);
  }
  const interval = Number(process.env.RESULT_INTERVAL || 300) || 300;
  for (;;) {
    const r = await pullOnce(cfg);
    if (!r.ok) {
      console.error(`[result] çekim hatası: ${r.error}`);
      process.exit(3);
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

if (process.argv[1] && /result-pull(\.ts|\.js)?$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[result]beklenmeyen hata: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  });
}
