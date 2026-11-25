"use client";

/**
 * Etkileşimli segmentasyon düzenleyici (m-seg).
 *
 * - Fırça / silgi: dairesel, sürüklemede kesintisiz iz (`paintStroke`).
 * - Eşik dolgusu: HU aralığındaki pikselleri kesite ekler.
 * - Bölge büyütme: tıklanan tohumdan 4-komşuluk flood fill.
 * - Kesit kopyalama, kesit/tüm maske temizleme, geri al (12 adım).
 * - Hacim (mL) ve kesit profili; DICOM SEG / RTSTRUCT indirme.
 *
 * Sınırlar açıkça gösterilir: maske hekim düzenlemesidir, rapora otomatik
 * yazılmaz; RTSTRUCT konturları satır taramasıyla üretilir (dış zarfa yaklaşır).
 *
 * Bileşen yalnızca açıkken bağlanır (üst bileşen koşullu render eder); böylece
 * her oturum taze maske durumuyla başlar ve kapalıyken maliyet oluşturmaz.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SeriesData } from "@/lib/types";
import { buildWindowLUT, windowToRGBA } from "@/lib/window";
import { buildRtStruct, buildSegDocument } from "@/lib/dicomSeg";
import {
  DEFAULT_SEGMENT_COLORS, cloneMask, copySlice, emptyMask, growRegion, makeSegmentDef,
  paint, paintStroke, prune, screenToImage, segmentSummary, slicePixelCount, thresholdFill, volume,
  type SegMask, type SegmentDef, type VolumeResult,
} from "@/lib/segmentation";

export interface SegEditorState {
  seriesId: string;
  mask: SegMask;
  def: SegmentDef;
  opacity: number;
  volume: VolumeResult;
}

/** AI aday maskesi: bulgu kimliği + etiket + seri uzayında maske. */
export interface SegCandidate {
  id: string;
  label: string;
  mask: SegMask;
}

interface Props {
  series: SeriesData;
  slice: number;
  wl: number;
  ww: number;
  invert: boolean;
  pxMm: number;
  initial?: SegEditorState | null;
  /** Vision AI aday maskeleri (tohumlama); boşsa bölüm "aday yok" der. */
  candidates?: SegCandidate[];
  onApply: (state: SegEditorState | null) => void;
  onClose: () => void;
  toast: (m: string, ms?: number) => void;
}

type Tool = "brush" | "erase" | "threshold" | "grow";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function SegmentationEditor({ series, slice, wl, ww, invert, pxMm, initial, candidates = [], onApply, onClose }: Props) {
  const reusable = initial && initial.seriesId === series.id && initial.mask.width === series.width && initial.mask.height === series.height;
  const [seg, setSeg] = useState<{ mask: SegMask; v: number }>(() => ({
    mask: reusable ? cloneMask(initial!.mask) : emptyMask(series.width, series.height),
    v: 0,
  }));
  const [localSlice, setLocalSlice] = useState(() => clamp(slice, 0, series.slices.length - 1));
  const [tool, setTool] = useState<Tool>("brush");
  const [radius, setRadius] = useState(6);
  const [lo, setLo] = useState(-200);
  const [hi, setHi] = useState(300);
  const [label, setLabel] = useState(() => initial?.def.label ?? "Hekim segmenti");
  const [colorIdx, setColorIdx] = useState(0);
  const [opacity, setOpacity] = useState(() => initial?.opacity ?? 0.45);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [msg, setMsg] = useState("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const maskRef = useRef<SegMask>(seg.mask);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<SegMask[]>([]);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const geo = useMemo(() => ({
    px: pxMm > 0 ? pxMm : 1,
    py: series.pixelSpacing > 0 ? series.pixelSpacing : undefined,
    sliceThickness: series.sliceThickness > 0 ? series.sliceThickness : 1,
    sliceSpacing: series.sliceSpacing,
  }), [pxMm, series.pixelSpacing, series.sliceThickness, series.sliceSpacing]);

  const def = useMemo<SegmentDef>(() => {
    const d = makeSegmentDef(1, label || "Hekim segmenti", "MANUAL");
    d.color = DEFAULT_SEGMENT_COLORS[colorIdx % DEFAULT_SEGMENT_COLORS.length];
    d.algorithmName = "AtikViewer maske düzenleyici";
    return d;
  }, [label, colorIdx]);

  const stats = useMemo(() => ({
    volume: volume(seg.mask, geo),
    slices: seg.mask.slices.size,
    pixels: slicePixelCount(seg.mask, localSlice),
    summary: segmentSummary(label || "Segment", volume(seg.mask, geo)),
  }), [seg, geo, localSlice, label]);

  /** Yeni maske durumunu ref + state olarak yazar (çizim ve hacim aynı veriyi görür). */
  const commitMask = useCallback((next: SegMask) => {
    prune(next);
    maskRef.current = next;
    setSeg((s) => ({ mask: next, v: s.v + 1 }));
  }, []);

  const snapshot = useCallback(() => {
    undoRef.current.push(cloneMask(maskRef.current));
    if (undoRef.current.length > 12) undoRef.current.shift();
  }, []);

  const finish = useCallback(() => {
    if (maskRef.current.slices.size > 0) {
      onApply({ seriesId: series.id, mask: cloneMask(maskRef.current), def, opacity, volume: volume(maskRef.current, geo) });
    } else {
      onApply(null);
    }
    onClose();
  }, [series.id, onApply, onClose, def, opacity, geo]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setLocalSlice((s) => Math.max(0, s - 1)); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setLocalSlice((s) => Math.min(series.slices.length - 1, s + 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, series.slices.length]);

  const brushColor = DEFAULT_SEGMENT_COLORS[colorIdx % DEFAULT_SEGMENT_COLORS.length];

  /** Tuval: pencere/seviye + maske harmanı; imleç halkası ayrıca çizilir. */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const W = series.width, H = series.height;
    const sliceIdx = clamp(localSlice, 0, series.slices.length - 1);
    const pixels = series.slices[sliceIdx];
    const key = `${series.id}|${sliceIdx}|${Math.round(wl)}|${Math.round(ww)}|${invert}|${seg.v}|${colorIdx}|${Math.round(opacity * 100)}`;

    if (!compositeRef.current || compositeRef.current.key !== key) {
      const c = compositeRef.current?.canvas ?? document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d")!;
      if (!pixels) {
        ctx.clearRect(0, 0, W, H);
      } else {
        let u32: Uint32Array;
        if (series.isColor && series.rgbaSlices?.[sliceIdx]) {
          u32 = Uint32Array.from(series.rgbaSlices[sliceIdx]);
        } else {
          const { lut, lo: winLo } = buildWindowLUT(wl, ww, invert);
          u32 = windowToRGBA(pixels, lut, winLo);
        }
        const mk = seg.mask.width === W && seg.mask.height === H ? seg.mask.slices.get(sliceIdx) : undefined;
        if (mk) {
          const [r, g, b] = brushColor;
          const a = Math.round(clamp(opacity, 0, 1) * 255);
          const inv = 255 - a;
          for (let i = 0; i < mk.length && i < u32.length; i++) {
            if (!mk[i]) continue;
            const base = u32[i];
            const br = base & 0xff, bg = (base >> 8) & 0xff, bb = (base >> 16) & 0xff;
            const nr = (br * inv + r * a) / 255, ng = (bg * inv + g * a) / 255, nb = (bb * inv + b * a) / 255;
            u32[i] = 0xff000000 | ((nb | 0) << 16) | ((ng | 0) << 8) | (nr | 0);
          }
        }
        const img = ctx.createImageData(W, H);
        new Uint32Array(img.data.buffer).set(u32);
        ctx.putImageData(img, 0, 0);
      }
      compositeRef.current = { key, canvas: c };
    }

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(compositeRef.current.canvas, 0, 0);
    if (cursor) {
      const { x, y } = cursor;
      ctx.save();
      ctx.strokeStyle = tool === "erase" ? "rgba(255,120,120,0.95)" : tool === "brush" ? "rgba(0,255,255,0.95)" : "rgba(255,215,0,0.95)";
      ctx.lineWidth = 1.5;
      if (tool === "brush" || tool === "erase") {
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2); ctx.stroke();
      } else {
        const d = 9;
        ctx.beginPath(); ctx.moveTo(x - d, y); ctx.lineTo(x + d, y); ctx.moveTo(x, y - d); ctx.lineTo(x, y + d); ctx.stroke();
      }
      ctx.restore();
    }
  }, [series, localSlice, wl, ww, invert, seg, colorIdx, opacity, cursor, tool, radius, brushColor]);

  const toImage = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget;
    return screenToImage({ x: e.clientX, y: e.clientY }, cv.getBoundingClientRect(), cv.width, cv.height);
  };

  const huSlice = () => series.slices[clamp(localSlice, 0, series.slices.length - 1)];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toImage(e);
    setCursor(pt);
    snapshot();
    if (tool === "threshold" || tool === "grow") {
      const next = cloneMask(maskRef.current);
      if (tool === "threshold") {
        const n = thresholdFill(next, localSlice, huSlice(), Math.min(lo, hi), Math.max(lo, hi));
        setMsg(n > 0 ? `Eşik dolgusu: ${n} piksel eklendi (${Math.min(lo, hi)}…${Math.max(lo, hi)} HU).` : "Eşik aralığında piksel yok; HU değerlerini kontrol edin.");
      } else {
        const n = growRegion(next, localSlice, huSlice(), { x: Math.round(pt.x), y: Math.round(pt.y) }, Math.min(lo, hi), Math.max(lo, hi));
        setMsg(n > 0 ? `Bölge büyütme: ${n} piksel eklendi.` : "Tohum noktası eşik aralığında değil; başka nokta deneyin.");
      }
      commitMask(next);
      return;
    }
    const next = cloneMask(maskRef.current);
    paint(next, localSlice, pt.x, pt.y, radius, tool === "erase");
    commitMask(next);
    drawingRef.current = true;
    lastRef.current = pt;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toImage(e);
    setCursor(pt);
    if (!drawingRef.current) return;
    const last = lastRef.current ?? pt;
    const next = cloneMask(maskRef.current);
    paintStroke(next, localSlice, last, pt, radius, tool === "erase");
    commitMask(next);
    lastRef.current = pt;
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) { setMsg("Geri alınacak adım yok."); return; }
    commitMask(prev);
    setMsg("Son adım geri alındı.");
  };

  const clearSlice = () => {
    snapshot();
    const next = cloneMask(maskRef.current);
    next.slices.delete(localSlice);
    commitMask(next);
    setMsg(`Kesit ${localSlice + 1} temizlendi.`);
  };

  const copyPrev = () => {
    if (localSlice <= 0) { setMsg("İlk kesitten kopyalanacak önceki kesit yok."); return; }
    snapshot();
    const next = cloneMask(maskRef.current);
    if (!copySlice(next, localSlice - 1, localSlice)) { setMsg("Önceki kesitte maske yok."); return; }
    commitMask(next);
    setMsg(`Kesit ${localSlice} maskesi kesit ${localSlice + 1}'e kopyalandı.`);
  };

  /**
   * AI aday maskesini düzenlemeye açar (tohumlama).
   *
   * AI önerisi DEĞİŞTİRİLMEZ: çalışma maskesine kopya alınır, hekim düzenler.
   * Kopya olduğu için geri alınabilir ve kaydedilen maske hekim sorumluluğundadır;
   * rapora AI bulgusu olarak yazılmaz.
   */
  const seedFromCandidate = (c: SegCandidate) => {
    if (c.mask.width !== series.width || c.mask.height !== series.height) {
      setMsg("AI aday maskesinin boyutu bu seriyle uyuşmuyor; tohumlama yapılmadı.");
      return;
    }
    snapshot();
    const next = cloneMask(c.mask);
    commitMask(next);
    setLabel((prev) => (prev.startsWith("AI tohumlu") ? prev : `AI tohumlu · ${c.label}`.slice(0, 64)));
    setMsg(`AI adayı “${c.label}” düzenlemeye alındı (${next.slices.size} kesit). AI önerisi değişmez; maske hekim düzenlemesidir.`);
  };

  const clearAll = () => {
    snapshot();
    commitMask(emptyMask(series.width, series.height));
    onApply(null);
    setMsg("Maske temizlendi.");
  };

  const canExport = !!(series.seriesUid && series.sopClassUid && series.sopUids?.length);
  const exportDoc = (kind: "seg" | "rtstruct") => {
    if (!canExport) { setMsg("Bu seride SOP Instance UID bilgisi yok; SEG/RTSTRUCT yalnızca gerçek DICOM serileri için üretilir."); return; }
    if (!maskRef.current.slices.size) { setMsg("Maske boş; önce bir segment çizin."); return; }
    const base = {
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex,
      studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      source: { seriesUid: series.seriesUid!, sopClassUid: series.sopClassUid!, sopUids: series.sopUids! },
      frameOfReferenceUid: series.frameOfRef,
      geometry: {
        pxMm: geo.px,
        pyMm: geo.py ?? geo.px,
        dz: geo.sliceSpacing && geo.sliceSpacing > 0 ? geo.sliceSpacing : geo.sliceThickness,
        origin: (series.ipp?.[0] ?? [0, 0, 0]) as [number, number, number],
      },
      width: series.width, height: series.height,
    };
    const bytes = kind === "seg"
      ? buildSegDocument({ ...base, segments: [{ def, mask: maskRef.current }] })
      : buildRtStruct({ ...base, rois: [{ def, mask: maskRef.current }] });
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind === "seg" ? "SEG" : "RTSTRUCT"}-${series.modality}-${maskRef.current.slices.size}-kesit.dcm`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg(`${kind === "seg" ? "DICOM SEG" : "RTSTRUCT"} indirildi (${maskRef.current.slices.size} kesit). Hekim düzenlemesine açıktır.`);
  };

  const btn = "cursor-pointer rounded-md border px-2 py-1 text-[11px] font-bold";
  const toolBtn = (t: Tool, text: string, hint: string) => (
    <button
      type="button"
      aria-pressed={tool === t}
      title={hint}
      onClick={() => setTool(t)}
      className={`${btn} ${tool === t ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100" : "border-[#223047] text-slate-300 hover:bg-white/5"}`}
    >{text}</button>
  );

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/75 p-2" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(); }}>
      <div
        role="dialog" aria-modal="true" aria-labelledby="seg-title"
        className="flex max-h-[95vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#223047] bg-[#0b1018] shadow-2xl"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a2230] px-3 py-2">
          <div>
            <h2 id="seg-title" className="text-sm font-black text-cyan-300">🧩 Segmentasyon düzenleyici — {series.description || series.modality}</h2>
            <p className="text-[10px] text-slate-400">Hekim düzenlemesi; rapora otomatik yazılmaz. AI aday örtüsü düzenlenebilir maske değildir.</p>
          </div>
          <div className="flex items-center gap-2">
            <button ref={closeRef} type="button" onClick={finish} className={`${btn} border-cyan-400/50 bg-cyan-500/15 text-cyan-100`}>Uygula ve kapat</button>
            <button type="button" onClick={() => { onApply(null); onClose(); }} className={`${btn} border-rose-400/40 text-rose-200`}>Segmenti kaldır</button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 md:flex-row">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <canvas
              ref={canvasRef}
              width={series.width}
              height={series.height}
              role="img"
              aria-label={`Segment düzenleme tuvali, kesit ${localSlice + 1}`}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={() => setCursor(null)}
              className="max-h-[58vh] w-auto max-w-full cursor-crosshair touch-none rounded border border-[#223047] bg-black"
              style={{ imageRendering: "pixelated" }}
            />
            <div className="flex w-full flex-wrap items-center gap-2">
              <button type="button" onClick={() => setLocalSlice((s) => Math.max(0, s - 1))} className={`${btn} border-[#223047] text-slate-200`} aria-label="Önceki kesit">←</button>
              <input
                type="range" min={0} max={series.slices.length - 1} value={localSlice}
                onChange={(e) => setLocalSlice(Number(e.target.value))}
                aria-label="Kesit" className="min-w-[120px] flex-1 cursor-pointer"
              />
              <button type="button" onClick={() => setLocalSlice((s) => Math.min(series.slices.length - 1, s + 1))} className={`${btn} border-[#223047] text-slate-200`} aria-label="Sonraki kesit">→</button>
              <span className="font-mono text-[11px] text-slate-300">Kesit {localSlice + 1}/{series.slices.length}</span>
            </div>
            <p role="status" aria-live="polite" className="min-h-[1.2em] w-full text-center text-[11px] text-emerald-200">{msg}</p>
          </div>

          <aside className="w-full shrink-0 space-y-3 md:w-[290px]" aria-label="Segmentasyon araçları">
            <section>
              <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">Araç</div>
              <div className="flex flex-wrap gap-1">
                {toolBtn("brush", "🖌 Fırça", "Sürükleyerek boya")}
                {toolBtn("erase", "⌫ Silgi", "Sürükleyerek sil")}
                {toolBtn("threshold", "▦ Eşik", "HU aralığını tek tıkla ekle")}
                {toolBtn("grow", "◍ Bölge büyüt", "Tohumdan bağlantılı bölge")}
              </div>
            </section>

            {(tool === "brush" || tool === "erase") && (
              <label className="block text-[11px] text-slate-300">Fırça yarıçapı: {radius} px
                <input type="range" min={1} max={60} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="mt-1 w-full cursor-pointer" />
              </label>
            )}

            {(tool === "threshold" || tool === "grow") && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-slate-300">Alt HU
                  <input type="number" value={lo} onChange={(e) => setLo(Number(e.target.value))} className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
                </label>
                <label className="block text-[11px] text-slate-300">Üst HU
                  <input type="number" value={hi} onChange={(e) => setHi(Number(e.target.value))} className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
                </label>
              </div>
            )}

            <section className="space-y-1">
              <label className="block text-[11px] text-slate-300">Segment adı
                <input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
              </label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-slate-300">Renk</span>
                {DEFAULT_SEGMENT_COLORS.map((c, i) => (
                  <button key={i} type="button" aria-label={`Renk ${i + 1}`} aria-pressed={colorIdx === i} onClick={() => setColorIdx(i)}
                    className={`h-5 w-5 rounded-full border-2 ${colorIdx === i ? "border-white" : "border-transparent"}`}
                    style={{ backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})` }} />
                ))}
              </div>
              <label className="block text-[11px] text-slate-300">Örtü opaklığı: %{Math.round(opacity * 100)}
                <input type="range" min={5} max={90} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="mt-1 w-full cursor-pointer" />
              </label>
            </section>

            <section>
              <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">AI adayından başlat</div>
              {candidates.length === 0 ? (
                <p className="text-[10px] leading-snug text-slate-500">
                  Aday maske yok. Vision AI analizini çalıştırıp bulguları görünür yapın; aday maskeler burada listelenir.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {candidates.slice(0, 6).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => seedFromCandidate(c)}
                      title={`${c.label} — ${c.mask.slices.size} kesit; düzenlemeye kopyalanır`}
                      className={`${btn} border-cyan-400/40 text-cyan-100`}
                    >{c.label.length > 26 ? `${c.label.slice(0, 26)}…` : c.label}</button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[10px] leading-snug text-slate-500">Tohumlama yalnız kopya alır; AI aday örtüsü değişmez, maske hekim düzenlemesi olarak kalır.</p>
            </section>

            <section>
              <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">Düzenle</div>
              <div className="flex flex-wrap gap-1">
                <button type="button" onClick={undo} className={`${btn} border-[#223047] text-slate-200`}>↶ Geri al</button>
                <button type="button" onClick={clearSlice} className={`${btn} border-[#223047] text-slate-200`}>Kesiti temizle</button>
                <button type="button" onClick={copyPrev} className={`${btn} border-[#223047] text-slate-200`}>Önceki kesitten kopyala</button>
                <button type="button" onClick={clearAll} className={`${btn} border-rose-400/40 text-rose-200`}>Tümünü temizle</button>
              </div>
            </section>

            <section className="rounded-lg border border-[#223047] bg-[#0d141e] p-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Hacim</div>
              <div className="text-lg font-black text-fuchsia-200">{stats.volume.ml.toFixed(2)} <span className="text-[10px] font-normal text-slate-400">mL</span></div>
              <div className="text-[10px] text-slate-400">{stats.volume.voxelCount} voksel · {stats.slices} kesitte maske · bu kesitte {stats.pixels} piksel</div>
              <div className="mt-1 text-[10px] text-slate-500">Hesap: piksel alanı × kesit kalınlığı. Kesit aralığı yoksa kalınlık kullanılır.</div>
            </section>

            <section>
              <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">Dışa aktar</div>
              <div className="flex flex-wrap gap-1">
                <button type="button" onClick={() => exportDoc("seg")} disabled={!canExport} className={`${btn} border-emerald-400/40 text-emerald-200 disabled:opacity-40`}>DICOM SEG</button>
                <button type="button" onClick={() => exportDoc("rtstruct")} disabled={!canExport} className={`${btn} border-emerald-400/40 text-emerald-200 disabled:opacity-40`}>RTSTRUCT</button>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-amber-200/80">
                {canExport
                  ? "RTSTRUCT konturları satır taramasıyla üretilir (konkav segmentlerde dış zarfa yaklaşır). SEG 1 bit/pikseldir."
                  : "Bu seride SOP Instance UID yok (örnek/demo seri); dışa aktarma yalnızca gerçek DICOM serilerinde çalışır."}
              </p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
