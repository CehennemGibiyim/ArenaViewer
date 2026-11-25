"use client";

/**
 * Ölçüm geçmişi / trend paneli (c-measure-history).
 *
 * - Seçili hastanın sunucudaki ölçümlerini okur (`GET /api/measurements`).
 * - Bu çalışmanın ekran ölçümlerini yapılandırılmış satır olarak kaydeder
 *   (`POST`, aynı hasta+çalışma+seri için değiştirir; kopya üretmez).
 * - Etiket bazında zaman serisi ve mini grafik gösterir.
 *
 * Sunucu/DB yoksa panel açıkça "geçmiş okunamadı" der; tarayıcıda hesaplanan
 * hiçbir değer geçmiş gibi sunulmaz.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/csrfClient";
import type { SeriesData } from "@/lib/types";
import {
  buildTrends, sparkline, trendSummary,
  type HistoryRow, type TrendSeries,
} from "@/lib/measureHistory";

interface Props {
  open: boolean;
  onClose: () => void;
  patientId: string;
  patientName?: string;
  series: SeriesData | null;
  /** Kaydedilecek satırlar (ekran ölçümlerinden üretilir, üst bileşende). */
  rowsToSave: HistoryRow[];
  toast: (m: string, ms?: number) => void;
}

const UNIT_TR: Record<string, string> = { mm: "mm", mL: "mL", mm2: "mm²", HU: "HU", SUV: "SUV" };

export default function MeasureHistoryPanel({ open, onClose, patientId, patientName, series, rowsToSave, toast }: Props) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const load = useCallback(async () => {
    if (!patientId.trim()) { setError("Hasta kimliği yok; geçmiş sorgulanamaz."); return; }
    setLoading(true); setError(""); setSavedMsg("");
    try {
      const r = await apiFetch(`/api/measurements?patientId=${encodeURIComponent(patientId)}`);
      if (!r.ok) {
        setError(r.status === 401 ? "Oturum gerekli (giriş yapın)." : `Geçmiş okunamadı (HTTP ${r.status}).`);
        setRows([]);
        return;
      }
      const data = (await r.json()) as HistoryRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setError("Sunucuya ulaşılamadı; geçmiş yalnız bağlı sürümde görünür.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [open, load]);

  if (!open) return null;

  const trends: TrendSeries[] = buildTrends(rows);

  const save = async () => {
    if (!rowsToSave.length) { toast("Bu çalışmada kaydedilecek sayısal ölçüm yok.", 4000); return; }
    setSaving(true); setSavedMsg("");
    try {
      const r = await apiFetch("/api/measurements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: rowsToSave }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setSavedMsg(`Kaydedilemedi: ${j.error ?? `HTTP ${r.status}`}`);
        return;
      }
      const j = (await r.json()) as { saved?: number };
      setSavedMsg(`${j.saved ?? rowsToSave.length} ölçüm satırı geçmişe yazıldı (aynı çalışma için değiştirildi).`);
      await load();
    } catch {
      setSavedMsg("Sunucuya ulaşılamadı; ölçümler kaydedilmedi.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="measure-history-title" className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#223047] bg-[#0b1018] shadow-2xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a2230] px-3 py-2">
          <div>
            <h2 id="measure-history-title" className="text-sm font-black text-cyan-300">📈 Ölçüm geçmişi ve trend</h2>
            <p className="text-[10px] text-slate-400">
              {patientName ? `${patientName} · ` : ""}{patientId || "hasta kimliği yok"} — değerler yalnızca kaydedilmiş ölçümlerden gelir; eksik ölçüm tahmin edilmez.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} className="cursor-pointer rounded-md border border-[#223047] px-2 py-1 text-[11px] font-bold text-slate-200">{loading ? "Yükleniyor…" : "Yenile"}</button>
            <button type="button" onClick={save} disabled={saving || rowsToSave.length === 0} className="cursor-pointer rounded-md border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[11px] font-bold text-emerald-100 disabled:opacity-40">
              {saving ? "Kaydediliyor…" : `Bu çalışmanın ölçümlerini kaydet (${rowsToSave.length})`}
            </button>
            <button type="button" onClick={onClose} className="cursor-pointer rounded-md border border-[#223047] px-2 py-1 text-[11px] font-bold text-slate-300">Kapat</button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {savedMsg && <p role="status" aria-live="polite" className="mb-2 rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-100">{savedMsg}</p>}
          {error && <p role="status" className="mb-2 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">{error}</p>}
          {!error && !loading && rows.length === 0 && (
            <p className="rounded border border-[#223047] bg-[#0d141e] px-3 py-6 text-center text-xs text-slate-400">
              Bu hasta için kayıtlı ölçüm yok. “Bu çalışmanın ölçümlerini kaydet” ile ilk kaydı oluşturabilirsiniz.
            </p>
          )}

          {trends.length > 0 && (
            <table className="w-full border-collapse text-[11px]">
              <caption className="sr-only">Etikete göre ölçüm trendleri</caption>
              <thead>
                <tr className="border-b border-[#223047] text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th scope="col" className="py-1 pr-2">Ölçüm</th>
                  <th scope="col" className="py-1 pr-2">Grafik</th>
                  <th scope="col" className="py-1 pr-2">Değerler</th>
                  <th scope="col" className="py-1">Özet</th>
                </tr>
              </thead>
              <tbody>
                {trends.map((t) => (
                  <tr key={`${t.label}-${t.unit}`} className="border-b border-[#141c27] align-top">
                    <th scope="row" className="py-1.5 pr-2 text-left font-semibold text-slate-200">
                      {t.label}
                      <div className="text-[9.5px] font-normal text-slate-500">{UNIT_TR[t.unit] ?? t.unit} · {t.points.length} ölçüm</div>
                    </th>
                    <td className="py-1.5 pr-2">
                      <svg width={120} height={28} role="img" aria-label={`${t.label} trend grafiği`}>
                        <polyline points={sparkline(t.points, 120, 28)} fill="none" stroke={t.direction === "artis" ? "#fb7185" : t.direction === "azalma" ? "#34d399" : "#94a3b8"} strokeWidth={1.6} />
                      </svg>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-[10px] text-slate-300">
                      {t.points.map((p, i) => (
                        <span key={`${p.studyUid}-${i}`} className="mr-2 inline-block">
                          {p.studyDate || "tarih yok"}: {p.value.toFixed(t.unit === "HU" || t.unit === "SUV" ? 1 : 2)}
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5 text-[10px] text-slate-300">{trendSummary(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
            Trend yalnız ölçüm matematiğidir (yüzde değişim, ikilenme süresi); klinik yorum değildir. Aynı etiketli ölçümler aynı lezyon kabul edilir — farklı lezyonları
            ayırmak için ölçüme etiket verin. İkilenme süresi yalnız artan ve tarihleri farklı serilerde hesaplanır.
          </p>
          {series && rowsToSave.length === 0 && (
            <p className="mt-1 text-[10px] text-slate-500">Bu görüntüleme sekmesinde sayısal ölçüm yok; kaydetmek için önce uzunluk/alan/hacim ölçümü alın.</p>
          )}
        </div>
      </div>
    </div>
  );
}
