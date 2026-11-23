"use client";

import { useEffect, useMemo, useState } from "react";
import { ADVICE, KIND_LABEL, csvOf, daysBetween, summarize, type NoduleKind, type NoduleTrack } from "@/lib/lungrads";
import { recist11, recistCsv } from "@/lib/recist";

export interface MeasurementChoice { label: string; mm: number; slice: number }
interface Props {
  patientId: string; patientName: string; studyDate: string;
  measurements: MeasurementChoice[];
  onClose: () => void;
}

const COLORS = ["#22d3ee", "#fbbf24", "#f472b6", "#a3e635", "#fb923c", "#a78bfa"];
const isoDate = (s: string) => { const d = (s || "").replace(/\D/g, "").slice(0, 8); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : new Date().toISOString().slice(0, 10); };
const uid = () => Math.random().toString(36).slice(2, 9);
const key = (pid: string) => `atik-nodules:${pid}`;

/** Nodül takibi: aynı hastanın nodül ölçümleri zaman serisi olarak izlenir; Lung-RADS özeti ve hacim ikilenme süresi hesaplanır. */
export default function NoduleTracker({ patientId, patientName, studyDate, measurements, onClose }: Props) {
  const [tracks, setTracks] = useState<NoduleTrack[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [date, setDate] = useState(isoDate(studyDate));
  const [diam, setDiam] = useState("");
  const [solid, setSolid] = useState("");
  const [note, setNote] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newLoc, setNewLoc] = useState("");
  const [newKind, setNewKind] = useState<NoduleKind>("solid");
  const [msg, setMsg] = useState("");
  // RECIST 1.1 ölçütleri — hekim işaretler
  const [newLesion, setNewLesion] = useState(false);
  const [allGone, setAllGone] = useState(false);

  useEffect(() => {
    void (async () => {
      try { const raw = localStorage.getItem(key(patientId)); const t = raw ? (JSON.parse(raw) as NoduleTrack[]) : []; setTracks(t); setSel(t[0]?.id ?? null); } catch { setTracks([]); }
      setLoaded(true);
    })();
  }, [patientId]);
  useEffect(() => {
    if (!loaded) return;
    void (async () => {
      try { localStorage.setItem(key(patientId), JSON.stringify(tracks)); } catch { setMsg("Tarayıcı depolama alanı dolu; kayıt yapılamadı."); }
    })();
  }, [tracks, loaded, patientId]);

  const cur = tracks.find((t) => t.id === sel) ?? null;
  const sum = useMemo(() => (cur ? summarize(cur) : null), [cur]);
  const recist = useMemo(
    () => recist11(tracks, { newLesion, allDisappeared: allGone }),
    [tracks, newLesion, allGone],
  );

  const addTrack = () => {
    const label = newLabel.trim() || `Nodül ${tracks.length + 1}`;
    const t: NoduleTrack = { id: uid(), label, location: newLoc.trim(), kind: newKind, points: [] };
    setTracks((x) => [...x, t]); setSel(t.id); setNewLabel(""); setNewLoc("");
  };
  const addPoint = () => {
    if (!cur) return;
    const d = parseFloat(diam.replace(",", "."));
    if (!Number.isFinite(d) || d <= 0 || d > 200) { setMsg("Geçerli bir çap (mm) girin."); return; }
    const s = solid ? parseFloat(solid.replace(",", ".")) : undefined;
    if (cur.points.some((p) => p.date === date)) { setMsg("Bu tarihte zaten ölçüm var; önce silin."); return; }
    setTracks((all) => all.map((t) => (t.id === cur.id ? { ...t, points: [...t.points, { date, diameterMm: d, solidMm: s, note: note.trim() || undefined }] } : t)));
    setDiam(""); setSolid(""); setNote(""); setMsg("");
  };
  const delPoint = (date0: string) => setTracks((all) => all.map((t) => (t.id === sel ? { ...t, points: t.points.filter((p) => p.date !== date0) } : t)));
  const delTrack = (id: string) => { setTracks((all) => all.filter((t) => t.id !== id)); setSel((s) => (s === id ? null : s)); };

  // grafik — eksen üst sınırı, bileşen açılışında bir kez alınır (render'da saflık için)
  const [chartNow] = useState(() => Date.now());
  const all = tracks.flatMap((t) => t.points.map((p) => ({ t: new Date(p.date).getTime(), d: p.diameterMm })));
  const tMin = Math.min(...all.map((a) => a.t), chartNow), tMax = Math.max(...all.map((a) => a.t), tMin + 86400000 * 30);
  const dMax = Math.max(16, ...all.map((a) => a.d * 1.15));
  const X = (t: number) => 44 + ((t - tMin) / (tMax - tMin)) * 436, Y = (d: number) => 190 - (d / dMax) * 170;
  const sortedPts = (t: NoduleTrack) => [...t.points].sort((a, b) => a.date.localeCompare(b.date));

  const downloadCsv = () => {
    const body = csvOf(tracks) + (recist ? "\n\n" + recistCsv(recist) : "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/csv;charset=utf-8" }));
    a.download = `nodul-takibi-${patientId}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  const inp = "rounded border border-[#1e2735] bg-[#0e141d] px-1.5 py-0.5 text-slate-100";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#2d3b4e] bg-[#0b0f16] text-xs text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1a2230] px-4 py-2">
          <div><span className="text-sm font-bold text-cyan-300">Nodül takibi</span> <span className="text-slate-400">· {patientName} · {patientId}</span></div>
          <button onClick={onClose} className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 hover:bg-[#1a2330]">✕ Kapat</button>
        </div>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-4 md:grid-cols-2">
          <div className="space-y-3">
            <div className="rounded-lg border border-[#1a2230] p-2">
              <div className="mb-1 font-bold text-slate-100">Nodüller</div>
              {tracks.length === 0 && <div className="text-slate-500">Henüz nodül yok. Aşağıdan ekleyin.</div>}
              {tracks.map((t, i) => (
                <div key={t.id} className={`flex items-center justify-between rounded px-2 py-1 ${sel === t.id ? "bg-cyan-400/10 ring-1 ring-cyan-400/40" : ""}`}>
                  <button className="flex-1 cursor-pointer text-left" onClick={() => setSel(t.id)}><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />{t.label}{t.location ? ` · ${t.location}` : ""} <span className="text-slate-500">({KIND_LABEL[t.kind]}, {t.points.length} ölçüm)</span></button>
                  <button aria-label={`${t.label} sil`} className="cursor-pointer px-1 text-slate-500 hover:text-red-400" onClick={() => { if (window.confirm(`${t.label} ve tüm ölçümleri silinsin mi?`)) delTrack(t.id); }}>🗑</button>
                </div>
              ))}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[#1a2230] pt-2">
                <input aria-label="Nodül adı" placeholder="Ad (ör. N1)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className={`${inp} w-20`} />
                <input aria-label="Konum" placeholder="Konum (SÜL…)" value={newLoc} onChange={(e) => setNewLoc(e.target.value)} className={`${inp} w-24`} />
                <select aria-label="Tür" value={newKind} onChange={(e) => setNewKind(e.target.value as NoduleKind)} className={inp}>{(Object.keys(KIND_LABEL) as NoduleKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
                <button data-testid="add-nodule" onClick={addTrack} className="cursor-pointer rounded bg-cyan-500 px-2 py-0.5 font-bold text-black">＋ Nodül</button>
              </div>
            </div>
            {cur && (
              <div className="rounded-lg border border-[#1a2230] p-2">
                <div className="mb-1 font-bold text-slate-100">Ölçüm ekle · {cur.label}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input aria-label="Tarih" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inp} />
                  <input aria-label="Çap (mm)" placeholder="Çap mm" value={diam} onChange={(e) => setDiam(e.target.value)} className={`${inp} w-20`} />
                  {cur.kind === "partsolid" && <input aria-label="Solid bileşen (mm)" placeholder="Solid mm" value={solid} onChange={(e) => setSolid(e.target.value)} className={`${inp} w-20`} />}
                  <input aria-label="Not" placeholder="Not" value={note} onChange={(e) => setNote(e.target.value)} className={`${inp} w-28`} />
                  <button data-testid="add-point" onClick={addPoint} className="cursor-pointer rounded bg-cyan-500 px-2 py-0.5 font-bold text-black">Ekle</button>
                </div>
                {measurements.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">Açık görüntüdeki ölçümden al:
                    {measurements.map((m, i) => <button key={i} onClick={() => setDiam(m.mm.toFixed(1))} className="cursor-pointer rounded border border-[#2d3b4e] px-1.5 py-0.5 hover:bg-[#1a2330]">{m.label} · K{m.slice + 1} · {m.mm.toFixed(1)} mm</button>)}
                  </div>
                )}
                {msg && <div className="mt-1 text-amber-300">{msg}</div>}
                <table className="mt-2 w-full text-left"><tbody>
                  {sortedPts(cur).map((p) => (
                    <tr key={p.date} className="border-t border-[#1a2230]"><td className="py-0.5 font-mono">{p.date}</td><td className="font-mono text-cyan-300">{p.diameterMm.toFixed(1)} mm{p.solidMm ? ` (solid ${p.solidMm})` : ""}</td><td className="text-slate-500">{p.note}</td><td className="text-right"><button aria-label={`${p.date} sil`} className="cursor-pointer text-slate-500 hover:text-red-400" onClick={() => delPoint(p.date)}>✕</button></td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="rounded-lg border border-[#1a2230] p-2">
              <div className="mb-1 font-bold text-slate-100">Çap – zaman</div>
              <svg data-testid="nodule-chart" viewBox="0 0 500 215" className="w-full">
                <rect x="0" y="0" width="500" height="215" fill="#070a0f" />
                {[6, 8, 15].filter((v) => v < dMax).map((v) => (
                  <g key={v}><line x1="44" x2="480" y1={Y(v)} y2={Y(v)} stroke="#334155" strokeDasharray="4 4" /><text x="8" y={Y(v) + 3} fontSize="9" fill="#64748b">{v} mm</text></g>
                ))}
                <line x1="44" x2="480" y1="190" y2="190" stroke="#475569" /><line x1="44" x2="44" y1="20" y2="190" stroke="#475569" />
                <text x="44" y="206" fontSize="9" fill="#94a3b8">{new Date(tMin).toISOString().slice(0, 10)}</text>
                <text x="480" y="206" fontSize="9" fill="#94a3b8" textAnchor="end">{new Date(tMax).toISOString().slice(0, 10)}</text>
                <text x="8" y="14" fontSize="9" fill="#94a3b8">çap (mm)</text>
                {tracks.map((t, i) => {
                  const pts = sortedPts(t); const c = COLORS[i % COLORS.length];
                  return (
                    <g key={t.id} opacity={sel && sel !== t.id ? 0.45 : 1}>
                      <polyline fill="none" stroke={c} strokeWidth="2" points={pts.map((p) => `${X(new Date(p.date).getTime())},${Y(p.diameterMm)}`).join(" ")} />
                      {pts.map((p) => <circle key={p.date} cx={X(new Date(p.date).getTime())} cy={Y(p.diameterMm)} r="3.5" fill={c}><title>{`${t.label} · ${p.date} · ${p.diameterMm} mm`}</title></circle>)}
                    </g>
                  );
                })}
              </svg>
              <div className="text-[10px] text-slate-500">Kesikli çizgiler: 6 / 8 / 15 mm (Lung-RADS solid nodül boyut eşikleri).</div>
            </div>
            {cur && sum && (
              <div className="rounded-lg border border-[#1a2230] p-2 leading-relaxed" data-testid="nodule-summary">
                <div className="mb-1 font-bold text-slate-100">Özet · {cur.label}</div>
                <div>Son ölçüm: <b className="text-cyan-300">{sum.latest.diameterMm.toFixed(1)} mm</b> ({sum.latest.date})</div>
                <div>İlk ölçümden değişim: <b>{sum.growthMm >= 0 ? "+" : ""}{sum.growthMm.toFixed(1)} mm</b>{sum.growth12mMm !== null && <> · son 12 ay: <b>{sum.growth12mMm >= 0 ? "+" : ""}{sum.growth12mMm.toFixed(1)} mm</b></>}</div>
                <div>Durum: <b>{{ baseline: "İlk (bazal)", new: "Yeni", growing: "Büyüyor", stable: "Stabil" }[sum.status]}</b>{sum.vdtDays !== null && <> · hacim ikilenme süresi ≈ <b>{Math.round(sum.vdtDays)} gün</b>{sum.vdtDays < 400 ? " (hızlı büyüme)" : ""}</>}</div>
                <div className="mt-1 rounded bg-cyan-400/10 px-2 py-1">Lung-RADS (özet eşik): <b className="text-cyan-200">{sum.category}</b> — {ADVICE[sum.category]}</div>
                {cur.points.length > 1 && <div className="text-slate-500">Toplam izlem süresi {Math.round(daysBetween(sum.first.date, sum.latest.date))} gün.</div>}
              </div>
            )}
            {recist && (
              <div className="rounded-lg border border-[#1a2230] p-2 leading-relaxed" data-testid="recist-panel">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-1 font-bold text-slate-100">
                  <span>RECIST 1.1 · Hedef lezyon yanıtı</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                      recist.response === "PD"
                        ? "bg-rose-500/20 text-rose-200"
                        : recist.response === "PR"
                          ? "bg-emerald-500/20 text-emerald-200"
                          : recist.response === "CR"
                            ? "bg-cyan-500/20 text-cyan-200"
                            : "bg-slate-500/20 text-slate-200"
                    }`}
                  >
                    {recist.responseLabel}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
                  <div className="text-slate-500">Bazal · {recist.baselineDate}</div>
                  <div className="text-right text-cyan-300">{recist.baselineSumMm.toFixed(1)} mm</div>
                  <div className="text-slate-500">İzlem · {recist.followUpDate}</div>
                  <div className="text-right text-cyan-300">{recist.followUpSumMm.toFixed(1)} mm</div>
                  <div className="text-slate-500">Değişim</div>
                  <div className="text-right">
                    {recist.deltaMm >= 0 ? "+" : ""}
                    {recist.deltaMm.toFixed(1)} mm ({recist.deltaPct === null ? "—" : `${recist.deltaPct >= 0 ? "+" : ""}${recist.deltaPct.toFixed(1)} %`})
                  </div>
                  <div className="text-slate-500">Hedef lezyon</div>
                  <div className="text-right">
                    {recist.targetCount}
                    {recist.overLimit ? " (≤10 sınırı aşıldı)" : ""}
                  </div>
                </div>
                <div className="mt-1 rounded bg-[#0e141d] px-2 py-1 text-[11px] text-slate-300">{recist.criteria}</div>

                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
                  <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={newLesion}
                      onChange={(e) => setNewLesion(e.target.checked)}
                      className="h-3.5 w-3.5 accent-rose-500"
                    />
                    İzlemde <b>yeni lezyon</b> var (hekim işareti → PD)
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={allGone}
                      onChange={(e) => setAllGone(e.target.checked)}
                      className="h-3.5 w-3.5 accent-cyan-500"
                    />
                    Tüm hedef lezyonlar <b>kayboldu</b> (→ CR)
                  </label>
                </div>

                <table className="mt-2 w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="py-0.5 font-semibold">Lezyon</th>
                      <th className="py-0.5 text-right font-semibold">Bazal</th>
                      <th className="py-0.5 text-right font-semibold">İzlem</th>
                      <th className="py-0.5 text-right font-semibold">Δ%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recist.lesions.map((l) => (
                      <tr key={l.label} className="border-t border-[#1a2230]">
                        <td className="py-0.5">{l.label}</td>
                        <td className="py-0.5 text-right font-mono text-cyan-300">{l.baselineMm === null ? "—" : `${l.baselineMm.toFixed(1)} mm`}</td>
                        <td className="py-0.5 text-right font-mono text-cyan-300">{l.followUpMm === null ? "—" : `${l.followUpMm.toFixed(1)} mm`}</td>
                        <td className="py-0.5 text-right font-mono">
                          {l.deltaPct === null ? (
                            <span className="text-amber-300">bazal yok</span>
                          ) : (
                            `${l.deltaPct >= 0 ? "+" : ""}${l.deltaPct.toFixed(1)}`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                  Hesap yalnız girilen en uzun çaplara dayanır. Hedef lezyon seçimi, organ başına ≤5 / toplam ≤10 sınırı,
                  lenf nodu (kısa eksen) ölçümleri ve non-hedef lezyonların değerlendirilmesi hekim sorumluluğundadır.
                  <span className="text-amber-300"> Klinik karar aracı değildir; sonuç radyoloji uzmanı tarafından doğrulanmalıdır.</span>
                </div>
              </div>
            )}
            <div className="rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-amber-200">
              Kategori, ACR Lung-RADS v2022 eşiklerinin ÖZETİ ve girilen çaplara dayanır; nodül tipi, konum, morfoloji, risk faktörleri ve güncel kılavuz dikkate alınmaz. Klinik karar aracı değildir. Veriler yalnızca bu tarayıcıda saklanır.
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-[#1a2230] px-4 py-2">
          <span className="text-slate-500">{tracks.length} nodül · {tracks.reduce((a, t) => a + t.points.length, 0)} ölçüm</span>
          <button disabled={tracks.length === 0} onClick={downloadCsv} className="cursor-pointer rounded border border-[#2d3b4e] px-3 py-1 font-bold hover:bg-[#1a2330] disabled:opacity-40">CSV indir</button>
        </div>
      </div>
    </div>
  );
}
