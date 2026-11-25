import type { StudyRow } from "./types";

/** Kategori adları analiz motorunun mevcut skorlarına dayanır; tanı değildir. */
export function triageGroup(s: Pick<StudyRow, "triageLevel" | "triageScore" | "aiEngine">): "kritik" | "yuksek" | "diger" | "analiz-yok" {
  if (!s.triageLevel || !s.aiEngine || s.aiEngine === "no-model" || s.aiEngine === "image-review" || !Number.isFinite(s.triageScore)) return "analiz-yok";
  if (s.triageScore > 0.8) return "kritik";
  if (s.triageScore > 0.6) return "yuksek";
  return "diger";
}

export function triageCounts(rows: StudyRow[]) {
  const counts = { kritik: 0, yuksek: 0, diger: 0, "analiz-yok": 0 };
  for (const row of rows) counts[triageGroup(row)]++;
  return counts;
}
