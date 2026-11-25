import { coercePacsConfig, unsealPacsConfig } from "./pacs";
import { getSetting } from "./settings";
import { DEFAULT_PACS, trimRoot, type PacsConfig } from "@/lib/pacsPresets";

/**
 * PACS yapılandırmasının veritabanından okunması (app_settings → `pacs` anahtarı).
 * Ayrı dosyada: DICOMweb istemcisi (pacs.ts) veritabanı bilmez, böylece testler
 * DB olmadan çalışır.
 *
 * Geriye dönük uyumluluk: `pacs` kaydı yoksa eski `pacsBaseUrl` ayarı kullanılır.
 */
export async function loadPacsConfig(): Promise<PacsConfig | null> {
  const raw = (await getSetting("pacs", "")).trim();
  if (raw) {
    try {
      const parsed = coercePacsConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      /* bozuk kayıt: aşağıda eski ayara düşülür */
    }
  }
  const legacy = trimRoot(await getSetting("pacsBaseUrl", ""));
  if (legacy && /^https?:\/\//i.test(legacy)) {
    return { ...DEFAULT_PACS, name: "PACS", kind: "custom", qidoRoot: legacy, notes: "Adres 'pacsBaseUrl' (eski) ayarından okunuyor." };
  }
  return null;
}

/** Şifreli alanları çözer; yönetim paneli bunu `publicPacsConfig` ile sunar. */
export const sealedPacsConfig = unsealPacsConfig;

/**
 * MWL ek yapılandırması (`app_settings` → `pacs.mwl`):
 * `{ "mwlRoot": "https://pacs/dcm4chee-arc/aets/AET/rs", "dimseUrl": "http://127.0.0.1:2580/cfind" }`
 *
 * Ana PACS kaydını değiştirmeye gerek yok: MWL kökü farklı bir AET'te olabilir
 * ve DIMSE C-FIND için ayrı bir köprü süreci (`npm run mwl:cfindproxy`) çalışır.
 * Bozuk/eksik kayıt sessizce yok sayılır (MWL devre dışı kalır, iş istasyonu çalışır).
 */
export async function loadMwlEndpoints(): Promise<{ mwlRoot: string; dimseUrl: string }> {
  const raw = (await getSetting("pacs.mwl", "")).trim();
  if (!raw) return { mwlRoot: "", dimseUrl: "" };
  try {
    const p = JSON.parse(raw) as { mwlRoot?: unknown; dimseUrl?: unknown };
    const clean = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? trimRoot(v.trim()) : "");
    return { mwlRoot: clean(p.mwlRoot), dimseUrl: clean(p.dimseUrl) };
  } catch {
    return { mwlRoot: "", dimseUrl: "" };
  }
}
