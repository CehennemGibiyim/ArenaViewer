"use client";

/**
 * Diz MR segmentasyonu paneli (a-knee) — araştırma amaçlı.
 *
 * Yerel nnU-Net modeli (aagatti/nnunet_knee, MIT) ile 9 yapının (medial/
 * lateral menisküs, 4 kıkırdak, femur/tibia/patella kemiği) maskesini üretir:
 * mL hacimleri, rapor satırı ve DICOM SEG / RTSTRUCT dışa aktarımı.
 * **Yırtık tanısı konmaz.** Tıbbi cihaz değildir; radyoloji uzmanı onayı olmadan
 * klinik olarak kullanılamaz.
 */
import { useEffect, useState } from "react";
import type { SeriesData } from "@/lib/types";
import { useEscapeKey } from "@/lib/useEscapeKey";
import { buildRtStruct, buildSegDocument, sliceSopMap } from "@/lib/dicomSeg";
import { sendDerivedToPacs } from "@/lib/sendDerived";
import { makeSegmentDef } from "@/lib/segmentation";
import { DEEP_KNEE_MODEL_CARD } from "@/lib/modelCards";
import {
  KNEE_STRUCTURES,
  kneeSegEligible,
  kneeSegSummaryText,
  kneeScan,
  kneeVolumeStats,
  splitKneeLabels,
  type KneeVolumeStat,
} from "@/lib/kneeSeg";
import type { SegMask } from "@/lib/segmentation";

interface Props {
  series: SeriesData;
  onClose: () => void;
  /** Özet satırını rapora/akışa ekler. */
  onAddToFindings?: (text: string) => void;
  toast?: (m: string, ms?: number) => void;
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export default function KneeSegPanel({ series, onClose, onAddToFindings, toast }: Props) {
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [stats, setStats] = useState<KneeVolumeStat[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [model, setModel] = useState("");
  const [masks, setMasks] = useState<Map<number, SegMask> | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [sending, setSending] = useState(false);
  useEscapeKey(onClose);

  const pxMm = series.pixelSpacingX && series.pixelSpacingX > 0 ? series.pixelSpacingX : series.pixelSpacing > 0 ? series.pixelSpacing : 1;
  const pyMm = series.pixelSpacing > 0 ? series.pixelSpacing : pxMm;
  const dz = (series.sliceSpacing && series.sliceSpacing > 0 ? series.sliceSpacing : series.sliceThickness) > 0
    ? (series.sliceSpacing && series.sliceSpacing > 0 ? series.sliceSpacing : series.sliceThickness)
    : 1;
  const spacing: [number, number, number] = [dz, pyMm, pxMm];
  const canExport = !!series.sopUids && series.sopUids.length > 0 && !!series.seriesUid && !!series.sopClassUid;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const reason = kneeSegEligible(series);
          if (reason) { if (!cancelled) { setErr(`Uygun değil: ${reason}`); setBusy(false); } return; }
          const out = await kneeScan(series);
          if (cancelled) return;
          const m = splitKneeLabels(out.labels, out.dims);
          setMasks(m);
          setStats(kneeVolumeStats(m, spacing));
          setElapsedMs(out.elapsedMs);
          setModel(out.model);
          setBusy(false);
        } catch (e) {
          if (!cancelled) {
            setErr(e instanceof Error ? e.message : "Diz segmentasyonu çalıştırılamadı.");
            setBusy(false);
          }
        }
      })();
    }, 30);
    return () => { cancelled = true; clearTimeout(t); };
    // series kimliği açılışta sabittir; spacing ondan türetilir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  const buildSegments = (ms: Map<number, SegMask>) =>
    KNEE_STRUCTURES
      .filter((st) => (ms.get(st.id)?.slices.size ?? 0) > 0)
      .map((st) => ({ def: makeSegmentDef(st.id, st.tr, "AUTOMATIC"), mask: ms.get(st.id)! }));

  const exportSeg = async (kind: "seg" | "rtstruct", destination: "download" | "pacs" = "download") => {
    if (!masks || !canExport) {
      toast?.("Bu seride SOP Instance UID bilgisi yok; SEG/RTSTRUCT yalnızca gerçek DICOM serileri için üretilir.", 7000);
      return;
    }
    const segments = buildSegments(masks);
    if (!segments.length) { toast?.("Hiçbir yapı segmentlenemedi; dışa aktarılacak maske yok.", 6000); return; }
    const base = {
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex,
      studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      source: { seriesUid: series.seriesUid!, sopClassUid: series.sopClassUid!, sopUids: series.sopUids! },
      frameOfReferenceUid: series.frameOfRef,
      geometry: { pxMm: pxMm > 0 ? pxMm : 1, pyMm: pyMm > 0 ? pyMm : 1, dz: dz > 0 ? dz : 1, origin: (series.ipp?.[0] ?? [0, 0, 0]) as [number, number, number] },
      width: series.width, height: series.height,
    };
    const bytes = kind === "seg"
      ? buildSegDocument({ ...base, segments })
      : buildRtStruct({ ...base, rois: segments, sliceSopUids: sliceSopMap(series.sopUids) });
    const ext = kind === "seg" ? "SEG" : "RTSTRUCT";
    const filename = `${ext}-MR-diz-${series.slices.length}-kesit.dcm`;
    if (destination === "pacs") {
      if (!series.studyUid) { toast?.("Çalışma UID'si yok; PACS'e gönderilemez.", 6000); return; }
      setSending(true);
      try {
        const out = await sendDerivedToPacs(kind, bytes, series.studyUid, filename);
        if (out.ok) toast?.(`${ext} PACS'e gönderildi — ${out.stored} nesne (${out.pacs ?? "PACS"}). Araştırma amaçlıdır; PACS kabulü kurumunuza bağlıdır.`, 8000);
        else toast?.(`PACS'e gönderilemedi: ${out.error}${out.queued ? ` — ${out.queued} nesne yeniden deneme kuyruğuna alındı (Dışa aktar ▾ → ⏳ Kuyruk)` : ""}`, 9000);
      } finally {
        setSending(false);
      }
      return;
    }
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }), filename);
    toast?.(`${ext} indirildi (${segments.length} segment). Araştırma amaçlıdır; klinik doğrulama yapılmamıştır.`, 8000);
  };

  const totalMl = stats?.reduce((a, s) => a + s.ml, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="knee-seg-panel" role="dialog" aria-modal="true" aria-label="Diz MR segmentasyonu">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-amber-400/40 bg-[var(--t05)] text-xs text-[var(--sl200)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--t25)] px-4 py-2">
          <div>
            <div className="text-sm font-bold text-[var(--ac-amber300)]">🦴 Diz MR segmentasyonu — araştırma amaçlı</div>
            <div className="text-[10px] text-[var(--sl500)]">
              {series.description || series.modality} · {series.slices.length} kesit · {pxMm.toFixed(2)}×{pyMm.toFixed(2)}×{dz.toFixed(2)} mm · nnU-Net v2 cascade (MIT)
            </div>
          </div>
          <div className="flex items-center gap-2">
            {stats && onAddToFindings && (
              <button
                onClick={() => onAddToFindings(kneeSegSummaryText(stats, { elapsedMs, model }))}
                className="cursor-pointer rounded border border-cyan-400/50 px-2 py-0.5 text-[var(--ac-cyan200)] hover:bg-cyan-400/10"
              >
                Rapora ekle
              </button>
            )}
            <button onClick={onClose} aria-label="Kapat" className="cursor-pointer rounded border border-[var(--t39)] px-2 py-0.5 hover:bg-[var(--t26)]">✕</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div className="rounded border border-amber-400/50 bg-amber-400/10 px-2 py-1.5 text-[11px] leading-snug text-[var(--ac-amber200)]">
            ⚠ <b>Yırtık tanısı konmaz.</b> Bu araç yalnız anatomik yapıların (menisküs/kıkırdak/kemik) sınırlarını çizer ve hacim verir.
            Radyoloji uzmanı onayı olmadan klinik olarak kullanılamaz; tıbbi cihaz değildir.
          </div>

          {busy && <div className="mt-3 text-[var(--sl400)]">nnU-Net çıkarımı çalışıyor… (ilk çağrıda model yüklenir; CPU&apos;da dakikalar sürebilir — kapamayın)</div>}
          {!busy && err && <div className="mt-3 rounded border border-rose-400/40 bg-rose-400/10 px-2 py-1.5 text-[var(--ac-rose200)]">{err}</div>}

          {!busy && stats && (
            <>
              <table className="mt-3 w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-[var(--sl500)]">
                    <th className="border-b border-[var(--t25)] py-1 pr-2">Yapı</th>
                    <th className="border-b border-[var(--t25)] py-1 pr-2 text-right">Hacim</th>
                    <th className="border-b border-[var(--t25)] py-1 pr-2 text-right">Voksel</th>
                    <th className="border-b border-[var(--t25)] py-1 text-right">Kesit</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.id} className={s.voxels > 0 ? "text-[var(--sl200)]" : "text-[var(--sl600)]"}>
                      <td className="border-b border-[var(--t13)] py-1 pr-2">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: s.id >= 5 && s.id <= 6 ? "#ff9f1c" : s.id >= 7 ? "#4cc9f0" : "#2ee6a8" }} />
                        {s.label}
                      </td>
                      <td className="border-b border-[var(--t13)] py-1 pr-2 text-right font-mono">{s.ml.toFixed(2)} mL</td>
                      <td className="border-b border-[var(--t13)] py-1 pr-2 text-right font-mono">{s.voxels.toLocaleString("tr-TR")}</td>
                      <td className="border-b border-[var(--t13)] py-1 text-right font-mono">{s.slices}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-[var(--sl400)]">
                    <td className="py-1 pr-2 font-semibold">Toplam (maskelenen)</td>
                    <td className="py-1 pr-2 text-right font-mono font-semibold">{totalMl.toFixed(1)} mL</td>
                    <td className="py-1 pr-2"></td>
                    <td className="py-1"></td>
                  </tr>
                </tfoot>
              </table>

              <div className="mt-2 text-[10px] text-[var(--sl500)]">
                Süre: {(elapsedMs / 1000).toFixed(1)} sn · Model: {model || "nnU-Net Knee MRI (MIT)"} · Kendini bildirilen Dice ≈ 0,84 (menisküs) / 0,906 (ortalama); prospektif doğrulama YOKTUR.
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void exportSeg("seg")}
                  disabled={!canExport || sending}
                  title={canExport ? "9 segmentli DICOM SEG üretir" : "Gerçek DICOM serisi gerekli (SOP Instance UID yok)"}
                  className="cursor-pointer rounded border border-emerald-400/50 bg-emerald-400/10 px-2 py-1 text-[var(--ac-emerald200)] enabled:hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  🧩 SEG indir
                </button>
                <button
                  onClick={() => void exportSeg("rtstruct")}
                  disabled={!canExport || sending}
                  title={canExport ? "9 ROI'li RT Structure Set üretir" : "Gerçek DICOM serisi gerekli (SOP Instance UID yok)"}
                  className="cursor-pointer rounded border border-emerald-400/50 bg-emerald-400/10 px-2 py-1 text-[var(--ac-emerald200)] enabled:hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  🗂️ RTSTRUCT indir
                </button>
                <button
                  onClick={() => void exportSeg("seg", "pacs")}
                  disabled={!canExport || sending}
                  title="Üretilen 9 segmentli DICOM SEG'i PACS'e STOW-RS ile geri yazar"
                  className="cursor-pointer rounded border border-cyan-400/50 bg-cyan-400/10 px-2 py-1 text-[var(--ac-cyan200)] enabled:hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ☁ SEG → PACS
                </button>
                <button
                  onClick={() => void exportSeg("rtstruct", "pacs")}
                  disabled={!canExport || sending}
                  title="Üretilen 9 ROI'li RT Structure Set'i PACS'e STOW-RS ile geri yazar"
                  className="cursor-pointer rounded border border-cyan-400/50 bg-cyan-400/10 px-2 py-1 text-[var(--ac-cyan200)] enabled:hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ☁ RTSTRUCT → PACS
                </button>
                <button onClick={() => setCardOpen((v) => !v)} className="cursor-pointer rounded border border-[var(--t39)] px-2 py-1 text-[var(--sl300)] hover:bg-[var(--t26)]">
                  {cardOpen ? "Model kartını gizle" : "Model kartını göster"}
                </button>
              </div>
              {!canExport && (
                <div className="mt-1 text-[10.5px] text-[var(--ac-amber300)]/90">Bu seri gerçek DICOM değil (UID yok); SEG/RTSTRUCT üretilemez — mL istatistikleri yine de kullanılabilir.</div>
              )}
              {cardOpen && (
                <div className="mt-2 rounded border border-[var(--t25)] bg-[var(--t45)] p-2">
                  <div className="font-bold text-[var(--sl200)]">{DEEP_KNEE_MODEL_CARD.name}</div>
                  <div className="text-[10px] text-[var(--sl500)]">{DEEP_KNEE_MODEL_CARD.version}</div>
                  <div className="mt-1 text-[var(--sl300)]"><b>Amaçlanan kullanım:</b> {DEEP_KNEE_MODEL_CARD.intendedUse}</div>
                  <div className="mt-1 text-[var(--sl300)]"><b>Yöntem:</b> {DEEP_KNEE_MODEL_CARD.method}</div>
                  <ul className="mt-1 list-disc pl-4 text-[var(--sl400)]">
                    {DEEP_KNEE_MODEL_CARD.limitations.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                  <div className="mt-1 text-[var(--ac-amber200)]/90"><b>Doğrulama:</b> {DEEP_KNEE_MODEL_CARD.validation}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
