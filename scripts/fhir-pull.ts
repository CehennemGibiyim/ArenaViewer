/**
 * FHIR çekim köprüsü — kurum FHIR sunucusu → ArenaViewer (e-fhir-in).
 *
 * Node süreci FHIR'in tam OAuth akışını (Authorization Code/PKCE) taşımaz; bu
 * köprü **Bearer token** (client-credentials/PAT) veya Basic kimliği ile
 * ServiceRequest + ImagingStudy serilerini çeker, ham FHIR JSON'unu doğrulayıp
 * `/api/his/fhir` ucuna iletir (push). Doğrulama/uygulama ucun entegre katmanında
 * kalır; köprü makul bir şekilde HTTPS + token ile çalışır.
 *
 * Kullanım:
 *   FHIR_URL=https://fhir.kurum/fhir/r4 FHIR_TOKEN=xxx npm run fhir:pull
 *   FHIR_URL=... FHIR_USER=admin FHIR_PASSWORD=xxx npm run fhir:pull
 *   FHIR_INTERVAL=300 npm run fhir:pull   # 300s'de bir çek
 *   HIS_BASE_URL=http://... HIS_API_KEY=... (varsayılan: 127.0.0.1:3000)
 *
 * Çıkış kodu: 0 = başarılı çekim, 2 = yapılandırma hatası, 3 = çekim hatası.
 */
import { fetchFhirRaw, fhirQueryUrl, type FhirConfig } from "../src/lib/server/fhirRepo";

/** Uç adresi + anahtar: her çekimde env'den okunur (testler env'i değiştirebilir). */
const baseUrl = () => (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = () => process.env.HIS_API_KEY || "";

export function cfgFromEnv(): FhirConfig {
  return {
    baseUrl: (process.env.FHIR_URL || "").trim().replace(/\/+$/, ""),
    token: process.env.FHIR_TOKEN?.trim() || "",
    username: process.env.FHIR_USER?.trim() || "",
    password: process.env.FHIR_PASSWORD || "",
    timeoutMs: Number(process.env.FHIR_TIMEOUT_MS || 15000) || 15000,
    defaultModality: process.env.FHIR_DEFAULT_MODALITY?.trim() || "",
  };
}

export function validateEnv(cfg: FhirConfig): string | null {
  if (!cfg.baseUrl || !/^https?:\/\//i.test(cfg.baseUrl)) return "FHIR_URL http(s) URL olmalıdır";
  if (!cfg.token && !cfg.username) return "FHIR_TOKEN veya FHIR_USER+FHIR_PASSWORD gerekir";
  return null;
}

/** Tek çekim döngüsü; push edilen ham FHIR serisini ucun ayrıştırmasına bırakır. */
export async function pullOnce(cfg: FhirConfig, log: (m: string) => void = console.log): Promise<{ ok: boolean; error?: string }> {
  const types = ["ServiceRequest", "ImagingStudy"] as const;
  for (const type of types) {
    try {
      const bundle = await fetchFhirRaw(cfg, fhirQueryUrl(cfg.baseUrl, type));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs + 5000);
      try {
        const res = await fetch(`${baseUrl()}/api/his/fhir`, {
          method: "POST",
          headers: { "Content-Type": "application/fhir+json", "x-api-key": apiKey() },
          body: JSON.stringify(bundle),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false, error: `uç ${res.status}: ${text.slice(0, 200)}` };
        }
        const data = (await res.json().catch(() => null)) as { accepted?: number } | null;
        log(`[fhir] ${type}: ${data?.accepted ?? 0} aday kabul`);
      } catch (e) {
        return { ok: false, error: String(e) };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[fhir] ${type} hata: ${msg}`);
      return { ok: false, error: msg };
    }
  }
  return { ok: true };
}

async function main(): Promise<number> {
  if (!apiKey()) {
    console.error("[fhir] HIS_API_KEY tanımlı değil.");
    return 2;
  }
  const cfg = cfgFromEnv();
  const err = validateEnv(cfg);
  if (err) {
    console.error(`[fhir] ${err}`);
    return 2;
  }
  const interval = Math.max(30, Number(process.env.FHIR_INTERVAL || 600)) * 1000;
  for (;;) {
    const r = await pullOnce(cfg);
    if (!r.ok) console.error(`[fhir] çekim hatalı: ${r.error}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

if (process.argv[1] && /fhir-pull/.test(process.argv[1])) {
  void main().then((c) => {
    if (c === 2 || c === 3) process.exit(c);
  });
}
