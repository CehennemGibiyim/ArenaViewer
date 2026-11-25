/** Geometri kontrolü yalnız düzlemsel konum farklarını inceler; tanısal değildir. */
export function analyzeSlicePositions(positions: readonly number[] | undefined) {
  if (!positions || positions.length < 2 || positions.some(p => !Number.isFinite(p))) {
    return { comparable: false, spacing: null, samePlane: 0, irregular: 0 };
  }
  const sorted = [...positions].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((p, i) => p - sorted[i]);
  const samePlane = gaps.filter(d => d <= 0.01).length;
  const nonzero = gaps.filter(d => d > 0.01).sort((a, b) => a - b);
  const spacing = nonzero.length ? nonzero[Math.floor(nonzero.length / 2)] : null;
  // İki aralıktan kesin 'eksik kesit' çıkarımı yapılmaz; en az üç aralık gerekir.
  const irregular = spacing !== null && nonzero.length >= 3
    ? nonzero.filter(d => Math.abs(d - spacing) > spacing * 0.25).length : 0;
  return { comparable: true, spacing, samePlane, irregular };
}
