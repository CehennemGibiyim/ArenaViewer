"use client";

/**
 * Radyasyon dozu paneli (yeni modül).
 *
 * RDSR (X-Ray Radiation Dose SR) dosyalarını **tarayıcıda** okur; dosya sunucuya
 * gönderilmez. Değerler yalnızca belgede yazılanlardır; etkin doz yaklaşık
 * hesaptır ve DRL değerleri örnektir (düzenlenebilir). Klinik karar aracı değildir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EFFECTIVE_DOSE_REGIONS, ORNEK_DRL, SOP_RADIATION_DOSE_SR,
  compareToDrl, doseSummaryText, effectiveDoseMsv, extractDoseReport, summarizeDose,
  type DoseReport, type DoseSummary, type EffectiveDoseRegion,
} from "@/lib/dose";

interface Entry {
  report: DoseReport;
  summary: DoseSummary;
  file: string;
  sample: boolean;
}

const DRL_KEY = "atik_drl";

type DrlValues = Partial<Record<EffectiveDoseRegion, { ctdiVol?: number; dlp?: number }>>;

function defaults(): DrlValues {
  const out: DrlValues = {};
  for (const d of ORNEK_DRL) out[d.region] = { ctdiVol: d.ctdiVol, dlp: d.dlp };
  return out;
}

function loadDrl(): DrlValues {
  try {
    const raw = window.localStorage.getItem(DRL_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Record<string, { ctdiVol?: unknown; dlp?: unknown }>;
    const out: DrlValues = {};
    for (const r of EFFECTIVE_DOSE_REGIONS) {
      const v = parsed?.[r.id];
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
      const ctdiVol = num(v?.ctdiVol); const dlp = num(v?.dlp);
      if (ctdiVol !== undefined || dlp !== undefined) out[r.id] = { ctdiVol, dlp };
    }
    return Object.keys(out).length ? out : defaults();
  } catch {
    return defaults();
  }
}

const levelStyle: Record<string, string> = {
  ustunde: "border-rose-400/40 bg-rose-500/15 text-rose-200",
  yakinda: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  altinda: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
};
const levelLabel: Record<string, string> = { ustunde: "DRL üstünde", yakinda: "DRL yakınında", altinda: "DRL altında" };

export default function DosePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [active, setActive] = useState(0);
  const [region, setRegion] = useState<EffectiveDoseRegion | "">("");
  const [drl, setDrl] = useState<DrlValues>(() => (typeof window === "undefined" ? defaults() : loadDrl()));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const persistDrl = useCallback((next: DrlValues) => {
    setDrl(next);
    try { window.localStorage.setItem(DRL_KEY, JSON.stringify(next)); } catch { /* depolama kapalı */ }
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true); setError(""); setMsg("");
    try {
      const [{ parseDicom }, { applyCharset }, { parseStructuredReport }] = await Promise.all([
        import("dicom-parser"), import("@/lib/dicomCharset"), import("@/lib/dicomSpecial"),
      ]);
      const added: Entry[] = [];
      const problems: string[] = [];
      for (const file of files) {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const ds = applyCharset(parseDicom(buf));
          const sop = ds.string("x00080016") ?? "";
          const doc = parseStructuredReport(ds);
          const report = doc ? extractDoseReport(doc, { label: file.name }) : null;
          if (!report) {
            problems.push(`${file.name}: RDSR doz ölçümü bulunamadı${sop && sop !== SOP_RADIATION_DOSE_SR ? ` (SOP Class ${sop})` : ""}.`);
            continue;
          }
          if (sop && sop !== SOP_RADIATION_DOSE_SR) {
            report.warnings.push(`SOP Class UID RDSR (…88.67) değil: ${sop}. Değerler yine de belgeden okundu.`);
          }
          added.push({ report, summary: summarizeDose(report), file: file.name, sample: false });
        } catch (e) {
          problems.push(`${file.name}: okunamadı (${e instanceof Error ? e.message : "bilinmeyen hata"}).`);
        }
      }
      if (added.length) {
        setEntries((prev) => [...prev, ...added]);
        setActive(entries.length + added.length - 1);
        setMsg(`${added.length} doz raporu okundu.`);
      }
      if (problems.length) setError(problems.join(" "));
    } finally {
      setBusy(false);
    }
  }, [entries.length]);

  /** Örnek veri: dosya olmadan panelin davranışını göstermek için. */
  const addSample = useCallback(() => {
    const report: DoseReport = {
      id: `sample-${Date.now()}`,
      title: "ÖRNEK — Toraks BT doz raporu",
      templateId: "10001",
      procedure: "Toraks BT, kontrastsız (örnek)",
      events: [
        { index: 1, protocol: "Toraks rutin", ctdiVol: 12.4, dlp: 470, extras: [] },
        { index: 2, protocol: "Toraks takip", ctdiVol: 9.1, dlp: 215, extras: [] },
      ],
      warnings: ["Bu bir ÖRNEK kayıttır; hasta verisi değildir."],
    };
    setEntries((prev) => [...prev, { report, summary: summarizeDose(report), file: "örnek", sample: true }]);
    setActive(entries.length);
    setMsg("Örnek doz raporu eklendi (gerçek hasta verisi değildir).");
  }, [entries.length]);

  const current = entries[active];
  const summary = current?.summary;
  const regionDrl = region ? drl[region] : undefined;
  const comparisons = useMemo(() => (summary ? compareToDrl(summary, { ctdiVol: regionDrl?.ctdiVol, dlp: regionDrl?.dlp }) : []), [summary, regionDrl]);
  const effective = summary && region ? effectiveDoseMsv(summary.totalDlp, region) : undefined;

  const summaryText = useCallback(() => {
    if (!current) return "";
    return doseSummaryText(current.report, current.summary, {
      region: region || undefined,
      drl: regionDrl ? { ctdiVol: regionDrl.ctdiVol, dlp: regionDrl.dlp } : undefined,
    });
  }, [current, region, regionDrl]);

  const copy = async () => {
    const text = summaryText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Özet panoya kopyalandı.");
    } catch {
      setMsg("Panoya kopyalanamadı; metni seçip elle kopyalayın.");
    }
  };

  const download = () => {
    const text = summaryText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `doz-ozeti-${current?.report.id.slice(0, 24) ?? "rapor"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Özet metin dosyası indirildi.");
  };

  if (!open) return null;

  const card = "rounded-lg border border-[#223047] bg-[#0d141e] p-2.5";
  const labelCls = "text-[10px] font-bold uppercase tracking-wider text-slate-400";

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-3"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dose-title"
        aria-describedby="dose-disclaimer"
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-[#223047] bg-[#0b1018] p-4 shadow-2xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="dose-title" className="text-base font-black text-cyan-300">☢ Radyasyon dozu (RDSR)</h2>
            <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-slate-400">
              X-Ray Radiation Dose SR dosyalarını tarayıcıda okur; CTDIvol ve DLP özetler. Dosya sunucuya gönderilmez.
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Doz panelini kapat"
            className="cursor-pointer rounded border border-slate-500/40 px-2 py-1 text-xs font-bold text-slate-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">
            Kapat ✕
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-md border border-cyan-400/50 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/20 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cyan-300">
            RDSR dosyası seç
            <input
              ref={inputRef}
              type="file" multiple accept=".dcm,application/dicom" className="sr-only"
              onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.currentTarget.value = ""; }}
            />
          </label>
          <button type="button" onClick={addSample} className="cursor-pointer rounded-md border border-violet-400/40 px-3 py-1.5 text-xs font-bold text-violet-200 hover:bg-violet-400/10">Örnek özet ekle</button>
          {entries.length > 0 && (
            <button type="button" onClick={() => { setEntries([]); setActive(0); setError(""); setMsg(""); }}
              className="cursor-pointer rounded-md border border-rose-400/40 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-400/10">
              Listeyi temizle
            </button>
          )}
          <span role="status" aria-live="polite" className="text-[11px] text-slate-400">{busy ? "Okunuyor…" : msg}</span>
        </div>

        {error && <p role="alert" className="mt-2 rounded border border-rose-400/40 bg-rose-500/10 p-2 text-[11px] text-rose-200">{error}</p>}

        {entries.length === 0 && !error && (
          <p className="mt-4 rounded-lg border border-dashed border-[#223047] p-4 text-center text-xs text-slate-400">
            Henüz doz raporu yok. PACS/doz yazılımından indirdiğiniz RDSR dosyasını seçin veya örnek özeti ekleyin.
          </p>
        )}

        {entries.length > 1 && (
          <div className="mt-3">
            <label className="block text-[11px] text-slate-400">
              Rapor
              <select aria-label="Doz raporu seç" value={active} onChange={(e) => setActive(Number(e.target.value))}
                className="ml-2 rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
                {entries.map((e, i) => <option key={e.report.id + i} value={i}>{i + 1}. {e.file}</option>)}
              </select>
            </label>
          </div>
        )}

        {current && summary && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-black text-slate-200">{current.report.title}</h3>
              {current.sample && <span className="rounded border border-violet-400/40 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-bold text-violet-200">ÖRNEK VERİ</span>}
              {current.report.procedure && <span className="text-[11px] text-slate-400">{current.report.procedure}</span>}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className={card}><div className={labelCls}>Olay</div><div className="text-lg font-black text-slate-100">{summary.eventCount}</div></div>
              <div className={card}><div className={labelCls}>Toplam DLP</div><div className="text-lg font-black text-cyan-200">{summary.totalDlp === undefined ? "—" : summary.totalDlp.toFixed(1)}<span className="ml-1 text-[10px] font-normal text-slate-400">mGy·cm</span></div></div>
              <div className={card}><div className={labelCls}>Ort. CTDIvol</div><div className="text-lg font-black text-emerald-200">{summary.meanCtdiVol === undefined ? "—" : summary.meanCtdiVol.toFixed(2)}<span className="ml-1 text-[10px] font-normal text-slate-400">mGy</span></div></div>
              <div className={card}><div className={labelCls}>En yüksek CTDIvol</div><div className="text-lg font-black text-amber-200">{summary.maxCtdiVol === undefined ? "—" : summary.maxCtdiVol.toFixed(2)}<span className="ml-1 text-[10px] font-normal text-slate-400">mGy</span></div></div>
            </div>

            {summary.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-[10.5px] text-amber-200/90">
                {summary.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}

            {current.report.events.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-[#223047]">
                <table className="w-full border-collapse text-[11px]">
                  <caption className="sr-only">Işınlama olayları ve doz değerleri</caption>
                  <thead>
                    <tr className="bg-[#111a26] text-left text-slate-400">
                      <th scope="col" className="px-2 py-1 font-bold">#</th>
                      <th scope="col" className="px-2 py-1 font-bold">Protokol / bölge</th>
                      <th scope="col" className="px-2 py-1 text-right font-bold">CTDIvol (mGy)</th>
                      <th scope="col" className="px-2 py-1 text-right font-bold">DLP (mGy·cm)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.report.events.map((e) => (
                      <tr key={e.index} className="border-t border-[#182231] text-slate-200">
                        <td className="px-2 py-1 font-mono">{e.index}</td>
                        <td className="px-2 py-1">{e.protocol ?? "—"}{e.region ? <span className="text-slate-500"> · {e.region}</span> : null}</td>
                        <td className="px-2 py-1 text-right font-mono">{e.ctdiVol === undefined ? "—" : e.ctdiVol.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right font-mono">{e.dlp === undefined ? "—" : e.dlp.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-[11px] text-slate-300">
                Bölge (etkin doz tahmini için)
                <select aria-label="Bölge" value={region} onChange={(e) => setRegion(e.target.value as EffectiveDoseRegion | "")}
                  className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
                  <option value="">Seçilmedi</option>
                  {EFFECTIVE_DOSE_REGIONS.map((r) => <option key={r.id} value={r.id}>{r.label} (k={r.k})</option>)}
                </select>
              </label>
              <div className={card}>
                <div className={labelCls}>Yaklaşık etkin doz</div>
                <div className="text-lg font-black text-violet-200">
                  {effective === undefined ? "—" : `${effective.toFixed(2)} mSv`}
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-slate-500">DLP × bölge katsayısı; dozimetri ölçümü değildir.</p>
              </div>
            </div>

            {region && (
              <div className="rounded-lg border border-[#223047] bg-[#0d141e] p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-300">Örnek DRL karşılaştırması — kurumsal DRL ile değiştirin</span>
                  <button type="button" onClick={() => {
                    const reset = { ...drl };
                    const d = ORNEK_DRL.find((x) => x.region === region);
                    reset[region] = { ctdiVol: d?.ctdiVol, dlp: d?.dlp };
                    persistDrl(reset);
                  }} className="cursor-pointer rounded border border-slate-500/40 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/10">Örnek değere dön</button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block text-[11px] text-slate-300">CTDIvol DRL (mGy)
                    <input type="number" min={0} step="0.1" aria-label="CTDIvol DRL" value={regionDrl?.ctdiVol ?? ""}
                      onChange={(e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); persistDrl({ ...drl, [region]: { ...drl[region], ctdiVol: v } }); }}
                      className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
                  </label>
                  <label className="block text-[11px] text-slate-300">DLP DRL (mGy·cm)
                    <input type="number" min={0} step="1" aria-label="DLP DRL" value={regionDrl?.dlp ?? ""}
                      onChange={(e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); persistDrl({ ...drl, [region]: { ...drl[region], dlp: v } }); }}
                      className="mt-1 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
                  </label>
                </div>
                {comparisons.length === 0 ? (
                  <p className="mt-2 text-[11px] text-slate-500">Karşılaştırma için değer ve DRL gerekir.</p>
                ) : (
                  <table className="mt-2 w-full border-collapse text-[11px]">
                    <thead><tr className="text-left text-slate-400"><th scope="col" className="py-1 font-bold">Metrik</th><th scope="col" className="py-1 text-right font-bold">Değer</th><th scope="col" className="py-1 text-right font-bold">DRL</th><th scope="col" className="py-1 text-right font-bold">Oran</th><th scope="col" className="py-1 text-right font-bold">Durum</th></tr></thead>
                    <tbody>
                      {comparisons.map((c) => (
                        <tr key={c.metric} className="border-t border-[#182231]">
                          <td className="py-1 text-slate-200">{c.metric === "dlp" ? "DLP" : "CTDIvol"}</td>
                          <td className="py-1 text-right font-mono text-slate-200">{c.value.toFixed(2)}</td>
                          <td className="py-1 text-right font-mono text-slate-400">{c.drl}</td>
                          <td className="py-1 text-right font-mono text-slate-200">%{Math.round(c.ratio * 100)}</td>
                          <td className="py-1 text-right"><span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${levelStyle[c.level]}`}>{levelLabel[c.level]}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                  DRL değerleri örnektir ve doğrulanmamıştır; bu tablo uygunluk/kalite kanıtı değildir.
                </p>
              </div>
            )}

            {current.report.warnings.length > 0 && (
              <details className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-2 text-[10.5px] text-amber-200">
                <summary className="cursor-pointer font-semibold">Belge uyarıları ({current.report.warnings.length})</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">{current.report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copy()} className="cursor-pointer rounded bg-cyan-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-400">Özeti kopyala</button>
              <button type="button" onClick={download} className="cursor-pointer rounded border border-slate-500/40 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10">.txt indir</button>
            </div>
          </div>
        )}

        <p id="dose-disclaimer" className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-amber-200">
          Bu panel bilgi amaçlıdır. Değerler yalnızca belgede yazılanlardır; eksik değer tahmin edilmez.
          Etkin doz yaklaşık göstergedir, DRL değerleri örnektir. Klinik karar veya dozimetri ölçümü yerine geçmez.
        </p>
      </div>
    </div>
  );
}
