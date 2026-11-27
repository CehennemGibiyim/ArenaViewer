"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesData } from "@/lib/types";
import { curvedMpr, type CurvedImage, type CurvedMode } from "@/lib/curvedMpr";

/**
 * Kavisli (curved) MPR — v-mpr "Kavisli MPR" maddesi.
 *
 * Aksiyel kesit üzerinde merkez hattı noktaları işaretlenir (damar/omurga seyri);
 * "Düzleştir" hattı yay uzunluğuna göre eşit örnekleyip paralel taşıma çerçevesiyle
 * dik şeridi yeniden keser (src/lib/curvedMpr.ts). Farklı kesitlerde işaretlenen
 * noktalar tek merkez hattına eklenir. Görüntü yalnızca görselleştirmedir; ölçüm
 * için değildir.
 */
interface Props { series: SeriesData; wl: number; ww: number; invert: boolean }

const BG = -3.4e38;

export default function CurvedMprPanel({ series, wl, ww, invert }: Props) {
  const [slice, setSlice] = useState(0);
  const [pts, setPts] = useState<[number, number, number][]>([]);
  const [half, setHalf] = useState(30);
  const [slab, setSlab] = useState(0);
  const [mode, setMode] = useState<CurvedMode>("avg");
  const [result, setResult] = useState<CurvedImage | null>(null);
  const [err, setErr] = useState("");
  const srcCv = useRef<HTMLCanvasElement>(null);
  const outCv = useRef<HTMLCanvasElement>(null);
  const N = series.slices.length;
  const W = series.width, H = series.height;

  // ── aksiyel kaynak kesit + noktalar ──
  useEffect(() => {
    const c = srcCv.current; if (!c) return;
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    const id = ctx.createImageData(W, H);
    const u32 = new Uint32Array(id.data.buffer);
    const lo = wl - ww / 2, k = 255 / Math.max(1, ww);
    const sl = series.slices[Math.min(N - 1, Math.max(0, slice))];
    for (let i = 0; i < sl.length; i++) {
      let g = (sl[i] - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g; if (invert) g = 255 - g;
      const gi = g | 0; u32[i] = 0xff000000 | (gi << 16) | (gi << 8) | gi;
    }
    ctx.putImageData(id, 0, 0);
    // noktaları çiz
    pts.forEach(([x, y, z], i) => {
      if (z !== slice) return;
      ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "var(--t00)"; ctx.stroke();
      ctx.fillStyle = "var(--t00)"; ctx.font = "bold 9px monospace"; ctx.fillText(String(i + 1), x + 1.2, y + 3);
    });
  }, [series, slice, wl, ww, invert, pts, N, W, H]);

  // ── düzleştirilmiş görüntü ──
  useEffect(() => {
    const c = outCv.current; if (!c) return;
    if (!result) { const ctx = c.getContext("2d"); if (ctx) ctx.clearRect(0, 0, c.width, c.height); return; }
    const { width, height, data } = result;
    c.width = width; c.height = height;
    const ctx = c.getContext("2d")!;
    const id = ctx.createImageData(width, height);
    const u32 = new Uint32Array(id.data.buffer);
    const lo = wl - ww / 2, k = 255 / Math.max(1, ww);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v <= BG) { u32[i] = 0xff000000; continue; }
      let g = (v - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g; if (invert) g = 255 - g;
      const gi = g | 0; u32[i] = 0xff000000 | (gi << 16) | (gi << 8) | gi;
    }
    ctx.putImageData(id, 0, 0);
  }, [result, wl, ww, invert]);

  const flatten = () => {
    setErr("");
    const img = curvedMpr(series, { points: pts, halfWidthMm: half, slabMm: slab, mode: slab > 0 ? mode : "single" });
    if (!img) { setResult(null); setErr("En az iki farklı nokta işaretleyin (farklı konum veya kesit)."); return; }
    setResult(img);
  };

  const addPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * H);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    setPts((p) => [...p, [x, y, slice]]);
  };

  const btn = (on = false) => `cursor-pointer rounded px-2 py-0.5 font-bold ${on ? "bg-cyan-400/20 text-[var(--ac-cyan200)] ring-1 ring-cyan-400/50" : "bg-[var(--t17)] text-[var(--sl300)] hover:bg-[var(--t31)]"}`;
  const ptOnSlice = pts.filter((p) => p[2] === slice).length;

  return (
    <div className="flex h-full min-h-0 flex-col text-[11px] text-[var(--sl300)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--t25)] bg-[var(--t05)] px-2 py-1">
        <span className="font-bold text-[var(--ac-cyan300)]">Kavisli MPR</span>
        <label className="flex items-center gap-1">Kesit
          <input aria-label="Aksiyel kesit" type="range" min={0} max={N - 1} value={slice} onChange={(e) => setSlice(Number(e.target.value))} className="w-32" />
          <span className="w-16 font-mono text-[var(--ac-cyan300)]">{slice + 1}/{N}</span>
        </label>
        <label className="flex items-center gap-1">Yarım genişlik
          <input aria-label="Şerit yarım genişliği (mm)" type="range" min={5} max={60} step={1} value={half} onChange={(e) => setHalf(Number(e.target.value))} className="w-24" />
          <span className="w-10 font-mono text-[var(--ac-cyan300)]">{half} mm</span>
        </label>
        <label className="flex items-center gap-1">Kalın kesit
          <input aria-label="Kalın kesit (mm)" type="range" min={0} max={40} value={slab} onChange={(e) => setSlab(Number(e.target.value))} className="w-20" />
          <span className="w-10 font-mono text-[var(--ac-cyan300)]">{slab} mm</span>
        </label>
        {slab > 0 && (["avg", "mip"] as const).map((k) => <button key={k} onClick={() => setMode(k)} className={btn(mode === k)}>{k === "avg" ? "Ort." : "MIP"}</button>)}
        <button data-testid="curved-flatten" className={btn(true)} onClick={flatten} disabled={pts.length < 2}>Düzleştir</button>
        <button className={btn(false)} onClick={() => setPts((p) => p.slice(0, -1))} disabled={pts.length === 0}>Son noktayı sil</button>
        <button className={btn(false)} onClick={() => { setPts([]); setResult(null); setErr(""); }} disabled={pts.length === 0}>Temizle</button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 p-2">
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 flex shrink-0 items-center justify-between text-[10px] text-[var(--sl400)]">
            <span>Aksiyel — tıklayarak merkez hattını işaretleyin ({pts.length} nokta, bu kesitte {ptOnSlice})</span>
          </div>
          <div className="relative min-h-0 flex-1">
            <canvas
              ref={srcCv} data-testid="curved-src" className="mx-auto h-full max-h-full w-auto max-w-full cursor-crosshair" style={{ aspectRatio: `${W} / ${H}` }}
              onClick={addPoint}
              role="img" aria-label="Merkez hattı işaretleme"
            />
          </div>
          {pts.length > 0 && (
            <div className="mt-1 flex max-h-16 shrink-0 flex-wrap gap-1 overflow-auto">
              {pts.map((p, i) => (
                <button key={i} onClick={() => setSlice(p[2])} title="Bu noktanın kesitine git" className="rounded border border-[var(--t35)] bg-[var(--t10)] px-1.5 py-0.5 font-mono text-[var(--ac-cyan200)] hover:border-cyan-400/60">
                  {i + 1}:{p[2] + 1}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 flex shrink-0 items-center justify-between text-[10px] text-[var(--sl400)]">
            <span>Düzleştirilmiş (yay × yanal){result ? ` — ${result.lengthMm.toFixed(1)} mm · ${result.height}×${result.width}` : ""}</span>
          </div>
          <div className="relative min-h-0 flex-1 bg-[var(--t00)]">
            <canvas ref={outCv} data-testid="curved-out" className="mx-auto h-full max-h-full w-auto max-w-full object-contain" />
            {!result && !err && <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-[var(--sl500)]">Merkez hattını işaretleyip «Düzleştir» düğmesine basın.</div>}
            {err && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-[var(--ac-amber300)]">{err}</div>}
          </div>
          <div className="mt-1 shrink-0 text-[10px] text-[var(--sl500)]">Görüntü yalnızca görselleştirmedir — ölçüm için değildir. Hattın sürekliliği hekim sorumluluğundadır.</div>
        </div>
      </div>
    </div>
  );
}
