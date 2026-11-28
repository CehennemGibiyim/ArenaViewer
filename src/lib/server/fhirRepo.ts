/**
 * FHIR girişi sunucu katmanı: `app_settings`'ten FHIR kökü ve kimlik bilgilerini
 * okur, ServiceRequest/ImagingStudy kaynaklarını çeker ve çalışmalara uygular.
 *
 * Desteklenilen kimlik: **Bearer** token (OAuth client-credentials üretiği token)
 * veya **Basic** auth. Tam OAuth PKCE akışı kurum entegrasyonu (Authorization Code
 * adımları) katar; token/parola silinmez, şifreli ayar kaydında saklanır
 * (`fhir` anahtarının seal/unseal edilmesi `pacs.ts` deseniyledir).
 *
 * DB'ye doğrudan dokunma: siparişlerin çalışma kayıtları `studyRepo.upsertStudy`
 * üzerinden yazılır — öyle ki HL7/MWL/MPPS ile aynı çalışma UID'si köprüsü kurulur.
 */
import { encryptText, decryptText } from "@/lib/server/crypto";
import { fhirResourcesToOrders, type FhirOrderPayload, type FhirResource } from "@/lib/fhirIn";

export interface FhirConfig {
  /** FHIR temel URL'si, kök "/" ile bitmeli; örn. https://fhir.kurum/fhir/r4 */
  baseUrl: string;
  /** OAuth/PAT token → `Authorization: Bearer <token>` */
  token: string;
  /** Basic auth kullanıcı adı (token yoksa) */
  username: string;
  /** Basic auth parola (şifreli ayar kaydında) */
  password: string;
  /** Birkaç saniyelik çekim süresi */
  timeoutMs: number;
  /** Varsayılan modalite hattı (ServiceRequest modalite eksikse kullanılır) */
  defaultModality: string;
}

export const DEFAULT_FHIR: FhirConfig = {
  baseUrl: "",
  token: "",
  username: "",
  password: "",
  timeoutMs: 15000,
  defaultModality: "",
};

const cleanUrl = (v: unknown): string =>
  typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim().replace(/\/+$/, "") : "";

/** FHIR ayar kaydını kaydedeki şifreli şekil üzere çözerek döndürür. */
export function coerceFhirConfig(raw: unknown): FhirConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    baseUrl: cleanUrl(o.baseUrl),
    token: typeof o.token === "string" ? o.token.trim() : "",
    username: typeof o.username === "string" ? o.username.trim() : "",
    password: typeof o.password === "string" ? o.password : "",
    timeoutMs: typeof o.timeoutMs === "number" && o.timeoutMs > 0 && o.timeoutMs <= 600000 ? Math.floor(o.timeoutMs) : DEFAULT_FHIR.timeoutMs,
    defaultModality: typeof o.defaultModality === "string" ? o.defaultModality.trim() : "",
  };
}

/** `app_settings`'te `fhir` anahtarıyla saklanır; bozuk kayıt sessizce null. */
export async function loadFhirConfig(): Promise<FhirConfig | null> {
  const { getSetting } = await import("@/lib/server/settings");
  const raw = (await getSetting("fhir", "")).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const cfg = coerceFhirConfig(parsed);
    if (cfg && cfg.baseUrl) {
      // Şifreli alanlar kayıtta saklanır, çalıştırmada çözülür.
      if (cfg.password && cfg.password.startsWith("enc:")) cfg.password = decryptText(cfg.password);
      if (cfg.token && cfg.token.startsWith("enc:")) cfg.token = decryptText(cfg.token);
      return cfg;
    }
  } catch {
    /* bozuk kayıt: FHIR girişi devre dışı kalır, uygulama çalışır */
  }
  return null;
}

/** Ayar kaydını şifrelenerek saklar; `token`/`password` plain ile verilemez. */
export async function saveFhirConfig(cfg: FhirConfig): Promise<void> {
  const { db } = await import("@/db");
  const { appSettings } = await import("@/db/schema");
  const stored = {
    ...cfg,
    token: cfg.token ? encryptText(cfg.token) : "",
    password: cfg.password ? encryptText(cfg.password) : "",
  };
  await db.insert(appSettings).values({ key: "fhir", value: JSON.stringify(stored) }).onConflictDoUpdate({
    target: appSettings.key,
    set: { value: JSON.stringify(stored) },
  });
}

/** FHIR ucu: kimlik başlığını ve zaman aşımını uygular. */
export function fhirHeaders(cfg: FhirConfig): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/fhir+json", "Content-Type": "application/fhir+json" };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  else if (cfg.username) {
    h.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`, "utf8").toString("base64")}`;
  }
  return h;
}

/** `?_sort=-_lastUpdated&type=ServiceRequest` biçimde çekim sarmalayıcısı. */
export function fhirQueryUrl(baseUrl: string, type: "ServiceRequest" | "ImagingStudy" | "DiagnosticReport" | "Patient", extra: Record<string, string> = {}): string {
  const u = new URL(baseUrl);
  u.searchParams.set("_count", "200");
  u.searchParams.set("_pretty", "false");
  u.searchParams.set("_sort", "-_lastUpdated");
  if (type !== "Patient") u.searchParams.set("type", type);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

/** FHIR serisini çeker (ham JSON); HTTP 401/403/5xx hataları ayrıştırılır. */
export async function fetchFhirRaw(cfg: FhirConfig, url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...fhirHeaders(cfg), ...(init?.headers ?? {}) }, signal: controller.signal });
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "FHIR zaman aşımına uğradı" : `FHIR'e ulaşılamadı: ${String(e)}`;
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error("FHIR kimlik reddedildi (token/parola geçersiz).");
  if (res.status === 403) throw new Error("FHIR'e erişim izni yok (scope/token yetkisiz).");
  if (!res.ok) throw new Error(`FHIR ${res.status} hatası.`);
  return res.json();
}

/** FHIR serisini çeker ve sipariş/çalışma adaylarına ayrıştırır. */
export async function fetchFhirBundle(cfg: FhirConfig, url: string, init?: RequestInit): Promise<FhirOrderPayload[]> {
  const raw = await fetchFhirRaw(cfg, url, init);
  return fhirResourcesToOrders(raw);
}

/** Sipariş/çalışma yükünü çalışma kaydına uygular; aksesuarlar döndürülür. */
export async function applyFhirOrders(orders: FhirOrderPayload[], cfg: FhirConfig): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
  const { upsertStudy } = await import("@/lib/server/studyRepo");
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const o of orders) {
    if (!o.patientId) {
      skipped++;
      errors.push(`${o.fhirSource}: hasta kimliği yok`);
      continue;
    }
    const modality = o.modality || cfg.defaultModality;
    if (!modality) {
      skipped++;
      errors.push(`${o.fhirSource}: modalite yok`);
      continue;
    }
    try {
      const r = await upsertStudy(
        {
          studyUid: o.studyUid,
          patientName: o.patientName,
          patientId: o.patientId,
          accession: o.accessionNumber,
          modality,
          bodyPart: o.bodyPart,
          seriesDescription: o.description,
          ...(o.studyDate ? { studyDate: o.studyDate } : {}),
        },
        "fhir"
      );
      if (r.created) created++;
      else updated++;
    } catch (e) {
      errors.push(`${o.fhirSource}: ${String(e)}`);
    }
  }
  return { created, updated, skipped, errors };
}
