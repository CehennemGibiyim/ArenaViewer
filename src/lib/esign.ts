/**
 * Elektronik imza kaydı (r-esign).
 *
 * SINIR: Bu modül yalnızca **kayıt ve doğrulama** altyapısıdır; nitelikli
 * elektronik imza (NES) üretmez. NES, 5070 sayılı Kanun kapsamında akreditasyonlu
 * bir sağlayıcı (mobil imza, kart okuyucu) gerektirir; entegre edilene dek her
 * kayıt "nesne nitelikli DEĞİLDİR" olarak etiketlenir.
 */

export type SignatureMethod = "hesap-parola-mfa" | "nes-nitelikli" | "dahili-anahtar";

export const SIGNATURE_METHODS: { id: SignatureMethod; label: string; qualified: boolean }[] = [
  { id: "hesap-parola-mfa", label: "Hesap (parola + MFA) ile oturum onayı", qualified: false },
  { id: "dahili-anahtar", label: "Kurum içi anahtar/kaynaksız yerel onay (demo)", qualified: false },
  { id: "nes-nitelikli", label: "Nitelikli elektronik imza (NES) — sağlayıcı gerekli", qualified: true },
];

/** Yöntemin NES kapsamında nitelikli sayılıp sayılmayacağı. */
export function isQualifiedMethod(m: string): boolean {
  return SIGNATURE_METHODS.find((x) => x.id === m)?.qualified === true;
}

export interface SignatureRecordInput {
  reportId: number;
  studyUid: string;
  contentHash: string;
  signerName: string;
  signerRegNo?: string;
  institution?: string;
  method: SignatureMethod;
  version: number;
}

export interface SignatureRecord extends SignatureRecordInput {
  signedAt: string;
  algo: "SHA-256";
}

/** Kaydın kanonik (sabit sıralı) temsili — hash karşılaştırmaları ve denetim için. */
export function canonicalSignature(r: SignatureRecord): string {
  const ordered: Record<string, unknown> = {};
  const flat = r as unknown as Record<string, unknown>;
  for (const k of Object.keys(r).sort()) ordered[k] = flat[k];
  return JSON.stringify(ordered);
}

export function buildSignatureRecord(input: SignatureRecordInput): SignatureRecord {
  return {
    ...input,
    algo: "SHA-256",
    signedAt: new Date().toISOString(),
  };
}

/** Hash ve yöntem bütünlüğü denetimi. */
export function verifySignatureRecord(r: SignatureRecord, expectedContentHash: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(r.contentHash)) return false;
  if (r.contentHash.toLowerCase() !== String(expectedContentHash).toLowerCase()) return false;
  if (!SIGNATURE_METHODS.some((m) => m.id === r.method)) return false;
  return r.algo === "SHA-256" && Number.isFinite(r.reportId) && !!r.signedAt;
}

/** Rapor satırına yazılacak insan okunur imza notu. */
export function signatureNote(r: SignatureRecord): string {
  const q = isQualifiedMethod(r.method)
    ? "Nitelikli elektronik imza (NES)."
    : "Nitelikli elektronik imza (NES) DEĞİLDİR; içerik SHA-256 ile mühürlenir ve imza sahibinin kimliği için oturum bilgisi kullanılır.";
  return `${r.signerName}${r.signerRegNo ? ` (${r.signerRegNo})` : ""} · ${r.method} · ${r.signedAt} · ${q}`;
}
