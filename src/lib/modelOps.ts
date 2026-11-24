/**
 * Model operasyonları yardımcıları (A8): güven kalibrasyonu, beklenti sapması
 * (ECE) ve drift (kullanım/geribildirim oranı kayması) izleme.
 *
 * Bu modül yalnızca **geri bildirim sayımlarına** dayanır; klinik doğrulama
 * (gölge mod, bias/alt grup analizi) yerine geçmez.
 */

export interface ScoreOutcome {
  /** Modelin ürettiği güven/puan (0–1) */
  score: number;
  /** Hekim sonucu: bulgu onaylandı mı */
  approved: boolean;
}

export interface CalibrationBin {
  binLo: number;
  binHi: number;
  n: number;
  meanPred: number | null;
  /** Onaylanan / toplam (o bin içinde) */
  empirical: number | null;
}

/** Güven skorlarını eşit aralıklı binlere ayırıp ampirik oranları hesaplar. */
export function calibrationBins(data: ScoreOutcome[], binCount = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: binCount }, (_, i) => ({
    binLo: i / binCount,
    binHi: (i + 1) / binCount,
    n: 0,
    meanPred: null,
    empirical: null,
  }));
  const sum: number[] = new Array(binCount).fill(0);
  const app: number[] = new Array(binCount).fill(0);

  for (const d of data) {
    if (!Number.isFinite(d.score)) continue;
    const s = Math.max(0, Math.min(1, d.score));
    let idx = Math.floor(s * binCount);
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].n++;
    sum[idx] += s;
    if (d.approved) app[idx]++;
  }
  return bins.map((b, i) => ({
    ...b,
    meanPred: b.n ? sum[i] / b.n : null,
    empirical: b.n ? app[i] / b.n : null,
  }));
}

/** Beklenti sapması: n ağırlıklı |tahmini − ampirik| ortalaması. */
export function expectedCalibrationError(bins: CalibrationBin[]): number | null {
  const used = bins.filter((b) => b.n > 0 && b.meanPred !== null && b.empirical !== null);
  const total = used.reduce((n, b) => n + b.n, 0);
  if (!total) return null;
  return used.reduce((acc, b) => acc + (b.n / total) * Math.abs((b.meanPred as number) - (b.empirical as number)), 0);
}

export type DriftStatus = "yok" | "izle" | "sapma";

export interface DriftResult {
  status: DriftStatus;
  prevRate: number | null;
  curRate: number;
  /** İki oran arası yaklaşık z istatistiği */
  z: number | null;
  note: string;
}

/**
 * Geri bildirim oranındaki kaymayı izler. `prevRate` yoksa yalnız veri biriktirilir.
 * Kural: |z| < 2 → yok; 2–3 → izle; ≥3 → sapma adayı. Küçük örneklemede z güvenilir
 * değildir; bu yüzden minN altında “izle” konumunda kalınır.
 */
export function driftCheck(prevRate: number | null, curRate: number, nCur: number, minN = 30): DriftResult {
  if (prevRate === null || !Number.isFinite(prevRate)) {
    return { status: "yok", prevRate, curRate, z: null, note: "Önceki dönem oranı yok; taban çizgisi olarak bu dönem kullanılacak." };
  }
  const p = (prevRate * minN + curRate * nCur) / (minN + nCur);
  const se = Math.sqrt(Math.max(1e-9, p * (1 - p) * (1 / minN + 1 / Math.max(1, nCur))));
  const z = Math.abs(curRate - prevRate) / se;
  if (z >= 3) return { status: "sapma", prevRate, curRate, z, note: "Geri bildirim oranı belirgin şekilde değişti; model/veri kaynağını denetleyin." };
  if (z >= 2) return { status: "izle", prevRate, curRate, z, note: "Orta düzey kayma; yeni geri bildirimlerle birlikte tekrar değerlendirin." };
  return { status: "yok", prevRate, curRate, z, note: "Kayma sinyali yok." };
}

/** Model kartı/telifi için içerik özeti (SHA-256'ya benzer dağılım; denetim için kayıt anahtarı). */
export function modelFingerprint(fields: Record<string, string>): string {
  const keys = Object.keys(fields).sort();
  const h = [...keys.map((k) => `${k}=${fields[k]}`).join("|")].reduce((a, c) => {
    let x = a;
    for (let i = 0; i < c.length; i++) x = ((x << 5) - x + c.charCodeAt(i)) | 0;
    return x;
  }, 5381);
  return (h >>> 0).toString(16).padStart(8, "0");
}
