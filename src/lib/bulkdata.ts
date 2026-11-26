/**
 * DICOMweb metadata-içi piksel erişimi (e-wado-frame).
 *
 * DICOMweb standardı büyük değerleri (PixelData dahil) metadata içinde
 * `BulkDataURI` referansı ile verir. OHIF gibi görüntüleyiciler
 * piksel verisini instance yerine bu URI'den çeker (bant genişliği ve bellek).
 *
 * Bu modül İSTEMCİ ve SUNUCU ortamında çalışır; yalnız saf işlevleri içerir:
 *   - metadata JSON'unun şeklini doğrulama
 *   - piksel etiketini (7FE0,0010) bulma: BulkDataURI ya da InlineBinary
 *   - göreli URI'yi metadata tabanına göre çözme
 * Ağ çağrısı ve SSRF koruması sunucu tarafında (`src/lib/server/pacs.ts`) yapılır.
 */

export const PIXEL_DATA_TAG = "7FE0,0010";
export const METADATA_ACCEPT = "application/dicom+json";
export const BULKDATA_ACCEPT = "application/octet-stream";

export interface DicomJsonElement {
  vr?: string;
  Value?: unknown[];
  InlineBinary?: string;
  BulkDataURI?: string;
  ValueType?: string;
}
export type DicomJsonInstance = Record<string, DicomJsonElement>;

export type PixelSource =
  | { kind: "bulkdata"; uri: string; vr: string }
  | { kind: "inline-binary"; vr: string; base64: string }
  | { kind: "missing" }
  | { kind: "unsupported"; vr: string; reason: string };

/** metadata yanıtı: tek instance nesnesi ya da instance dizisi — ikisini de kabul eder. */
export function firstInstance(metadata: unknown): DicomJsonInstance {
  const inst = Array.isArray(metadata) ? metadata[0] : metadata;
  if (!inst || typeof inst !== "object" || Array.isArray(inst)) {
    throw new Error("metadata JSON'u DICOMweb yanıtı değil (instance nesnesi bekleniyor).");
  }
  return inst as DicomJsonInstance;
}

/** Göreli URI'yi metadata URL'sine göre çözer; şema http/https değilse hata. */
export function resolveBulkDataUri(uri: string, base: string): string {
  if (typeof uri !== "string" || uri.trim() === "") throw new Error("Boş BulkDataURI.");
  let u: URL;
  try {
    u = new URL(uri.trim(), base);
  } catch {
    throw new Error(`BulkDataURI çözümlenemedi: ${uri.slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`BulkDataURI http/https olmalı (${u.protocol}//…).`);
  }
  // Kullanıcı adı/parola taşıyan URI reddedilir (kimlik bilgisi sızdırma/SSRF hilesi).
  if (u.username || u.password) throw new Error("BulkDataURI kullanıcı bilgisi içeremez.");
  return u.toString();
}

/** Piksel verisinin kaynağını döndürür; ağa hiç çıkmaz. */
export function extractPixelSource(metadata: unknown, metadataUrl: string): PixelSource {
  const inst = firstInstance(metadata);
  const el = inst[PIXEL_DATA_TAG];
  if (!el || typeof el !== "object") return { kind: "missing" };
  const vr = typeof el.vr === "string" ? el.vr : "";
  if (typeof el.BulkDataURI === "string" && el.BulkDataURI.trim() !== "") {
    return { kind: "bulkdata", uri: resolveBulkDataUri(el.BulkDataURI, metadataUrl), vr: vr || "OB" };
  }
  if (typeof el.InlineBinary === "string" && el.InlineBinary.length > 0) {
    return { kind: "inline-binary", vr: vr || "OB", base64: el.InlineBinary };
  }
  if (Array.isArray(el.Value) && el.Value.length > 0) {
    return { kind: "unsupported", vr, reason: "PixelData Value dizisi olarak inline; çözülemiyor — instance WADO kullanın." };
  }
  return { kind: "missing" };
}

/** InlineBinary (base64) → baytlar. Bozuk base64'te hata fırlatır. */
export function decodeInlineBinary(base64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
