"use client";

import { useState } from "react";
import type { SeriesData } from "@/lib/types";
import { CMAPS, type CmapName } from "@/lib/fusion";
import { sameFrame, resampleOnto } from "@/lib/planes";
import { applyRigid, estimateRigid, isIdentityRigid, normalizeRigid, rigidNote, rigidTrusted, type RigidParams } from "@/lib/fusionRigid";
import { deformNote, estimateDeform, isIdentityField, type DeformField } from "@/lib/fusionDeform";
import { estimateTranslationMI, metricFor, miNote, miTrusted } from "@/lib/fusionMi";
import { estimateSliceShift, zShiftNote } from "@/lib/fusionZ";

export interface FusionConfig {
  seriesId: string;
  alpha: number;
  cmap: CmapName;
  loPct: number;
  hiPct: number;
  rigid?: RigidParams;
  /** Elastik (deforme) alan — katı hizalamadan sonra uygulanır. */
  deform?: DeformField | null;
  /** Kesitler arası (z) kayma, mm (fusionZ::estimateSliceShift). */
  zMm?: number;
}

interface Props {
  all: SeriesData[];
  primary: SeriesData | null;
  cfg: FusionConfig | null;
  onChange: (c: FusionConfig | null) => void;
  /** Ana serinin görüntülenen kesiti (katı hizalama bu kesitte hesaplanır). */
  slice?: number;
}

/** Füzyon (ör. PET → BT): ikinci seriyi hasta koordinatlarına göre ana serinin üzerine bindirir. */
export default function FusionControl({ all, primary, cfg, onChange, slice = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<{ busy: boolean; note: string }>({ busy: false, note: "" });
  const [deform, setDeform] = useState<{ busy: boolean; note: string }>({ busy: false, note: "" });
  const [zState, setZState] = useState<{ busy: boolean; note: string }>({ busy: false, note: "" });
  const candidates = all.filter((s) => primary && s.id !== primary.id && (!s.specialType || s.specialType === "image") && !s.isColor && s.slices.length > 0 && !!s.ipp && !!s.orientation && sameFrame(primary, s));
  const active = !!cfg;
  const set = (patch: Partial<FusionConfig>) => cfg && onChange({ ...cfg, ...patch });
  const choose = (id: string) => {
    const s = all.find((x) => x.id === id);
    if (!s) { onChange(null); return; }
    setAlign({ busy: false, note: "" });
    setDeform({ busy: false, note: "" });
    setZState({ busy: false, note: "" });
    onChange({ seriesId: id, alpha: 0.5, cmap: s.modality === "PT" || s.modality === "NM" ? "hot" : "rainbow", loPct: s.modality === "PT" ? 15 : 20, hiPct: s.modality === "PT" ? 80 : 100 });
  };
  const setRigid = (patch: Partial<RigidParams>) => {
    if (!cfg) return;
    // Katı dönüşüm değişince önceki elastik alan geçersizdir (alan o hizalamaya
    // göre kestirildi): sessizce eski alanı uygulamak bindirmeyi bozar.
    const staleDeform = cfg.deform && !isIdentityField(cfg.deform);
    onChange({ ...cfg, rigid: normalizeRigid({ ...(cfg.rigid ?? {}), ...patch }), deform: null });
    if (staleDeform) setDeform({ busy: false, note: "Katı hizalama değişti; elastik alan sıfırlandı — yeniden hesaplayın." });
  };
  /** Hizalama girdisi: yeniden örneklenmiş kesit, katı dönüşüm uygulanmış hâliyle. */
  const alignedMoving = (idx: number, other: SeriesData) => {
    const mov = resampleOnto(primary!, idx, other);
    if (!mov || !primary) return mov;
    return isIdentityRigid(cfg?.rigid) ? mov : applyRigid(mov, primary.width, primary.height, cfg!.rigid!);
  };

  // Otomatik katı hizalama: ana kesit ile yeniden örneklenmiş füzyon kesiti
  // arasında NCC taraması. Sonuç yalnız öneridir; hekim görsel doğrular.
  const autoAlign = async () => {
    if (!cfg || !primary) return;
    const other = all.find((x) => x.id === cfg.seriesId);
    if (!other) return;
    setAlign({ busy: true, note: "Hesaplanıyor…" });
    await new Promise((r) => setTimeout(r, 16));
    const idx = Math.min(Math.max(0, slice), primary.slices.length - 1);
    const ref = primary.slices[idx];
    const mov = resampleOnto(primary, idx, other);
    if (!ref || !mov) {
      setAlign({ busy: false, note: "Hizalama için konum bilgisi (IPP/IOP) eksik." });
      return;
    }
    // Metrik modaliteye göre seçilir: aynı modalite → NCC (dönme/ölçek dahil),
    // farklı modalite → MI (yalnız öteleme, çünkü yoğunluk ilişkisi doğrusal değil).
    const metric = metricFor(primary.modality, other.modality);
    if (metric === "mi") {
      const mi = estimateTranslationMI(ref, mov, primary.width, primary.height, { maxShift: 25 });
      onChange({ ...cfg, rigid: mi.rigid, deform: null });
      setAlign({ busy: false, note: miNote(mi, miTrusted(mi)) });
    } else {
      const est = estimateRigid(ref, mov, primary.width, primary.height, { maxShift: 25, maxRotDeg: 12 });
      onChange({ ...cfg, rigid: est.rigid, deform: null });
      setAlign({ busy: false, note: rigidNote(est, rigidTrusted(est)) });
    }
    setDeform({ busy: false, note: "" });
  };
  // Elastik (deforme) hizalama: katı hizalama sonrası yoğun yer değiştirme alanı.
  // Kazanç yoksa alan sıfır kalır; bindirme hiçbir durumda kötüleştirilmez.
  const autoDeform = async () => {
    if (!cfg || !primary) return;
    const other = all.find((x) => x.id === cfg.seriesId);
    if (!other) return;
    setDeform({ busy: true, note: "Hesaplanıyor…" });
    await new Promise((r) => setTimeout(r, 16));
    const idx = Math.min(Math.max(0, slice), primary.slices.length - 1);
    const ref = primary.slices[idx];
    const mov = alignedMoving(idx, other);
    if (!ref || !mov) {
      setDeform({ busy: false, note: "Hizalama için konum bilgisi (IPP/IOP) eksik." });
      return;
    }
    const est = estimateDeform(ref, mov, primary.width, primary.height, { maxDisp: 12, grid: 7, search: 3 });
    onChange({ ...cfg, deform: est.improved ? est.field : null });
    setDeform({ busy: false, note: deformNote(est) });
  };
  // Kesitler arası (z) kayma: iki serinin kesitlerini konuma göre eşleyip NCC ile
  // en iyi z ötelemesini arar (in-plane hizalama bunu düzeltemez).
  const autoZ = async () => {
    if (!cfg || !primary) return;
    const other = all.find((x) => x.id === cfg.seriesId);
    if (!other) return;
    setZState({ busy: true, note: "Hesaplanıyor…" });
    await new Promise((r) => setTimeout(r, 16));
    const est = estimateSliceShift(primary, other, { maxShiftMm: 30 });
    onChange({ ...cfg, zMm: est.improved ? est.dzMm : 0 });
    setZState({ busy: false, note: zShiftNote(est) });
  };
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={!primary}
        onClick={() => setOpen((o) => !o)}
        title={candidates.length ? "Füzyon: ikinci seriyi (ör. PET) hasta koordinatlarına göre bindir" : "Füzyon için aynı Frame of Reference'a ve konum bilgisine (IPP/IOP) sahip ikinci bir seri gerekir"}
        className={`cursor-pointer rounded-md border px-2 py-1 text-[11px] font-semibold ${active ? "border-amber-400/60 bg-amber-400/15 text-amber-200" : "border-[#2d3b4e] bg-[#111823] text-slate-300 hover:bg-[#1a2330]"}`}
      >
        Füzyon{active ? " ●" : ""}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-[#2d3b4e] bg-[#0b0f16] p-3 text-[11px] text-slate-200 shadow-2xl">
          <div className="mb-2 font-bold text-amber-300">Füzyon (bindirme)</div>
          {candidates.length === 0 ? (
            <p className="leading-relaxed text-slate-400">Bu seriyle aynı Frame of Reference&apos;ı paylaşan ve konum etiketleri (ImagePositionPatient / ImageOrientationPatient) olan başka bir seri açık değil. PET-BT için iki seriyi birlikte yükleyin.</p>
          ) : (
            <div className="space-y-2">
              <select aria-label="Füzyon serisi" value={cfg?.seriesId ?? ""} onChange={(e) => choose(e.target.value)} className="w-full rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1">
                <option value="">Kapalı</option>
                {candidates.map((s) => <option key={s.id} value={s.id}>{s.modality} · {s.description} ({s.slices.length})</option>)}
              </select>
              {cfg && (
                <>
                  <label className="flex items-center justify-between gap-2">Opaklık
                    <input type="range" min={10} max={100} value={Math.round(cfg.alpha * 100)} onChange={(e) => set({ alpha: Number(e.target.value) / 100 })} className="w-36" />
                  </label>
                  <label className="flex items-center justify-between gap-2">Alt eşik %{cfg.loPct}
                    <input type="range" min={0} max={90} value={cfg.loPct} onChange={(e) => set({ loPct: Math.min(Number(e.target.value), cfg.hiPct - 5) })} className="w-36" />
                  </label>
                  <label className="flex items-center justify-between gap-2">Üst sınır %{cfg.hiPct}
                    <input type="range" min={10} max={100} value={cfg.hiPct} onChange={(e) => set({ hiPct: Math.max(Number(e.target.value), cfg.loPct + 5) })} className="w-36" />
                  </label>
                  <label className="flex items-center justify-between gap-2">Renk
                    <select value={cfg.cmap} onChange={(e) => set({ cmap: e.target.value as CmapName })} className="w-36 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5">
                      {(Object.keys(CMAPS) as CmapName[]).map((k) => <option key={k} value={k}>{CMAPS[k]}</option>)}
                    </select>
                  </label>
                  <div className="space-y-1 rounded border border-[#1e2735] px-2 py-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-300">Katı hizalama</span>
                      <span className="font-mono text-[10px] text-slate-500">{isIdentityRigid(cfg.rigid) ? "kapalı" : "etkin"}</span>
                    </div>
                    <label className="flex items-center justify-between gap-2">Kaydırma X {Math.round(cfg.rigid?.dx ?? 0)} px
                      <input type="range" min={-50} max={50} step={1} value={Math.round(cfg.rigid?.dx ?? 0)} onChange={(e) => setRigid({ dx: Number(e.target.value) })} className="w-28" aria-label="Füzyon kaydırma X" />
                    </label>
                    <label className="flex items-center justify-between gap-2">Kaydırma Y {Math.round(cfg.rigid?.dy ?? 0)} px
                      <input type="range" min={-50} max={50} step={1} value={Math.round(cfg.rigid?.dy ?? 0)} onChange={(e) => setRigid({ dy: Number(e.target.value) })} className="w-28" aria-label="Füzyon kaydırma Y" />
                    </label>
                    <label className="flex items-center justify-between gap-2">Dönme {(cfg.rigid?.rotDeg ?? 0).toFixed(1)}°
                      <input type="range" min={-30} max={30} step={0.5} value={cfg.rigid?.rotDeg ?? 0} onChange={(e) => setRigid({ rotDeg: Number(e.target.value) })} className="w-28" aria-label="Füzyon dönme" />
                    </label>
                    <label className="flex items-center justify-between gap-2">Ölçek {(cfg.rigid?.scale ?? 1).toFixed(3)}
                      <input type="range" min={0.85} max={1.15} step={0.005} value={cfg.rigid?.scale ?? 1} onChange={(e) => setRigid({ scale: Number(e.target.value) })} className="w-28" aria-label="Füzyon ölçek" />
                    </label>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => void autoAlign()} disabled={align.busy} className="cursor-pointer rounded border border-cyan-400/40 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 disabled:opacity-50">
                        {align.busy ? "Hesaplanıyor…" : "Otomatik hizala (NCC)"}
                      </button>
                      <button type="button" onClick={() => { setRigid({ dx: 0, dy: 0, rotDeg: 0, scale: 1 }); setAlign({ busy: false, note: "" }); }} className="cursor-pointer rounded border border-[#2d3b4e] bg-[#111823] px-2 py-0.5 text-[10px] text-slate-300">Sıfırla</button>
                    </div>
                    {align.note && <p className="text-[10px] leading-snug text-amber-200/80">{align.note}</p>}
                  </div>
                  <div className="space-y-1 rounded border border-[#1e2735] px-2 py-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-300">Kesit kayması (z)</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {Math.abs(cfg.zMm ?? 0) >= 0.01 ? `${(cfg.zMm ?? 0).toFixed(1)} mm` : "kapalı"}
                      </span>
                    </div>
                    <label className="flex items-center justify-between gap-2">Kayma {(cfg.zMm ?? 0).toFixed(1)} mm
                      <input
                        type="range" min={-30} max={30} step={0.5} value={cfg.zMm ?? 0}
                        onChange={(e) => { onChange({ ...cfg, zMm: Number(e.target.value) }); setZState({ busy: false, note: "" }); }}
                        className="w-28" aria-label="Füzyon kesit kayması (z, mm)"
                      />
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void autoZ()}
                        disabled={zState.busy}
                        title="Kesitleri hasta konumuna göre eşleyip en iyi z kaymasını NCC ile ara"
                        className="cursor-pointer rounded border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200 disabled:opacity-50"
                      >
                        {zState.busy ? "Hesaplanıyor…" : "Otomatik (z)"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { onChange({ ...cfg, zMm: 0 }); setZState({ busy: false, note: "" }); }}
                        className="cursor-pointer rounded border border-[#2d3b4e] bg-[#111823] px-2 py-0.5 text-[10px] text-slate-300"
                      >
                        Sıfırla
                      </button>
                    </div>
                    {zState.note && <p className="text-[10px] leading-snug text-violet-200/80">{zState.note}</p>}
                  </div>
                  <div className="space-y-1 rounded border border-[#1e2735] px-2 py-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-300">Elastik (deforme)</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {cfg.deform && !isIdentityField(cfg.deform) ? `${cfg.deform.gw}×${cfg.deform.gh} ızgara` : "kapalı"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void autoDeform()}
                        disabled={deform.busy}
                        title="Katı hizalama sonrası bölgesel kaymaları kestir (blok eşleme + elastik düzleştirme)"
                        className="cursor-pointer rounded border border-teal-400/40 bg-teal-400/10 px-2 py-0.5 text-[10px] font-semibold text-teal-200 disabled:opacity-50"
                      >
                        {deform.busy ? "Hesaplanıyor…" : "Elastik hizala"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { set({ deform: null }); setDeform({ busy: false, note: "" }); }}
                        className="cursor-pointer rounded border border-[#2d3b4e] bg-[#111823] px-2 py-0.5 text-[10px] text-slate-300"
                      >
                        Sıfırla
                      </button>
                    </div>
                    {deform.note && <p className="text-[10px] leading-snug text-teal-200/80">{deform.note}</p>}
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-500">Eşikler, bindirilen serinin maksimumunun (%99,99) yüzdesidir. Aynı modalitede otomatik hizalama NCC ile kesit içi öteleme/dönme/ölçek kestirir; farklı modalitede (ör. BT↔MR) **MI (karşılıklı bilgi)** kullanılır ve yalnız öteleme aranır. Elastik hizalama ardından 7×7 düğümlü alan ekler (en çok 12 px); kesit kayması (z) ayrı kestirilir. 3B hacim kaydı, eğim/eğrilik ve kesit aralığı değişimi YOKTUR; kazanç yoksa alan/kayma uygulanmaz. Sonuç tanı aracı değildir, görsel doğrulama gerekir.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
