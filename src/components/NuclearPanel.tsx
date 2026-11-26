"use client";

/**
 * Nükleer tıp paneli (a-nm).
 *
 * PET/SPECT serisinden (SuvInfo.factor ile) **eşik tabanlı MTV ve SUVpeak/SUVmean**
 * üretir; hekimin girdiği zaman-aktivite noktalarından **TIC** (wash-out / plato /
 * progresif) sınıflandırması yapar. TIC ve MTV, klinik karar aracı değildir;
 * mutlak kalibrasyon (doz, decay, atenüasyon) seri meta verisine bağlıdır.
 */
import { useMemo, useState } from "react";
import type { SeriesData } from "@/lib/types";
import {
  metabolicTumorVolume, resolveSuvThreshold, sampleSuvVoxels, suvMeanAbove, ticCurve,
} from "@/lib/nuclear";
import { useEscapeKey } from "@/lib/useEscapeKey";
import { suvVariants, type Sex } from "@/lib/suvVariants";

interface Props {
  series: SeriesData;
  onClose: () => void;
  onAddToFindings?: (text: string) => void;
}

interface TicRow { t: string; v: string }

const patternTone: Record<string, string> = {
  washout: "text-rose-200 border-rose-400/40 bg-rose-400/10",
  progressif: "text-emerald-200 border-emerald-400/40 bg-emerald-400/10",
  plateau: "text-amber-200 border-amber-400/40 bg-amber-400/10",
  yetersiz: "text-slate-300 border-[#243044]",
};
const patternLabel: Record<string, string> = {
  washout: "wash-out", progressif: "progresif", plateau: "plato", yetersiz: "yetersiz veri",
};

export default function NuclearPanel({ series, onClose, onAddToFindings }: Props) {
  useEscapeKey(onClose);
  const factor = series.suv?.factor ?? null;
  const [manualFactor, setManualFactor] = useState("");
  // SUVlbm/SUVbsa: boy ve cinsiyet DICOM'da yoksa elle girilebilir (hesap, tahmin gizlenmez).
  const [heightInput, setHeightInput] = useState<string>(
    series.suv?.heightCm ? String(series.suv.heightCm) : "",
  );
  const [sexSel, setSexSel] = useState<Sex>(series.suv?.sex ?? "unknown");
  const [mode, setMode] = useState<"mutlak" | "yuzde">("mutlak");
  const [thresholdInput, setThresholdInput] = useState("2.5");
  const [tic, setTic] = useState<TicRow[]>([
    { t: "60", v: "" }, { t: "120", v: "" }, { t: "300", v: "" },
  ]);

  const effFactor = useMemo(() => {
    if (factor && factor > 0) return factor;
    const m = Number(manualFactor.replace(",", "."));
    return Number.isFinite(m) && m > 0 ? m : 0;
  }, [factor, manualFactor]);

  const suvVariantsInfo = useMemo(() => {
    const s = series.suv;
    if (!s || s.weightKg === undefined || s.doseBq === undefined || s.halfLifeS === undefined || s.deltaS === undefined) return null;
    const h = Number(heightInput.replace(",", "."));
    return suvVariants({
      weightKg: s.weightKg, heightCm: Number.isFinite(h) && h > 0 ? h : null, sex: sexSel,
      doseBq: s.doseBq, halfLifeS: s.halfLifeS, deltaS: s.deltaS,
    });
  }, [series.suv, heightInput, sexSel]);

  const spacingMm3 = useMemo(() => {
    const px = series.pixelSpacingX && series.pixelSpacingX > 0 ? series.pixelSpacingX : series.pixelSpacing > 0 ? series.pixelSpacing : 1;
    const py = series.pixelSpacing > 0 ? series.pixelSpacing : px;
    const dz = series.sliceSpacing && series.sliceSpacing > 0 ? series.sliceSpacing : series.sliceThickness > 0 ? series.sliceThickness : 1;
    return px * py * dz;
  }, [series]);

  // SUV örnekleri (senkron; örnekleme 2 piksel / ≤64 kesit olduğu için hızlı).
  const sample = useMemo(() => {
    if (effFactor <= 0 || series.slices.length === 0) return null;
    return sampleSuvVoxels((z) => series.slices[z], series.width, series.height, series.slices.length, spacingMm3, { factor: effFactor });
  }, [effFactor, series, spacingMm3]);

  const threshold = useMemo(
    () => (sample ? resolveSuvThreshold(sample.values, mode, Number(thresholdInput.replace(",", "."))) : 0),
    [sample, mode, thresholdInput],
  );
  const mtv = useMemo(
    () => (sample ? metabolicTumorVolume(sample.values, sample.voxelMl, threshold) : null),
    [sample, threshold],
  );
  const meanAbove = useMemo(() => (sample ? suvMeanAbove(sample.values, threshold) : null), [sample, threshold]);

  const ticResult = useMemo(() => {
    const t: number[] = [];
    const v: number[] = [];
    for (const r of tic) {
      const tn = Number(r.t.replace(",", "."));
      const vn = Number(r.v.replace(",", "."));
      if (Number.isFinite(tn) && Number.isFinite(vn) && r.v.trim()) { t.push(tn); v.push(vn); }
    }
    return ticCurve(t, v);
  }, [tic]);

  const addLine = () => {
    if (!mtv || !onAddToFindings) return;
    const ticPart = ticResult.pattern === "yetersiz" ? "" : ` TIC: ${patternLabel[ticResult.pattern]} (zirve ${ticResult.peakValue.toFixed(1)} @ ${ticResult.peakTimeSec} sn).`;
    onAddToFindings(
      `Nükleer tıp: SUV ≥${threshold} eşiğinde MTV ${mtv.mtvMl} mL, SUVpeak ${mtv.suvPeak.toFixed(1)}${meanAbove !== null ? `, SUVmean ${meanAbove}` : ""}.${ticPart} Eşik tabanlı ölçümdür; protokol ve kalibrasyon hekim denetimindedir.`,
    );
  };

  const noise = Math.max(1, ...(sample?.values.slice(0, 1) ?? [1]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="nuclear-panel" role="dialog" aria-modal="true" aria-label="Nükleer tıp analizi">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2d3b4e] bg-[#0b0f16] text-xs text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1a2230] px-4 py-2">
          <div>
            <div className="text-sm font-bold text-slate-100">Nükleer tıp · MTV / SUV / TIC</div>
            <div className="text-[10px] text-slate-500">{series.description || series.modality} · {series.slices.length} kesit · SUV birimi {series.suv?.units || "bilinmiyor"}</div>
          </div>
          <div className="flex items-center gap-2">
            {mtv && onAddToFindings && (
              <button onClick={addLine} className="cursor-pointer rounded border border-cyan-400/50 px-2 py-0.5 text-cyan-200 hover:bg-cyan-400/10">Rapora ekle</button>
            )}
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 hover:bg-[#1a2330]">✕</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {factor === null && (
            <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200">
              Seride SUV çarpanı yok ({series.suv?.note || "SuvInfo eksik"}). Ölçmek için piksel → SUV çarpanını elle girin.
              <input value={manualFactor} onChange={(e) => setManualFactor(e.target.value)} placeholder="çarpan" className="ml-2 w-24 rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5 text-slate-100" />
            </div>
          )}
          {/* SUV varyantları: SUVbw seriden; SUVlbm/SUVbsa boy+cinsiyet gerektirir. */}
          <div className="mt-2 rounded border border-[#243044] bg-[#0d131c] px-2 py-1.5" data-testid="suv-variants">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-slate-200">SUV varyantları</span>
              <span className="text-[10px] text-slate-500">{series.suv?.note || "SUVbw bilgisi yok"}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
              <label className="flex items-center gap-1">
                Boy (cm)
                <input value={heightInput} onChange={(e) => setHeightInput(e.target.value)} placeholder={series.suv?.heightCm ? String(series.suv.heightCm) : "ör. 175"} aria-label="Hasta boyu (cm)" className="w-16 rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5 text-slate-100" />
              </label>
              <label className="flex items-center gap-1">
                Cinsiyet
                <select value={sexSel} onChange={(e) => setSexSel(e.target.value as Sex)} aria-label="Hasta cinsiyeti" className="rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5 text-slate-100">
                  <option value="unknown">bilinmiyor</option>
                  <option value="M">erkek</option>
                  <option value="F">kadın</option>
                </select>
              </label>
              {series.suv?.heightAssumed === "m" && <span className="text-slate-500">(DICOM boyu metre olarak yorumlandı)</span>}
            </div>
            {suvVariantsInfo ? (
              <ul className="mt-1 space-y-0.5 text-[10.5px] text-slate-400">
                <li>SUVbw: <b className="text-slate-200">{factor ? factor.toPrecision(3) : "—"}</b> çarpan</li>
                <li>SUVlbm: <b className="text-slate-200">{suvVariantsInfo.lbm.factor ? suvVariantsInfo.lbm.factor.toPrecision(3) : "—"}</b> — {suvVariantsInfo.lbm.note}</li>
                <li>SUVbsa: <b className="text-slate-200">{suvVariantsInfo.bsa.factor ? suvVariantsInfo.bsa.factor.toPrecision(3) : "—"}</b> — {suvVariantsInfo.bsa.note}</li>
              </ul>
            ) : (
              <p className="mt-1 text-[10.5px] text-slate-500">Seride ağırlık/doz/yarı ömür/gecikme bilgisi yok; varyantlar hesaplanamaz.</p>
            )}
            <p className="mt-1 text-[10px] text-slate-500">SUVlbm (Janmahasatian) ve SUVbsa (Du Bois) hesaplanmış değerlerdir; klinik karar için ölçüm değildir.</p>
          </div>

          {sample && sample.sampledVoxels === 0 && (
            <div className="mt-2 rounded border border-rose-400/40 bg-rose-400/10 px-2 py-1 text-rose-200">
              Seride pozitif piksel yok; SUV haritası oluşturulamadı.
            </div>
          )}

          {sample && sample.sampledVoxels > 0 && mtv && (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Eşik:</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as "mutlak" | "yuzde")} className="rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5">
                  <option value="mutlak">mutlak SUV</option>
                  <option value="yuzde">maksimumun %</option>
                </select>
                <input value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} aria-label="Eşik değeri" className="w-20 rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5" />
                <span className="text-slate-500">→ SUV ≥ {threshold}</span>
                <span className="ml-auto text-[10px] text-slate-500">{sample.sliceStep} kesitte bir, {sample.pixelStride} pikselde bir örneklendi</span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded border border-[#1a2230] p-2"><div className="text-slate-500">MTV</div><div className="text-lg font-bold text-cyan-200">{mtv.mtvMl} mL</div></div>
                <div className="rounded border border-[#1a2230] p-2"><div className="text-slate-500">SUVpeak</div><div className="text-lg font-bold text-slate-100">{mtv.suvPeak.toFixed(1)}</div></div>
                <div className="rounded border border-[#1a2230] p-2"><div className="text-slate-500">SUVmean (eşik üstü)</div><div className="text-lg font-bold text-slate-100">{meanAbove ?? "—"}</div></div>
                <div className="rounded border border-[#1a2230] p-2"><div className="text-slate-500">Eşik üstü voksel</div><div className="text-lg font-bold text-slate-100">{mtv.voxelCount.toLocaleString("tr-TR")}</div></div>
              </div>
              <div className="mt-1 text-[10.5px] leading-relaxed text-slate-400">{mtv.advice}</div>
              <div className="mt-1 text-[10px] text-slate-500">Örneklenen voksel: {sample.sampledVoxels.toLocaleString("tr-TR")} · örnek hacmi {sample.voxelMl.toFixed(4)} mL · toplam ölçek {noise.toFixed(0)} (ilk SUV değerleri)</div>
            </>
          )}

          <div className="mt-3 rounded border border-[#1a2230] p-2">
            <div className="flex items-center justify-between">
              <b className="text-slate-200">Zaman-aktivite eğrisi (TIC)</b>
              <button onClick={() => setTic((r) => [...r, { t: "", v: "" }])} className="cursor-pointer rounded border border-[#2d3b4e] px-2 py-0.5 hover:bg-[#1a2330]">+ nokta</button>
            </div>
            <div className="mt-1 space-y-1">
              {tic.map((r, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span className="w-6 text-slate-500">#{i + 1}</span>
                  <input value={r.t} onChange={(e) => setTic((rows) => rows.map((x, k) => (k === i ? { ...x, t: e.target.value } : x)))} placeholder="sn" aria-label={`${i + 1}. nokta zamanı (sn)`} className="w-20 rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5" />
                  <input value={r.v} onChange={(e) => setTic((rows) => rows.map((x, k) => (k === i ? { ...x, v: e.target.value } : x)))} placeholder="SUV/aktivite" aria-label={`${i + 1}. nokta değeri`} className="w-28 rounded border border-[#232e40] bg-[#141b24] px-1.5 py-0.5" />
                  {tic.length > 3 && (
                    <button onClick={() => setTic((rows) => rows.filter((_, k) => k !== i))} aria-label={`${i + 1}. noktayı sil`} className="cursor-pointer text-rose-300">✕</button>
                  )}
                </div>
              ))}
            </div>
            <div className={`mt-2 rounded border p-2 ${patternTone[ticResult.pattern]}`}>
              <div className="font-bold">{patternLabel[ticResult.pattern]}</div>
              <div className="text-[11px] leading-relaxed">{ticResult.advice}</div>
              <div className="mt-0.5 text-[10px]">
                zirve {ticResult.peakValue.toFixed(2)} @ {ticResult.peakTimeSec} sn
                {ticResult.washIn !== null ? ` · wash-in ${ticResult.washIn.toFixed(3)}/sn` : ""}
                {ticResult.washOutPct !== null ? ` · wash-out %${ticResult.washOutPct.toFixed(1)}` : ""}
              </div>
            </div>
          </div>

          <div className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[10px] leading-relaxed text-amber-200">
            MTV eşik tabanlıdır ve örnekleme (piksel/kesit adımı) ile hızlandırılmıştır; SUV kalibrasyonu doz, decay ve atenüasyon düzeltmesine bağlıdır.
            TIC için en az 3 zaman noktası gerekir; eğri yorumu klinik ve diğer tetkiklerle birlikte yapılır. Klinik karar aracı değildir.
          </div>
        </div>
      </div>
    </div>
  );
}
