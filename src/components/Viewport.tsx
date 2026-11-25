"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { snapPoint } from "@/lib/msk";
import type { Annotation, Finding, SeriesData, ToolName } from "@/lib/types";
import { annotationSummary, dist, ellipseTest, pointInPolygon, perpendicular, regionStats, type Pt } from "@/lib/geometry";
import { buildFusionLayer, type FusionParams } from "@/lib/fusion";
import { jumpToPatient, refLinesFor, registerPanel, unregisterPanel, usePanelRegistry } from "@/lib/panelRegistry";
import { planeOf, toPatient } from "@/lib/planes";
import { buildWindowLUT, windowToRGBA } from "@/lib/window";
import { GpuWindower, needsGpu } from "@/lib/gpuWindow";
import { applyGesture, gestureStep, pinchOf, type Pinch } from "@/lib/gestures";
import { HEAT_ALPHA_MAX, heatPixel, heatVisible } from "@/lib/heat";
import { fmtConfShort } from "@/lib/format";

const SEV_COLOR: Record<string, string> = { kritik: "#ff3b5c", yuksek: "#ff9f1c", orta: "#ffd60a", dusuk: "#4cc9f0", normal: "#2ee6a8" };
const SEV_RGB: Record<string, [number, number, number]> = { kritik: [255, 59, 92], yuksek: [255, 159, 28], orta: [255, 214, 10], dusuk: [76, 201, 240], normal: [46, 230, 168] };

export interface ScanState {
  active: boolean;
  sliceProgress: number;
  scannedSlices: number;
  totalSlices: number;
  phaseLabel: string;
}

/** CXR model çıktısından gelen çözülmüş ısı haritası (64×64 gri). */
export interface HeatData {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface OverlayData {
  masks: Map<string, Map<number, Uint8Array>>;
  opacity: number;
  /** bulgu id → ısı haritası; yalnızca ilgili karede çizilir. */
  heats?: Map<string, HeatData>;
  heatOpacity?: number;
}

/** Isı haritası renklaması (mavi → camgöbeği → yeşil → sarı → kırmızı), alfa eşikli. */
type Rot = 0 | 90 | 180 | 270;
type Draft = { mode: "drag"; tool: ToolName; a: Pt; b: Pt } | { mode: "multi"; tool: ToolName; pts: Pt[]; cursor: Pt } | null;
const DRAG_TOOLS: ToolName[] = ["length", "rect", "ellipse", "ellipsoid", "arrow", "calib"];
const MULTI_NEED: Partial<Record<ToolName, number>> = { angle: 3, cobb: 4, deviation: 3 };

interface ViewportProps {
  series: SeriesData | null;
  slice: number;
  wl: number;
  ww: number;
  invert: boolean;
  zoom: number;
  pan: { x: number; y: number };
  tool: ToolName;
  rotation: Rot;
  flipH: boolean;
  flipV: boolean;
  pxMm: number;
  scan?: ScanState | null;
  findings?: Finding[];
  revealedIds?: Set<string>;
  activeFindingId?: string | null;
  overlay?: OverlayData | null;
  showDicomOverlays?: boolean;
  annotations?: Annotation[];
  readOnly?: boolean;
  label?: string;
  /** Çapraz referans çizgileri için panel kimliği (aynı çerçevedeki diğer panellerin düzlemleri çizilir). */
  panelId?: string;
  /** PET-BT vb. füzyon katmanı (bu seri üzerine bindirilir). */
  fusion?: FusionParams | null;
  onSlice: (s: number) => void;
  onWL: (wl: number, ww: number) => void;
  onZoom: (z: number) => void;
  onPan: (p: { x: number; y: number }) => void;
  onAddAnnotation?: (a: Omit<Annotation, "id">) => void;
  /** MSK protokol nokta sayısı; tool "msk" iken noktalar bu kadar olunca bildirilir. */
  mskPointCount?: number;
  onMskPoints?: (pts: Pt[], slice: number) => void;
  /** MSK noktasını belirgin özelliğe yapıştırır (px yarıçap; 0 = kapalı). */
  snapRadius?: number;
  onCalibrate?: (pxLength: number) => void;
  onHover?: (v: number | null) => void;
}

/**
 * Taban katmanı tuvalini üretir (True Color kopyası veya WL/WW LUT uygulaması).
 *
 * Büyük gri görüntülerde (≥1 MP) GPU yolu denenir: doku bir kez yüklenir,
 * WL/WW/invert yalnız uniform olarak değişir (v-perf). GPU yoksa ya da bağlam
 * kaybolduysa CPU LUT yolu aynen kullanılır — davranış değişmez.
 */
function buildBaseCanvas(
  series: SeriesData,
  idx: number,
  wl: number,
  ww: number,
  invert: boolean,
  gpu?: GpuWindower | null
): HTMLCanvasElement | null {
  const sl = series.slices[idx];
  if (!sl) return null;
  const W = series.width, H = series.height;
  const isColor = !!series.isColor && !!series.rgbaSlices && !!series.rgbaSlices[idx];
  if (gpu && !isColor) {
    const g = gpu.render({
      key: `${series.id}|${idx}`,
      pixels: sl,
      width: W,
      height: H,
      wl,
      ww,
      invert,
      isInt16: sl instanceof Int16Array,
      isUint16: sl instanceof Uint16Array,
    });
    if (g) return g;
  }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const octx = c.getContext("2d");
  if (!octx) return null;
  const img = octx.createImageData(W, H);
  const u32 = new Uint32Array(img.data.buffer);
  if (isColor) u32.set(series.rgbaSlices![idx]);
  else { const wlut = buildWindowLUT(wl, ww, invert); windowToRGBA(sl, wlut.lut, wlut.lo, u32); }
  octx.putImageData(img, 0, 0);
  return c;
}

/**
 * GPU pencereleyici örneği (bileşen başına bir tane). Yalnızca tarayıcıda oluşturulur;
 * `needsGpu` false dönerse hiç kurulmaz (küçük görüntüler CPU'da daha hızlı).
 */
function ensureGpu(ref: { current: GpuWindower | null }, series: SeriesData | null): GpuWindower | null {
  if (!series || typeof document === "undefined") return null;
  if (ref.current) return ref.current;
  // WebGL2 desteğini ucuz bir bağlamla sınar; başarısızsa null kalır (CPU yolu).
  let webgl2 = false;
  try {
    const probe = document.createElement("canvas").getContext("webgl2");
    webgl2 = !!probe;
    // Sondaj bağlamını bırak: çok sayıda panel açılırsa tarayıcı bağlam sınırına takılmasın.
    (probe as WebGL2RenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch { webgl2 = false; }
  if (!needsGpu({ webgl2, isColor: !!series.isColor, width: series.width, height: series.height, sliceCount: series.slices.length })) return null;
  const w = new GpuWindower();
  ref.current = w.available ? w : null;
  return ref.current;
}

/** Önbellek boyutu sınırı: en eski eklenen kayıtları siler. */
function trimBaseCache(map: Map<string, { key: string; canvas: HTMLCanvasElement }>, max: number) {
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const EMPTY_FINDINGS: Finding[] = [];
const EMPTY_SET = new Set<string>();
const EMPTY_ANN: Annotation[] = [];

export default function Viewport(props: ViewportProps) {
  const {
    series, slice: requestedSlice, wl, ww, invert, zoom, pan, tool, rotation, flipH, flipV, pxMm, scan = null,
    findings = EMPTY_FINDINGS, revealedIds = EMPTY_SET, activeFindingId = null, overlay = null,
    showDicomOverlays = true, annotations = EMPTY_ANN, readOnly = false, label, panelId, fusion = null,
    onSlice, onWL, onZoom, onPan, onAddAnnotation, onCalibrate, onHover,
    mskPointCount = 0, onMskPoints, snapRadius = 0,
  } = props;

  const slice = series ? Math.max(0, Math.min(requestedSlice, series.slices.length - 1)) : 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Taban katmanı küçük önbelleği: aktif kesit + komşular (kademeli/önceden pencereleme, v-perf).
  const BASE_CACHE_MAX = 6;
  // GPU pencereleyici (v-perf): büyük gri görüntülerde doku bir kez yüklenir.
  const gpuRef = useRef<GpuWindower | null>(null);

  // GPU dokusu seri değişince ve bileşen kalkınca bırakılır: 4096² int16 doku
  // ≈32 MB; seri değişiminde tutmak bellek sızıntısı olurdu.
  useEffect(() => {
    const g = gpuRef.current;
    return () => { g?.dispose(); };
  }, [series?.id]);

  const PREFETCH_PIXELS_MAX = 2_000_000; // taban tabanlı ön-işleme bellek kapısı (~2 MP ≈ 8 MB)
  const baseCache = useRef(new Map<string, { key: string; canvas: HTMLCanvasElement }>());
  const ovRef = useRef<{ key: string; canvas: HTMLCanvasElement | null }>({ key: "", canvas: null });
  const dragRef = useRef<{ button: number; sx: number; sy: number; wl: number; ww: number; zoom: number; pan: { x: number; y: number } } | null>(null);
  // Dokunmatik jest durumu (v-multimon): aktif temas noktaları + son kıstırma.
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<Pinch | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [isFullscreen, setFullscreen] = useState(false);
  const [renderTick, setTick] = useState(0);
  const fusRef = useRef<{ key: string; canvas: HTMLCanvasElement | null }>({ key: "", canvas: null });
  const heatRef = useRef<Map<string, { key: string; canvas: HTMLCanvasElement }>>(new Map());
  const registryVersion = usePanelRegistry();
  const suvFactor = series?.suv?.factor ?? null;

  // Tam ekran durumu yalnız bu panel için (v-multimon): Esc/başka panel tam ekranı
  // devralırsa düğme doğru etiketi göstersin.
  useEffect(() => {
    const onChange = () => setFullscreen(!!wrapRef.current && document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
  };

  // Bu panelin hangi seri/kesiti gösterdiğini kayda geçir (referans çizgileri ve 3B imleç için).
  // onSlice her render'da yeniden oluşabilen bir arrow fonksiyon olduğundan geri çağırma
  // ref üzerinden tutulur; böylece kayıt bağımlılıkları serbest bırakılmaz.
  const sliceFn = useRef(onSlice);
  useEffect(() => { sliceFn.current = onSlice; });
  useEffect(() => {
    if (!panelId) return;
    registerPanel({
      id: panelId, series, slice,
      label: series ? `${series.description} · K${slice + 1}` : panelId,
      setSlice: (n: number) => sliceFn.current(n),
    });
    return () => unregisterPanel(panelId);
  }, [panelId, series, slice]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const dims = useCallback(() => {
    if (!series) return { dispW: 1, dispH: 1 };
    const r = rotation === 90 || rotation === 270;
    return { dispW: r ? series.height : series.width, dispH: r ? series.width : series.height };
  }, [series, rotation]);

  const getTransform = useCallback(() => {
    const { dispW, dispH } = dims();
    const scale = Math.min(size.w / dispW, size.h / dispH) * 0.92 * zoom;
    return { scale, ox: size.w / 2 - (dispW / 2) * scale + pan.x, oy: size.h / 2 - (dispH / 2) * scale + pan.y, dispW, dispH };
  }, [dims, size, zoom, pan]);

  // Görüntü koordinatı -> Ekran koordinatı
  const imgToDisp = useCallback((p: Pt): Pt => {
    if (!series) return p;
    const { dispW, dispH } = dims();
    let q: Pt;
    if (rotation === 90) q = { x: series.height - p.y, y: p.x };
    else if (rotation === 180) q = { x: series.width - p.x, y: series.height - p.y };
    else if (rotation === 270) q = { x: p.y, y: series.width - p.x };
    else q = p;
    return { x: flipH ? dispW - q.x : q.x, y: flipV ? dispH - q.y : q.y };
  }, [series, rotation, flipH, flipV, dims]);

  const dispToImg = useCallback((d: Pt): Pt => {
    if (!series) return d;
    const { dispW, dispH } = dims();
    const x = flipH ? dispW - d.x : d.x;
    const y = flipV ? dispH - d.y : d.y;
    if (rotation === 90) return { x: y, y: series.height - x };
    if (rotation === 180) return { x: series.width - x, y: series.height - y };
    if (rotation === 270) return { x: series.width - y, y: x };
    return { x, y };
  }, [series, rotation, flipH, flipV, dims]);

  const canvasToImg = useCallback((cx: number, cy: number): Pt => {
    const { scale, ox, oy } = getTransform();
    return dispToImg({ x: (cx - ox) / scale, y: (cy - oy) / scale });
  }, [getTransform, dispToImg]);

  // Kademeli/önceden pencereleme (v-perf): görünür kesidin komşuları boş zamanda işlenip
  // önbelleğe alınır; kaydırma sırasında hedef kesit hazır gelir. Bellek kapısı var:
  // yalnızca toplam taban katmanı ~8 MB altı (≈2 MP) serilerde çalışır.
  useEffect(() => {
    if (!series || series.isColor) return;
    // GPU yolu varsa ön-işleme gereksiz: WL/WW değişimi yalnız uniform güncellemesi.
    const gpu = ensureGpu(gpuRef, series);
    if (gpu) return;
    if (series.width * series.height > PREFETCH_PIXELS_MAX) return;
    const rWl = Math.round(wl), rWw = Math.round(ww);
    const keys = [slice + 1, slice + 2, slice - 1, slice - 2]
      .filter((k) => k >= 0 && k < series.slices.length)
      .map((k) => `${series.id}|${k}|${rWl}|${rWw}|${invert}|mono`);
    const todo = keys.filter((k) => !baseCache.current.has(k));
    if (!todo.length) return;
    let alive = true;
    const step = () => {
      if (!alive) return;
      const k = todo.pop();
      if (!k) return;
      if (!baseCache.current.has(k)) {
        const idx = Number(k.split("|")[1]);
        const c = buildBaseCanvas(series, idx, rWl, rWw, invert);
        if (c) { baseCache.current.set(k, { key: k, canvas: c }); trimBaseCache(baseCache.current, BASE_CACHE_MAX); }
      }
      setTimeout(step, 0);
    };
    const t = setTimeout(step, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [series, slice, wl, ww, invert]);

  // ───────── Çizim Döngüsü ─────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#07090c";
    ctx.fillRect(0, 0, size.w, size.h);
    if (!series) return;

    const W = series.width;
    const H = series.height;
    const sliceIdx = Math.min(slice, series.slices.length - 1);
    const sl = series.slices[sliceIdx];

    // 1. Taban katmanı: True Color RGBA veya Monokrom Grayscale LUT
    const isColor = series.isColor && series.rgbaSlices && series.rgbaSlices[sliceIdx];
    const key = `${series.id}|${slice}|${Math.round(wl)}|${Math.round(ww)}|${invert}|${isColor ? "color" : "mono"}`;

    // GPU yolu (v-perf): büyük gri serilerde taban katmanı GPU'da pencerelenir.
    // Doku kesit başına bir kez yüklenir; WL/WW/invert yalnız uniform değiştirir.
    // GPU yoksa/başarısızsa aşağıdaki CPU yolu aynen çalışır (davranış değişmez).
    const gpu = ensureGpu(gpuRef, series);
    let gpuBase: HTMLCanvasElement | null = null;
    if (gpu) {
      gpuBase = buildBaseCanvas(series, sliceIdx, wl, ww, invert, gpu);
    }

    let cachedBase = gpuBase ? null : baseCache.current.get(key);
    if (!cachedBase && !gpuBase) {
      const c = buildBaseCanvas(series, sliceIdx, wl, ww, invert);
      if (c) { cachedBase = { key, canvas: c }; baseCache.current.set(key, cachedBase); trimBaseCache(baseCache.current, BASE_CACHE_MAX); }
    }

    // 2. AI Maske Örtüsü
    let ovCanvas: HTMLCanvasElement | null = null;
    if (overlay && overlay.opacity > 0) {
      const vis = findings.filter((f) => revealedIds.has(f.id) && overlay.masks.get(f.id)?.get(slice));
      if (vis.length) {
        const okey = `${series.id}|${slice}|${vis.map((f) => f.id).join(",")}|${overlay.opacity}`;
        if (ovRef.current.key !== okey) {
          const c = ovRef.current.canvas ?? document.createElement("canvas");
          c.width = W; c.height = H;
          const octx = c.getContext("2d")!;
          const img = octx.createImageData(W, H);
          const u32 = new Uint32Array(img.data.buffer);
          const a = Math.round(overlay.opacity * 255);
          for (const f of vis) {
            const [r, g, b] = SEV_RGB[f.severity] ?? SEV_RGB.dusuk;
            const col = (a << 24) | (b << 16) | (g << 8) | r;
            const mk = overlay.masks.get(f.id)!.get(slice)!;
            for (let i = 0; i < mk.length; i++) if (mk[i]) u32[i] = col;
          }
          octx.putImageData(img, 0, 0);
          ovRef.current = { key: okey, canvas: c };
        }
        ovCanvas = ovRef.current.canvas;
      }
    }

    // 2b. CXR ısı haritası katmanı (Grad-CAM): modelin baktığı alanlar
    let heatCanvas: HTMLCanvasElement | null = null;
    if (overlay?.heats && (overlay.heatOpacity ?? 0) > 0) {
      const alpha = Math.round(Math.max(0, Math.min(HEAT_ALPHA_MAX, overlay.heatOpacity ?? 0)) * 255);
      const vis = findings.filter(
        (f) => revealedIds.has(f.id) && f.sliceIndex === slice && overlay.heats!.get(f.id),
      );
      if (vis.length) {
        const layer = document.createElement("canvas");
        layer.width = W; layer.height = H;
        const lctx = layer.getContext("2d")!;
        for (const f of vis) {
          const hd = overlay.heats!.get(f.id)!;
          const key = `${f.id}|${alpha}`;
          let cached = heatRef.current.get(f.id);
          if (!cached || cached.key !== key) {
            const c = document.createElement("canvas");
            c.width = hd.w; c.height = hd.h;
            const cctx = c.getContext("2d")!;
            const img = cctx.createImageData(hd.w, hd.h);
            const u32 = new Uint32Array(img.data.buffer);
            for (let i = 0; i < hd.data.length; i++) {
              const v = hd.data[i];
              if (!heatVisible(v)) { u32[i] = 0; continue; } // düşük aktivasyon gizlenir
              u32[i] = heatPixel(v, alpha);
            }
            cctx.putImageData(img, 0, 0);
            cached = { key, canvas: c };
            heatRef.current.set(f.id, cached);
          }
          lctx.imageSmoothingEnabled = true;
          lctx.drawImage(cached.canvas, 0, 0, W, H);
        }
        heatCanvas = layer;
      }
    }

    // 1b. Füzyon katmanı (ör. PET → BT): hasta koordinatlarına göre yeniden örneklenir
    let fusCanvas: HTMLCanvasElement | null = null;
    let fusNote = "";
    if (fusion && !series.isColor) {
      const fkey = `${series.id}|${slice}|${fusion.series.id}|${fusion.alpha}|${fusion.cmap}|${fusion.loPct}|${fusion.hiPct}`;
      if (fusRef.current.key !== fkey) {
        const layer = buildFusionLayer(series, slice, fusion);
        if (layer) {
          const c = fusRef.current.canvas ?? document.createElement("canvas");
          c.width = W; c.height = H;
          const fctx = c.getContext("2d")!;
          const img = fctx.createImageData(W, H);
          new Uint32Array(img.data.buffer).set(layer);
          fctx.putImageData(img, 0, 0);
          fusRef.current = { key: fkey, canvas: c };
        } else fusRef.current = { key: fkey, canvas: null };
      }
      fusCanvas = fusRef.current.canvas;
      fusNote = fusCanvas ? `FÜZYON · ${fusion.series.modality} ${fusion.series.description} · %${Math.round(fusion.alpha * 100)}` : "Füzyon: konum bilgisi (IPP/IOP/FrameOfReference) uyuşmuyor";
    }

    const { scale, ox, oy, dispW, dispH } = getTransform();
    const drawLayer = (cv: HTMLCanvasElement | null) => {
      if (!cv) return;
      ctx.save();
      ctx.imageSmoothingEnabled = scale < 3;
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      ctx.translate(dispW / 2, dispH / 2);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(cv, -W / 2, -H / 2, W, H);
      ctx.restore();
    };

    // Taban katmanı: GPU varsa GPU tuvali; yoksa CPU LUT tuvali.
    // Not: `drawImage` kaynak tuvali o an kopyalar — GPU tuvali sonraki karede
    // yeniden kullanılsa da bu karedeki çizim doğru kalır.
    drawLayer(gpuBase ?? baseCache.current.get(key)?.canvas ?? null);
    if (fusCanvas) drawLayer(fusCanvas);
    if (ovCanvas) drawLayer(ovCanvas);
    if (heatCanvas) drawLayer(heatCanvas);

    const toC = (p: Pt) => {
      const d = imgToDisp(p);
      return { x: ox + d.x * scale, y: oy + d.y * scale };
    };
    const now = performance.now();

    // 3. DICOM Overlays (6000..601E)
    if (showDicomOverlays && series.overlays && series.overlays.length > 0) {
      for (const ov of series.overlays) {
        if (ov.visible === false) continue;
        ctx.save();
        ctx.fillStyle = ov.type === "R" ? "rgba(239, 68, 68, 0.85)" : "rgba(34, 197, 94, 0.85)"; // Red for ROI, Green for Graphics
        const ox0 = ov.originX - 1;
        const oy0 = ov.originY - 1;
        const oRows = ov.rows;
        const oCols = ov.cols;

        for (let r = 0; r < oRows; r++) {
          for (let c = 0; c < oCols; c++) {
            if (ov.data[r * oCols + c]) {
              const pt = toC({ x: ox0 + c, y: oy0 + r });
              ctx.fillRect(pt.x, pt.y, Math.max(1, scale), Math.max(1, scale));
            }
          }
        }
        ctx.restore();
      }
    }

    // 4. DICOM GSPS Presentation States
    if (series.gsps && series.gsps.length > 0) {
      for (const gs of series.gsps) {
        ctx.save();
        ctx.strokeStyle = "#a855f7";
        ctx.fillStyle = "#a855f7";
        ctx.lineWidth = 1.8;

        for (const gr of gs.graphics) {
          if (gr.type === "ELLIPSE" && gr.data.length >= 4) {
            const [cx0, cy0, rx0, ry0] = gr.data;
            const cPt = toC({ x: cx0, y: cy0 });
            ctx.beginPath();
            ctx.ellipse(cPt.x, cPt.y, rx0 * scale, ry0 * scale, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (gr.type === "POLYLINE" && gr.data.length >= 4) {
            ctx.beginPath();
            for (let i = 0; i < gr.data.length; i += 2) {
              const pt = toC({ x: gr.data[i], y: gr.data[i + 1] });
              if (i === 0) ctx.moveTo(pt.x, pt.y);
              else ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
          }
        }

        for (const tx of gs.texts) {
          if (tx.anchorPoint) {
            const pt = toC(tx.anchorPoint);
            ctx.font = "bold 11px ui-monospace, monospace";
            ctx.fillText(tx.text, pt.x, pt.y);
          }
        }
        ctx.restore();
      }
    }

    // 5. AI Bulgu Kutuları
    for (const f of findings) {
      if (!revealedIds.has(f.id) || slice < f.sliceStart || slice > f.sliceEnd) continue;
      const box = f.sliceBoxes?.[slice] ?? f.bbox;
      if (!box) continue;
      const col = SEV_COLOR[f.severity] ?? "#4cc9f0";
      const p1 = toC({ x: box.x * W, y: box.y * H });
      const p2 = toC({ x: (box.x + box.w) * W, y: (box.y + box.h) * H });
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y), bw = Math.abs(p2.x - p1.x), bh = Math.abs(p2.y - p1.y);
      const active = f.id === activeFindingId || slice === f.sliceIndex;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.globalAlpha = active ? 1 : 0.6 + 0.3 * (0.55 + 0.45 * Math.sin(now / 280));
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash(active ? [] : [6, 4]);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.95;
      ctx.font = "bold 11px ui-monospace, monospace";
      const txt = `[Kesit ${f.keySliceNumber}] ${f.label}${fmtConfShort(f) ? ` · ${fmtConfShort(f)}` : ""}`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = "rgba(5,8,12,0.9)";
      ctx.fillRect(x, y - 20, tw + 14, 18);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.strokeRect(x, y - 20, tw + 14, 18);
      ctx.fillStyle = col;
      ctx.fillText(txt, x + 7, y - 7);
      ctx.restore();
    }

    // 6. Kullanıcı Ölçümleri (Uzunluk, Açı, Cobb, ROI, Ok vb.)
    ctx.save();
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.lineWidth = 1.5;
    const dot = (p: { x: number; y: number }) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); };
    const text = (s: string, p: { x: number; y: number }) => {
      const w = ctx.measureText(s).width;
      ctx.save(); ctx.fillStyle = "rgba(5,8,12,0.75)"; ctx.fillRect(p.x + 5, p.y - 14, w + 6, 14); ctx.restore();
      ctx.fillText(s, p.x + 8, p.y - 3);
    };

    const drawAnn = (a: { kind: Annotation["kind"]; points: Pt[]; text?: string; stats?: Annotation["stats"] }, temp: boolean) => {
      const P = a.points.map(toC);
      const color = (a.kind as string) === "msk" ? "#a78bfa" : a.kind === "length" || a.kind === "calib" ? "#ffd60a" : a.kind === "angle" || a.kind === "cobb" ? "#ff66c4" : a.kind === "arrow" ? "#7dd3fc" : a.kind === "deviation" ? "#fb923c" : a.kind === "ellipsoid" ? "#34d399" : "#b388ff";
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.setLineDash(temp || a.kind === "calib" ? [5, 3] : []);
      ctx.beginPath();
      if ((a.kind as string) === "msk") {
        P.forEach((q, i) => { dot(q); ctx.fillText(String(i + 1), q.x + 6, q.y - 6); });
        ctx.beginPath();
        P.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      }
      else if (a.kind === "length" || a.kind === "calib" || a.kind === "arrow") { ctx.moveTo(P[0].x, P[0].y); if (P[1]) ctx.lineTo(P[1].x, P[1].y); }
      else if (a.kind === "deviation") {
        ctx.moveTo(P[0].x, P[0].y); if (P[1]) ctx.lineTo(P[1].x, P[1].y);
        if (P[2] && a.points[1]) {
          const d = perpendicular(a.points[0], a.points[1], a.points[2]);
          const F = toC(d.foot);
          ctx.stroke(); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(P[2].x, P[2].y); ctx.lineTo(F.x, F.y);
        }
      }
      else if (a.kind === "angle") { ctx.moveTo(P[0].x, P[0].y); if (P[1]) ctx.lineTo(P[1].x, P[1].y); if (P[2]) ctx.lineTo(P[2].x, P[2].y); }
      else if (a.kind === "cobb") { ctx.moveTo(P[0].x, P[0].y); if (P[1]) ctx.lineTo(P[1].x, P[1].y); if (P[2]) { ctx.moveTo(P[2].x, P[2].y); if (P[3]) ctx.lineTo(P[3].x, P[3].y); } }
      else if (a.kind === "rect" && P[1]) {
        const c1 = toC({ x: a.points[0].x, y: a.points[0].y }), c2 = toC({ x: a.points[1].x, y: a.points[1].y });
        const q = [c1, toC({ x: a.points[1].x, y: a.points[0].y }), c2, toC({ x: a.points[0].x, y: a.points[1].y })];
        ctx.moveTo(q[0].x, q[0].y); q.slice(1).forEach((s) => ctx.lineTo(s.x, s.y)); ctx.closePath();
      } else if ((a.kind === "ellipse" || a.kind === "ellipsoid") && P[1]) {
        const cx = (a.points[0].x + a.points[1].x) / 2, cy = (a.points[0].y + a.points[1].y) / 2;
        const rx = Math.abs(a.points[1].x - a.points[0].x) / 2, ry = Math.abs(a.points[1].y - a.points[0].y) / 2;
        for (let t = 0; t <= 48; t++) {
          const s = toC({ x: cx + rx * Math.cos((t / 48) * Math.PI * 2), y: cy + ry * Math.sin((t / 48) * Math.PI * 2) });
          if (t === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
      } else if (a.kind === "polygon") {
        P.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)));
        if (!temp) ctx.closePath();
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (a.kind !== "rect" && a.kind !== "ellipse" && a.kind !== "ellipsoid") P.forEach(dot);
      if (a.kind === "arrow" && P[1]) {
        const ang = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x);
        ctx.beginPath(); ctx.moveTo(P[1].x, P[1].y);
        ctx.lineTo(P[1].x - 10 * Math.cos(ang - Math.PI / 6), P[1].y - 10 * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(P[1].x - 10 * Math.cos(ang + Math.PI / 6), P[1].y - 10 * Math.sin(ang + Math.PI / 6));
        ctx.closePath(); ctx.fill();
      }
      if (!temp) {
        const full = a as Annotation;
        const anchor = a.kind === "angle" ? P[1] : a.kind === "deviation" ? P[2] : a.kind === "arrow" ? P[1] : a.kind === "length" ? { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 } : P[P.length - 1];
        const s = annotationSummary(full, pxMm, series.unit, suvFactor);
        if (s && anchor) text(s, anchor);
      }
    };

    for (const a of annotations) if (a.slice === slice) drawAnn(a, false);
    if (draft?.mode === "drag") drawAnn({ kind: draft.tool as Annotation["kind"], points: [draft.a, draft.b] }, true);
    if (draft?.mode === "multi") drawAnn({ kind: draft.tool as Annotation["kind"], points: [...draft.pts, draft.cursor] }, true);
    ctx.restore();

    // 6b. Çapraz referans çizgileri (diğer panellerin kesit düzlemleri)
    if (panelId) {
      for (const rl of refLinesFor(panelId, series, slice)) {
        const a = toC(rl.a), b = toC(rl.b);
        ctx.save();
        ctx.strokeStyle = rl.color; ctx.fillStyle = rl.color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9; ctx.setLineDash([8, 5]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = "600 10px ui-monospace, monospace";
        ctx.fillText(rl.label.slice(0, 28), Math.max(4, Math.min(size.w - 120, a.x + 6)), Math.max(12, Math.min(size.h - 6, a.y - 4)));
        ctx.restore();
      }
    }
    if (fusNote) {
      ctx.save(); ctx.font = "700 10.5px ui-monospace, monospace"; ctx.fillStyle = fusCanvas ? "#fbbf24" : "#f87171";
      ctx.fillText(fusNote, 10, size.h - 26); ctx.restore();
    }

    // 7. AI Tarama Çizgisi
    if (scan?.active) {
      const lineY = oy + dispH * scale * scan.sliceProgress;
      const grad = ctx.createLinearGradient(0, oy, 0, lineY);
      grad.addColorStop(0, "rgba(46,230,168,0.02)");
      grad.addColorStop(1, "rgba(46,230,168,0.14)");
      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(ox, oy, dispW * scale, Math.max(0, lineY - oy));
      ctx.strokeStyle = "rgba(46,230,168,0.95)"; ctx.shadowColor = "#2ee6a8"; ctx.shadowBlur = 14; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ox, lineY); ctx.lineTo(ox + dispW * scale, lineY); ctx.stroke();
      ctx.restore();
    }
  }, [series, slice, wl, ww, invert, size, getTransform, imgToDisp, fusion, panelId, registryVersion, suvFactor, findings, revealedIds, activeFindingId, overlay, showDicomOverlays, annotations, draft, scan, rotation, flipH, flipV, pxMm, renderTick]);

  // Nabız animasyonu
  const animate = !!scan?.active || (!!series && findings.some((f) => f.bbox && revealedIds.has(f.id) && slice >= f.sliceStart && slice <= f.sliceEnd));
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      // 20 fps nabız yeterlidir; her görüntü panelini 60 fps React render'a zorlamayın.
      if (now - last >= 50) { last = now; setTick((t) => (t + 1) % 1e6); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // Esc iptal / Enter çokgeni bitir
  const finishPolygon = useCallback((pts: Pt[]) => {
    if (!series || pts.length < 3) { setDraft(null); return; }
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const st = regionStats(series, slice, { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, (x, y) => pointInPolygon(x, y, pts));
    if (st) onAddAnnotation?.({ kind: "polygon", slice, points: pts, stats: st });
    setDraft(null);
  }, [series, slice, onAddAnnotation]);

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDraft(null);
      if (e.key === "Enter" && draft.mode === "multi" && draft.tool === "polygon") finishPolygon(draft.pts);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, finishPolygon]);

  // Kesit/seri/araç değişince çizim taslağını sıfırla (render sırasında korumalı durum güncellemesi).
  const [prevDraftKey, setPrevDraftKey] = useState(`${slice}-${series?.id ?? ""}-${tool}`);
  {
    const k = `${slice}-${series?.id ?? ""}-${tool}`;
    if (prevDraftKey !== k) { setPrevDraftKey(k); setDraft(null); }
  }

  // ───────── Etkileşimler ─────────
  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  };
  const annTool = !readOnly && (DRAG_TOOLS.includes(tool) || tool === "angle" || tool === "cobb" || tool === "deviation" || tool === "polygon" || tool === "msk");

  const onDown = (e: React.PointerEvent) => {
    if (!series) return;
    const { cx, cy } = local(e);
    const p = canvasToImg(cx, cy);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Dokunmatik: iki parmak jest moduna geçer (kıstırma + kaydırma).
    if (e.pointerType === "touch") {
      touchesRef.current.set(e.pointerId, { x: cx, y: cy });
      if (touchesRef.current.size >= 2) {
        pinchRef.current = pinchOf(Array.from(touchesRef.current.values()));
        dragRef.current = null;
        setDraft(null);
        return;
      }
    }
    // 3B imleç: tıklanan noktanın hasta koordinatında aynı çerçevedeki diğer panelleri günceller.
    if (e.button === 0 && tool === "xref") {
      const pl = planeOf(series, slice);
      if (pl && panelId) jumpToPatient(panelId, toPatient(pl, p.x, p.y));
      return;
    }
    if (e.button === 0 && annTool && e.pointerType !== "touch") {
      if (DRAG_TOOLS.includes(tool)) setDraft({ mode: "drag", tool, a: p, b: p });
      else if (tool === "msk") {
        const need = Math.max(1, mskPointCount || 3);
        const prev = draft?.mode === "multi" && draft.tool === tool ? draft.pts : [];
        let np = p;
        if (snapRadius > 0 && series && series.slices[slice]) {
          np = snapPoint(series.slices[slice], series.width, series.height, p, snapRadius, "edge");
        }
        const pts = [...prev, np];
        if (pts.length >= need) {
          onMskPoints?.(pts.slice(0, need), slice);
          setDraft(null);
        } else setDraft({ mode: "multi", tool, pts, cursor: np });
      }
      else {
        const need = MULTI_NEED[tool];
        const prev = draft?.mode === "multi" && draft.tool === tool ? draft.pts : [];
        if (tool === "polygon" && prev.length >= 3 && dist(toScreen(prev[0]), { x: cx, y: cy }) < 9) { finishPolygon(prev); return; }
        const pts = [...prev, p];
        if (need && pts.length === need) {
          onAddAnnotation?.({ kind: tool as "angle" | "cobb" | "deviation", slice, points: pts });
          setDraft(null);
        } else setDraft({ mode: "multi", tool, pts, cursor: p });
      }
      return;
    }
    // Dokunmatikte tek parmak kaydırır (araç `wl` olsa bile); farede davranış aynı.
    dragRef.current = { button: e.pointerType === "touch" ? 1 : e.button, sx: cx, sy: cy, wl, ww, zoom, pan: { ...pan } };
  };

  const toScreen = (p: Pt) => {
    const { scale, ox, oy } = getTransform();
    const d = imgToDisp(p);
    return { x: ox + d.x * scale, y: oy + d.y * scale };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!series) return;
    const { cx, cy } = local(e);
    const p = canvasToImg(cx, cy);
    const inside = p.x >= 0 && p.y >= 0 && p.x < series.width && p.y < series.height;
    onHover?.(inside ? series.slices[slice][Math.floor(p.y) * series.width + Math.floor(p.x)] : null);
    if (e.pointerType === "touch" && touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x: cx, y: cy });
      if (touchesRef.current.size >= 2) {
        const next = pinchOf(Array.from(touchesRef.current.values()));
        const step = gestureStep(pinchRef.current, next);
        pinchRef.current = next;
        const st = applyGesture({ zoom, pan }, step);
        if (step.zoom !== 1) onZoom(st.zoom);
        if (step.dx || step.dy) onPan(st.pan);
        return;
      }
    }
    if (draft?.mode === "multi") setDraft({ ...draft, cursor: p });
    else if (draft?.mode === "drag") setDraft({ ...draft, b: p });
    const d = dragRef.current;
    if (!d) return;
    const dx = cx - d.sx, dy = cy - d.sy;
    const eff: ToolName = d.button === 1 ? "pan" : d.button === 2 ? "zoom" : tool;
    if (eff === "wl" && !series.isColor) onWL(d.wl + dy * (series.unit === "HU" ? 2 : 4), Math.max(1, d.ww + dx * (series.unit === "HU" ? 4 : 6)));
    else if (eff === "pan") onPan({ x: d.pan.x + dx, y: d.pan.y + dy });
    else if (eff === "zoom") onZoom(Math.min(12, Math.max(0.15, d.zoom * Math.exp(-dy / 180))));
  };

  const onUp = (e?: React.PointerEvent) => {
    if (e) {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) pinchRef.current = null;
      if (touchesRef.current.size > 0) { dragRef.current = null; return; }
    }
    dragRef.current = null;
    if (!series || draft?.mode !== "drag") return;
    const { a, b, tool: t } = draft;
    setDraft(null);
    if (dist(a, b) < 2) return;
    if (t === "length") onAddAnnotation?.({ kind: "length", slice, points: [a, b] });
    else if (t === "calib") onCalibrate?.(dist(a, b));
    else if (t === "arrow") onAddAnnotation?.({ kind: "arrow", slice, points: [a, b], text: window.prompt("Ok notu (isteğe bağlı)", "") ?? "" });
    else if (t === "rect") {
      const st = regionStats(series, slice, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, () => true);
      if (st) onAddAnnotation?.({ kind: "rect", slice, points: [a, b], stats: st });
    } else if (t === "ellipsoid") {
      const cxx = (a.x + b.x) / 2, cyy = (a.y + b.y) / 2;
      const st = regionStats(series, slice, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, ellipseTest(cxx, cyy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2));
      const d1 = Math.abs(b.x - a.x) * pxMm, d2 = Math.abs(b.y - a.y) * pxMm;
      const def = ((d1 + d2) / 2).toFixed(1);
      const ans = window.prompt(`Elipsoid hacmi: 3. eksen çapı (mm) — örn. kraniokaudal ölçü.\nBoş bırakılırsa ortalama (${def} mm) kullanılır.`, def);
      const d3 = parseFloat((ans ?? "").replace(",", "."));
      onAddAnnotation?.({ kind: "ellipsoid", slice, points: [a, b], text: Number.isFinite(d3) && d3 > 0 ? String(d3) : def, stats: st ?? undefined });
    } else if (t === "ellipse") {
      const cxx = (a.x + b.x) / 2, cyy = (a.y + b.y) / 2;
      const st = regionStats(series, slice, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, ellipseTest(cxx, cyy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2));
      if (st) onAddAnnotation?.({ kind: "ellipse", slice, points: [a, b], stats: st });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!series) return;
    if (e.ctrlKey || e.metaKey) onZoom(Math.min(12, Math.max(0.15, zoom * (e.deltaY > 0 ? 0.9 : 1.1))));
    else onSlice(Math.max(0, Math.min(series.slices.length - 1, slice + (e.deltaY > 0 ? 1 : -1))));
  };

  const current = findings.filter((f) => revealedIds.has(f.id) && slice >= f.sliceStart && slice <= f.sliceEnd && f.category !== "Sistem");

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-[#07090c]" style={{ touchAction: "none" }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: tool === "pan" ? "grab" : "crosshair" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => onHover?.(null)}
        onDoubleClick={() => { if (draft?.mode === "multi" && draft.tool === "polygon") finishPolygon(draft.pts.slice(0, -1).length >= 3 ? draft.pts.slice(0, -1) : draft.pts); }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {label && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-violet-200">{label}</div>}
      <button
        type="button"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Tam ekrandan çık (Esc)" : "Bu paneli tam ekran yap"}
        aria-label={isFullscreen ? "Tam ekrandan çık" : "Paneli tam ekran yap"}
        className="absolute right-2 top-2 z-10 rounded border border-[#243044] bg-black/60 px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-cyan-400/60 hover:text-cyan-200"
      >{isFullscreen ? "⤡" : "⛶"}</button>
      {current.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-12 flex -translate-x-1/2 flex-col items-center gap-1">
          {current.map((cf) => (
            <div key={cf.id} className="flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold shadow-lg backdrop-blur-md" style={{ background: "rgba(11,15,22,0.9)", border: `1.5px solid ${SEV_COLOR[cf.severity] ?? "#22d3ee"}`, color: SEV_COLOR[cf.severity] ?? "#22d3ee" }}>
              🔍 KESİT {cf.keySliceNumber}{slice === cf.sliceIndex ? " (en belirgin)" : ""}: {cf.label}
            </div>
          ))}
        </div>
      )}
      {draft?.mode === "multi" && (
        <div className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded bg-black/70 px-3 py-1 text-[11px] text-slate-200">
          {draft.tool === "polygon" ? "Çokgen: noktalara tıklayın · çift tık/Enter: bitir · Esc: iptal" : draft.tool === "deviation" ? `Sapma: ${["1. referans noktası", "2. referans noktası", "ölçülecek nokta"][draft.pts.length] ?? ""} · Esc: iptal` : `${draft.pts.length}/${MULTI_NEED[draft.tool]} nokta · Esc: iptal`}
        </div>
      )}
    </div>
  );
}
