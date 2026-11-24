"use client";

/**
 * Yapılandırılmış radyoloji skorlama paneli (Lung-RADS, TI-RADS, BI-RADS,
 * PI-RADS v2.1, ACR meme yoğunluğu).
 *
 * Panel yalnızca hekimin seçtiği özelliklerden skoru hesaplar; sonucu rapora
 * “öneri” satırı olarak ekler ve isteğe bağlı olarak takip görevi oluşturur.
 * Klinik karar aracı değildir; her satır “hekim onayına tabidir” notu taşır.
 */
import { useMemo, useState } from "react";
import { ASPECTS_LABELS, ASPECTS_REGIONS, aspectsScore } from "@/lib/stroke";
import {
  acrDensity, agatston, biRads, boneDensity, cxrCardiothoracicRatio, lungRads, piRadsV2,
  scoreSystem, scoreToText, tiRads, CALCIUM_VESSELS, aspectsToScore,
  type AgatstonResult,
  SCORE_SYSTEMS as SCORE_LIST,
  type ScoreResult, type ScoreSystemId,
} from "@/lib/structuredReport";

interface Props {
  modality: string;
  bodyPart: string;
  /** Skor satırını rapora ekler (izlenim/öneri alanı). */
  onApply: (text: string) => void;
  /** Takip görevi oluşturur; mesaj ve süre hazır gelir. */
  onCreateTask?: (t: { message: string; intervalDays: number | null; severity: string }) => Promise<void> | void;
}

const lbl = "block text-[10px] font-bold uppercase tracking-wide text-slate-400";
const sel = "mt-0.5 w-full rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200";
const num = "mt-0.5 w-full rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200";

export default function StructuredScorePanel({ modality, bodyPart, onApply, onCreateTask }: Props) {
  const candidates = useMemo(() => {
    const m = (modality ?? "").toUpperCase();
    const b = (bodyPart ?? "").toLocaleUpperCase("tr-TR");
    const exact = SCORE_LIST.filter((s) => s.modality === m);
    const region = exact.filter((s) => !s.bodyPart || b.includes(s.bodyPart));
    return region.length > 0 ? region : exact.length > 0 ? exact : SCORE_LIST;
  }, [modality, bodyPart]);

  const [system, setSystem] = useState<ScoreSystemId>(candidates[0].id);

  // Lung-RADS
  const [lrSolid, setLrSolid] = useState("");
  const [lrPartSolid, setLrPartSolid] = useState("");
  const [lrNonsolid, setLrNonsolid] = useState("");
  const [lrCalc, setLrCalc] = useState("none");
  const [lrSusp, setLrSusp] = useState(false);
  // TI-RADS
  const [tiComp, setTiComp] = useState("solid");
  const [tiEcho, setTiEcho] = useState("hypoechoic");
  const [tiShape, setTiShape] = useState("wider");
  const [tiMargin, setTiMargin] = useState("smooth");
  const [tiFoci, setTiFoci] = useState<string[]>([]);
  // BI-RADS
  const [biCat, setBiCat] = useState("3");
  // PI-RADS
  const [piZone, setPiZone] = useState<"TZ" | "PZ">("TZ");
  const [piT2, setPiT2] = useState("3");
  const [piDwi, setPiDwi] = useState("3");
  const [piDce, setPiDce] = useState(false);
  // Yoğunluk
  const [dens, setDens] = useState<"a" | "b" | "c" | "d">("b");
  // ASPECTS: anormal işaretli bölgeler
  const [aspectsSet, setAspectsSet] = useState<string[]>([]);
  // Agatston: damar bazlı (peck HU, alan mm²)
  const [ca, setCa] = useState<Record<string, { hu: string; area: string }>>({
    LM: { hu: "", area: "" }, LAD: { hu: "", area: "" }, LCx: { hu: "", area: "" }, RCA: { hu: "", area: "" },
  });
  // Kemik yoğunluğu
  const [boneHu, setBoneHu] = useState("");
  // Akciğer grafisi ölçümleri
  const [cxrCardiac, setCxrCardiac] = useState("");
  const [cxrThoracic, setCxrThoracic] = useState("");

  const result: ScoreResult = useMemo(() => {
    if (system === "lungRads") {
      return lungRads({
        solidMm: lrSolid ? Number(lrSolid.replace(",", ".")) : null,
        partSolidMm: lrPartSolid ? Number(lrPartSolid.replace(",", ".")) : null,
        nonsolidMm: lrNonsolid ? Number(lrNonsolid.replace(",", ".")) : null,
        calcification: lrCalc as "none" | "benign" | "malignant",
        suspiciousFeature: lrSusp,
      });
    }
    if (system === "tiRads") {
      return tiRads({
        composition: tiComp as "cystic" | "spongiform" | "mixed" | "solid",
        echogenicity: tiEcho as "anechoic" | "hyperIso" | "hypoechoic" | "veryHypoechoic",
        shape: tiShape as "wider" | "taller",
        margin: tiMargin as "smooth" | "illDefined" | "lobulated" | "extrathyroidal",
        foci: tiFoci as Array<"none" | "cometTail" | "macrocalc" | "rim" | "punctate">,
      });
    }
    if (system === "biRads") return biRads(biCat);
    if (system === "piRads") {
      return piRadsV2({
        zone: piZone,
        t2: piT2 ? Number(piT2) : null,
        dwi: piDwi ? Number(piDwi) : null,
        dce: piDce,
      });
    }
    if (system === "aspects") return aspectsToScore(aspectsScore(aspectsSet));
    if (system === "agatston") {
      const num = (v: string) => Number(v.replace(",", "."));
      return agatston(CALCIUM_VESSELS.map((v) => ({
        vessel: v,
        peakHu: Number.isFinite(num(ca[v].hu)) ? num(ca[v].hu) : 0,
        areaMm2: Number.isFinite(num(ca[v].area)) ? num(ca[v].area) : 0,
      })));
    }
    if (system === "boneDensity") {
      const v = boneHu.trim() ? Number(boneHu.replace(",", ".")) : null;
      return boneDensity(Number.isFinite(v) ? v : null);
    }
    if (system === "cxr") {
      const c = cxrCardiac.trim() ? Number(cxrCardiac.replace(",", ".")) : null;
      const t = cxrThoracic.trim() ? Number(cxrThoracic.replace(",", ".")) : null;
      return cxrCardiothoracicRatio(
        c !== null && Number.isFinite(c) ? c : null,
        t !== null && Number.isFinite(t) ? t : null,
      );
    }
    return acrDensity(dens);
  }, [system, lrSolid, lrPartSolid, lrNonsolid, lrCalc, lrSusp, tiComp, tiEcho, tiShape, tiMargin, tiFoci, biCat, piZone, piT2, piDwi, piDce, dens, ca, boneHu, cxrCardiac, cxrThoracic, aspectsSet]);

  const meta = scoreSystem(system);
  const canTask = result.followUpDays !== null || result.tissueSampling;

  const toggleFoci = (f: string) =>
    setTiFoci((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  return (
    <div className="rounded-lg border border-[#232e40] bg-[#0b0f16] p-3 text-xs text-slate-300">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-slate-200">📊 Yapılandırılmış skor</span>
        <select value={system} onChange={(e) => setSystem(e.target.value as ScoreSystemId)} aria-label="Skor sistemi" className={sel}>
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <span className="text-[10px] text-slate-500">{meta.source}</span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 md:grid-cols-4">
        {system === "lungRads" && (
          <>
            <label className={lbl}>Solid nodül çapı (mm)
              <input className={num} inputMode="decimal" placeholder="örn. 7" value={lrSolid} onChange={(e) => setLrSolid(e.target.value)} />
            </label>
            <label className={lbl}>Kısmi solid komponent (mm)
              <input className={num} inputMode="decimal" placeholder="opsiyonel" value={lrPartSolid} onChange={(e) => setLrPartSolid(e.target.value)} />
            </label>
            <label className={lbl}>Non-solid boyut (mm)
              <input className={num} inputMode="decimal" placeholder="opsiyonel" value={lrNonsolid} onChange={(e) => setLrNonsolid(e.target.value)} />
            </label>
            <label className={lbl}>Kalsifikasyon
              <select className={sel} value={lrCalc} onChange={(e) => setLrCalc(e.target.value)}>
                <option value="none">yok / endşeli</option>
                <option value="benign">benign görünümlü</option>
                <option value="malignant">malign</option>
              </select>
            </label>
            <label className="col-span-2 flex items-center gap-2 self-end pb-1">
              <input type="checkbox" checked={lrSusp} onChange={(e) => setLrSusp(e.target.checked)} />
              Şüpheli özellik (spikülasyon / büyüme / kavitasyon)
            </label>
          </>
        )}

        {system === "tiRads" && (
          <>
            <label className={lbl}>Kompozisyon
              <select className={sel} value={tiComp} onChange={(e) => setTiComp(e.target.value)}>
                <option value="cystic">kistik / tamamen kistik</option>
                <option value="spongiform">spongiform</option>
                <option value="mixed">karma kistik-solid</option>
                <option value="solid">solid / hemen hemen solid</option>
              </select>
            </label>
            <label className={lbl}>Ekojenisite
              <select className={sel} value={tiEcho} onChange={(e) => setTiEcho(e.target.value)}>
                <option value="anechoic">anekojen</option>
                <option value="hyperIso">hiper/izojen</option>
                <option value="hypoechoic">hipoekojen</option>
                <option value="veryHypoechoic">çok hipoekojen</option>
              </select>
            </label>
            <label className={lbl}>Şekil
              <select className={sel} value={tiShape} onChange={(e) => setTiShape(e.target.value)}>
                <option value="wider">genişlik &gt; yükseklik</option>
                <option value="taller">yükseklik &gt; genişlik</option>
              </select>
            </label>
            <label className={lbl}>Sınır
              <select className={sel} value={tiMargin} onChange={(e) => setTiMargin(e.target.value)}>
                <option value="smooth">düzgün</option>
                <option value="illDefined">belirsiz</option>
                <option value="lobulated">lobüle/düzensiz</option>
                <option value="extrathyroidal">ekstratiroidal yayılım</option>
              </select>
            </label>
            <div className="col-span-2 sm:col-span-3 md:col-span-4">
              <span className={lbl}>Ekojenik fokus(lar)</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {(["none", "cometTail", "macrocalc", "rim", "punctate"] as const).map((f) => {
                  const names: Record<string, string> = { none: "yok", cometTail: "kuyruk", macrocalc: "makrokals.", rim: "rim", punctate: "punctate" };
                  const on = tiFoci.includes(f);
                  return (
                    <button key={f} type="button" onClick={() => toggleFoci(f)} className={`cursor-pointer rounded border px-2 py-1 text-[11px] ${on ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200" : "border-[#232e40] text-slate-400 hover:bg-[#141b24]"}`}>{names[f]}</button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {system === "biRads" && (
          <label className={lbl}>BI-RADS kategorisi
            <select className={sel} value={biCat} onChange={(e) => setBiCat(e.target.value)}>
              {["0", "1", "2", "3", "4", "5", "6"].map((c) => <option key={c} value={c}>BI-RADS {c}</option>)}
            </select>
          </label>
        )}

        {system === "piRads" && (
          <>
            <label className={lbl}>Zon
              <select className={sel} value={piZone} onChange={(e) => setPiZone(e.target.value as "TZ" | "PZ")}>
                <option value="TZ">geçiş zonu (TZ)</option>
                <option value="PZ">periferal zon (PZ)</option>
              </select>
            </label>
            <label className={lbl}>T2 puanı (1–5)
              <input className={num} inputMode="numeric" value={piT2} onChange={(e) => setPiT2(e.target.value)} />
            </label>
            <label className={lbl}>DWI puanı (1–5)
              <input className={num} inputMode="numeric" value={piDwi} onChange={(e) => setPiDwi(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 self-end pb-1">
              <input type="checkbox" checked={piDce} onChange={(e) => setPiDce(e.target.checked)} />
              DCE pozitif
            </label>
          </>
        )}

        {system === "aspects" && (
          <div className="col-span-2 sm:col-span-3 md:col-span-4">
            <span className={lbl}>Anormal bulgu verilen bölgeler (işaretleyin)</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ASPECTS_REGIONS.map((r) => {
                const on = aspectsSet.includes(r);
                return (
                  <button key={r} type="button" onClick={() => setAspectsSet((cur) => (on ? cur.filter((x) => x !== r) : [...cur, r]))} className={`cursor-pointer rounded border px-2 py-1 text-[11px] ${on ? "border-rose-400/60 bg-rose-400/15 text-rose-200" : "border-[#232e40] text-slate-400 hover:bg-[#141b24]"}`}>{ASPECTS_LABELS[r]}</button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-slate-500">İşaretsiz bölgeler normal sayılır; skor 10 eksi anormal bölge sayısıdır.</p>
          </div>
        )}

        {system === "acrDensity" && (
          <label className={lbl}>Meme yoğunluğu (ACR)
            <select className={sel} value={dens} onChange={(e) => setDens(e.target.value as "a" | "b" | "c" | "d")}>
              <option value="a">a — neredeyse tamamen yağlı</option>
              <option value="b">b — dağınık fibroglandüler</option>
              <option value="c">c — heterojen yoğun</option>
              <option value="d">d — son derece yoğun</option>
            </select>
          </label>
        )}

        {system === "agatston" && (
          <>
            <div className="col-span-2 flex items-center justify-between sm:col-span-3 md:col-span-4">
              <span className={lbl}>Damarlardaki kalsifikasyonlar (en yüksek HU / alan mm²)</span>
              <span className="text-[10px] text-slate-500">Skor eşiği: ≥130 HU ve alan ≥1 mm²</span>
            </div>
            {CALCIUM_VESSELS.map((v) => (
              <div key={v} className="col-span-2 flex items-end gap-2 sm:col-span-1">
                <span className="pb-1 font-mono text-[11px] font-bold text-cyan-300">{v}</span>
                <label className="flex-1 text-[10px] text-slate-500">peck HU
                  <input className={num} inputMode="decimal" placeholder="HU" value={ca[v].hu} onChange={(e) => setCa({ ...ca, [v]: { ...ca[v], hu: e.target.value } })} />
                </label>
                <label className="flex-1 text-[10px] text-slate-500">alan mm²
                  <input className={num} inputMode="decimal" placeholder="mm²" value={ca[v].area} onChange={(e) => setCa({ ...ca, [v]: { ...ca[v], area: e.target.value } })} />
                </label>
              </div>
            ))}
          </>
        )}

        {system === "boneDensity" && (
          <label className={lbl}>L1–L4 trabeküler ortalama HU
            <input className={num} inputMode="decimal" placeholder="örn. 145" value={boneHu} onChange={(e) => setBoneHu(e.target.value)} />
          </label>
        )}

        {system === "cxr" && (
          <>
            <label className={lbl}>En geniş kardiyal çap (mm)
              <input className={num} inputMode="decimal" placeholder="PA film" value={cxrCardiac} onChange={(e) => setCxrCardiac(e.target.value)} />
            </label>
            <label className={lbl}>İç torasik çap (mm)
              <input className={num} inputMode="decimal" placeholder="ria kostal ark" value={cxrThoracic} onChange={(e) => setCxrThoracic(e.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="mt-3 rounded border border-[#232e40] bg-[#0e141d] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-cyan-400/15 px-2 py-0.5 font-mono text-[11px] font-bold text-cyan-200">{result.label}</span>
          <span className="text-[10px] text-slate-500">{result.basis}</span>
        </div>
        {system === "agatston" && "total" in result && (
          <p className="mt-1 font-mono text-[10px] text-slate-400">
            Toplam {(result as AgatstonResult).total} · {Object.entries((result as AgatstonResult).perVessel).map(([v, n]) => `${v} ${n}`).join(" / ") || "damarsal skor yok"} · atlanan lezyon {(result as AgatstonResult).ignored}
          </p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{result.advice}</p>
        <p className="mt-1 text-[9.5px] italic text-slate-500">{meta.disclaimer}</p>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onApply(scoreToText(result))} className="cursor-pointer rounded border border-cyan-400/40 px-2 py-1 font-bold text-cyan-200 hover:bg-cyan-400/10">
          Rapor metnine ekle
        </button>
        {canTask && onCreateTask && (
          <button
            type="button"
            onClick={() => void onCreateTask({ message: `${meta.title}: ${result.label} — ${result.advice}`, intervalDays: result.followUpDays, severity: result.tissueSampling ? "yuksek" : "orta" })}
            className="cursor-pointer rounded border border-emerald-400/40 px-2 py-1 font-bold text-emerald-200 hover:bg-emerald-400/10"
          >
            {result.tissueSampling ? "🔬 Biyopsi/takip görevi oluştur" : "🗓 Takip görevi oluştur"}
          </button>
        )}
      </div>
    </div>
  );
}
