"use client";
/**
 * Segmentasyon editörü (m-seg) — elle fırça/silgi, eşik dolgusu, tohumdan bölge
 * büyütme, kesit kopyalama ve hacim (mL) okuması.
 *
 * Çekirdek mantık `src/lib/segmentation.ts` içindedir ve testlidir; bu bileşen
 * yalnız çizim ve etkileşim yapar. Maske seri kimliğiyle tarayıcıda saklanır
 * (`segmask:<seriesId>`); DICOM SEG / RTSTRUCT dışa aktarımı Dışa aktar menüsüne
 * elle çizilen maskeyi de katar.
 *
 * UYARI: Üretilen maske hekim düzenlemesine açıktır, tıbbi cihaz değildir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SeriesData } from "@/lib/types";
import {
  copySlice, emptyMask, growRegion, makeSegmentDef, maskFromJson, maskPixelCount, maskToJson,
  paint, prune, thresholdFill, volume, type SegMask,
} from "@/lib/segmentation";
import { buildRtStruct, buildSegDocument } from "@/lib/dicomSeg";
import { buildWindowLUT } from "@/lib/window";

interface Props {
  series: SeriesData | null;
  slice: number;
  wl: number;
  ww: number;
  invert: boolean;
  pxMm: number;
  onClose: () => void;
  toast: (m: string, ms?: number) => void;
}

type Tool = "brush" | "erase" | "threshold" | "grow";

const MASK_COLOR = "rgba(34,211,238,0.45)";
const storageKey = (id: string) => `segmask:${id}`;

function downloadBytes(bytes: Uint8Array, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export default function SegEditor({ series, slice: activeSlice, wl, ww, invert, pxMm, onClose, toast }: Props) {
  const [slice, setSlice] = useState(activeSlice);
  const [tool, setTool] = useState<Tool>("brush");
  const [radius, setRadius] = useState(6);
  const [lo, setLo] = useState(Math.round(wl - ww / 2));
  const [hi, setHi] = useState(Math.round(wl + ww / 2));
  const [label, setLabel] = useState("Hedef alan");
  const [busy, setBusy] = useState(false);
  // Maske durumda tutulur (ref değil): React kuralları ve lint için tek kaynak.
  // Kesit dizileri yerinde güncellenir, üst nesne değiştirilerek render tetiklenir.
  const [mask, setMask] = useState<SegMask>(() => emptyMask(1, 1));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef<{ down: boolean; last: { x: number; y: number } | null }>({ down: false, last: null });

  const W = series?.width ?? 0;
  const H = series?.height ?? 0;
  const sliceCount = series?.slices.length ?? 0;

  // Maske yükle (seri değişince) ve kesit sınırla.
  useEffect(() => {
    if (!series) return;
    void (async () => {
      let m = emptyMask(series.width, series.height);
      try {
        const raw = localStorage.getItem(storageKey(series.id));
        if (raw) {
          const parsed = maskFromJson(JSON.parse(raw));
          if (parsed.width === series.width && parsed.height === series.height) m = parsed;
        }
      } catch { /* bozuk kayıt: boş maskeyle başla */ }
      setMask(m);
      setSlice(Math.max(0, Math.min(activeSlice, series.slices.length - 1)));
    })();
    // activeSlice yalnız ilk açılışta başlangıç değeridir; sonraki değişimleri
    // editör içi gezinme yönetir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series?.id]);

  // Kalıcılık: maske değiştikçe tarayıcıya yaz (seri kimliğiyle).
  const persist = useCallback((m: SegMask) => {
    if (!series) return;
    try { localStorage.setItem(storageKey(series.id), JSON.stringify(maskToJson(m))); } catch { /* kota dolu */ }
  }, [series]);

  /**
   * Maskeyi değiştirir: kesit haritasını kopyalar, `fn` yerinde günceller,
   * yeni üst nesne ile render tetikler ve tarayıcıya yazar.
   */
  const mutate = useCallback((fn: (m: SegMask) => number | void): number => {
    const next: SegMask = { ...mask, slices: new Map(mask.slices) };
    const r = fn(next);
    setMask(next);
    persist(next);
    return typeof r === "number" ? r : 0;
  }, [mask, persist]);

  const vol = useMemo(() => {
    if (!series) return null;
    return volume(mask, {
      px: pxMm > 0 ? pxMm : 1,
      py: series.pixelSpacing > 0 ? series.pixelSpacing : 1,
      sliceThickness: series.sliceThickness,
      sliceSpacing: series.sliceSpacing,
    });
  }, [series, pxMm, mask]);

  const pixels = sliceCount > 0 ? mask.slices.get(slice) : undefined;
  const sliceMarked = useMemo(() => {
    if (!pixels) return 0;
    let n = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i]) n++;
    return n;
  }, [pixels]);

  // ── Çizim: kesit + maske örtüsü ──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !series) return;
    const s = series.slices[slice];
    if (!s) return;
    const cssW = cv.clientWidth || 640;
    const scale = Math.min(cssW / W, 1);
    cv.width = Math.max(1, Math.round(W * scale));
    cv.height = Math.max(1, Math.round(H * scale));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const base = document.createElement("canvas");
    base.width = W; base.height = H;
    const bctx = base.getContext("2d");
    if (!bctx) return;
    const img = bctx.createImageData(W, H);
    const u32 = new Uint32Array(img.data.buffer);
    const { lut, lo: llo } = buildWindowLUT(wl, ww, invert);
    for (let i = 0; i < s.length; i++) {
      let t = (s[i] - llo) | 0;
      if (t < 0) t = 0; else if (t > lut.length - 1) t = lut.length - 1;
      const g = lut[t];
      u32[i] = 0xff000000 | (g << 16) | (g << 8) | g;
    }
    bctx.putImageData(img, 0, 0);

    const m = mask.slices.get(slice);
    if (m) {
      const ov = bctx.createImageData(W, H);
      const ovu = new Uint32Array(ov.data.buffer);
      const r = 34, g2 = 211, b = 238;
      const fill = (0.45 * 255) | 0;
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        ovu[i] = (fill << 24) | (b << 16) | (g2 << 8) | r;
      }
      const ovc = document.createElement("canvas");
      ovc.width = W; ovc.height = H;
      const octx = ovc.getContext("2d");
      if (octx) { octx.putImageData(ov, 0, 0); bctx.drawImage(ovc, 0, 0); }
    }
    ctx.drawImage(base, 0, 0, cv.width, cv.height);
    void MASK_COLOR;
  }, [series, slice, wl, ww, invert, mask, W, H]);

  const totalPx = useMemo(() => maskPixelCount(mask), [mask]);

  if (!series) {
    return (
      <Shell onClose={onClose} title="Segmentasyon">
        <p className="p-4 text-sm text-slate-300">Segmentasyon için önce bir görüntü serisi açın.</p>
      </Shell>
    );
  }

  const toImage = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget;
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    return { x, y };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const erase = tool === "erase";
    const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius / 2)));
    mutate((m) => {
      for (let i = 0; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        paint(m, slice, Math.round(x), Math.round(y), radius, erase);
      }
    });
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!series.slices[slice]) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e);
    if (tool === "threshold") {
      const n = mutate((m) => thresholdFill(m, slice, series.slices[slice], lo, hi));
      toast(n ? `Eşik dolgusu: ${n} piksel eklendi (${lo}…${hi} HU).` : "Eşik aralığında piksel yok.", 5000);
      return;
    }
    if (tool === "grow") {
      const n = mutate((m) => growRegion(m, slice, series.slices[slice], { x: Math.round(p.x), y: Math.round(p.y) }, lo, hi));
      toast(n ? `Bölge büyütme: ${n} piksel eklendi.` : "Tohum noktası eşik dışında ya da bağlantılı alan yok.", 5000);
      return;
    }
    painting.current = { down: true, last: p };
    stroke(p, p);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!painting.current.down) return;
    const p = toImage(e);
    const last = painting.current.last ?? p;
    painting.current.last = p;
    stroke(last, p);
  };

  const endStroke = () => { painting.current = { down: false, last: null }; };

  const clearSlice = () => {
    if (!window.confirm(`Kesit ${slice + 1} maskesi silinsin mi?`)) return;
    mutate((m) => { m.slices.delete(slice); });
  };

  const clearAll = () => {
    if (!window.confirm("Tüm kesitlerdeki maske silinsin mi? Bu işlem geri alınamaz.")) return;
    const cleared = emptyMask(W, H);
    setMask(cleared);
    persist(cleared);
  };

  const copyToNext = () => {
    if (slice + 1 >= sliceCount) { toast("Son kesitten sonrasına kopyalanamaz.", 4000); return; }
    if (!mask.slices.get(slice)) { toast("Bu kesitte maske yok.", 4000); return; }
    mutate((m) => { copySlice(m, slice, slice + 1); });
    setSlice(slice + 1);
  };

  const exportSeg = async (kind: "seg" | "rtstruct") => {
    if (!series.seriesUid || !series.sopClassUid || !series.sopUids?.length) {
      toast("Bu seride SOP Instance UID bilgisi yok; SEG/RTSTRUCT üretilemez.", 7000);
      return;
    }
    const current: SegMask = { ...mask, slices: new Map(mask.slices) };
    prune(current);
    if (!current.slices.size) { toast("Maske boş — önce bir alan çizip işaretleyin.", 6000); return; }
    setBusy(true);
    try {
      const geo = {
        pxMm: pxMm > 0 ? pxMm : 1,
        pyMm: series.pixelSpacing > 0 ? series.pixelSpacing : 1,
        dz: (series.sliceSpacing ?? series.sliceThickness) > 0 ? (series.sliceSpacing ?? series.sliceThickness) : 1,
        origin: (series.ipp?.[0] ?? [0, 0, 0]) as [number, number, number],
      };
      const base = {
        patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex,
        studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
        source: { seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, sopUids: series.sopUids },
        frameOfReferenceUid: series.frameOfRef, geometry: geo, width: W, height: H,
      };
      const def = makeSegmentDef(1, label.trim().slice(0, 64) || "Hedef alan", "MANUAL");
      const bytes = kind === "seg"
        ? buildSegDocument({ ...base, segments: [{ def, mask: current }] })
        : buildRtStruct({ ...base, rois: [{ def, mask: current }] });
      downloadBytes(bytes, `${kind === "seg" ? "SEG" : "RTSTRUCT"}-${series.modality}-${current.slices.size}-kesit.dcm`);
      toast(`${kind === "seg" ? "SEG" : "RTSTRUCT"} indirildi (${current.slices.size} kesit). Hekim düzenlemesine açıktır.`, 7000);
      persist(current);
    } catch (e) {
      toast(`Dışa aktarma başarısız: ${e instanceof Error ? e.message : "bilinmeyen hata"}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose} title="Segmentasyon editörü">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 md:flex-row">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {([["brush", "🖌 Fırça"], ["erase", "🧽 Silgi"], ["threshold", "📏 Eşik dolgusu"], ["grow", "🌊 Bölge büyüt"]] as [Tool, string][]).map(([t, tLabel]) => (
              <button key={t} onClick={() => setTool(t)}
                className={`rounded border px-2 py-1 ${tool === t ? "border-cyan-400 bg-cyan-400/15 text-cyan-200" : "border-[#243044] text-slate-300 hover:border-cyan-400/50"}`}>{tLabel}</button>
            ))}
            <label className="ml-2 flex items-center gap-1 text-slate-400">Yarıçap
              <input type="range" min={1} max={40} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="w-24" />
              <b className="w-6 text-right font-mono text-slate-200">{radius}</b>
            </label>
            <span className="ml-auto flex items-center gap-1">
              <button className="rounded border border-[#243044] px-2 py-1 text-slate-300 hover:border-cyan-400/50" onClick={() => setSlice(Math.max(0, slice - 1))} disabled={slice <= 0}>◀</button>
              <span className="font-mono text-slate-300">{slice + 1}/{sliceCount}</span>
              <button className="rounded border border-[#243044] px-2 py-1 text-slate-300 hover:border-cyan-400/50" onClick={() => setSlice(Math.min(sliceCount - 1, slice + 1))} disabled={slice >= sliceCount - 1}>▶</button>
            </span>
          </div>
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={endStroke}
            className="mt-2 w-full cursor-crosshair rounded border border-[#1a2230] bg-black"
            style={{ touchAction: "none", imageRendering: "pixelated" }}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            WL {Math.round(wl)} / WW {Math.round(ww)} · Bu kesitte <b className="text-cyan-300">{sliceMarked}</b> piksel · Tüm seride <b className="text-cyan-300">{totalPx}</b> piksel
            {vol?.sliceRange ? ` (kesit ${vol.sliceRange[0] + 1}–${vol.sliceRange[1] + 1})` : ""}.
          </p>
        </div>

        <aside className="w-full shrink-0 space-y-2 text-[11px] md:w-72">
          <div className="rounded border border-[#1a2230] p-2">
            <div className="text-slate-400">Hacim</div>
            <div className="text-lg font-bold text-cyan-200">{vol ? vol.ml.toFixed(2) : "0.00"} mL</div>
            <div className="text-slate-500">{vol ? vol.voxelCount.toLocaleString("tr-TR") : 0} piksel · {vol?.mm3 ? Math.round(vol.mm3).toLocaleString("tr-TR") : 0} mm³</div>
            <div className="mt-1 text-[10px] text-amber-300/80">Hacim piksel aralığına göredir; hekim onayına tabidir.</div>
          </div>

          <div className="rounded border border-[#1a2230] p-2">
            <div className="text-slate-400">Eşik (HU) — dolgu ve bölge büyütme</div>
            <div className="mt-1 flex items-center gap-1">
              <input type="number" value={lo} onChange={(e) => setLo(Number(e.target.value))} className="w-20 rounded border border-[#243044] bg-[#0b0f16] px-1 py-0.5 text-slate-200" />
              <span className="text-slate-500">…</span>
              <input type="number" value={hi} onChange={(e) => setHi(Number(e.target.value))} className="w-20 rounded border border-[#243044] bg-[#0b0f16] px-1 py-0.5 text-slate-200" />
              <button className="ml-auto rounded border border-[#243044] px-1.5 py-0.5 text-slate-300 hover:border-cyan-400/50"
                onClick={() => { setLo(Math.round(wl - ww / 2)); setHi(Math.round(wl + ww / 2)); }}>WL/WW</button>
            </div>
          </div>

          <div className="rounded border border-[#1a2230] p-2">
            <div className="text-slate-400">Segment adı</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} className="mt-1 w-full rounded border border-[#243044] bg-[#0b0f16] px-1.5 py-1 text-slate-200" />
          </div>

          <div className="grid grid-cols-2 gap-1">
            <button className="rounded border border-[#243044] px-2 py-1 text-slate-300 hover:border-cyan-400/50" onClick={copyToNext}>Sonraki kesite kopyala</button>
            <button className="rounded border border-[#243044] px-2 py-1 text-slate-300 hover:border-cyan-400/50" onClick={clearSlice}>Bu kesiti sil</button>
            <button className="rounded border border-rose-400/40 px-2 py-1 text-rose-300 hover:bg-rose-400/10" onClick={clearAll}>Tümünü sil</button>
            <button className="rounded border border-[#243044] px-2 py-1 text-slate-300 hover:border-cyan-400/50" onClick={() => { persist(mask); toast("Maske bu tarayıcıda kaydedildi.", 4000); }}>Kaydet</button>
          </div>

          <div className="grid grid-cols-1 gap-1">
            <button disabled={busy} className="rounded border border-emerald-400/40 px-2 py-1 text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-50" onClick={() => void exportSeg("seg")}>🧩 DICOM SEG indir</button>
            <button disabled={busy} className="rounded border border-emerald-400/40 px-2 py-1 text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-50" onClick={() => void exportSeg("rtstruct")}>🧩 RTSTRUCT indir</button>
          </div>

          <p className="rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-amber-200">
            Maske tarayıcıda saklanır ve Dışa aktar → SEG/RTSTRUCT çıktısına katılır. AI aday örtüsü düzenlenebilir maske değildir.
            Bu araç tıbbi cihaz değildir; klinik karar için kullanılamaz.
          </p>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#243044] bg-[#0b0f16]">
        <header className="flex items-center gap-2 border-b border-[#1a2230] px-3 py-2">
          <h2 className="text-sm font-bold text-slate-100">{title}</h2>
          <button onClick={onClose} className="ml-auto rounded border border-[#243044] px-2 py-0.5 text-xs text-slate-300 hover:border-rose-400/60 hover:text-rose-200">Kapat (Esc)</button>
        </header>
        {children}
      </div>
    </div>
  );
}
