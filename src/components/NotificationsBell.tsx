"use client";

import { useCallback, useEffect, useState } from "react";
import type { NotificationRow } from "@/lib/types";

/**
 * Bildirim zili: kritik bulgu bildirimleri (D1) ve takip önerisi görevleri (D2).
 *
 * D1 — kapanış döngüsü: bir bildirimi yalnızca “alındı” demek yetmez; alan kişinin
 * iletildiği kanıtı (`relayedTo`/`relayedAt`) ve gerekirse eskalasyon kaydı tutulur.
 * D2 — takip önerisi: onaylı rapordan gelen öneri burada yapılan bir görev listesi
 * olarak görünür; tamamlanana dek açık kalır, sonuç denetim izine yazılır.
 */
export default function NotificationsBell() {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"bildirim" | "takip">("bildirim");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications");
      if (r.ok) setItems((await r.json()) as NotificationRow[]);
    } catch {
      /* çevrimdışı */
    }
  }, []);
  useEffect(() => {
    void (async () => { await load(); })();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const findings = items.filter((n) => n.kind !== "followup");
  const followups = items.filter((n) => n.kind === "followup");
  const unacked = findings.filter((n) => !n.ackAt).length;
  const openFollowups = followups.filter((n) => n.status === "acik").length;

  const patch = async (id: number, body: Record<string, unknown>) => {
    await fetch("/api/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) });
    void load();
  };
  const ack = (id: number) => patch(id, {});
  const relay = (id: number) => {
    const to = window.prompt("Bildirim kime/kanala iletildi? (ör. Göğüs Cerrahisi — telefon)", "");
    if (to && to.trim()) void patch(id, { action: "relay", relayedTo: to.trim() });
  };
  const escalate = (id: number) => void patch(id, { action: "escalate" });
  const setFollowup = (id: number, status: string) => patch(id, { action: "status", status });

  const kapanisMetni = (n: NotificationRow) =>
    n.relayedAt ? `${n.relayedTo || "Kanala"} · ${new Date(n.relayedAt).toLocaleTimeString("tr-TR")}` : "İletildi kaydı yok";

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} title="Kritik bulgu bildirimleri ve takip görevleri" className={`relative cursor-pointer rounded-md px-2 py-1.5 text-sm ${(unacked || openFollowups) ? "text-rose-300" : "text-slate-400 hover:text-slate-200"}`}>
        🔔
        {unacked > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[9px] font-black text-white">{unacked}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-[26rem] overflow-hidden rounded-xl border border-[#232e40] bg-[#0b0f16] shadow-2xl">
          <div className="flex items-center gap-1 border-b border-[#1a2230] px-3 py-2">
            <button onClick={() => setTab("bildirim")} className={`rounded px-2 py-1 text-[10px] font-bold ${tab === "bildirim" ? "bg-cyan-400/15 text-cyan-300" : "text-slate-400"}`}>Bildirimler {unacked > 0 ? `(${unacked})` : ""}</button>
            <button onClick={() => setTab("takip")} className={`rounded px-2 py-1 text-[10px] font-bold ${tab === "takip" ? "bg-emerald-400/15 text-emerald-300" : "text-slate-400"}`}>Takip önerileri {openFollowups > 0 ? `(${openFollowups})` : ""}</button>
          </div>

          {tab === "bildirim" && (
            <div className="max-h-80 overflow-y-auto">
              {findings.length === 0 && <p className="p-4 text-center text-xs text-slate-500">Bildirim yok.</p>}
              {findings.map((n) => (
                <div key={n.id} className="border-b border-[#141b26] p-3 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-black ${n.severity === "kritik" ? "bg-rose-500/20 text-rose-300" : "bg-orange-500/20 text-orange-300"}`}>{n.severity.toUpperCase()}</span>
                    <span className="font-mono text-[9.5px] text-slate-500">{new Date(n.createdAt).toLocaleString("tr-TR")}</span>
                  </div>
                  <p className="mt-1 text-slate-200">{n.message}</p>
                  <p className={`mt-1 text-[10px] ${n.ackAt ? "text-emerald-300" : "text-slate-500"}`}>
                    {n.ackAt ? `✓ ${n.ackByName} tarafından alındı · ${new Date(n.ackAt).toLocaleTimeString("tr-TR")}` : "Alınmadı"}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {!n.ackAt && <button onClick={() => void ack(n.id)} className="cursor-pointer rounded bg-cyan-500 px-2.5 py-1 text-[10.5px] font-bold text-slate-950 hover:bg-cyan-400">Alındı</button>}
                    <button onClick={() => relay(n.id)} title="Bildirimin iletildiğini kaydet" className="cursor-pointer rounded border border-slate-500/40 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-500/10">İletildi…</button>
                    <button onClick={() => escalate(n.id)} title="Eskalasyonu kaydet" className="cursor-pointer rounded border border-amber-500/40 px-2 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/10">⚑ Eskalasyon</button>
                    <span className={`ml-auto text-[9.5px] ${n.escalated ? "text-amber-300" : "text-slate-500"}`}>
                      {n.escalated ? "⚑ Eskalasyonlu" : "kapanış:"}
                    </span>
                    <span className="w-20 truncate text-right text-[9.5px] text-slate-400" title={kapanisMetni(n)}>{n.escalated ? "" : kapanisMetni(n)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "takip" && (
            <div className="max-h-80 overflow-y-auto">
              {followups.length === 0 && <p className="p-4 text-center text-xs text-slate-500">Takip önerisi yok. Onaylı raporlardaki “Öneri” metni otomatik buraya düşer.</p>}
              {followups.map((n) => (
                <div key={n.id} className={`border-b border-[#141b26] p-3 text-[11px] ${n.status !== "acik" ? "opacity-60" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      {n.severity !== "bilgi" && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${n.severity === "kritik" ? "bg-rose-500/25 text-rose-200" : "bg-orange-500/25 text-orange-200"}`}>
                          {n.severity.toUpperCase()}
                        </span>
                      )}
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${n.status === "acik" ? "bg-emerald-500/20 text-emerald-300" : n.status === "tamamlandi" ? "bg-slate-500/20 text-slate-400" : "bg-rose-500/20 text-rose-300"}`}>
                        {n.status === "acik" ? "AÇIK" : n.status === "tamamlandi" ? "TAMAMLANDI" : "İPTAL"}
                      </span>
                    </span>
                    <span className="font-mono text-[9.5px] text-slate-500">
                      {[n.modality, n.bodyRegion].filter(Boolean).join(" · ") || "—"} {n.dueDate ? `· son ${n.dueDate}` : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-200">{n.message}</p>
                  {n.recommendedIntervalDays != null && <p className="mt-0.5 text-[10px] text-slate-400">Önerilen aralık: {n.recommendedIntervalDays} gün</p>}
                  {n.studyUid && <p className="mt-0.5 font-mono text-[9.5px] text-slate-500">{n.studyUid}</p>}
                  {n.status === "acik" && (
                    <div className="mt-1.5 flex gap-1.5">
                      <button onClick={() => setFollowup(n.id, "tamamlandi")} className="cursor-pointer rounded bg-emerald-500 px-2.5 py-1 text-[10.5px] font-bold text-slate-950 hover:bg-emerald-400">Tamamlandı</button>
                      <button onClick={() => setFollowup(n.id, "iptal")} className="cursor-pointer rounded border border-rose-500/40 px-2 py-1 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/10">İptal</button>
                    </div>
                  )}
                  {n.completedAt && <p className="mt-1 text-[10px] text-slate-500">Kapatıldı: {new Date(n.completedAt).toLocaleString("tr-TR")}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
