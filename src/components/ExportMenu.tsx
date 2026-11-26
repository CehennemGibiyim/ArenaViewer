"use client";

import { useRef, useState } from "react";
import type { Annotation, KeyImage, SeriesData } from "@/lib/types";
import { exportPngZip, exportVideoWebm } from "@/lib/exportMedia";
import { buildKeyObjectSelection, buildPresentationState } from "@/lib/dicomSr";
import { planKeyObject } from "@/lib/pacsSend";
import { planAnonStow } from "@/lib/stowPayload";
import { subSeriesForRange, rangeLength } from "@/lib/anonRange";
import { buildAnonymizedDicom } from "@/lib/dicomWrite";
import { annotationsToMeasurements, exportCoverage, siteCode } from "@/lib/measurementExport";
import { buildMeasurementReportSr } from "@/lib/sr1500";
import { writableAnnotationCount } from "@/lib/gspsGraphics";
import { buildRtStruct, buildSegDocument } from "@/lib/dicomSeg";
import { emptyMask, makeSegmentDef, maskFromJson, paint, prune, unionMasks, type SegMask } from "@/lib/segmentation";
import { apiFetch } from "@/lib/csrfClient";
import { type CodeTable, parseCodeTable } from "@/lib/codeMapping";
import { loadCodeTable, CODE_MAP_KEY } from "@/lib/codeTableClient";
import { writePreference } from "@/lib/browserPreferences";

interface Props {
  series: SeriesData | null;
  wl: number; ww: number; invert: boolean; slice: number;
  rotation?: 0 | 90 | 180 | 270;
  flipH?: boolean; flipV?: boolean;
  keyImages: KeyImage[];
  /** Ekran ölçümleri (TID 1500 yapılandırılmış SR için) */
  annotations?: Annotation[];
  /** Piksel→mm ölçeği */
  pxMm?: number;
  /** Bölge (bulgu yeri kodu için) */
  bodyPart?: string;
  toast: (m: string, ms?: number) => void;
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Dışa aktarma: cine video (WebM), kesit PNG ZIP, anahtar kesit DICOM KO. */
export default function ExportMenu({ series, wl, ww, invert, slice, rotation = 0, flipH = false, flipV = false, keyImages, annotations = [], pxMm = 1, bodyPart = "", toast }: Props) {
  const [open, setOpen] = useState(false);
  const [dlg, setDlg] = useState<"video" | "zip" | null>(null);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [fps, setFps] = useState(12);
  const [side, setSide] = useState(512);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [sending, setSending] = useState<"ko" | "pr" | "anon" | null>(null);
  const [stowDlg, setStowDlg] = useState(false);
  const [stowType, setStowType] = useState<"ko" | "pr" | "anon-all" | "anon-range">("anon-all");
  const [stowFrom, setStowFrom] = useState(1);
  const [stowTo, setStowTo] = useState(1);
  const [codeMap, setCodeMap] = useState<CodeTable | null>(() => (typeof window === "undefined" ? null : loadCodeTable()?.table ?? null));
  const codeFileRef = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const n = series?.slices.length ?? 0;
  const imageOk = !!series && (!series.specialType || series.specialType === "image") && n > 0;

  const openDlg = (k: "video" | "zip") => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    if (!imageOk) { toast("Önce bir görüntü serisi açın."); return; }
    setFrom(1); setTo(n); setDlg(k); setOpen(false);
  };
  const run = async () => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    if (!series || !dlg) return;
    const f = Math.max(1, Math.min(n, from)) - 1, t = Math.max(f + 1, Math.min(n, to)) - 1;
    abort.current = new AbortController();
    setProg({ done: 0, total: t - f + 1 });
    const o = { wl, ww, invert, maxSide: side, from: f, to: t, fps, onProgress: (done: number, total: number) => setProg({ done, total }), signal: abort.current.signal };
    try {
      if (dlg === "video") { download(await exportVideoWebm(series, o), `cine-${series.modality}-${f + 1}-${t + 1}.webm`); toast("Video indirildi (WebM).", 4000); }
      else { download(new Blob([(await exportPngZip(series, o)).slice().buffer as ArrayBuffer], { type: "application/zip" }), `kesitler-${series.modality}-${f + 1}-${t + 1}.zip`); toast("Kesitler ZIP olarak indirildi.", 4000); }
      setDlg(null);
    } catch (e) { toast(`Dışa aktarma başarısız: ${e instanceof Error ? e.message : "hata"}`, 6000); }
    finally { setProg(null); }
  };
  const exportKo = () => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    setOpen(false);
    if (!series || !imageOk) { toast("Önce bir görüntü serisi açın."); return; }
    if (keyImages.length === 0) { toast("Önce en az bir anahtar kesit (★) ekleyin."); return; }
    if (!series.sopUids || !series.sopClassUid || !series.seriesUid) { toast("Bu seride SOP Instance UID bilgisi yok (örnek vaka veya UID'siz görüntü); KO yalnızca gerçek DICOM serileri için üretilir.", 7000); return; }
    const items = keyImages.filter((k) => series.sopUids![k.slice]).map((k) => ({ sopUid: series.sopUids![k.slice], note: k.note }));
    const bytes = buildKeyObjectSelection({
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex, studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, items,
    });
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }), `KO-${series.modality}-${items.length}-anahtar-kesit.dcm`);
    toast(`DICOM Key Object (${items.length} anahtar kesit) indirildi.`, 5000);
  };

  const exportPr = () => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    setOpen(false);
    if (!series || !imageOk) { toast("Önce bir görüntü serisi açın."); return; }
    if (!series.sopUids || !series.sopClassUid || !series.seriesUid) { toast("Bu seride SOP Instance UID bilgisi yok (örnek vaka veya UID'siz görüntü); PR yalnızca gerçek DICOM serileri için üretilir.", 7000); return; }
    const bytes = buildPresentationState({
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex, studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, sopUids: series.sopUids,
      wl, ww, invert, rotation, flipH, flipV,
      annotations,
    });
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }), `PR-${series.modality}-sunum-durumu.dcm`);
    const written = writableAnnotationCount(annotations, series.sopUids);
    const skipped = annotations.length - written;
    toast(`DICOM sunum durumu (GSPS/PR) indirildi — ${written} anotasyon grafik katmanı olarak yazıldı${skipped > 0 ? `, ${skipped} anotasyon atlandı (kesit/UID eşleşmedi)` : ""}. Rapor belgesi değildir.`, 7000);
  };

  /**
   * Anonim seriyi PACS'e gönderir (e-stow). Baytlar TARAYICIDA sıfırdan üretilir
   * (kimlik/özel etiket taşımaz); sunucu yalnız STOW-RS'i çağırır.
   */
  const sendAnonToPacs = async (range?: { from: number; to: number }) => {
    setOpen(false);
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    setStowDlg(false);
    if (!series) { toast("Önce bir görüntü serisi açın."); return; }
    if (!series.sopUids?.length) { toast("Bu seride SOP Instance UID bilgisi yok; anonim gönderim yalnız gerçek DICOM serilerinde yapılır.", 7000); return; }
    // Seçili parça (1 tabanlı kapalı aralık) kesilir; dilim sınırları rangeLength/subSeriesForRange içinde düzeltilir.
    const total = series.slices.length;
    const num = (v: number, fallback: number) => (Number.isFinite(v) ? Math.trunc(v) : fallback);
    const from = range ? Math.max(1, num(range.from, 1)) : 1;
    const to = range ? Math.min(total, Math.max(from, num(range.to, total))) : total;
    const target = range ? subSeriesForRange(series, from, to) : series;
    const rangeNote = range ? ` — kesit ${from}–${to}` : "";
    try {
      // Baytlar tarayıcıda sıfırdan üretilir: orijinal etiket/UID/kimlik taşınmaz.
      const anon = buildAnonymizedDicom({ ...target, patientName: "", patientId: "" } as typeof series);
      const plan = planAnonStow(anon.map((a) => ({ name: a.name, bytes: a.bytes })), target.sopUids);
      if (!plan.ok) { toast(plan.reason ?? "Gönderim hazırlanamadı", 7000); return; }
      setSending("anon");
      const r = await apiFetch("/api/pacs/stow", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "anon", studyUid: series.studyUid, instances: plan.instances, ...(range ? { selection: { from, to, total } } : {}) }),
      });
      const d = (await r.json().catch(() => ({}))) as { stored?: number; failed?: number; text?: string; error?: string; pacs?: string };
      if (!r.ok && r.status !== 207) throw new Error(d.error ?? "Gönderilemedi");
      toast(`${d.text ?? `${d.stored ?? 0} örnek gönderildi`} (${d.pacs ?? "PACS"})${rangeNote}.`, 8000);
    } catch (e) { toast(`Anonim gönderim başarısız: ${e instanceof Error ? e.message : "hata"}`, 8000); }
    finally { setSending(null); }
  };

  /** Kurum eşleme dosyasını (CSV/TSV/JSON) okur, doğrular ve tarayıcıda saklar. */
  const importCodeMap = async (file: File | null | undefined) => {
    setOpen(false);
    if (!file) return;
    try {
      const text = await file.text();
      const table = parseCodeTable(text, { source: file.name });
      if (table.accepted === 0) {
        toast(`Eşleme dosyası kullanılamadı: ${table.errors.slice(0, 2).join("; ") || "geçerli satır yok"}.`, 9000);
        return;
      }
      writePreference(CODE_MAP_KEY, { text, source: file.name });
      setCodeMap(table);
      const warn = table.errors.length ? ` ${table.errors.length} satır reddedildi` : "";
      const dup = table.warnings.length ? `, ${table.warnings.length} uyarı` : "";
      toast(`${file.name}: ${table.accepted} kod eşlemesi yüklendi${warn}${dup}. SR çıktısında yalnız özel kodlar bu tabloyla değiştirilir.`, 9000);
    } catch (e) {
      toast(`Eşleme dosyası okunamadı: ${e instanceof Error ? e.message : "hata"}`, 8000);
    }
  };
  const clearCodeMap = () => {
    setOpen(false);
    writePreference(CODE_MAP_KEY, null);
    setCodeMap(null);
    toast("Kurum kod eşlemesi kaldırıldı; SR belgesinde özel kodlar 99ATIKVIEWER olarak yazılır.", 7000);
  };

  /** Ölçümler → DICOM Comprehensive SR (TID 1500): sayısal ölçüm ağacı. */
  const exportSr1500 = () => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    setOpen(false);
    if (!series) { toast("Önce bir görüntü serisi açın."); return; }
    const table = codeMap ?? loadCodeTable()?.table ?? null;
    const measurements = annotationsToMeasurements(annotations, {
      pxMm: pxMm > 0 ? pxMm : 1,
      site: bodyPart ? siteCode(bodyPart, table) : undefined,
      series: { seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, sopUids: series.sopUids },
    });
    if (measurements.length === 0) {
      toast("Yapılandırılmış SR için sayısal ölçüm gerekir (uzunluk, elipsoid, ROI, çokgen). Açı/Cobb/ok yazılmaz.", 7000);
      return;
    }
    const bytes = buildMeasurementReportSr({
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex,
      studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      title: `${series.modality} ${bodyPart || series.description} ölçümleri`,
      measurements,
      codeTable: table,
    });
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }), `SR1500-${series.modality}-${measurements.length}-olcum.dcm`);
    const cov = exportCoverage(annotations);
    const mappedNote = table ? `, kurum kod eşlemesi: ${table.accepted} terim` : ", kod eşlemesi yok (özel kodlar 99ATIKVIEWER)";
    toast(`TID 1500 SR indirildi: ${measurements.length} sayısal ölçüm${cov.skipped.length ? ` (yazılmayan: ${cov.skipped.join(", ")})` : ""}${mappedNote}.`, 7000);
  };

  /**
   * Ekran işaretlerinden segmentasyon → DICOM SEG / RTSTRUCT.
   * Kaynak: kapalı şekiller (elips/dikdörtgen/çokgen) ve uzunluk/elipsoid
   * işaretlerinin orta noktasına küçük fırça izi. AI örtüsü düzenlenebilir maske değildir.
   */
  const exportSeg = (kind: "seg" | "rtstruct") => {
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    setOpen(false);
    if (!series) { toast("Önce bir görüntü serisi açın."); return; }
    if (!series.seriesUid || !series.sopClassUid || !series.sopUids?.length) {
      toast("Bu seride SOP Instance UID bilgisi yok; SEG/RTSTRUCT yalnızca gerçek DICOM serileri için üretilir.", 7000);
      return;
    }
    const w = series.width, h = series.height;
    const shapes = annotations.filter((a) => ["ellipse", "rect", "polygon", "length", "ellipsoid"].includes(a.kind));
    // Segmentasyon editöründe elle çizilen maske de dışa aktarıma katılır
    // (tarayıcıda `segmask:<seriesId>` altında saklanır).
    let manual: SegMask | null = null;
    try {
      const raw = localStorage.getItem(`segmask:${series.id}`);
      if (raw) {
        const parsed = maskFromJson(JSON.parse(raw));
        if (parsed.width === w && parsed.height === h && parsed.slices.size) manual = parsed;
      }
    } catch { /* bozuk kayıt: yok say */ }
    if (!shapes.length && !manual) { toast("Önce görüntü üzerinde bir şekil işaretleyin ya da Segmentasyon editöründe alan çizin.", 6000); return; }
    let mask = emptyMask(w, h);
    const brush = (cx: number, cy: number, r: number) => paint(mask, 0, Math.round(cx), Math.round(cy), r);
    for (const a of shapes) {
      const p = a.points;
      if (!p.length) continue;
      if (a.kind === "polygon") {
        // Çokgen: köşeler arasını doldur (kenar çizgisi + iç dolgu yaklaşımı).
        for (let i = 0; i < p.length; i++) {
          const q = p[(i + 1) % p.length];
          const steps = Math.max(1, Math.round(Math.hypot(q.x - p[i].x, q.y - p[i].y)));
          for (let k = 0; k <= steps; k++) brush(p[i].x + ((q.x - p[i].x) * k) / steps, p[i].y + ((q.y - p[i].y) * k) / steps, 1);
        }
      } else if (p.length >= 2) {
        const cx = (p[0].x + p[1].x) / 2, cy = (p[0].y + p[1].y) / 2;
        const r = Math.max(2, Math.round(Math.min(Math.abs(p[1].x - p[0].x), Math.abs(p[1].y - p[0].y)) / 2));
        brush(cx, cy, Math.min(r, 40));
      }
    }
    prune(mask);
    if (manual) {
      const merged = unionMasks(mask, manual);
      if (merged) mask = merged;
      else toast("Elle çizilen maske boyutu seriyle uyuşmadı; yalnız işaretlerden üretilen maske kullanıldı.", 7000);
    }
    prune(mask);
    if (!mask.slices.size) { toast("İşaretlerden maske üretilemedi (kesit/koordinat eksik).", 6000); return; }
    const geo = {
      pxMm: pxMm > 0 ? pxMm : 1,
      pyMm: series.pixelSpacing > 0 ? series.pixelSpacing : 1,
      dz: (series.sliceSpacing ?? series.sliceThickness) > 0 ? (series.sliceSpacing ?? series.sliceThickness) : 1,
      origin: (series.ipp?.[0] ?? [0, 0, 0]) as [number, number, number],
    };
    const base = {
      patientName: series.patientName, patientId: series.patientId, patientSex: series.patientSex,
      studyUid: series.studyUid, studyDate: series.studyDate, institution: series.institution,
      source: { seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, sopUids: series.sopUids },
      frameOfReferenceUid: series.frameOfRef, geometry: geo, width: w, height: h,
    };
    const def = makeSegmentDef(1, bodyPart ? `${bodyPart} işaretli alan` : "İşaretli alan", "MANUAL");
    // Elle çizilen maske varsa segment adı onu da kapsar.
    const bytes = kind === "seg"
      ? buildSegDocument({ ...base, segments: [{ def, mask }] })
      : buildRtStruct({ ...base, rois: [{ def, mask }] });
    const ext = kind === "seg" ? "SEG" : "RTSTRUCT";
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }), `${ext}-${series.modality}-${mask.slices.size}-kesit.dcm`);
    toast(`${ext} indirildi (${mask.slices.size} kesit). Hekim düzenlemesine açıktır; AI örtüsü maske değildir.`, 7000);
  };

  /** KO/PR nesnesini PACS'e STOW-RS ile gönderir (rapor SR'ı rapor penceresinden gider). */
  const sendToPacs = async (kind: "ko" | "pr") => {
    setOpen(false);
    setStowDlg(false);
    if (series?.lazyPending) { toast("Çalışma yükleniyor — kesitler inmeden bu işlem yapılamaz.", 6000); return; }
    if (!series) { toast("Önce bir görüntü serisi açın."); return; }
    const plan = planKeyObject(keyImages, series);
    if (!plan.ok) { toast(plan.reason ?? "Gönderilemedi", 7000); return; }
    setProg(null);
    setSending(kind);
    try {
      const r = await apiFetch("/api/pacs/stow", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, studyUid: series.studyUid, seriesKey: `${series.seriesUid ?? series.description}|${series.slices.length}`,
          seriesUid: series.seriesUid, sopClassUid: series.sopClassUid, sopUids: series.sopUids,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { stored?: number; pacs?: string; error?: string; message?: string };
      if (!r.ok) throw new Error(d.error ?? "PACS'e gönderilemedi");
      toast(`${kind === "ko" ? "Anahtar kesit (KO)" : "Sunum durumu (PR)"} PACS'e gönderildi — ${d.stored ?? 1} nesne (${d.pacs ?? "PACS"}).`, 6000);
      if (plan.skipped.length) toast(`${plan.skipped.length} kesit UID eşlemesi olmadığı için atlandı.`, 6000);
    } catch (e) { toast(`PACS'e gönderilemedi: ${e instanceof Error ? e.message : "hata"}`, 8000); }
    finally { setSending(null); }
  };

  const item = "block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[#1a2330]";
  return (
    <div className="relative shrink-0">
      <input
        ref={codeFileRef}
        type="file"
        accept=".csv,.tsv,.txt,.json,text/csv,application/json"
        className="hidden"
        data-codemap-input="1"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void importCodeMap(f); }}
      />
      <button type="button" onClick={() => setOpen((o) => !o)} className="cursor-pointer rounded-md border border-[#2d3b4e] bg-[#111823] px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-[#1a2330]">Dışa aktar ▾</button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-[#2d3b4e] bg-[#0b0f16] py-1 text-[11px] text-slate-200 shadow-2xl">
          <button className={item} onClick={() => openDlg("video")}>🎞 Cine video (WebM)…</button>
          <button className={item} onClick={() => openDlg("zip")}>🖼 Kesitler → PNG (ZIP)…</button>
          <button className={item} onClick={exportKo}>★ Anahtar kesitler → DICOM KO</button>
          <button className={item} onClick={exportPr} title="Pencere, döndürme ve çevirme ayarlarını GSPS belgesi olarak kaydeder">🖼 Görünüm → DICOM PR (sunum durumu)</button>
          <div className="my-1 border-t border-[#1e2735]" />
          <button className={item} disabled={sending !== null} onClick={() => { setStowType("anon-all"); setStowFrom(1); setStowTo(n); setStowDlg(true); setOpen(false); }} title="Nesne türü (KO / PR / anonim seri) ve anonim gönderimde kesit aralığını seçerek gönderir">☁ PACS&apos;e gönder (STOW)…</button>
          <button className={item} onClick={() => exportSeg("seg")} title="İşaretli alanlardan DICOM Segmentasyon (SEG, 1 bit/piksel) üretir">🧩 Segmentasyon → DICOM SEG</button>
          <button className={item} onClick={() => exportSeg("rtstruct")} title="İşaretli alanlardan RTSTRUCT (ROI konturları) üretir">🧩 Segmentasyon → RTSTRUCT</button>
          <button className={item} onClick={exportSr1500} title="Ölçümleri TID 1500 yapılandırılmış rapor (Comprehensive SR) olarak indirir">📐 Ölçümler → DICOM SR (TID 1500)</button>
          <button className={item} onClick={() => codeFileRef.current?.click()} title="Kurumun lisanslı RadLex/SNOMED CT eşleme dosyası (CSV/TSV/JSON) — yalnız özel 99ATIKVIEWER kodları değiştirilir">🔖 Kurum kod eşlemesi yükle…{codeMap ? ` (${codeMap.accepted})` : ""}</button>
          {codeMap && <button className={item} onClick={clearCodeMap} title="Saklanan eşleme tablosunu siler">🗑 Kurum kod eşlemesini kaldır</button>}
          <div className="px-3 py-1 text-[10px] leading-relaxed text-slate-500">Video/PNG görüntü verisini olduğu gibi aktarır; kimlik bilgisi içermez ama anonimleştirme/DICOM etiketi taşımaz.</div>
        </div>
      )}
      {dlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-xl border border-[#2d3b4e] bg-[#0b0f16] p-4 text-xs text-slate-200 shadow-2xl">
            <div className="mb-3 text-sm font-bold text-cyan-300">{dlg === "video" ? "Cine video (WebM)" : "Kesitler → PNG (ZIP)"}</div>
            <div className="space-y-2">
              <label className="flex items-center justify-between">İlk kesit<input aria-label="İlk kesit" type="number" min={1} max={n} value={from} onChange={(e) => setFrom(Number(e.target.value))} className="w-20 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5" /></label>
              <label className="flex items-center justify-between">Son kesit<input aria-label="Son kesit" type="number" min={1} max={n} value={to} onChange={(e) => setTo(Number(e.target.value))} className="w-20 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5" /></label>
              {dlg === "video" && <label className="flex items-center justify-between">Kare/sn<input aria-label="Kare hızı" type="number" min={1} max={30} value={fps} onChange={(e) => setFps(Math.max(1, Math.min(30, Number(e.target.value))))} className="w-20 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5" /></label>}
              <label className="flex items-center justify-between">Boyut (px)
                <select aria-label="Boyut" value={side} onChange={(e) => setSide(Number(e.target.value))} className="w-24 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5"><option value={256}>256</option><option value={512}>512</option><option value={1024}>1024</option></select>
              </label>
              <div className="text-[10px] text-slate-500">Geçerli pencere (WL {Math.round(wl)} / WW {Math.round(ww)}){invert ? ", ters" : ""} uygulanır. Şu an {slice + 1}. kesitte.</div>
              {prog && <div className="h-2 overflow-hidden rounded bg-[#1a2230]"><div className="h-full bg-cyan-400" style={{ width: `${(prog.done / prog.total) * 100}%` }} /></div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="cursor-pointer rounded border border-[#2d3b4e] px-3 py-1" onClick={() => { abort.current?.abort(); setDlg(null); }}>{prog ? "İptal" : "Kapat"}</button>
              <button data-testid="export-run" disabled={!!prog} className="cursor-pointer rounded bg-cyan-500 px-3 py-1 font-bold text-black disabled:opacity-50" onClick={() => void run()}>{prog ? `${prog.done}/${prog.total}` : "Dışa aktar"}</button>
            </div>
          </div>
        </div>
      )}
      {stowDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-96 rounded-xl border border-[#2d3b4e] bg-[#0b0f16] p-4 text-xs text-slate-200 shadow-2xl">
            <div className="mb-3 text-sm font-bold text-cyan-300">PACS&apos;e gönder (STOW-RS)</div>
            <fieldset className="space-y-1.5">
              <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-1 hover:border-[#1e2735]">
                <input type="radio" name="stow-type" className="mt-0.5" checked={stowType === "ko"} onChange={() => setStowType("ko")} />
                <span><b>KO</b> — anahtar kesitler (PACS&apos;te QIDO-RS ile doğrulanır)</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-1 hover:border-[#1e2735]">
                <input type="radio" name="stow-type" className="mt-0.5" checked={stowType === "pr"} onChange={() => setStowType("pr")} />
                <span><b>PR</b> — görünüm/sunum durumu (pencere, ters, döndürme, çevirme)</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-1 hover:border-[#1e2735]">
                <input type="radio" name="stow-type" className="mt-0.5" checked={stowType === "anon-all"} onChange={() => setStowType("anon-all")} />
                <span><b>Anonim seri</b> — tüm kesitler ({n}); baytlar tarayıcıda üretilir, kimlik taşınmaz</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent p-1 hover:border-[#1e2735]">
                <input type="radio" name="stow-type" className="mt-0.5" checked={stowType === "anon-range"} onChange={() => setStowType("anon-range")} />
                <span><b>Anonim seri</b> — yalnız kesit aralığı (seri parçası)</span>
              </label>
              {stowType === "anon-range" && (
                <div className="flex flex-wrap items-center gap-2 border-l border-[#1e2735] py-1 pl-6">
                  <label className="flex items-center gap-1">İlk<input aria-label="İlk kesit" type="number" min={1} max={n} value={stowFrom} onChange={(e) => setStowFrom(Number(e.target.value))} className="w-16 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5" /></label>
                  <label className="flex items-center gap-1">Son<input aria-label="Son kesit" type="number" min={1} max={n} value={stowTo} onChange={(e) => setStowTo(Number(e.target.value))} className="w-16 rounded border border-[#1e2735] bg-[#0e141d] px-1 py-0.5" /></label>
                  <span className="text-slate-500">{rangeLength(stowFrom, stowTo, n)} kesit gönderilecek</span>
                </div>
              )}
            </fieldset>
            <p className="mt-2 text-[10px] leading-snug text-slate-500">Rapor SR&apos;ı bu menüden gönderilmez — onaylı rapor ekranındaki «PACS&apos;e gönder» kullanılır. Her gönderim denetim kaydına yazılır. Anonim gönderimde dilimler 1&apos;den numaralanır, kesit konumları korunur.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button className="cursor-pointer rounded border border-[#2d3b4e] px-3 py-1" onClick={() => setStowDlg(false)}>Vazgeç</button>
              <button disabled={sending !== null || n === 0 || (stowType === "anon-range" && rangeLength(stowFrom, stowTo, n) === 0)} className="cursor-pointer rounded bg-cyan-500 px-3 py-1 font-bold text-black disabled:opacity-50" onClick={() => void (stowType === "ko" ? sendToPacs("ko") : stowType === "pr" ? sendToPacs("pr") : stowType === "anon-all" ? sendAnonToPacs() : sendAnonToPacs({ from: stowFrom, to: stowTo }))}>{sending ? "Gönderiliyor…" : "Gönder"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
