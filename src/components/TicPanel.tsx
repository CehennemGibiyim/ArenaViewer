"use client";

/**
 * ROI tabanlı TIC paneli (v-fusion).
 *
 * Hekimin çizdiği ROI, aynı Frame of Reference'ı paylaşan dinamik serilerin
 * karşılık gelen kesitlerinde yeniden uygulanır; ortalama yoğunluk zaman
 * eksenine dizilip wash-out / plato / progresif olarak sınıflanır.
 * Ölçüm yardımcısıdır — tanı aracı değildir.
 */
import { useMemo, useState } from "react";
import type { Annotation, SeriesData } from "@/lib/types";
import { useEscapeKey } from "@/lib/useEscapeKey";
import { analyzeRoiTic, buildTicPhases, ticRoiCandidates, ticSummaryLine, type TicAnalysis } from "@/lib/ticRoi";

interface Props {
  series: SeriesData;
  all: SeriesData[];
  slice: number;
  annotations: Annotation[];
  onClose: () => void;
  onAddToFindings?: (text: string) => void;
}

const patternTone: Record<string, string> = {
  washout: "text-[var(--ac-rose200)] border-rose-400/40 bg-rose-400/10",
  progressif: "text-[var(--ac-emerald200)] border-emerald-400/40 bg-emerald-400/10",
  plateau: "text-[var(--ac-amber200)] border-amber-400/40 bg-amber-400/10",
  yetersiz: "text-[var(--sl300)] border-[var(--t35)]",
};
const patternLabel: Record<string, string> = {
  washout: "Tip 3 — wash-out", progressif: "Tip 1 — progresif", plateau: "Tip 2 — plato", yetersiz: "Yetersiz veri",
};

export default function TicPanel({ series, all, slice, annotations, onClose, onAddToFindings }: Props) {
  useEscapeKey(onClose);
  const candidates = useMemo(() => ticRoiCandidates(annotations, slice), [annotations, slice]);
  const [roiId, setRoiId] = useState<string>(candidates[0]?.id ?? "");
  const roi = candidates.find((a) => a.id === roiId) ?? candidates[0] ?? null;

  const analysis: TicAnalysis | null = useMemo(() => {
    if (!roi) return null;
    const phases = buildTicPhases(series, slice, roi, all);
    if (!phases.length) return null;
    return analyzeRoiTic(phases, all.filter((s) => s.id !== series.id));
  }, [roi, series, slice, all]);

  const w = 300, h = 110, pad = 18;
  const plot = useMemo(() => {
    if (!analysis || analysis.values.length < 2) return null;
    const vs = analysis.values;
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const span = Math.max(1e-6, hi - lo);
    const n = vs.length;
    const x = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
    const y = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);
    const pts = vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return { pts, x, y, lo, hi };
  }, [analysis]);

  const copySummary = () => {
    if (!analysis) return;
    const text = `${ticSummaryLine(analysis)}\n${analysis.note}`;
    void navigator.clipboard?.writeText(text).catch(() => {});
    onAddToFindings?.(text);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="ROI tabanlı TIC analizi">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--t35)] bg-[var(--t06)] p-4 text-[var(--sl200)] shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-mono text-sm font-black tracking-wide text-[var(--ac-cyan300)]">TIC · ROI zaman-yoğunluk eğrisi</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--sl400)]">
              ROI, aynı çerçevedeki dinamik serilerin karşılık gelen kesitlerine uygulanır. Zaman ekseni Series/Acquisition Time farkıdır.
            </p>
          </div>
          <button onClick={onClose} className="cursor-pointer rounded border border-[var(--t39)] px-2 py-1 text-[11px] text-[var(--sl300)] hover:bg-[var(--t24)]">Kapat ✕</button>
        </div>

        {candidates.length === 0 ? (
          <p className="mt-4 rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11.5px] text-[var(--ac-amber200)]">
            Bu kesitte ROI bulunamadı. Araç çubuğundan <b>dikdörtgen</b>, <b>elips</b> veya <b>poligon</b> seçip lezyonun üzerine çizin; sonra bu paneli yeniden açın.
          </p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1">
                ROI:
                <select value={roi?.id ?? ""} onChange={(e) => setRoiId(e.target.value)} className="rounded border border-[var(--t30)] bg-[var(--t10)] px-2 py-1 text-[11px]">
                  {candidates.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.kind === "rect" ? "dikdörtgen" : a.kind === "ellipse" ? "elips" : "poligon"} · kesit {a.slice + 1} · {a.points.length} nokta
                    </option>
                  ))}
                </select>
              </label>
              {analysis && (
                <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-black ${patternTone[analysis.curve.pattern]}`}>
                  {patternLabel[analysis.curve.pattern]}
                </span>
              )}
              {analysis && analysis.excluded > 0 && (
                <span className="text-[10.5px] text-[var(--sl500)]">{analysis.excluded} seri geometri/zaman uyuşmadığı için dışlandı</span>
              )}
            </div>

            {!analysis && (
              <p className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11.5px] text-[var(--ac-amber200)]">
                ROI hiçbir seride uygulanamadı (geometri uyuşmuyor veya seri renkli). En az iki paralel seri gerekir.
              </p>
            )}

            {analysis && (
              <>
                <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 w-full rounded border border-[var(--t27)] bg-[var(--t45)]" role="img" aria-label="TIC eğrisi">
                  {plot && (
                    <>
                      <polyline points={plot.pts} fill="none" stroke="#22d3ee" strokeWidth={2} />
                      {analysis.values.map((v, i) => (
                        <circle key={i} cx={plot.x(i)} cy={plot.y(v)} r={2.5} fill="#22d3ee" />
                      ))}
                      <text x={pad} y={12} fill="var(--t42)" fontSize={9} fontFamily="ui-monospace">
                        {plot.hi.toFixed(1)}
                      </text>
                      <text x={pad} y={h - 5} fill="var(--t42)" fontSize={9} fontFamily="ui-monospace">
                        {plot.lo.toFixed(1)}
                      </text>
                    </>
                  )}
                  <text x={w - pad} y={h - 5} fill="var(--t42)" fontSize={9} textAnchor="end" fontFamily="ui-monospace">
                    {analysis.axis === "sn" ? "zaman (sn)" : "faz sırası"}
                  </text>
                </svg>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[10.5px]">
                    <thead className="text-[var(--sl500)]">
                      <tr className="text-left">
                        <th className="py-0.5 pr-2">Faz</th>
                        <th className="py-0.5 pr-2">Seri</th>
                        <th className="py-0.5 pr-2">Kesit</th>
                        <th className="py-0.5 pr-2">{analysis.axis === "sn" ? "Zaman (sn)" : "Sıra"}</th>
                        <th className="py-0.5 text-right">Ortalama</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-[var(--sl300)]">
                      {analysis.phases.map((p, i) => (
                        <tr key={p.seriesId} className="border-t border-[var(--t17)]">
                          <td className="py-0.5 pr-2">{i + 1}</td>
                          <td className="max-w-[160px] truncate py-0.5 pr-2" title={p.label}>{p.modality} · {p.label}</td>
                          <td className="py-0.5 pr-2">{p.sliceIndex + 1}</td>
                          <td className="py-0.5 pr-2">{analysis.axis === "sn" ? analysis.times[i] : i + 1}</td>
                          <td className="py-0.5 text-right">{p.mean.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-2 grid gap-1 text-[11px] text-[var(--sl300)] sm:grid-cols-2">
                  <div>Zirve: <b>{analysis.peak.toFixed(2)}</b></div>
                  <div>Zirveye artış: <b>{analysis.enhancementPct === null ? "—" : `%${analysis.enhancementPct.toFixed(1)}`}</b></div>
                  <div>Wash-out: <b>{analysis.curve.washOutPct === null ? "—" : `%${analysis.curve.washOutPct.toFixed(1)}`}</b></div>
                  <div>Wash-in: <b>{analysis.curve.washIn === null ? "—" : `${analysis.curve.washIn.toFixed(3)}/sn`}</b></div>
                </div>
                <p className="mt-2 rounded border border-[var(--t35)] bg-[var(--t48)] px-2 py-1.5 text-[10.5px] leading-relaxed text-[var(--sl400)]">
                  {analysis.curve.advice}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-[var(--ac-amber200)]/80">{analysis.note}</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={copySummary} className="cursor-pointer rounded border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-semibold text-[var(--ac-cyan200)] hover:bg-cyan-400/20">
                    Özeti akışa ekle + kopyala
                  </button>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(analysis.csv).catch(() => {})}
                    className="cursor-pointer rounded border border-[var(--t39)] px-2.5 py-1 text-[11px] text-[var(--sl300)] hover:bg-[var(--t24)]"
                  >
                    CSV kopyala
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
