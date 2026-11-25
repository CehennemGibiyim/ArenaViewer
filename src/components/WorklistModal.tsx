"use client";

import { useCallback, useEffect, useState } from "react";
import type { StudyRow, UserInfo } from "@/lib/types";
import { apiFetch } from "@/lib/csrfClient";

interface PacsStudy {
  studyUid: string;
  patientName: string;
  patientId: string;
  studyDate: string;
  modalities: string;
  description: string;
  instances: number;
}

/** `/api/his/mwl` yanıtındaki öge (sunucu tarafı `MwlItem` ile aynı alanlar). */
interface MwlRow {
  accession: string;
  patientId: string;
  patientName: string;
  patientSex: string;
  modality: string;
  bodyPart: string;
  description: string;
  scheduledStart: string;
  stationAeTitle: string;
  status: string;
  stepId: string;
  studyInstanceUid: string;
  priority: string;
}

const MWL_STATUS: Record<string, string> = { SCHEDULED: "Planlandı", ARRIVED: "Geldi", STARTED: "Başladı", COMPLETED: "Tamamlandı", CANCELLED: "İptal" };

interface Props {
  open: boolean;
  onClose: () => void;
  user: UserInfo;
  onOpenStudy: (s: StudyRow) => void;
  onOpenPacs: (s: PacsStudy) => void;
}

const STATUS_LABEL: Record<string, string> = { bekliyor: "Bekliyor", okunuyor: "Okunuyor", taslak: "Taslak", onayli: "Onaylı" };

function triageChip(level: string, score: number) {
  if (!level) return <span className="text-slate-600">—</span>;
  const c = score > 0.8 ? "border-rose-500/50 bg-rose-500/20 text-rose-200" : score > 0.6 ? "border-orange-500/50 bg-orange-500/15 text-orange-200" : score > 0.4 ? "border-yellow-500/50 bg-yellow-500/15 text-yellow-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  return <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold ${c}`}>{level}</span>;
}

/** Aidoc/Lunit tarzı: yüksek skorlu vakalar için ayrı "kritik aday" rozeti. */
function criticalBadge(score: number) {
  if (score <= 0.8) return null;
  return <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap rounded border border-rose-400/60 bg-rose-500/25 px-1.5 py-0.5 font-mono text-[9.5px] font-black tracking-wide text-rose-100"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />KRİTİK ADAY</span>;
}

export default function WorklistModal({ open, onClose, user, onOpenStudy, onOpenPacs }: Props) {
  const [tab, setTab] = useState<"liste" | "pacs" | "mwl">("liste");
  const [rows, setRows] = useState<StudyRow[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [pacs, setPacs] = useState<PacsStudy[]>([]);
  const [pq, setPq] = useState("");
  const [pacsErr, setPacsErr] = useState("");
  const [mwl, setMwl] = useState<MwlRow[]>([]);
  const [mwlDate, setMwlDate] = useState("");
  const [mwlModality, setMwlModality] = useState("");
  const [mwlOpen, setMwlOpen] = useState(true);
  const [mwlErr, setMwlErr] = useState("");
  const [mwlBusy, setMwlBusy] = useState(false);
  const [mwlNote, setMwlNote] = useState("");
  const [mwlLoaded, setMwlLoaded] = useState(false);
  const canAssign = true;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch(`/api/studies?${new URLSearchParams({ q, status })}`);
    if (r.ok) setRows((await r.json()) as StudyRow[]);
    setLoading(false);
  }, [q, status]);
  useEffect(() => {
    if (open && tab === "liste") void (async () => { await load(); })();
  }, [open, tab, load]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    await apiFetch(`/api/studies/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    void load();
  };
  const searchPacs = async () => {
    setPacsErr("");
    const r = await apiFetch(`/api/pacs/studies?q=${encodeURIComponent(pq)}`);
    const d = await r.json();
    if (!r.ok) { setPacs([]); setPacsErr((d as { error?: string }).error ?? "PACS hatası"); return; }
    setPacs(d as PacsStudy[]);
  };

  // MWL: modalite konsolunun "bugünün işleri" listesi (DICOMweb ya da DIMSE köprüsü).
  const loadMwl = useCallback(async () => {
    setMwlBusy(true);
    setMwlErr("");
    const params = new URLSearchParams();
    if (mwlDate) params.set("date", mwlDate);
    if (mwlModality) params.set("modality", mwlModality);
    if (mwlOpen) params.set("open", "1");
    const r = await apiFetch(`/api/his/mwl?${params}`);
    const d = (await r.json().catch(() => ({}))) as { items?: MwlRow[]; error?: string };
    if (!r.ok) { setMwl([]); setMwlErr(d.error ?? "MWL sorgusu başarısız"); }
    else setMwl(d.items ?? []);
    setMwlBusy(false);
  }, [mwlDate, mwlModality, mwlOpen]);
  /**
   * ADT^A08/A40 iletimi (e-hl7-mwl): demografi güncellemesi veya mükerrer kayıt
   * birleştirme. Ham HL7 metni yapıştırılır; sunucu plan üretip uygular ve
   * yapılmayan adımları gerekçesiyle döndürür (sessiz başarı yok).
   */
  const pushAdt = async () => {
    const raw = window.prompt("ADT mesajını yapıştırın (MSH ile başlayan HL7 v2 metni — A08/A40):", "");
    if (!raw?.trim()) return;
    setMwlErr("");
    setMwlNote("ADT uygulanıyor…");
    const r = await apiFetch("/api/his/mwl", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "adt", hl7: raw.trim() }),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string; action?: string; changed?: number; studies?: number; reason?: string; warnings?: string[] };
    const warn = d.warnings?.length ? ` · Uyarı: ${d.warnings[0]}` : "";
    if (!r.ok) { setMwlNote(""); setMwlErr(`ADT uygulanamadı: ${d.error ?? "hata"}`); return; }
    setMwlNote(`${d.action === "birlestir" ? `Birleştirildi (${d.studies ?? 0} çalışma)` : `ADT işlendi (${d.changed ?? 0} çalışma)`} — ${d.reason ?? "tamam"}.${warn}`);
    void loadMwl();
  };


  // Kullanıcı sekme/düğme ile istediğinde yüklenir (efekt içinde zincirleme durum
  // güncellemesi yapmamak için) — yerel sekme için aynı desen `load()` ile kullanılıyor.
  useEffect(() => {
    if (!open || tab !== "mwl" || mwlLoaded) return;
    void (async () => {
      await loadMwl();
      setMwlLoaded(true);
    })();
  }, [open, tab, mwlLoaded, loadMwl]);

  // "Çalışmaya al": MWL ögesi yerel kayda dönüşür; görüntü PACS'ten geldiğinde
  // aynı StudyInstanceUID ile eşleşir (accession bazlı türetme yalnız yedek).
  const takeMwl = async (row: MwlRow) => {
    setMwlBusy(true);
    setMwlNote("");
    const r = await apiFetch("/api/his/mwl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string; created?: boolean; id?: number };
    if (!r.ok) setMwlNote(d.error ?? "Çalışmaya alınamadı");
    else {
      setMwlNote(d.created ? `Yeni çalışma açıldı (#${d.id})` : `Mevcut çalışma güncellendi (#${d.id})`);
      setMwl((prev) => prev.map((x) => (x.stepId === row.stepId && x.accession === row.accession ? { ...x, status: "ARRIVED" } : x)));
    }
    setMwlBusy(false);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#232e40] bg-[#0b0f16] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[#1a2230] px-4 py-3">
          <h2 className="text-sm font-black tracking-wide text-slate-100">Çalışma listesi</h2>
          {(["liste", "pacs", "mwl"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`cursor-pointer rounded px-3 py-1 text-xs font-bold ${tab === t ? "bg-cyan-400/15 text-cyan-300 ring-1 ring-cyan-400/40" : "text-slate-400 hover:text-slate-200"}`}>{t === "liste" ? "Yerel / HBYS" : t === "pacs" ? "PACS (DICOMweb)" : "İş listesi (MWL)"}</button>
          ))}
          <button onClick={onClose} className="ml-auto cursor-pointer rounded border border-[#2d3b4e] bg-[#141b24] px-2.5 py-1 text-xs text-slate-300 hover:text-white">✕</button>
        </div>

        {tab === "liste" && (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#1a2230] px-4 py-2 text-xs">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hasta, ID, açıklama ara…" className="w-64 rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1.5 text-slate-200 placeholder:text-slate-600 focus:outline-none" />
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1.5 text-slate-200">
                <option value="">Tüm durumlar</option>
                {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <span className="text-slate-500">Triyaj önceliğine göre sıralıdır (en acil üstte).</span>
              <button onClick={() => void load()} className="ml-auto cursor-pointer text-cyan-400">⟳ yenile</button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-[#0b0f16] text-left text-slate-500">
                  <tr>{["Triyaj ▼", "Hasta", "ID", "Modalite", "Açıklama", "Tarih", "Durum", "Atanan", "Rapor", ""].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">{loading ? "Yükleniyor…" : "Kayıt yok. Görüntü açıp ☁ ile sunucuya kaydedin veya HBYS/PACS'tan getirin."}</td></tr>}
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-[#101722]">
                      <td className="border-b border-[#141b26] px-3 py-2">{triageChip(s.triageLevel, s.triageScore)}{criticalBadge(s.triageScore)}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-semibold text-slate-100">{s.patientName}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-slate-400">{s.patientId}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-bold text-cyan-300">{s.modality}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-300">{s.seriesDescription}<span className="ml-1 text-slate-600">({s.sliceCount})</span></td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-400">{s.studyDate}</td>
                      <td className="border-b border-[#141b26] px-3 py-2">
                        <select value={s.workStatus} disabled={!canAssign && s.workStatus === "onayli"} onChange={(e) => void patch(s.id, { workStatus: e.target.value })} className="rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5 text-slate-200">
                          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k} disabled={k === "onayli" && !canAssign}>{v}</option>)}
                        </select>
                      </td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-300">{s.assignedToName || (canAssign ? <button onClick={() => void patch(s.id, { assignTo: "me" })} className="cursor-pointer text-cyan-400 hover:underline">bana ata</button> : "—")}</td>
                      <td className="border-b border-[#141b26] px-3 py-2">{s.reportStatus ? <span className={s.reportStatus === "onaylandi" ? "text-emerald-300" : "text-rose-300"}>{s.reportStatus === "onaylandi" ? "onaylı" : "taslak"}</span> : <span className="text-slate-600">—</span>}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-right">
                        {s.hasFiles ? <button onClick={() => { onOpenStudy(s); onClose(); }} className="cursor-pointer rounded bg-cyan-500 px-2.5 py-1 font-bold text-slate-950 hover:bg-cyan-400">Aç</button> : <span className="text-[10px] text-slate-600">görüntü yok</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "mwl" && (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#1a2230] px-4 py-2 text-xs">
              <input type="date" value={mwlDate} onChange={(e) => setMwlDate(e.target.value)} aria-label="Planlanan tarih" className="rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1.5 text-slate-200" />
              <select value={mwlModality} onChange={(e) => setMwlModality(e.target.value)} aria-label="Modalite" className="rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1.5 text-slate-200">
                <option value="">Tüm modaliteler</option>
                {["CT", "MR", "CR", "DX", "US", "MG", "NM", "PT", "RF", "XA"].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <label className="flex items-center gap-1 text-slate-400"><input type="checkbox" checked={mwlOpen} onChange={(e) => setMwlOpen(e.target.checked)} /> yalnız açık işler</label>
              <button onClick={() => void loadMwl()} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 font-bold text-slate-950 hover:bg-cyan-400">{mwlBusy ? "Sorgulanıyor…" : "Sorgula"}</button>
              <button onClick={() => void pushAdt()} title="HBYS'den gelen ADT^A08 (demografi güncellemesi) veya ADT^A40 (hasta birleştirme) mesajını uygular" className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-1.5 font-semibold text-slate-300 hover:bg-[#1a2330]">👤 ADT ilet</button>
              <span className="text-slate-500">Tarih boşsa PACS bugünü döndürür. Kaynak: Yönetim → Entegrasyon → MWL kökü / DIMSE köprüsü.</span>
            </div>
            {mwlErr && <div className="border-b border-[#1a2230] px-4 py-2 text-xs font-semibold text-rose-300">{mwlErr}</div>}
            {mwlNote && <div className="border-b border-[#1a2230] px-4 py-2 text-xs font-semibold text-emerald-300">{mwlNote}</div>}
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-[#0b0f16] text-left text-slate-500"><tr>{["Başlangıç", "Hasta", "ID", "Modalite", "Açıklama", "İstek no", "İstasyon", "Durum", ""].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {mwl.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">{mwlBusy ? "Sorgulanıyor…" : "Bu tarihte iş yok. HBYS'de istek oluşturulduğundan emin olun."}</td></tr>}
                  {mwl.map((m) => (
                    <tr key={`${m.stepId || m.accession}-${m.patientId}`} className="hover:bg-[#101722]">
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-slate-400">{m.scheduledStart.replace("T", " ")}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-semibold text-slate-100">{m.patientName || "—"}{m.priority === "STAT" && <span className="ml-1 rounded border border-rose-400/60 bg-rose-500/20 px-1 font-mono text-[9px] font-black text-rose-100">STAT</span>}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-slate-400">{m.patientId}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-bold text-cyan-300">{m.modality || "—"}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-300">{m.description || m.bodyPart || "—"}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-slate-400">{m.accession || m.stepId}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-400">{m.stationAeTitle || "—"}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-300">{MWL_STATUS[m.status] ?? m.status}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-right">
                        <button disabled={mwlBusy} onClick={() => void takeMwl(m)} className="cursor-pointer rounded bg-cyan-500 px-2.5 py-1 font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">Çalışmaya al</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "pacs" && (
          <>
            <div className="flex items-center gap-2 border-b border-[#1a2230] px-4 py-2 text-xs">
              <input value={pq} onChange={(e) => setPq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void searchPacs()} placeholder="Hasta adı veya ID (QIDO-RS)…" className="w-72 rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1.5 text-slate-200 placeholder:text-slate-600 focus:outline-none" />
              <button onClick={() => void searchPacs()} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 font-bold text-slate-950">Ara</button>
              <span className="text-slate-500">PACS adresi: Yönetim → Entegrasyon.</span>
            </div>
            {pacsErr && <div className="border-b border-[#1a2230] px-4 py-2 text-xs font-semibold text-rose-300">{pacsErr}</div>}
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-[#0b0f16] text-left text-slate-500"><tr>{["Hasta", "ID", "Tarih", "Modalite", "Açıklama", "Görüntü", ""].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {pacs.map((s) => (
                    <tr key={s.studyUid} className="hover:bg-[#101722]">
                      <td className="border-b border-[#141b26] px-3 py-2 font-semibold text-slate-100">{s.patientName}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-slate-400">{s.patientId}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-400">{s.studyDate}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-bold text-cyan-300">{s.modalities}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-300">{s.description}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-slate-400">{s.instances}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 text-right"><button onClick={() => { onOpenPacs(s); onClose(); }} className="cursor-pointer rounded bg-cyan-500 px-2.5 py-1 font-bold text-slate-950 hover:bg-cyan-400">Getir ve aç</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
