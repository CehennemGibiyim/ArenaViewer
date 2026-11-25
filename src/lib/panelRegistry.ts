import { useSyncExternalStore } from "react";
import type { SeriesData } from "./types";
import { intersectLine, planeOf, sameFrame, sliceIndexAtPoint, type V3 } from "./planes";

/**
 * Ekrandaki görüntü panellerinin (ana + referans) hangi seri/kesiti gösterdiği;
 * çapraz referans çizgileri ve 3B imleç (konuma atlama) için.
 */
export interface PanelInfo {
  id: string;
  series: SeriesData | null;
  slice: number;
  label: string;
  /** Kesit değişikliği talebini panele iletmek için geri çağırma (2B/3B imleç). */
  setSlice?: (n: number) => void;
}

const panels = new Map<string, PanelInfo>();
let version = 0;
let refLinesOn = true;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((l) => l()); };

export function registerPanel(info: PanelInfo) {
  const old = panels.get(info.id);
  // Not: setSlice geri çağırma her render'da yeniden oluşabileceğinden eşitlikte sayılmaz;
  // panel bilgisi (seri/kesit/etiket) değişmedikçe kayıt durur.
  if (old && old.series === info.series && old.slice === info.slice && old.label === info.label) return;
  panels.set(info.id, info);
  bump();
}

/**
 * 3B imleç: `fromId` panelinde hasta koordinatındaki bir noktaya tıklanınca,
 * aynı Frame of Reference'i paylaşan DİĞER panellerin en yakın kesidine atlar.
 * Dönüş: kesidi güncellenen panel sayısı. Geometrisi/çerçevesi olmayan paneller atlanır.
 */
export function jumpToPatient(fromId: string, P: V3): number {
  const from = panels.get(fromId);
  if (!from || !from.series) return 0;
  let changed = 0;
  for (const p of panels.values()) {
    if (p.id === fromId || !p.series || !p.setSlice) continue;
    if (!sameFrame(from.series, p.series)) continue;
    const idx = sliceIndexAtPoint(p.series, P);
    if (idx !== null && idx !== p.slice) { p.setSlice(idx); changed++; }
  }
  return changed;
}
export function unregisterPanel(id: string) { if (panels.delete(id)) bump(); }
export function setRefLines(on: boolean) { if (refLinesOn !== on) { refLinesOn = on; bump(); } }
export const getRefLines = () => refLinesOn;
export function usePanelRegistry() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version, () => 0);
}

export interface RefLine { a: { x: number; y: number }; b: { x: number; y: number }; label: string; color: string }
const COLORS = ["#22d3ee", "#fbbf24", "#f472b6", "#a3e635", "#fb923c"];

/** `self` panelinin kesitine, DİĞER panellerin kesit düzlemlerinin kesişim doğruları. */
export function refLinesFor(selfId: string, series: SeriesData | null, slice: number): RefLine[] {
  if (!refLinesOn || !series) return [];
  const t = planeOf(series, slice);
  if (!t) return [];
  const out: RefLine[] = [];
  let ci = 0;
  for (const p of panels.values()) {
    if (p.id === selfId || !p.series || p.series.id === series.id && p.slice === slice) continue;
    const color = COLORS[ci++ % COLORS.length];
    if (!sameFrame(series, p.series)) continue;
    const o = planeOf(p.series, Math.min(p.slice, p.series.slices.length - 1));
    if (!o) continue;
    const l = intersectLine(t, o);
    if (l) out.push({ ...l, label: p.label, color });
  }
  return out;
}
