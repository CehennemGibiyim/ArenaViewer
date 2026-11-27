"use client";

import { useEffect, useState } from "react";
import Viewport from "./Viewport";
import ViewerErrorBoundary from "./ViewerErrorBoundary";
import { mapSliceByPosition } from "@/lib/geometry";
import { alignmentNote, alignmentTrusted, estimateAlignment, type AlignmentResult } from "@/lib/registration";
import { parallelSeries } from "@/lib/planes";
import type { SeriesData, ToolName } from "@/lib/types";

interface Props {
  allSeries: SeriesData[];
  seriesId: string | null;
  onSeriesChange: (id: string | null) => void;
  primary: SeriesData | null;
  primarySlice: number;
  syncSlice: boolean;
  windowOverride?: { wl: number; ww: number };
  tool: ToolName;
  invert: boolean;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  onPrimarySlice: (i: number) => void;
  label: string;
  panelId?: string;
  /** Görünüm kilidi (v-compare): true ise zoom/pan ana panelden paylaşılır. */
  viewSync?: boolean;
  /** Paylaşılan görünüm (yalnız viewSync açıkken kullanılır). */
  syncZoom?: number;
  syncPan?: { x: number; y: number };
  /** Görünüm kilidi açıkken ref panelindeki zoom/pan değişikliklerini ana panele iletir. */
  onViewSync?: (zoom: number, pan: { x: number; y: number }) => void;
}

export default function RefPanel(p: Props) {
  const images = p.allSeries.filter((s) => (!s.specialType || s.specialType === "image") && s.slices.length > 0);
  const series = images.find((s) => s.id === p.seriesId) ?? null;
  const [local, setLocal] = useState(0);
  const [wl, setWl] = useState(0);
  const [ww, setWw] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Görünüm kilidi: açıkken zoom/pan ana panelden gelir; yerel durum yedekte kalır.
  const baseZoom = p.viewSync && p.syncZoom !== undefined ? p.syncZoom : zoom;
  const effPan = p.viewSync && p.syncPan ? p.syncPan : pan;
  const applyView = (z: number, pn: { x: number; y: number }) => {
    if (p.viewSync) p.onViewSync?.(z, pn);
    setZoom(z);
    setPan(pn);
  };
  // Kayıt (registration) sonucu: a-prior hizalaması (a-prior).
  const [align, setAlign] = useState<(AlignmentResult & { trusted: boolean }) | null>(null);
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignMsg, setAlignMsg] = useState<string>("");

  // Seri veya pencere ayarı değişince görüntüyü sıfırla: effect yerine render sırasında
  // korumalı durum güncellemesi (React "You Might Not Need an Effect" deseni).
  const resetKey = `${series?.id ?? ""}|${p.windowOverride?.wl ?? ""}|${p.windowOverride?.ww ?? ""}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (series) {
      setWl(p.windowOverride?.wl ?? series.defaultWL);
      setWw(p.windowOverride?.ww ?? series.defaultWW);
      setLocal(Math.floor(series.slices.length / 2));
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setAlign(null);
      setAlignMsg("");
    }
  }

  const synced = p.syncSlice && !!p.primary && !!series && parallelSeries(p.primary, series);
  const mapped = series && synced ? mapSliceByPosition(p.primary!, p.primarySlice, series) : local;
  const slice = series ? Math.max(0, Math.min(mapped, series.slices.length - 1)) : 0;
  const tool: ToolName = ["wl", "pan", "zoom", "xref"].includes(p.tool) ? p.tool : "wl";

  /**
   * Önceki/şimdiki kesidi hizalar (katı: öteleme + izotropik ölçek, NCC).
   * Hesaplama birkaç yüz ms sürebilir; bu yüzden bir sonraki kareye ertelenir
   * ("hizalanıyor…" göstergesi boyanabilsin) ve ana iş parçacığı bloke edilmez.
   */
  const runAlign = () => {
    const a = p.primary;
    if (!a || !series) return;
    const refSlice = a.slices[Math.min(p.primarySlice, a.slices.length - 1)];
    const movSlice = series.slices[slice];
    if (!refSlice || !movSlice) { setAlignMsg("Hizalama için iki görüntü kesidi gerekir."); return; }
    setAlignBusy(true);
    setAlignMsg("");
    setTimeout(() => {
      try {
        const maxShift = Math.max(6, Math.round(Math.min(a.width, a.height) * 0.12));
        const res = estimateAlignment(refSlice, a.width, a.height, movSlice, series.width, series.height, { maxShift });
        const trusted = alignmentTrusted(res);
        setAlign({ ...res, trusted });
        setAlignMsg(alignmentNote(res, trusted));
      } catch (e) {
        setAlign(null);
        setAlignMsg(`Hizalama başarısız: ${e instanceof Error ? e.message : "bilinmeyen hata"}`);
      } finally {
        setAlignBusy(false);
      }
    }, 0);
  };

  return (
    <div className="relative h-full w-full border border-[var(--t25)]" data-testid="reference-panel">
      <ViewerErrorBoundary resetKey={series?.id ?? "empty"} label={p.label}>
        <Viewport
          series={series} slice={slice} wl={wl} ww={ww} invert={p.invert}
          zoom={baseZoom * (align?.trusted ? align.scale : 1)}
          pan={effPan} tool={tool}
          alignPx={align?.trusted ? { dx: align.dx, dy: align.dy } : null}
          rotation={p.rotation} flipH={p.flipH} flipV={p.flipV} pxMm={series?.pixelSpacing ?? 1} readOnly panelId={p.panelId}
          label={series ? `${p.label}${synced ? " · senkron" : ""} · Kesit ${slice + 1}/${series.slices.length}` : p.label}
          onSlice={(s) => {
            if (s === slice) return;
            if (synced) p.onPrimarySlice(p.primarySlice + (s > slice ? 1 : -1));
            else setLocal(s);
          }}
          onWL={(a, b) => { setWl(a); setWw(b); }} onZoom={(z) => applyView(z / (align?.trusted ? align.scale : 1), effPan)} onPan={(pn) => applyView(baseZoom, pn)}
        />
      </ViewerErrorBoundary>
      <select
        aria-label={`${p.label} serisi`}
        value={p.seriesId ?? ""}
        onChange={(e) => p.onSeriesChange(e.target.value || null)}
        className="absolute right-2 top-2 max-w-[60%] rounded border border-[var(--t30)] bg-[var(--t10)]/90 px-1.5 py-1 text-[10px] text-[var(--sl200)] focus:outline-none"
      >
        <option value="">— seri seçin —</option>
        {images.map((s) => <option key={s.id} value={s.id}>{s.modality} · {s.description} ({s.slices.length})</option>)}
      </select>
      {series && <div className="pointer-events-none absolute bottom-1 left-2 font-mono text-[10px] text-[var(--ac-cyan200)]/80">WL {Math.round(wl)} · WW {Math.round(ww)}</div>}
      {series && p.primary && (
        <div className="absolute bottom-1 right-2 flex max-w-[78%] flex-col items-end gap-1 text-[10px]">
          <div className="flex gap-1">
            <button
              onClick={runAlign}
              disabled={alignBusy}
              title="Bu kesidi ana penceredeki kesitle hizala (normalize çapraz korelasyon; öteleme + ölçek)"
              className="rounded border border-[var(--t35)] bg-[var(--t10)]/90 px-1.5 py-0.5 text-[var(--sl200)] hover:border-cyan-400/60 hover:text-[var(--ac-cyan200)] disabled:opacity-50"
            >🎯 {alignBusy ? "hizalanıyor…" : "Hizala"}</button>
            {align && (
              <button
                onClick={() => { setAlign(null); setAlignMsg(""); }}
                title="Hizalamayı kaldır"
                className="rounded border border-[var(--t35)] bg-[var(--t10)]/90 px-1.5 py-0.5 text-[var(--sl300)] hover:border-rose-400/60 hover:text-[var(--ac-rose200)]"
              >↺</button>
            )}
            <button
              onClick={() => { applyView(1, { x: 0, y: 0 }); }}
              title={p.viewSync ? "Görünüm kilidi: her iki panelin yakınlaştırma/kaydırmasını sıfırla" : "Bu panelin yakınlaştırma/kaydırmasını sıfırla"}
              className="rounded border border-[var(--t35)] bg-[var(--t10)]/90 px-1.5 py-0.5 text-[var(--sl300)] hover:border-cyan-400/60 hover:text-[var(--ac-cyan200)]"
            >1:1</button>
          </div>
          {alignMsg && (
            <div className={`rounded px-1.5 py-0.5 text-right ${align?.trusted ? "bg-cyan-500/15 text-[var(--ac-cyan200)]" : "bg-amber-500/15 text-[var(--ac-amber200)]"}`}>
              {alignMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
