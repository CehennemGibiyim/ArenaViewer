"use client";

/**
 * Ölçüm geçmişi paneli (c-measure-history).
 *
 * Sunucudaki yapılandırılmış ölçümleri (`/api/measurements`) lezyon bazlı zaman
 * serisi olarak gösterir: çap/HU trendi, ilk–son değişim ve CSV indirme.
 * Veri sunucudan gelir; tarayıcı kaydı (localStorage) yalnız yedek yoldur.
 */
import { useEffect, useMemo, useState } from "react";
import { buildSeries, historyCsv, seriesSummary, sparkPoints, type MeasurementRecord } from "@/lib/measureHistory";
import { useEscapeKey } from "@/lib/useEscapeKey";

interface Props {
  patientId: string;
  /** Panel her açıldığında artar; değişince liste yeniden çekilir. */
  refreshKey?: number;
  onClose: () => void;
}

export default function MeasureHistoryPanel({ patientId, refreshKey = 0, onClose }: Props) {
  const [records, setRecords] = useState<MeasurementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  useEscapeKey(onClose);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`/api/measurements?patientId=${encodeURIComponent(patientId)}`, { credentials: "same-origin" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          if (live) setMsg(r.status === 401 ? "Oturum gerekli; ölçüm geçmişi sunucudan okunamadı." : body.error || `Sunucu hatası (${r.status}).`);
          if (live) setRecords([]);
          return;
        }
        const data = (await r.json()) as { measurements?: MeasurementRecord[] };
        if (live) {
          setRecords(Array.isArray(data.measurements) ? data.measurements : []);
          setMsg("");
        }
      } catch {
        if (live) setMsg("Sunucuya ulaşılamadı; geçmiş yüklenemedi.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [patientId, refreshKey]);

  const series = useMemo(() => buildSeries(records), [records]);

  const downloadCsv = () => {
    const body = historyCsv(series);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/csv;charset=utf-8" }));
    a.download = `olcum-gecmisi-${patientId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" data-testid="measure-history-panel" role="dialog" aria-modal="true" aria-label="Sunucu ölçüm geçmişi">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2d3b4e] bg-[#0b0f16] text-xs text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1a2230] px-4 py-2">
          <b className="text-sm text-slate-100">Ölçüm geçmişi · sunucu</b>
          <div className="flex items-center gap-2">
            <button onClick={downloadCsv} disabled={series.length === 0} className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 hover:bg-[#1a2330] disabled:opacity-40">CSV indir</button>
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 hover:bg-[#1a2330]">✕</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div className="text-[10.5px] text-slate-500">Hasta: {patientId} · {series.length} lezyon · {records.length} ölçüm</div>
          {loading && <div className="mt-3 text-slate-400">Yükleniyor…</div>}
          {!loading && msg && <div className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200">{msg}</div>}
          {!loading && !msg && series.length === 0 && (
            <div className="mt-3 rounded border border-[#1a2230] px-2 py-2 text-slate-400">
              Bu hasta için sunucuda kayıtlı ölçüm yok. Nodül takibi panelinde ölçüm eklenince otomatik yazılır.
            </div>
          )}
          {series.map((s) => (
            <div key={s.key} className="mt-2 rounded-lg border border-[#1a2230] p-2">
              <div className="flex items-center justify-between gap-2">
                <b className="text-slate-100">{s.label}{s.anatomy ? <span className="text-slate-400"> · {s.anatomy}</span> : null}</b>
                <span className="text-[10px] text-slate-500">{s.points.length} ölçüm{s.spanDays !== null ? ` · ${s.spanDays} gün` : ""}</span>
              </div>
              <div className="mt-1 flex items-center gap-3">
                <svg viewBox="0 0 120 28" className="h-7 w-28 shrink-0" role="img" aria-label={`${s.label} trend`}>
                  <polyline points={sparkPoints(s.points)} fill="none" stroke="#22d3ee" strokeWidth="1.5" />
                </svg>
                <div className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{seriesSummary(s)}</div>
              </div>
              <table className="mt-1 w-full text-left text-[11px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="py-0.5 font-semibold">Tarih</th>
                    <th className="py-0.5 text-right font-semibold">Çap (mm)</th>
                    <th className="py-0.5 text-right font-semibold">HU</th>
                  </tr>
                </thead>
                <tbody>
                  {s.points.map((p) => (
                    <tr key={p.date} className="border-t border-[#151d28]">
                      <td className="py-0.5 text-slate-300">{p.date}</td>
                      <td className="py-0.5 text-right font-mono text-slate-200">{p.longMm.toFixed(1)}</td>
                      <td className="py-0.5 text-right font-mono text-slate-400">{p.hu === null ? "—" : p.hu}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="mt-2 text-[10px] leading-relaxed text-slate-500">
            Kayıtlar hasta + tarih + lezyon adına göre tekildir; yeniden gönderim mükerrer nokta üretmez. Trend yalnız girilen
            ölçümlere dayanır, klinik karar aracı değildir.
          </div>
        </div>
      </div>
    </div>
  );
}
