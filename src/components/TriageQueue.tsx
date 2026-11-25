"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/csrfClient";
import { triageCounts, triageGroup } from "@/lib/triageQueue";
import type { StudyRow } from "@/lib/types";

export default function TriageQueue({ onOpenStudy }: { onOpenStudy: (s: StudyRow) => void }) {
  const [rows, setRows] = useState<StudyRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("hepsi");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true); setError(""); setRows([]); setTruncated(false);
      try {
        const response = await apiFetch("/api/triage-queue", { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || "Kuyruk yüklenemedi");
        }
        const data = await response.json() as { items: StudyRow[]; truncated: boolean };
        if (!controller.signal.aborted) { setRows(data.items); setTruncated(data.truncated); }
      } catch (e) {
        if (!controller.signal.aborted) { setRows([]); setTruncated(false); setError(e instanceof Error ? e.message : "Kuyruk yüklenemedi. Bağlantıyı kontrol edip yeniden deneyin."); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [revision]);
  const counts = triageCounts(rows);
  const visible = filter === "hepsi" ? rows : rows.filter(s => triageGroup(s) === filter);
  const labels = { kritik: "Kritik aday", yuksek: "Yüksek aday", diger: "Diğer analizler", "analiz-yok": "Analiz yok / triyaj üretmez" };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="space-y-2 border-b border-[#1a2230] px-4 py-3 text-xs text-slate-300">
      <p className="text-amber-200">Araştırma / demo: AI önceliği klinik olarak doğrulanmamıştır. Tanı veya acil karar yerine geçmez; tüm çalışmalar hekimce değerlendirilmelidir.</p>
      <p>Onaylı iş durumu dışındaki çalışmalar mevcut AI skoruna göre sıralanır. Skor çalışma kaydındaki son analiz veya rapor bilgisinden gelir; analiz edilmemiş çalışmalar da listelenir. Rapor durumu ayrıca gösterilir.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label>Göster: <select aria-label="Triyaj filtresi" value={filter} onChange={e => setFilter(e.target.value)} className="rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1">
          <option value="hepsi">Tümü ({rows.length})</option>
          {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label} ({counts[key as keyof typeof counts]})</option>)}
        </select></label>
        <button onClick={refresh} className="text-cyan-400">⟳ yenile</button>
        {truncated && <span className="text-amber-300">İlk 500 çalışma gösteriliyor; sayılar tüm kuyruğu temsil etmez.</span>}
      </div>
    </div>
    {error && <p role="alert" className="px-4 py-2 text-xs text-rose-300">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 bg-[#0b0f16] text-slate-500"><tr>{["AI önceliği", "Hasta / ID", "Çalışma", "Motor", "İş / rapor", ""].map(h => <th key={h} className="border-b border-[#1a2230] px-3 py-2">{h}</th>)}</tr></thead>
        <tbody>
          {visible.map(s => <tr key={s.id} className="border-b border-[#141b26] text-slate-300">
            <td className="px-3 py-2"><span className={triageGroup(s) === "kritik" ? "font-bold text-rose-300" : triageGroup(s) === "yuksek" ? "font-bold text-orange-300" : ""}>{labels[triageGroup(s)]}</span><div>{s.triageLevel || "—"}</div></td>
            <td className="px-3 py-2">{s.patientName}<div className="text-slate-500">{s.patientId}</div></td>
            <td className="px-3 py-2">{s.modality} · {s.seriesDescription}<div className="text-slate-500">{s.studyDate}</div></td>
            <td className="px-3 py-2">{s.aiEngine || "—"}{s.aiEngine === "simulated-sample" && <div className="text-amber-300">Simülasyon</div>}</td>
            <td className="px-3 py-2">{s.workStatus} / {s.reportStatus ?? "rapor yok"}<div>{s.assignedToName || "Atanmamış"}</div></td>
            <td className="px-3 py-2">{s.hasFiles ? <button onClick={() => onOpenStudy(s)} className="rounded bg-cyan-500 px-2 py-1 font-bold text-slate-950">Aç</button> : <span className="text-slate-500">Görüntü yok</span>}</td>
          </tr>)}
          {!visible.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">{loading ? "Yükleniyor…" : error ? "" : "Gösterilecek çalışma yok."}</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}
