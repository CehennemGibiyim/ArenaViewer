"use client";

/**
 * Model kayıt defteri paneli (a-modelops) — /yonetim → Model kayıt defteri.
 *
 * Sürüm kaydı/аşama değişikliği yapar ve A/B trafik planını gösterir. Kurallar
 * istemcide de uygulanır (`validateRegistration`), ama tek doğruluk kaynağı
 * sunucudur: hata yanıtı aynen gösterilir. Panel performans iddiası taşımaz.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/csrfClient";
import {
  MODEL_STAGES, trafficPlan, validateRegistration,
  type ModelStage, type ModelVersion, type RegistrySummary,
} from "@/lib/modelRegistry";

const STAGE_TR: Record<ModelStage, string> = { aday: "Aday", gölge: "Gölge", aktif: "Aktif", emekli: "Emekli" };
const STAGE_STYLE: Record<ModelStage, string> = {
  aday: "border-slate-500/40 text-slate-300",
  gölge: "border-violet-400/40 text-violet-200",
  aktif: "border-emerald-400/50 text-emerald-200",
  emekli: "border-rose-400/30 text-rose-200/70",
};

export default function ModelRegistryPanel() {
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [summary, setSummary] = useState<RegistrySummary | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ modelKey: "nodule.ct", version: "", stage: "aday" as ModelStage, trafficPct: 0, artifactHash: "", notes: "" });

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await apiFetch("/api/models");
      if (!r.ok) {
        setMsg(r.status === 401 ? "Oturum gerekli." : r.status === 403 ? "Yalnız yönetici model kayıt defterini görebilir." : `Kayıt defteri okunamadı (HTTP ${r.status}).`);
        setModels([]); setSummary(null);
        return;
      }
      const j = (await r.json()) as { models?: ModelVersion[]; summary?: RegistrySummary };
      setModels(Array.isArray(j.models) ? j.models : []);
      setSummary(j.summary ?? null);
    } catch {
      setMsg("Sunucuya ulaşılamadı; kayıt defteri yalnız bağlı sürümde görünür.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const save = async (payload: Record<string, unknown>) => {
    const local = validateRegistration(payload);
    if (!local.ok) { setMsg(local.error!); return; }
    const r = await apiFetch("/api/models", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) { setMsg(`Kaydedilemedi: ${j.error ?? `HTTP ${r.status}`}`); return; }
    setMsg("Kayıt defteri güncellendi (denetim kaydına yazıldı).");
    await load();
  };

  const plan = trafficPlan(models);
  const activeKeys = [...new Set(models.filter((m) => m.stage === "aktif").map((m) => m.modelKey))];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-bold text-slate-100">Model kayıt defteri</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">
          Hangi sürüm hangi aşamada ve ne kadar trafik alıyor. Değişiklikler denetim kaydına yazılır; kayıt defteri model performansı KANITLAMAZ.
        </p>
      </div>

      {msg && <p role="status" aria-live="polite" className="rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-100">{msg}</p>}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
        <button type="button" onClick={() => void load()} className="cursor-pointer rounded border border-[#223047] px-2 py-1 font-bold">{loading ? "Yükleniyor…" : "Yenile"}</button>
        {summary && (
          <>
            <span className="rounded border border-[#223047] px-2 py-0.5">Toplam {summary.total}</span>
            <span className="rounded border border-[#223047] px-2 py-0.5">Aktif {summary.byStage.aktif} · Gölge {summary.byStage.gölge} · Aday {summary.byStage.aday} · Emekli {summary.byStage.emekli}</span>
            <span className="rounded border border-emerald-400/30 px-2 py-0.5 text-emerald-200">
              {summary.activeVersion ? `${summary.activeKey} @ ${summary.activeVersion}` : "Aktif sürüm yok"}
            </span>
          </>
        )}
      </div>

      {plan.error && models.length > 0 && <p className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">{plan.error} — A/B ataması yapılmaz.</p>}
      {plan.normalized && <p className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">Aktif trafik toplamı %100 değil; oranlar normalize edilerek kullanılıyor.</p>}
      {plan.buckets.length > 0 && (
        <p className="text-[11px] text-slate-300">
          Trafik planı: {plan.buckets.map((b) => `${b.version} %${b.pct.toFixed(1)}`).join(" · ")} · atama konu kimliğinin karmasına bağlı (aynı hasta aynı sürümde kalır).
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <caption className="sr-only">Model sürümleri</caption>
          <thead>
            <tr className="border-b border-[#223047] text-left text-[10px] uppercase tracking-wider text-slate-400">
              <th scope="col" className="py-1 pr-2">Model</th><th scope="col" className="pr-2">Sürüm</th><th scope="col" className="pr-2">Aşama</th>
              <th scope="col" className="pr-2">Trafik</th><th scope="col" className="pr-2">Özet</th><th scope="col" className="pr-2">Güncelleyen</th><th scope="col">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr><td colSpan={7} className="py-4 text-center text-slate-400">{loading ? "Yükleniyor…" : "Kayıtlı model sürümü yok."}</td></tr>
            )}
            {models.map((m) => (
              <tr key={m.id} className="border-b border-[#141c27]">
                <th scope="row" className="py-1 pr-2 text-left font-medium text-slate-100">{m.modelKey}</th>
                <td className="pr-2 font-mono">{m.version}</td>
                <td className="pr-2"><span className={`rounded border px-1.5 py-0.5 ${STAGE_STYLE[m.stage]}`}>{STAGE_TR[m.stage]}</span></td>
                <td className="pr-2 font-mono">{m.trafficPct}%</td>
                <td className="max-w-[220px] truncate pr-2 text-slate-400" title={m.artifactHash}>{m.artifactHash || "—"}</td>
                <td className="pr-2 text-slate-400">{m.createdBy || "—"}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {m.stage !== "emekli" && (
                      <button type="button" onClick={() => void save({ modelKey: m.modelKey, version: m.version, stage: "emekli", trafficPct: 0, artifactHash: m.artifactHash, notes: m.notes })}
                        className="cursor-pointer rounded border border-rose-400/40 px-1.5 py-0.5 text-rose-200">Emekliye ayır</button>
                    )}
                    {m.stage === "aday" && (
                      <button type="button" onClick={() => void save({ modelKey: m.modelKey, version: m.version, stage: "gölge", trafficPct: 0, artifactHash: m.artifactHash, notes: m.notes })}
                        className="cursor-pointer rounded border border-violet-400/40 px-1.5 py-0.5 text-violet-200">Gölgeye al</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="grid gap-2 rounded-lg border border-[#223047] bg-[#0d141e] p-2 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); void save({ ...form, trafficPct: Number(form.trafficPct) }); }}
      >
        <h3 className="text-[11px] font-bold text-slate-200 sm:col-span-2">Sürüm kaydet / güncelle</h3>
        <label className="text-[11px] text-slate-300">Model anahtarı
          <input required value={form.modelKey} onChange={(e) => setForm({ ...form, modelKey: e.target.value })}
            className="mt-0.5 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
        </label>
        <label className="text-[11px] text-slate-300">Sürüm
          <input required placeholder="1.2.0" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })}
            className="mt-0.5 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
        </label>
        <label className="text-[11px] text-slate-300">Aşama
          <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as ModelStage })}
            className="mt-0.5 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
            {MODEL_STAGES.map((s) => <option key={s} value={s}>{STAGE_TR[s]}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-slate-300">Trafik %
          <input type="number" min={0} max={100} value={form.trafficPct} onChange={(e) => setForm({ ...form, trafficPct: Number(e.target.value) })}
            className="mt-0.5 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
        </label>
        <label className="text-[11px] text-slate-300 sm:col-span-2">Özet / not (artifact hash, değişiklik gerekçesi)
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="mt-0.5 w-full rounded border border-[#223047] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className="cursor-pointer rounded border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[11px] font-bold text-emerald-100">Kaydet</button>
          {activeKeys.length > 1 && <span className="ml-2 text-[10px] text-slate-400">Birden çok model anahtarı aktif; A/B planı yukarıda listelenir.</span>}
        </div>
      </form>
    </div>
  );
}
