"use client";

/**
 * Akciğer kantitasyonu paneli (a-lungquant).
 *
 * Toraks BT serisinden kural tabanlı histogram çıkarır: LAA-950 (emfizem oranı),
 * ortalama HU, PD15, tahmini akciğer hacmi ve **kesit dağılım profili**.
 * Lob/fissür ayrımı yapılmaz; sonuç araştırma/izlem çıktısıdır, DSBG ve klinik
 * bütünlükle değerlendirilir. Tıbbi cihaz değildir.
 */
import { useEffect, useMemo, useState } from "react";
import type { SeriesData } from "@/lib/types";
import { useEscapeKey } from "@/lib/useEscapeKey";
import {
  lungQuant, lungQuantText, profileSummary, sampleLungHistogram,
  type LungProfile, type LungQuantResult,
} from "@/lib/lungQuant";

interface Props {
  series: SeriesData;
  onClose: () => void;
  /** Özet satırı rapora/akışa ekler. */
  onAddToFindings?: (text: string) => void;
}

const catTone = (category: string) => {
  if (category.startsWith("ağır")) return "text-[var(--ac-rose300)] border-rose-400/50 bg-rose-400/10";
  if (category === "orta") return "text-[var(--ac-amber300)] border-amber-400/50 bg-amber-400/10";
  if (category === "hafif") return "text-[var(--ac-yellow200)] border-yellow-400/40 bg-yellow-400/10";
  return "text-[var(--ac-emerald300)] border-emerald-400/40 bg-emerald-400/10";
};

export default function LungQuantPanel({ series, onClose, onAddToFindings }: Props) {
  const [busy, setBusy] = useState(true);
  const [profile, setProfile] = useState<LungProfile | null>(null);
  const [result, setResult] = useState<LungQuantResult | null>(null);
  const [err, setErr] = useState("");
  useEscapeKey(onClose);

  const spacing = useMemo(() => {
    const px = series.pixelSpacingX && series.pixelSpacingX > 0 ? series.pixelSpacingX : series.pixelSpacing > 0 ? series.pixelSpacing : 1;
    const py = series.pixelSpacing > 0 ? series.pixelSpacing : px;
    const dz = series.sliceSpacing && series.sliceSpacing > 0 ? series.sliceSpacing : series.sliceThickness > 0 ? series.sliceThickness : 1;
    return { px, py, dz };
  }, [series]);

  useEffect(() => {
    // Ağır hesabı ilk boyamadan sonra yap (arayüz donmasın).
    const t = setTimeout(() => {
      try {
        if (series.slices.length < 2) { setErr("Kantitasyon için en az 2 kesit gerekir."); setBusy(false); return; }
        const p = sampleLungHistogram(
          (z) => series.slices[z],
          series.width,
          series.height,
          series.slices.length,
        );
        if (p.sampledVoxels === 0) {
          setErr("Akciğer dokusu bulunamadı (gövde içinde −400 HU altı piksel yok). Bu seri toraks BT olmayabilir.");
          setProfile(p);
          setBusy(false);
          return;
        }
        const voxelMm3 = spacing.px * spacing.py * spacing.dz * p.pixelStride * p.pixelStride * p.sliceStep;
        setProfile(p);
        setResult(lungQuant(p.bins, voxelMm3));
      } catch {
        setErr("Hesaplama sırasında hata oluştu.");
      } finally {
        setBusy(false);
      }
    }, 30);
    return () => clearTimeout(t);
  }, [series, spacing]);

  const summary = useMemo(() => (profile ? profileSummary(profile.profile) : null), [profile]);
  const peakLaa = Math.max(1, ...(profile?.profile.map((p) => p.laa950Pct) ?? [1]));

  const addLine = () => {
    if (!result || !onAddToFindings) return;
    onAddToFindings(lungQuantText(result, profile ? { sliceStep: profile.sliceStep, pixelStride: profile.pixelStride } : null));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="lung-quant-panel" role="dialog" aria-modal="true" aria-label="Akciğer kantitasyonu">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--t39)] bg-[var(--t05)] text-xs text-[var(--sl200)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--t25)] px-4 py-2">
          <div>
            <div className="text-sm font-bold text-[var(--sl100)]">Akciğer kantitasyonu · LAA-950</div>
            <div className="text-[10px] text-[var(--sl500)]">{series.description || series.modality} · {series.slices.length} kesit · {spacing.px.toFixed(2)}×{spacing.py.toFixed(2)}×{spacing.dz.toFixed(2)} mm</div>
          </div>
          <div className="flex items-center gap-2">
            {result && onAddToFindings && (
              <button onClick={addLine} className="cursor-pointer rounded border border-cyan-400/50 px-2 py-0.5 text-[var(--ac-cyan200)] hover:bg-cyan-400/10">Rapora ekle</button>
            )}
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[var(--t39)] px-2 py-0.5 hover:bg-[var(--t26)]">✕</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {busy && <div className="text-[var(--sl400)]">Hesaplanıyor… (kesitler örnekleniyor)</div>}
          {!busy && err && <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[var(--ac-amber200)]">{err}</div>}

          {!busy && result && (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded border border-[var(--t25)] p-2">
                  <div className="text-[var(--sl500)]">LAA-950</div>
                  <div className="text-lg font-bold text-[var(--ac-cyan200)]">%{result.laa950Pct.toFixed(1)}</div>
                </div>
                <div className="rounded border border-[var(--t25)] p-2">
                  <div className="text-[var(--sl500)]">Ortalama HU</div>
                  <div className="text-lg font-bold text-[var(--sl100)]">{result.meanHu.toFixed(0)}</div>
                </div>
                <div className="rounded border border-[var(--t25)] p-2">
                  <div className="text-[var(--sl500)]">PD15</div>
                  <div className="text-lg font-bold text-[var(--sl100)]">{result.pd15Hu === null ? "—" : `${result.pd15Hu.toFixed(0)} HU`}</div>
                </div>
                <div className="rounded border border-[var(--t25)] p-2">
                  <div className="text-[var(--sl500)]">Hacim (tahmini)</div>
                  <div className="text-lg font-bold text-[var(--sl100)]">{result.volumeMl === null ? "—" : `${Math.round(result.volumeMl).toLocaleString("tr-TR")} mL`}</div>
                </div>
              </div>

              <div className={`mt-2 rounded border p-2 ${catTone(result.category)}`}>
                <div className="font-bold">{result.category}</div>
                <div className="text-[11px] leading-relaxed">{result.advice}</div>
              </div>

              <div className="mt-3 rounded border border-[var(--t25)] p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--sl400)]">Kesit dağılımı (LAA-950 %)</span>
                  <span className="text-[10px] text-[var(--sl500)]">
                    {profile ? `${profile.sliceStep} kesitte bir, ${profile.pixelStride} pikselde bir örneklendi · ${profile.sampledVoxels.toLocaleString("tr-TR")} voksel` : ""}
                  </span>
                </div>
                <svg viewBox="0 0 600 90" className="mt-1 w-full" role="img" aria-label="Kesit bazlı LAA-950 dağılımı">
                  {(profile?.profile ?? []).map((p, i, arr) => {
                    const w = 600 / Math.max(1, arr.length);
                    const h = (p.laa950Pct / peakLaa) * 70;
                    const worst = summary?.worstSlice === p.slice;
                    return (
                      <rect
                        key={p.slice}
                        x={i * w + 0.5}
                        y={80 - h}
                        width={Math.max(0.8, w - 1)}
                        height={Math.max(0.5, h)}
                        fill={worst ? "#fb7185" : "#22d3ee"}
                        opacity={worst ? 0.95 : 0.65}
                      >
                        <title>{`Kesit ${p.slice + 1}: LAA-950 %${p.laa950Pct} · ort. ${p.meanHu} HU · ${p.voxels} voksel`}</title>
                      </rect>
                    );
                  })}
                  <line x1="0" y1="80" x2="600" y2="80" stroke="var(--t35)" strokeWidth="1" />
                </svg>
                <div className="flex items-center justify-between text-[10px] text-[var(--sl500)]">
                  <span>üst (apikal)</span>
                  <span>{summary ? `en yüksek: kesit ${summary.worstSlice + 1} (%${summary.worstLaa950Pct})` : ""}</span>
                  <span>alt (bazal)</span>
                </div>
                {summary && <div className="mt-1 text-[10.5px] text-[var(--sl400)]">{summary.note}{summary.basalMinusApical !== null ? ` (bazal − apikal = ${summary.basalMinusApical >= 0 ? "+" : ""}${summary.basalMinusApical} yüzde puan)` : ""}</div>}
              </div>

              <div className="mt-3 rounded border border-[var(--t25)] p-2">
                <div className="text-[var(--sl400)]">Yoğunluk histogramı (akciğer içi)</div>
                <svg viewBox="0 0 600 70" className="mt-1 w-full" role="img" aria-label="HU histogramı">
                  {(profile?.bins ?? []).map((b, i, arr) => {
                    const max = Math.max(1, ...arr.map((x) => x.count));
                    const w = 600 / Math.max(1, arr.length);
                    const h = (b.count / max) * 60;
                    return <rect key={`${b.lo}`} x={i * w + 0.5} y={65 - h} width={Math.max(0.8, w - 1)} height={Math.max(0.4, h)} fill={b.hi <= -950 ? "#fb7185" : b.lo < -800 ? "#fbbf24" : "#38bdf8"} opacity="0.75"><title>{`${b.lo}…${b.hi} HU: ${b.count}`}</title></rect>;
                  })}
                  <line x1="0" y1="65" x2="600" y2="65" stroke="var(--t35)" strokeWidth="1" />
                </svg>
                <div className="flex justify-between text-[10px] text-[var(--sl500)]"><span>{profile?.bins[0]?.lo ?? -1250} HU</span><span>−950 (kırmızı)</span><span>{profile?.bins[profile.bins.length - 1]?.hi ?? 50} HU</span></div>
              </div>
            </>
          )}

          <div className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-[var(--ac-amber200)]">
            Kural tabanlı tahmin: gövde dışı hava dışlanır, ancak <b>lob/fissür ayrımı yapılmaz</b> ve örnekleme nedeniyle hacim yaklaşıktır.
            Yağ/doku sınırları, solunum fazı ve rekonstrüksiyon farkı sonucu değiştirir. KOAH tanısı DSBG ve klinik bütünlükle konur; klinik karar aracı değildir.
          </div>
        </div>
      </div>
    </div>
  );
}
