/**
 * CTP perfüzyon — cSVD (circular/truncated SVD) dekonvolüsyonu ve otomatik AIF seçimi.
 *
 * `stroke.ts` içindeki `ctpSummary` yalnızca eğri özelliklerine (zirve, AUC)
 * bakar; gerçek CBF/CBV/MTT/Tmax için doku eğrisinin arteriyel giriş
 * fonksiyonu (AIF) ile DEKONVOLÜSYONU gerekir. Bu modül onu yapar:
 *
 *   c(t) = CBF · (a * R)(t)      →   h = A⁻¹c  (h: akış ölçekli impuls yanıtı)
 *   CBF = max(h),  CBV = ∫h dt,  MTT = CBV / CBF,  Tmax = argmax(R)
 *
 * Tekil değer kesme (truncation) gürültüyü bastırır (SVD dekonvolüsyonu).
 *
 * SINIRLAR (kullanıcıya da yazılır): değerler RÖLATİF'tir (mutlak mL/100 g/dk
 * vermek için dansite→konsantrasyon (ρ) kalibrasyonu ve venöz çıkış ölçümü
 * gerekir). Hareket düzeltmesi ve kan beyin bariyeri geçirgenliği modeli yoktur.
 * Klinik karar aracı DEĞİLDİR.
 */

export interface Curve {
  /** Saniye, artan */
  t: number[];
  /** HU (veya zıt) yoğunluk */
  v: number[];
}

export interface DeconvOptions {
  /**
   * Tekil değer kesme oranı (0–1). Kesme gürültüyü bastırır ama MTT'yi YUKARI
   * yanlı yapar; gürültüsüz/az gürültülü eğrilerde 0 (tam ters çözüm) en doğru
   * sonucu verir. Varsayılan 0.05; gürültülü veride 0,05–0,15 önerilir.
   */
  truncation?: number;
  /** Eğri tabanı (baseline) çıkarılsın mı. Varsayılan true. */
  subtractBaseline?: boolean;
  /** Negatif salınımlar sıfırlansın mı (cSVD sonrası standart). Varsayılan true. */
  clampNegative?: boolean;
}

export interface DeconvResult {
  /** Örnekleme aralığı (sn) */
  dt: number;
  /** Akış ölçekli impuls yanıtı h(t) */
  h: number[];
  /** Kalıntı fonksiyonu R(t) = 1 - ∫h/CBV (0–1) */
  residue: number[];
  /** Rölatif CBF = max h */
  cbf: number;
  /** Rölatif CBV = ∫h dt */
  cbv: number;
  /** Ortalama geçiş süresi (sn) = CBV/CBF */
  mttSec: number;
  /**
   * Tmax benzeri gecikme (sn): kalıntı fonksiyonu R(t) ilk kez 0.9'un altına
   * indiği an — bolus geliş gecikmesi. (R, tanımı gereği t=0'da 1'e yakın başlar;
   * bu nedenle "tepe zamanı" değil "düşüş başlangıcı" kullanılır.)
   */
  tmaxSec: number;
  /** Kesilen tekil değer sayısı / toplam */
  truncated: string;
  caveat: string;
}

const EPS = 1e-12;

/** İlk `upto` örneğin medyanı (kontrast öncesi taban için). */
function medianOf(v: number[], upto: number): number {
  const n = Math.max(1, Math.min(v.length, upto));
  const head = [...v.slice(0, n)].sort((a, b) => a - b);
  return head[Math.floor(head.length / 2)] ?? 0;
}

/**
 * Kontrast geliş anı: AIF'in ilk %10 yükseldiği örnek. Taban (baseline) yalnızca
 * bu andan ÖNCEKİ örneklerden hesaplanır — ilk %20 dilim kullanılırsa yükselişin
 * başlangıcı da tabana karışır ve perfüzyon değerleri olduğundan düşük çıkar.
 */
export function bolusOnset(curve: Curve): number {
  const n = Math.max(1, Math.min(curve.t.length, curve.v.length));
  const b = medianOf(curve.v, Math.max(1, Math.min(3, n)));
  let peak = -Infinity;
  for (let i = 0; i < n; i++) if (curve.v[i] > peak) peak = curve.v[i];
  const amp = peak - b;
  if (!(amp > 0)) return 1;
  const thr = b + 0.1 * amp;
  for (let i = 0; i < n; i++) if (curve.v[i] >= thr) return Math.max(1, i);
  return 1;
}

/** Simetrik matrisin özayrışımı (Jacobi rotasyonları). Küçük N (≤ 128) için yeterli. */
export function jacobiEigen(a0: number[][], maxSweeps = 60): { values: number[]; vectors: number[][] } {
  const n = a0.length;
  const a = a0.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off <= EPS) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < EPS) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

/**
 * SVD (kesilmiş) dekonvolüsyon: c = dt · A · h, A Toeplitz (AIF).
 * h = V Λ⁻¹ Vᵀ (dt·Aᵀc), λ < trunc·λmax olan bileşenler atılır.
 */
export function deconvolve(tissue: Curve, aif: Curve, opts: DeconvOptions = {}): DeconvResult {
  const trunc = Math.min(0.9, Math.max(0, opts.truncation ?? 0));
  const n = Math.min(tissue.t.length, tissue.v.length, aif.v.length);
  const dt = n > 1 ? (tissue.t[n - 1] - tissue.t[0]) / (n - 1) : 1;
  const caveat = "Rölatif perfüzyon değerleri (cSVD dekonvolüsyonu). Mutlak mL/100 g/dk için dansite kalibrasyonu ve venöz çıkış ölçümü gerekir; klinik karar aracı değildir.";

  if (n < 3 || !(dt > 0)) {
    return { dt: dt > 0 ? dt : 1, h: new Array(Math.max(0, n)).fill(0), residue: [], cbf: 0, cbv: 0, mttSec: 0, tmaxSec: 0, truncated: "0/0", caveat };
  }

  const sub = opts.subtractBaseline !== false;
  const onset = Math.min(n - 1, bolusOnset(aif));
  const bT = sub ? medianOf(tissue.v.slice(0, n), onset) : 0;
  const bA = sub ? medianOf(aif.v.slice(0, n), onset) : 0;
  const c = tissue.v.slice(0, n).map((x) => Math.max(0, x - bT));
  const a = aif.v.slice(0, n).map((x) => Math.max(0, x - bA));

  // Aᵀc (Toeplitz çarpımı) — A[i][j] = a[i-j], j ≤ i
  const atc = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) atc[j] += a[i - j] * c[i];
  const scale = dt;
  for (let j = 0; j < n; j++) atc[j] *= scale;

  // AᵀA (simetrik) — (AᵀA)[j][k] = Σ_i a[i-j]a[i-k], i ≥ max(j,k)
  const ata: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    for (let k = j; k < n; k++) {
      let s = 0;
      for (let i = k; i < n; i++) s += a[i - j] * a[i - k];
      const val = s * scale * scale;
      ata[j][k] = val;
      ata[k][j] = val;
    }
  }

  const { values, vectors } = jacobiEigen(ata);
  const lmax = Math.max(...values.map((x) => Math.abs(x)), 0);
  const cut = lmax * trunc;
  const h = new Array(n).fill(0);
  let kept = 0;
  for (let m = 0; m < n; m++) {
    if (values[m] <= cut || values[m] <= EPS) continue; // küçük tekil değer → gürültü
    kept++;
    let proj = 0;
    for (let i = 0; i < n; i++) proj += vectors[i][m] * atc[i];
    const coef = proj / values[m];
    for (let i = 0; i < n; i++) h[i] += coef * vectors[i][m];
  }

  if (opts.clampNegative !== false) for (let i = 0; i < n; i++) if (h[i] < 0) h[i] = 0;
  const cbf = Math.max(...h, 0);
  const cbv = h.reduce((s, x) => s + x, 0) * dt;
  const mttSec = cbf > EPS ? cbv / cbf : 0;

  // Kalıntı fonksiyonu ve Tmax
  const residue: number[] = new Array(n).fill(0);
  if (cbv > EPS) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += h[i] * dt;
      residue[i] = Math.max(0, Math.min(1, 1 - acc / cbv));
    }
  }
  let tmaxSec = 0;
  const drop = residue.findIndex((x) => x < 0.9);
  if (drop > 0) tmaxSec = tissue.t[drop] - tissue.t[0];

  return { dt, h, residue, cbf, cbv, mttSec, tmaxSec, truncated: `${kept}/${n}`, caveat };
}

/**
 * Otomatik AIF seçimi (klinik yazılımların yaptığı basit eleme):
 *  - erken ve yüksek zirve,
 *  - yeterli genlik (gürültü değil),
 *  - makul genişlik (çok geniş eğri venöz/geç faz).
 */
export function selectAif(curves: Curve[]): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    const n = Math.min(c.t.length, c.v.length);
    if (n < 5) continue;
    const b = medianOf(c.v.slice(0, n), Math.min(n, Math.max(1, bolusOnset(c))));
    let peak = -Infinity, iPeak = 0;
    for (let k = 0; k < n; k++) if (c.v[k] > peak) { peak = c.v[k]; iPeak = k; }
    const amp = peak - b;
    if (!(amp > 0)) continue;
    // Yarım yükseklik genişliği
    const half = b + amp / 2;
    let k1 = iPeak, k2 = iPeak;
    while (k1 > 0 && c.v[k1] > half) k1--;
    while (k2 < n - 1 && c.v[k2] > half) k2++;
    const width = (c.t[k2] - c.t[k1]) || 1e-6;
    const tPeak = c.t[iPeak] - c.t[0];
    // Skor: genlik ↑, erken zirve ↑, dar eğri ↑
    const score = (amp / 100) * (1 / (1 + tPeak / 10)) * (1 / (1 + width / 8));
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

export interface CtpThresholds {
  /** Core: rölatif CBF eşiği (normal dokuya göre) */
  coreCbf: number;
  /** Penumbra: Tmax eşiği (sn) */
  penumbraTmax: number;
}

export const CTP_THRESHOLDS: CtpThresholds = { coreCbf: 0.3, penumbraTmax: 6 };

export interface CtpSvdSummary {
  aifIndex: number;
  /** Orijinal indekslerle doku sonuçları */
  lesions: { index: number; cbf: number; cbv: number; mttSec: number; tmaxSec: number }[];
  /** Referans (normal) dokuya göre rölatif değerler */
  relative: { index: number; relCbf: number; relCbv: number }[];
  coreIndices: number[];
  penumbraIndices: number[];
  mismatchRatio: number | null;
  note: string;
}

/**
 * Çok bölgeli özet: AIF otomatik seçilir, her doku eğrisi dekonvolüsyona girer,
 * referans bölge (en yüksek CBF'li doku) normal kabul edilir; core/penumbra
 * eşikleri buna göre hesaplanır.
 */
export function ctpSvdSummary(curves: Curve[], ref?: { coreCbf?: number; penumbraTmax?: number }): CtpSvdSummary | null {
  if (curves.length < 2) return null;
  const aifIndex = selectAif(curves);
  if (aifIndex < 0) return null;
  const aif = curves[aifIndex];
  const lesions: CtpSvdSummary["lesions"] = [];
  curves.forEach((c, i) => {
    if (i === aifIndex) return;
    const d = deconvolve(c, aif);
    lesions.push({ index: i, cbf: d.cbf, cbv: d.cbv, mttSec: d.mttSec, tmaxSec: d.tmaxSec });
  });
  if (!lesions.length) return null;

  const refCbf = Math.max(...lesions.map((l) => l.cbf));
  const refCbv = Math.max(...lesions.map((l) => l.cbv));
  const coreCbf = ref?.coreCbf ?? CTP_THRESHOLDS.coreCbf;
  const penumbraTmax = ref?.penumbraTmax ?? CTP_THRESHOLDS.penumbraTmax;

  const relative = lesions.map((l) => ({
    index: l.index,
    relCbf: refCbf > 0 ? l.cbf / refCbf : 0,
    relCbv: refCbv > 0 ? l.cbv / refCbv : 0,
  }));
  const coreIndices = relative.filter((r) => r.relCbf < coreCbf).map((r) => r.index);
  const penumbraIndices = lesions.filter((l) => l.tmaxSec >= penumbraTmax && !coreIndices.includes(l.index)).map((l) => l.index);
  const mismatchRatio = coreIndices.length > 0 ? penumbraIndices.length / coreIndices.length : penumbraIndices.length > 0 ? null : 0;

  return {
    aifIndex,
    lesions,
    relative,
    coreIndices,
    penumbraIndices,
    mismatchRatio,
    note:
      `AIF otomatik seçildi (#${aifIndex + 1}). Core: röl. CBF < ${coreCbf} (${coreIndices.length} bölge); ` +
      `penumbra: Tmax ≥ ${penumbraTmax} sn (${penumbraIndices.length} bölge). Ölçümler rölatiftir, hekim doğrulaması gerekir.`,
  };
}

/**
 * Yapıştırılan eğrileri çözer. Biçim (satır başına bir bölge):
 *   `ad | t1,t2,t3 | v1,v2,v3`
 * Boş satırlar ve `#` ile başlayan yorumlar yok sayılır.
 */
export function parseCtpCurves(text: string): Curve[] {
  const out: Curve[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const tn = parts[1].split(/[\s;,]+/).filter(Boolean).map(Number);
    const vn = parts[2].split(/[\s;,]+/).filter(Boolean).map(Number);
    if (tn.length < 3 || tn.length !== vn.length || tn.some((x) => !Number.isFinite(x)) || vn.some((x) => !Number.isFinite(x))) continue;
    out.push({ t: tn, v: vn });
  }
  return out;
}

/** Paneli/raporu besleyen kısa metin. */
export function ctpSvdText(s: CtpSvdSummary): string {
  const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
  const rel = new Map(s.relative.map((r) => [r.index, r]));
  const rows = s.lesions.map((l) => {
    const r = rel.get(l.index);
    return `#${l.index + 1}) rCBF ${fmt((r?.relCbf ?? 0) * 100, 0)}% · rCBV ${fmt((r?.relCbv ?? 0) * 100, 0)}% · MTT ${fmt(l.mttSec)} sn · Tmax ${fmt(l.tmaxSec)} sn`;
  });
  return [
    `CTP (cSVD): ${rows.join(" | ")}`,
    `Core adayı: ${s.coreIndices.length ? s.coreIndices.map((i) => `#${i + 1}`).join(", ") : "yok"} · Penumbra adayı: ${s.penumbraIndices.length ? s.penumbraIndices.map((i) => `#${i + 1}`).join(", ") : "yok"}`,
    "Ölçümler rölatiftir (dekonvolüsyon); tanı ve tedavi kararı hekim değerlendirmesine tabidir.",
  ].join("\n");
}
