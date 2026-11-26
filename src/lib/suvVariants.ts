/**
 * SUV varyantları: SUVlbm (yağsız kütle) ve SUVbsa (vücut yüzey alanı).
 *
 * Neden: yalnız SUVbw (vücut ağırlığı) hesaplanıyordu; obez hastalarda SUVbw
 * değeri şişer. Literatürde SUVlbm (Janmahasatian) ve SUVbsa (Du Bois) yaygın
 * kullanılır. Bu modül formülleri saf fonksiyon olarak tutar; DICOM'dan boy/cinsiyet
 * okunamazsa hesaplanmaz ve neden yazılır (tahmin yürütülmez).
 *
 * Kaynaklar (formüller):
 *  - Janmahasatian ve ark., Clin Pharmacokinet 2005 (yağsız kütle, cinsiyete özgü).
 *  - Du Bois & Du Bois, Arch Intern Med 1916 (vücut yüzey alanı).
 *  - QIBA/DICOM PS3.3 C.8.9.1 (SUV tanımı: aktivite konsantrasyonu / normalize doz).
 *
 * Sınır: bu bir ölçüm değil, hesaplanmış tahmindir; çocuklarda/ampute hastalarda
 * Janmahasatian formülü doğrulanmamıştır.
 */
import type { SuvVariantInfo } from "./types";

export type Sex = "M" | "F" | "unknown";

/** DICOM Patient Sex (0010,0040) → M/F/bilinmiyor. */
export function parseSex(raw: string | undefined): Sex {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "M" || v === "MALE" || v === "E" || v === "ERKEK") return "M";
  if (v === "F" || v === "FEMALE" || v === "K" || v === "KADIN") return "F";
  return "unknown";
}

/**
 * DICOM Patient Size (0010,1020) yorumu. Etiket DS tipindedir ve standartta
 * **metre** beklenir; fakat pratikte cm olarak yazan cihazlar var. 0,5–2,5 arası
 * metre, 50–250 arası cm kabul edilir; dışındaki değer "bilinmiyor" sayılır.
 * Yorum yapıldığında `assumed` alanında açıkça yazılır.
 */
export function heightFromPatientSize(raw: number | undefined | null): { heightCm: number | null; assumed: "m" | "cm" | null } {
  if (raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0) return { heightCm: null, assumed: null };
  if (raw >= 0.5 && raw <= 2.5) return { heightCm: Math.round(raw * 1000) / 10, assumed: "m" };
  if (raw >= 50 && raw <= 250) return { heightCm: raw, assumed: "cm" };
  return { heightCm: null, assumed: null };
}

/** Yağsız kütle (kg, Janmahasatian). Eksik/geçersiz girdide null. */
export function leanBodyMassKg(weightKg: number, heightCm: number, sex: Sex): number | null {
  if (!(weightKg > 0) || !(heightCm > 0) || (sex !== "M" && sex !== "F")) return null;
  const hM = heightCm / 100;
  const bmi = weightKg / (hM * hM);
  const lbm = sex === "M" ? (9270 * weightKg) / (6680 + 216 * bmi) : (9270 * weightKg) / (8780 + 244 * bmi);
  return Number.isFinite(lbm) && lbm > 0 ? lbm : null;
}

/** Vücut yüzey alanı (m², Du Bois). */
export function bodySurfaceAreaM2(weightKg: number, heightCm: number): number | null {
  if (!(weightKg > 0) || !(heightCm > 0)) return null;
  const bsa = 0.007184 * Math.pow(weightKg, 0.425) * Math.pow(heightCm, 0.725);
  return Number.isFinite(bsa) && bsa > 0 ? bsa : null;
}

export interface SuvVariantInputs {
  weightKg: number;
  heightCm?: number | null;
  sex?: Sex;
  /** Toplam enjekte doz (Bq). */
  doseBq: number;
  halfLifeS: number;
  /** Enjeksiyondan referans zamana geçen süre (s). */
  deltaS: number;
}

function decayedDose(doseBq: number, halfLifeS: number, deltaS: number): number {
  return doseBq * Math.pow(2, -deltaS / halfLifeS);
}

/** SUVlbm çarpanı: SUV_lbm = piksel(Bq/mL) × çarpan. */
export function suvLbmFactor(i: SuvVariantInputs): number | null {
  if (!(i.doseBq > 0) || !(i.halfLifeS > 0)) return null;
  const lbm = leanBodyMassKg(i.weightKg, i.heightCm ?? 0, i.sex ?? "unknown");
  if (lbm === null) return null;
  const decayed = decayedDose(i.doseBq, i.halfLifeS, i.deltaS);
  const f = (lbm * 1000) / decayed;
  return Number.isFinite(f) && f > 0 ? f : null;
}

/** SUVbsa çarpanı: SUV_bsa = piksel(Bq/mL) × çarpan. */
export function suvBsaFactor(i: SuvVariantInputs): number | null {
  if (!(i.doseBq > 0) || !(i.halfLifeS > 0)) return null;
  const bsa = bodySurfaceAreaM2(i.weightKg, i.heightCm ?? 0);
  if (bsa === null) return null;
  const decayed = decayedDose(i.doseBq, i.halfLifeS, i.deltaS);
  const f = (bsa * 1000) / decayed;
  return Number.isFinite(f) && f > 0 ? f : null;
}

/** İki varyantı tek çağrıda üretir; hesaplanamayan varyantta neden `note` içindedir. */
export function suvVariants(i: SuvVariantInputs): { lbm: SuvVariantInfo; bsa: SuvVariantInfo } {
  const heightCm = i.heightCm ?? null;
  const sex = i.sex ?? "unknown";
  const hasHeight = heightCm !== null && heightCm > 0;
  const lbmKg = hasHeight ? leanBodyMassKg(i.weightKg, heightCm, sex) : null;
  const bsaM2 = hasHeight ? bodySurfaceAreaM2(i.weightKg, heightCm) : null;

  const lbm: SuvVariantInfo = {
    factor: suvLbmFactor(i),
    lbmKg: lbmKg === null ? null : Math.round(lbmKg * 10) / 10,
    note: lbmKg === null
      ? !hasHeight ? "Hasta boyu yok: SUVlbm hesaplanamadı." : "Cinsiyet bilinmiyor: SUVlbm hesaplanamadı."
      : `SUVlbm · ${(lbmKg).toFixed(1)} kg yağsız kütle (Janmahasatian, ${sex === "M" ? "erkek" : "kadın"})`,
  };
  const bsa: SuvVariantInfo = {
    factor: suvBsaFactor(i),
    bsaM2: bsaM2 === null ? null : Math.round(bsaM2 * 100) / 100,
    note: bsaM2 === null ? "Hasta boyu yok: SUVbsa hesaplanamadı." : `SUVbsa · ${bsaM2.toFixed(2)} m² vücut yüzey alanı (Du Bois)`,
  };
  return { lbm, bsa };
}
