import type { GapStatus } from "./gapAnalysis";

/** Sayımlar kayıt durumlarına dayanır; kısmi durumun gerçek yüzdesi bilinmez. */
export function gapProgress(items: readonly { status: GapStatus }[]) {
  const counts = { var: 0, kismi: 0, yok: 0 };
  for (const item of items) counts[item.status]++;
  const total = items.length;
  const percent = (value: number) => total ? Math.round(100 * value / total) : 0;
  return {
    ...counts,
    total,
    completedPercent: percent(counts.var),
    open: counts.kismi + counts.yok,
    // Kısmi maddelere 0,5 veren karşılaştırma göstergesi; ölçülmüş iş oranı değil.
    indexPercent: percent(counts.var + 0.5 * counts.kismi),
  };
}
