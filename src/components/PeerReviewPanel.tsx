"use client";

/**
 * RADPEER gözetim paneli (d-peer): örneklem + uyuşmazlık istatistikleri.
 *
 * Veri sunucudan gelir (`/api/peer-review/sample`, `/api/peer-review/stats`).
 * Panel hiçbir oranı tahmin etmez: kayıt yoksa "değerlendirme yok" der, küçük
 * örnekte Wilson güven aralığını gösterir. Kendi raporu örnekleme girmez.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/csrfClient";
import type { DiscordanceStats } from "@/lib/radpeer";

interface SampleItem {
  reportId: number;
  patientName: string;
  patientId: string;
  modality: string;
  studyDate: string;
  seriesDescription: string;
  approvedBy: string;
  approvedAt: string | null;
}

interface StatsResponse extends DiscordanceStats {
  headline: string;
  approvedReports: number;
  coverage: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const pct = (v: number | null) => (v === null ? "—" : `%${(v * 100).toFixed(1)}`);

export default function PeerReviewPanel({ open, onClose }: Props) {
  const [rate, setRate] = useState(5);
  const [items, setItems] = useState<SampleItem[]>([]);
  const [note, setNote] = useState("");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (r: number) => {
    setLoading(true); setMsg("");
    try {
      const [s, t] = await Promise.all([
        apiFetch(`/api/peer-review/sample?rate=${r}`),
        apiFetch("/api/peer-review/stats"),
      ]);
      if (!s.ok || !t.ok) {
        setMsg(s.status === 401 || t.status === 401
          ? "Oturum gerekli (giriş yapın)."
          : `Sunucu yanıtı: örneklem HTTP ${s.status}, istatistik HTTP ${t.status}.`);
        setItems([]); setStats(null);
        return;
      }
      const sj = (await s.json()) as { items?: SampleItem[]; note?: string };
      setItems(Array.isArray(sj.items) ? sj.items : []);
      setNote(sj.note ?? "");
      setStats((await t.json()) as StatsResponse);
    } catch {
      setMsg("Sunucuya ulaşılamadı; örneklem ve istatistikler yalnız bağlı sürümde görünür.");
      setItems([]); setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => void load(rate), 0);
    return () => clearTimeout(t);
  }, [open, rate, load]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="peer-panel-title" className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#223047] bg-[#0b1018] shadow-2xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a2230] px-3 py-2">
          <div>
            <h2 id="peer-panel-title" className="text-sm font-black text-cyan-300">⚖ RADPEER — örneklem ve uyuşmazlık istatistikleri</h2>
            <p className="text-[10px] text-slate-400">Kendi raporunuz örnekleme girmez; değerlendirilmemiş raporlar uyumlu sayılmaz.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-slate-300">Örneklem %
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="ml-1 rounded border border-[#223047] bg-[#141b24] px-1 py-0.5 text-[11px] text-slate-200">
                {[1, 5, 10, 20, 50].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void load(rate)} className="cursor-pointer rounded-md border border-[#223047] px-2 py-1 text-[11px] font-bold text-slate-200">{loading ? "Yükleniyor…" : "Yenile"}</button>
            <button type="button" onClick={onClose} className="cursor-pointer rounded-md border border-[#223047] px-2 py-1 text-[11px] font-bold text-slate-300">Kapat</button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px]">
          {msg && <p role="status" className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-100">{msg}</p>}

          <section aria-label="Uyuşmazlık özeti" className="rounded-lg border border-[#223047] bg-[#0d141e] p-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Özet</div>
            {stats ? (
              <>
                <p className="mt-1 text-sm font-black text-cyan-100">{stats.headline}</p>
                <p className="text-[10px] text-slate-400">
                  Onaylı rapor: {stats.approvedReports} · değerlendirilen kapsam: {pct(stats.coverage)} · Wilson %95 GA{" "}
                  {stats.wilson ? `${pct(stats.wilson.low)}–${pct(stats.wilson.high)}` : "—"}
                </p>
                <div className="mt-2 flex flex-wrap gap-3">
                  {stats.byScore.map((s) => (
                    <span key={String(s.score)} className="rounded border border-[#223047] px-2 py-0.5">
                      RADPEER {s.score}: <b className="text-slate-100">{s.count}</b>
                    </span>
                  ))}
                </div>
                {stats.byType.length > 0 && (
                  <p className="mt-1 text-[10px] text-slate-400">Fark türleri: {stats.byType.map((t) => `${t.type} (${t.count})`).join(" · ")}</p>
                )}
              </>
            ) : <p className="mt-1 text-slate-400">{loading ? "Yükleniyor…" : "İstatistik yok."}</p>}
          </section>

          {stats && stats.reviewers.length > 0 && (
            <section aria-label="Değerlendiren bazında uyum">
              <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">Değerlendiren bazında</div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[#223047] text-left text-[10px] uppercase tracking-wider text-slate-400">
                    <th scope="col" className="py-1">Hekim</th><th scope="col">n</th><th scope="col">Uyumlu</th><th scope="col">Kısmen</th><th scope="col">Uyumsuz</th><th scope="col">Uyum</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.reviewers.map((r) => (
                    <tr key={r.reviewer} className="border-b border-[#141c27]">
                      <th scope="row" className="py-1 text-left font-medium text-slate-200">{r.reviewer}</th>
                      <td className="font-mono">{r.total}</td>
                      <td className="font-mono">{r.uyumlu}</td>
                      <td className="font-mono">{r.kismen}</td>
                      <td className="font-mono">{r.uyumsuz}</td>
                      <td className="font-mono">{pct(r.agreementRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-slate-500">Küçük örneklemlerde oran dalgalıdır; kişi kıyaslaması için yeterli n gerekir.</p>
            </section>
          )}

          <section aria-label="Günün örneklemi">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Günün örneklemi ({items.length})</span>
              {note && <span className="text-[10px] text-amber-200">{note}</span>}
            </div>
            {items.length === 0 ? (
              <p className="rounded border border-[#223047] bg-[#0d141e] px-3 py-4 text-center text-slate-400">Örneklem boş.</p>
            ) : (
              <ul className="space-y-1">
                {items.map((it) => (
                  <li key={it.reportId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#223047] bg-[#0d141e] px-2 py-1">
                    <span>
                      <b className="text-slate-100">{it.patientName || it.patientId}</b>{" "}
                      <span className="text-slate-400">{it.modality} · {it.studyDate || "tarih yok"} · {it.seriesDescription}</span>
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">rapor #{it.reportId} · onaylayan {it.approvedBy || "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[10px] text-slate-500">Değerlendirme, rapor ekranındaki “İkinci okuma” kartından yapılır; bu panel yalnız örneklem ve istatistik gösterir.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
