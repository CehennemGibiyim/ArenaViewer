"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesData } from "@/lib/types";
import ObliquePanel from "./ObliquePanel";
import VolumeRender from "./VolumeRender";
import { obliquePlane, sampleTrilinear, type SlabMode } from "@/lib/volume";

type Mode = "single" | "avg" | "mip" | "minip";

/** Slab toplulaştırmalı düzlem üretimi (radyolojik yönelim: baş yukarıda, ön solda). */
function axialPlane(s: SeriesData, z: number, k: number, mode: Mode): Float32Array {
  const n = s.width * s.height;
  const out = new Float32Array(n);
  const z0 = Math.max(0, z - k), z1 = Math.min(s.slices.length - 1, z + k);
  if (mode === "single" || z0 === z1) { const sl = s.slices[z]; for (let i = 0; i < n; i++) out[i] = sl[i]; return out; }
  for (let i = 0; i < n; i++) {
    let acc = mode === "mip" ? -Infinity : mode === "minip" ? Infinity : 0;
    for (let zz = z0; zz <= z1; zz++) {
      const v = s.slices[zz][i];
      acc = mode === "mip" ? Math.max(acc, v) : mode === "minip" ? Math.min(acc, v) : acc + v;
    }
    out[i] = mode === "avg" ? acc / (z1 - z0 + 1) : acc;
  }
  return out;
}

function coronalPlane(s: SeriesData, y: number, k: number, mode: Mode): Float32Array {
  const N = s.slices.length, W = s.width;
  const out = new Float32Array(W * N);
  const y0 = Math.max(0, y - k), y1 = Math.min(s.height - 1, y + k);
  const cnt = y1 - y0 + 1;
  for (let r = 0; r < N; r++) {
    const sl = s.slices[N - 1 - r];
    const o = r * W;
    if (mode === "single" || cnt === 1) { const b = y * W; for (let x = 0; x < W; x++) out[o + x] = sl[b + x]; continue; }
    // ayırımsız (allocation-free) toplulaştırma: kalın kesit MPR'de ~2-3x hızlı
    for (let x = 0; x < W; x++) {
      let acc = mode === "mip" ? -Infinity : mode === "minip" ? Infinity : 0;
      for (let yy = y0; yy <= y1; yy++) {
        const v = sl[yy * W + x];
        if (mode === "mip") { if (v > acc) acc = v; } else if (mode === "minip") { if (v < acc) acc = v; } else acc += v;
      }
      out[o + x] = mode === "avg" ? acc / cnt : acc;
    }
  }
  return out;
}

function sagittalPlane(s: SeriesData, x: number, k: number, mode: Mode): Float32Array {
  const N = s.slices.length, W = s.width, H = s.height;
  const out = new Float32Array(H * N);
  const x0 = Math.max(0, x - k), x1 = Math.min(W - 1, x + k);
  const cnt = x1 - x0 + 1;
  for (let r = 0; r < N; r++) {
    const sl = s.slices[N - 1 - r];
    const o = r * H;
    for (let yy = 0; yy < H; yy++) {
      const b = yy * W;
      if (mode === "single" || cnt === 1) { out[o + yy] = sl[b + x]; continue; }
      let acc = mode === "mip" ? -Infinity : mode === "minip" ? Infinity : 0;
      for (let xx = x0; xx <= x1; xx++) {
        const v = sl[b + xx];
        if (mode === "mip") { if (v > acc) acc = v; } else if (mode === "minip") { if (v < acc) acc = v; } else acc += v;
      }
      out[o + yy] = mode === "avg" ? acc / cnt : acc;
    }
  }
  return out;
}

interface PlaneProps {
  title: string;
  w: number;
  rows: number;
  rowScale: number;
  data: Float32Array;
  wl: number;
  ww: number;
  invert: boolean;
  cross: { x: number; y: number };
  color: string;
  onPick: (ix: number, iy: number) => void;
  onWheel: (dir: number) => void;
}

function Plane({ title, w, rows, rowScale, data, wl, ww, invert, cross, color, onPick, onWheel }: PlaneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300 });
  const down = useRef(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const geo = () => {
    const s = Math.min(size.w / w, size.h / (rows * rowScale)) * 0.96;
    return { s, ox: (size.w - w * s) / 2, oy: (size.h - rows * rowScale * s) / 2 };
  };

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, size.w, size.h);
    const off = document.createElement("canvas");
    off.width = w; off.height = rows;
    const octx = off.getContext("2d")!;
    const img = octx.createImageData(w, rows);
    const u32 = new Uint32Array(img.data.buffer);
    const lo = wl - ww / 2, k = 255 / Math.max(1, ww);
    for (let i = 0; i < data.length; i++) {
      let g = (data[i] - lo) * k;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      if (invert) g = 255 - g;
      const gi = g | 0;
      u32[i] = 0xff000000 | (gi << 16) | (gi << 8) | gi;
    }
    octx.putImageData(img, 0, 0);
    const { s, ox, oy } = geo();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, oy, w * s, rows * rowScale * s);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(ox + cross.x * s, oy); ctx.lineTo(ox + cross.x * s, oy + rows * rowScale * s);
    ctx.moveTo(ox, oy + cross.y * rowScale * s); ctx.lineTo(ox + w * s, oy + cross.y * rowScale * s);
    ctx.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, wl, ww, invert, cross.x, cross.y, size, w, rows, rowScale, color]);

  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { s, ox, oy } = geo();
    const ix = (e.clientX - r.left - ox) / s;
    const iy = (e.clientY - r.top - oy) / (s * rowScale);
    if (ix >= 0 && iy >= 0 && ix < w && iy < rows) onPick(Math.floor(ix), Math.floor(iy));
  };

  return (
    <div className="relative flex min-h-0 flex-col border border-[#1a2230] bg-black">
      <div className="absolute left-2 top-1 z-10 font-mono text-[10px] font-bold" style={{ color }}>{title}</div>
      <div ref={wrap} className="min-h-0 flex-1">
        <canvas
          ref={cv}
          style={{ width: size.w, height: size.h, cursor: "crosshair" }}
          onPointerDown={(e) => { down.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pick(e); }}
          onPointerMove={(e) => down.current && pick(e)}
          onPointerUp={() => (down.current = false)}
          onWheel={(e) => onWheel(e.deltaY > 0 ? 1 : -1)}
        />
      </div>
    </div>
  );
}

interface Props {
  series: SeriesData;
  wl: number;
  ww: number;
  invert: boolean;
  initialTab?: "not" | "3b";
  onClose: () => void;
}

export default function VolumeView({ series, wl: wl0, ww: ww0, invert, initialTab = "not", onClose }: Props) {
  const N = series.slices.length;
  const W = series.width;
  const H = series.height;
  const spacing = series.sliceSpacing || series.sliceThickness || 1;
  const ratio = spacing / (series.pixelSpacing || 1);
  const [cur, setCur] = useState({ x: Math.floor(W / 2), y: Math.floor(H / 2), z: Math.floor(N / 2) });
  const [slab, setSlab] = useState(0);
  const [mode, setMode] = useState<Mode>("single");
  const [wl, setWl] = useState(wl0);
  const [ww, setWw] = useState(ww0);
  const [tab, setTab] = useState<"not" | "oblik" | "3b">(initialTab);
  const [big, setBig] = useState(false);
  /** Kullanıcının seçtiği kalıcı MPR katsayısı (varsayılan: kalp-damar). */
  const [prefFilter, setPrefFilter] = useState<{ wl: number; ww: number } | null>(null);

  /**
   * Üç düzlemin de geometrisi: kesit konumları (IPP) varsa hasta uzayından,
   * yoksa sıralı tarama sanalı üretilir. Koronal/sagittal bu sayede gerçek
   * kesit aralığına ve ölçeğe göre örneklenir (ölçek bozulması yaşanmaz).
   */
  const planeW = useMemo(() => {
    if (!series.ipp || series.ipp.length !== N) return W;
    let xs = 0, ys = 0, zs = 0;
    for (let i = 1; i < N; i++) { xs += Math.abs(series.ipp[i][0] - series.ipp[i - 1][0]); ys += Math.abs(series.ipp[i][1] - series.ipp[i - 1][1]); zs += Math.abs(series.ipp[i][2] - series.ipp[i - 1][2]); }
    const d = Math.hypot(xs, ys, zs) / Math.max(1, N - 1);
    // koronal: satır = kesit normali (mm), sütun = kaynak yatay (psX)
    return Math.max(W, Math.min(N, Math.round((d * N) / (series.pixelSpacingX ?? 1))));
  }, [series, N, W]);
  const planeH = useMemo(() => N, [N]);

  /** Hasta uzayından MPR düzlemi (trilinear). `rows`/`rowScale` ekrana çizim içindir. */
  function planeFor(axis: "axial" | "coronal" | "sagittal", idx: number, slabPx: number, mode: Mode): { data: Float32Array; w: number; rows: number; rowScale: number } {
    const hasGeo = Array.isArray(series.ipp) && series.ipp.length === N && series.orientation && series.orientation.length >= 6;
    if (!hasGeo) {
      const p = axis === "axial" ? axialPlane(series, idx, kz, mode) : axis === "coronal" ? coronalPlane(series, idx, kxy, mode) : sagittalPlane(series, idx, kxy, mode);
      const w = axis === "sagittal" ? H : W;
      const rows = axis === "axial" ? H : N;
      return { data: p, w, rows, rowScale: ratio };
    }
    const o = series.ipp![Math.max(0, Math.min(N - 1, idx))];
    const r: [number, number, number] = [series.orientation![0], series.orientation![1], series.orientation![2]];
    const c: [number, number, number] = [series.orientation![3], series.orientation![4], series.orientation![5]];
    const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
      a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    ];
    const norm = (a: [number, number, number]): [number, number, number] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const nrm = norm(cross(r, c));
    const psX = series.pixelSpacingX ?? series.pixelSpacing ?? 1;
    const psY = series.pixelSpacing ?? 1;
    let u: [number, number, number], v: [number, number, number], du: number, dv: number, outW: number, outRows: number;
    if (axis === "axial") {
      u = r; v = c; du = psY; dv = psX; outW = W; outRows = H;
    } else if (axis === "coronal") {
      u = c; v = nrm; du = psX; dv = spacing; outW = planeW; outRows = planeH;
    } else {
      u = r; v = nrm; du = psY; dv = spacing; outW = planeW; outRows = planeH;
    }
    const halfU = ((outW - 1) / 2) * du, halfV = ((outRows - 1) / 2) * dv;
    const slabMm = slabPx * (axis === "axial" ? spacing : du);
    const out = new Float32Array(outW * outRows);
    for (let q = 0; q < outRows; q++) {
      for (let p = 0; p < outW; p++) {
        const a = p * du - halfU, b = q * dv - halfV;
        const px = o[0] + u[0] * a + v[0] * b, py = o[1] + u[1] * a + v[1] * b, pz = o[2] + u[2] * a + v[2] * b;
        // px,py,pz → kaynak vokseller: sütun = (p-o)·c/psX, satır = (p-o)·r/psY, kesit ≈ (p-o)·n/adım
        const dx = px - o[0], dy = py - o[1], dz = pz - o[2];
        const j = dot3([dx, dy, dz], c) / psX, i = dot3([dx, dy, dz], r) / psY;
        const step = spacing || 1;
        const k = dot3([dx, dy, dz], nrm) / step;
        if (slabMm <= 0) out[q * outW + p] = sampleTrilinear(series, j, i, k);
        else {
          let acc = 0, cnt = 0;
          for (let m = -slabPx; m <= slabPx; m++) {
            const val = sampleTrilinear(series, j, i, k + m);
            if (val === null || Number.isNaN(val)) continue;
            if (mode === "mip") acc = Math.max(acc, val); else if (mode === "minip") acc = acc === 0 && cnt === 0 ? val : Math.min(acc, val);
            else acc += val;
            cnt++;
          }
          out[q * outW + p] = cnt === 0 ? NaN : mode === "avg" ? acc / cnt : acc;
        }
      }
    }
    return { data: out, w: outW, rows: outRows, rowScale: axis === "axial" ? 1 : spacing / (du || 1) };
  }
  const dot3 = (a: [number, number, number], b: [number, number, number]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const m: Mode = slab === 0 ? "single" : mode === "single" ? "avg" : mode;
  const kz = Math.round(slab / 2 / spacing);
  const kxy = Math.round(slab / 2 / (series.pixelSpacing || 1));
  // planeFor bu bileşen kapsamında seri/ölçek/kalınlıkla sınırlı; türetilmiş değerler bağımlılık dizisine yazılır.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scaleIdx = (idx: number, rows: number) => (rows === N ? idx : Math.max(0, Math.min(rows - 1, Math.round(idx * (rows - 1) / Math.max(1, N - 1)))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const axG = useMemo(() => planeFor("axial", cur.z, 0, "single"), [series, cur.z, planeW, planeH]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const coG = useMemo(() => planeFor("coronal", scaleIdx(cur.y, planeH), kz, m), [series, cur.y, kz, m, planeW, planeH]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saG = useMemo(() => planeFor("sagittal", scaleIdx(cur.x, planeH), kz, m), [series, cur.x, kz, m, planeW, planeH]);
  const ax = axG.data, co = coG.data, sa = saG.data;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  const val = series.slices[cur.z]?.[cur.y * W + cur.x];
  const zMm = series.slicePositions ? series.slicePositions[cur.z] : cur.z * spacing;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#05070a]">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[#1a2230] bg-[#0b0f16] px-3 py-2 text-xs">
        <span className="font-mono font-black tracking-widest text-cyan-300">{tab === "3b" ? "3B HACİM" : "MPR"} · {series.description}</span>
        <span className="font-mono text-slate-400">x {cur.x} · y {cur.y} · kesit {cur.z + 1}/{N} · z {zMm.toFixed(1)} mm · değer {val !== undefined ? val.toFixed(0) : "—"} {series.unit}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-slate-300">Kalın kesit
            <input type="range" min={0} max={40} step={1} value={slab} onChange={(e) => setSlab(Number(e.target.value))} className="w-28" />
            <span className="w-12 font-mono text-cyan-300">{slab} mm</span>
          </label>
          {(["avg", "mip", "minip"] as const).map((k) => (
            <button key={k} disabled={slab === 0} onClick={() => setMode(k)} className={`rounded px-2 py-1 font-bold disabled:opacity-40 ${m === k && slab > 0 ? "bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-400/50" : "text-slate-300 hover:bg-[#161e2b]"}`}>
              {k === "avg" ? "Ort." : k === "mip" ? "MIP" : "MinIP"}
            </button>
          ))}
          <div className="flex items-center gap-1">
            {([["soft", "Yumuşak"], ["bone", "Kemik"]] as const).map(([key, label]) => (
              <button key={key} onClick={() => {
                const f = key === "soft" ? { wl: 40, ww: 400 } : { wl: 350, ww: 1800 };
                setPrefFilter((p) => (p && p.wl === f.wl && p.ww === f.ww ? null : f));
                setWl(f.wl); setWw(f.ww);
              }} className={`cursor-pointer rounded px-2 py-0.5 font-bold ${prefFilter?.wl === (key === "soft" ? 40 : 350) ? "bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-400/50" : "text-slate-300 hover:bg-[#161e2b]"}`}>{label}</button>
            ))}
            <button onClick={() => { setPrefFilter(null); setWl(wl0); setWw(ww0); }} className="cursor-pointer rounded bg-[#141b24] px-2 py-0.5 font-bold text-slate-300 hover:bg-[#1f2937]">Filtreyi sıfırla</button>
          </div>
          <label className="flex items-center gap-1 text-slate-300">WL
            <input type="number" value={Math.round(wl)} onChange={(e) => setWl(Number(e.target.value))} className="w-16 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5 text-slate-100" />
          </label>
          <label className="flex items-center gap-1 text-slate-300">WW
            <input type="number" value={Math.round(ww)} onChange={(e) => setWw(Math.max(1, Number(e.target.value)))} className="w-16 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5 text-slate-100" />
          </label>
          <button onClick={onClose} className="rounded border border-[#2d3b4e] bg-[#141b24] px-3 py-1 font-bold text-slate-200 hover:bg-[#1f2937]">✕ Kapat</button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-1 p-1">
        {!big && <>
        <Plane title="AKSİYEL" w={axG.w} rows={axG.rows} rowScale={axG.rowScale} data={ax} wl={wl} ww={ww} invert={invert} color="#22d3ee"
          cross={{ x: cur.x + 0.5, y: cur.y + 0.5 }}
          onPick={(ix, iy) => setCur((c) => ({ ...c, x: clamp(ix, W), y: clamp(iy, H) }))}
          onWheel={(d) => setCur((c) => ({ ...c, z: clamp(c.z + d, N) }))} />
        <Plane title="KORONAL" w={coG.w} rows={coG.rows} rowScale={coG.rowScale} data={co} wl={wl} ww={ww} invert={invert} color="#fbbf24"
          cross={{ x: cur.x + 0.5, y: coG.rows - 1 - scaleIdx(cur.z, coG.rows) + 0.5 }}
          onPick={(ix, iy) => setCur((c) => ({ ...c, x: clamp(ix, W), z: scaleIdx(coG.rows - 1 - iy, N) }))}
          onWheel={(d) => setCur((c) => ({ ...c, y: clamp(c.y + d, H) }))} />
        <Plane title="SAGİTAL" w={saG.w} rows={saG.rows} rowScale={saG.rowScale} data={sa} wl={wl} ww={ww} invert={invert} color="#f472b6"
          cross={{ x: cur.y + 0.5, y: saG.rows - 1 - scaleIdx(cur.z, saG.rows) + 0.5 }}
          onPick={(ix, iy) => setCur((c) => ({ ...c, y: clamp(ix, H), z: scaleIdx(saG.rows - 1 - iy, N) }))}
          onWheel={(d) => setCur((c) => ({ ...c, x: clamp(c.x + d, W) }))} />
        </>}
        <div className={`flex min-h-0 flex-col overflow-hidden border border-[#1a2230] bg-[#0b0f16] ${big ? "col-span-2 row-span-2" : ""}`}>
          <div className="flex shrink-0 items-center gap-1 border-b border-[#1a2230] px-2 py-1 text-[11px]">
            {([["not", "Notlar"], ["oblik", "Oblik MPR"], ["3b", "3B hacim"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`cursor-pointer rounded px-2 py-0.5 font-bold ${tab === k ? "bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-400/50" : "bg-[#141b24] text-slate-300 hover:bg-[#1f2937]"}`}>{l}</button>
            ))}
            <button onClick={() => setBig((b) => !b)} className="ml-auto cursor-pointer rounded bg-[#141b24] px-2 py-0.5 font-bold text-slate-300 hover:bg-[#1f2937]">{big ? "▣ Küçült" : "⛶ Büyüt"}</button>
          </div>
          <div className="min-h-0 flex-1">
          {tab === "oblik" && <ObliquePanel series={series} center={cur} wl={wl} ww={ww} invert={invert} />}
          {tab === "3b" && <VolumeRender series={series} />}
          {tab === "not" && <div className="h-full overflow-auto p-3 text-[11px] leading-relaxed text-slate-300">
          <div className="mb-1 text-xs font-bold text-slate-100">MPR notları</div>
          <ul className="list-disc space-y-1 pl-4">
            <li>Bir düzleme tıklayın/sürükleyin: diğer düzlemlerde <b>çapraz referans çizgileri</b> aynı noktayı gösterir.</li>
            <li>Tekerlek: tıklanan düzlemin normali boyunca gezinir.</li>
            <li>Kalın kesit: ortalama / MIP (en parlak) / MinIP (en koyu) projeksiyonu.</li>
            <li>Kesit aralığı <b>{spacing.toFixed(2)} mm</b>, piksel <b>{(series.pixelSpacing || 1).toFixed(2)} mm</b> (dikey ölçek {ratio.toFixed(2)}×).</li>
            <li><b>Oblik MPR</b> ve <b>3B hacim</b> (VR/MIP, STL) sekmelerinden eğimli düzlem ve hacim görüntüleme kullanılır.</li>
            <li className="text-amber-300">Koronal/sagittal yönelim, kesitlerin kafa yönüne artan sıralandığı varsayımına dayanır.</li>
            {N < 12 && <li className="text-amber-300">Kesit sayısı az ({N}); yeniden kesit görüntüleri kaba görünebilir.</li>}
          </ul>
        </div>}
          </div>
        </div>
      </div>
    </div>
  );
}
