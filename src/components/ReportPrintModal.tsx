"use client";

import { buildReportSr, type EvidenceRef } from "@/lib/dicomSr";
import { processDictation } from "@/lib/dictate";
import { appropriatenessFor, isValidIcd10, suggestIcd10 } from "@/lib/icd10";
import { SIGNATURE_METHODS, signatureNote, type SignatureMethod, type SignatureRecord } from "@/lib/esign";
import { reportPlaceholders } from "@/lib/templateMacro";
import { pickStyleSample } from "@/lib/styleProfile";
import { REVIEW_REASON_MAX, missingReviewReasons, needsReviewReason, normalizeReviewReason, reviewReasonLines } from "@/lib/findingReview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtConf } from "@/lib/format";
import StructuredScorePanel from "@/components/StructuredScorePanel";
import PatientLetterModal from "@/components/PatientLetterModal";
import { PEER_RESULTS, RESULT_LABELS, type PeerResult } from "@/lib/peerReview";
import { SHARE_TTL_HOURS, shareState } from "@/lib/share";
import { MACRO_GROUPS, macroById, macrosByGroup, type MacroGroup } from "@/lib/macros";
import type {
  Finding, FindingApprovalStatus, KeyImage, ModelCard, ReportAddendum, ReportVersion, SavedReport, TemplateRow, UserInfo,
} from "@/lib/types";
import { apiFetch } from "@/lib/csrfClient";

export interface ReportData {
  id?: number;
  status: "taslak" | "onaylandi";
  version?: number;
  studyUid: string;
  patientName: string;
  patientId: string;
  patientAge: string;
  patientSex: string;
  studyDate: string;
  modality: string;
  bodyPart: string;
  seriesDescription: string;
  institution: string;
  sliceCount: number;
  technique: string;
  findingsText: string;
  impression: string;
  recommendation: string;
  clinicalInfo: string;
  findings: Finding[];
  findingsApproval: Record<string, FindingApprovalStatus>;
  /** Reddedilen/düzenlenen bulgu gerekçeleri (bulgu id → metin); onay için zorunlu. */
  findingsReason: Record<string, string>;
  engine: string;
  aiModel: string;
  modelCard: string;
  triageLevel: string;
  triageScore: number;
  approvedBy: string;
  doctorTitle: string;
  doctorRegNo: string;
  approvedAt: string | null;
  contentHash?: string;
  keyImageDataUrl: string;
  keyImages: KeyImage[];
  measurementsText: string;
  createdAt: string;
}

export type SaveResult = { ok: boolean; error?: string; data?: Partial<ReportData> };

interface Props {
  open: boolean;
  onClose: () => void;
  report: ReportData;
  user: UserInfo;
  onSave: (r: ReportData, action: "save" | "approve") => Promise<SaveResult>;
  onGotoSlice?: (sliceNumber: number) => void;
  /** Anahtar kesitlerin DICOM başvuruları (SR kanıt listesi); yoksa SR başvurusuz üretilir. */
  srEvidence?: EvidenceRef | null;
  /** AUTH_MODE=hesap'ta onay sahibi oturumla doğrulanmış sayılır; demo modunda false. */
  sessionIdentity?: boolean;
  /** Hekimin geçmiş raporları — üslup örneği seçimi için (taslak izlenimde kullanılır). */
  priorReports?: SavedReport[];
}

// ───────── Web Speech API (Türkçe dikte) ─────────
interface SpeechRec {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null; start(): void; stop(): void;
}
type SpeechCtor = new () => SpeechRec;

/**
 * Dikte komutları ve tıbbi sözlük `src/lib/dictate.ts` içinde uygulanır:
 * sayı sözcükleri, noktalama ("virgül", "iki nokta üst üste"), ölçü birimleri
 * ("milimetre" → mm) ve tipik ASR bozuklukları ("akciger" → akciğer).
 */
function MicButton({ onText, onClear }: { onText: (t: string) => void; onClear?: () => void }) {
  const [on, setOn] = useState(false);
  const [hint, setHint] = useState("");
  const rec = useRef<SpeechRec | null>(null);
  const stop = () => { rec.current?.stop(); };
  const toggle = () => {
    if (on) { stop(); return; }
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!C) { alert("Bu tarayıcı konuşma tanımayı desteklemiyor (Chrome/Edge önerilir)."); return; }
    const r = new C();
    r.lang = "tr-TR"; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => {
      let s = "";
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) s += e.results[i][0].transcript;
      if (!s.trim()) return;
      const d = processDictation(s);
      if (d.commands.includes("temizle")) {
        onClear?.();
        setHint(" alan temizlendi");
      } else {
        onText(d.text + " ");
        setHint(d.commands.length > 0 ? ` komut: ${d.commands.join(", ")}` : "");
      }
    };
    r.onend = () => { setOn(false); setHint(""); };
    r.onerror = () => { setOn(false); setHint(" dinleme hatası — tekrar deneyin"); };
    rec.current = r;
    r.start();
    setOn(true);
  };
  return (
    <span className="inline-flex items-center">
      <button type="button" onClick={toggle} title="Sesle dikte (Türkçe). Komutlar: nokta, virgül, iki nokta, yeni satır, yeni paragraf, temizle; sayılar ve tıbbi terimler otomatik düzeltilir." className={`ml-2 rounded px-1.5 text-[10px] font-bold ${on ? "animate-pulse bg-rose-500 text-white" : "bg-slate-200 text-slate-700 hover:bg-slate-300"}`}>
        {on ? "● dinliyor" : "🎤 dikte"}
      </button>
      {hint && <span className="ml-1 text-[9px] italic text-slate-500">{hint}</span>}
    </span>
  );
}

/** Rapor metin alanı. Modül seviyesinde tanımlıdır; render sırasında bileşen oluşturulmaz. */
function ReportField({ name, rows, value, editing, onChange, onMic, onClear, onGotoSlice, onClose }: {
  name: string;
  rows: number;
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  onMic: (t: string) => void;
  /** "temizle" sesli komutu bu alanı boşaltır. */
  onClear?: () => void;
  onGotoSlice?: (sliceNumber: number) => void;
  onClose: () => void;
}) {
  const linkify = (text: string) =>
    text.split(/(Kesit \d+)/g).map((part, i) => {
      const m = /^Kesit (\d+)$/.exec(part);
      return m && onGotoSlice ? (
        <button key={i} type="button" className="font-semibold text-[#0e7490] underline decoration-dotted print:no-underline" onClick={() => { onGotoSlice(Number(m[1])); onClose(); }}>{part}</button>
      ) : (<span key={i}>{part}</span>);
    });
  return (
    <div>
      <div className="flex items-center font-bold uppercase text-slate-900">{name}{editing && <MicButton onText={onMic} onClear={onClear} />}</div>
      {editing ? <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="mt-1 w-full rounded border border-slate-300 p-2 text-xs" /> : <p className="mt-0.5 whitespace-pre-wrap">{linkify(value)}</p>}
    </div>
  );
}

const STATUS_TR: Record<FindingApprovalStatus, string> = { onaylandi: "✓ Radyolog onayladı", reddedildi: "✗ Reddedildi", duzenlendi: "✎ Düzenlendi", bekliyor: "Onay bekliyor" };

export default function ReportPrintModal({ open, onClose, report: initial, user, onSave, onGotoSlice, srEvidence = null, sessionIdentity = false, priorReports = [] }: Props) {
  const [report, setReport] = useState<ReportData>(initial);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  // Hasta mektubu (d-patient-letter)
  const [letterOpen, setLetterOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  /** Eklenen ICD-10 kodları (rapora yazılan öneriler; kodlama hekime aittir). */
  const [icdCodes, setIcdCodes] = useState<string[]>([]);
  // Elektronik imza kaydı (kayıt/denetim; NES sağlayıcısı yoksa nesne nitelikli değildir)
  const [sigOpen, setSigOpen] = useState(false);
  const [sigMethod, setSigMethod] = useState<SignatureMethod>("hesap-parola-mfa");
  const [sigAck, setSigAck] = useState(false);
  const [sigBusy, setSigBusy] = useState(false);
  const [sigMsg, setSigMsg] = useState("");
  const [sigRecords, setSigRecords] = useState<SignatureRecord[]>([]);
  const [tplQuery, setTplQuery] = useState("");
  const [versions, setVersions] = useState<ReportVersion[]>([]);
  const [addenda, setAddenda] = useState<ReportAddendum[]>([]);
  const [addText, setAddText] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  // ikinci okuma (peer review)
  const [peerList, setPeerList] = useState<{ id: number; result: string; discrepancyType: string; note: string; reviewedByName: string; createdAt: string }[]>([]);
  const [peerResult, setPeerResult] = useState<PeerResult>("uyumlu");
  const [peerType, setPeerType] = useState("");
  const [peerNote, setPeerNote] = useState("");
  const [peerMsg, setPeerMsg] = useState("");
  // süreli paylaşım bağlantısı
  const [shares, setShares] = useState<{ token: string; reportId: number | null; expiresAt: string | Date; revokedAt: string | Date | null; accessCount: number; createdAt: string | Date }[]>([]);
  const [shareTtl, setShareTtl] = useState<number>(24);
  const [shareMsg, setShareMsg] = useState("");
  // createdAt yoksa yazdırma başlığında tutulacak yedik zaman damgası (mount anında bir kez).
  const [createdFallback] = useState(() => Date.now());

  // Rapor açılışında veya ilk veri değiştiğinde formu sıfırla (render sırasında korumalı durum güncellemesi).
  const [prevForm, setPrevForm] = useState<{ initial: ReportData; open: boolean }>({ initial, open });
  if (prevForm.initial !== initial || prevForm.open !== open) {
    setPrevForm({ initial, open });
    setReport(initial);
    setError("");
    setEditing(false);
    setIcdCodes([]);
    setSigOpen(false);
    setSigRecords([]);
  }

  // ICD-10 önerileri: rapor metnine göre yaklaşık eşleme (hekim onayı şart).
  const icdText = `${report.findingsText ?? ""} ${report.impression ?? ""}`;
  // Şablon yer tutucuları ([BOYUT] vb.): onay öncesi görünür olmalı.
  const leftPlaceholders = reportPlaceholders(report);
  const icdSuggest = useMemo(() => suggestIcd10(icdText, 5), [icdText]);
  const icdAppropriate = useMemo(
    () => (report.clinicalInfo ? appropriatenessFor(report.modality, report.bodyPart, report.clinicalInfo) : null),
    [report.clinicalInfo, report.modality, report.bodyPart],
  );

  const loadSignatures = useCallback(async (id: number) => {
    try {
      const r = await apiFetch(`/api/reports/${id}/signature`);
      if (!r.ok) return;
      const d = (await r.json()) as { records?: SignatureRecord[] };
      setSigRecords(Array.isArray(d.records) ? d.records : []);
    } catch { /* kayıt listesi yüklenemezse sessiz geç */ }
  }, []);

  const signReport = useCallback(async () => {
    if (!report.id) return;
    setSigBusy(true);
    setSigMsg("");
    try {
      const r = await apiFetch(`/api/reports/${report.id}/signature`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: sigMethod }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setSigMsg(d.error ?? "İmza kaydı oluşturulamadı.");
      else { setSigAck(false); await loadSignatures(report.id); setSigMsg("İmza kaydı denetim zincirine işlendi."); }
    } catch { setSigMsg("Ağ hatası — imza kaydı oluşturulamadı."); }
    finally { setSigBusy(false); }
  }, [report.id, sigMethod, loadSignatures]);

  const loadDetail = useCallback(async (id: number) => {
    const r = await apiFetch(`/api/reports/${id}`);
    if (!r.ok) return;
    const d = (await r.json()) as { versions: ReportVersion[]; addenda: ReportAddendum[] };
    setVersions(d.versions);
    setAddenda(d.addenda);
    apiFetch("/api/shares").then((sr) => (sr.ok ? sr.json() : null)).then((sd: { shares?: typeof shares } | null) => {
      if (sd?.shares) setShares(sd.shares.filter((x) => x.reportId === id));
    }).catch(() => {});
    apiFetch(`/api/reports/${id}/peer-reviews`).then((pr) => (pr.ok ? pr.json() : null)).then((pd: { reviews?: typeof peerList } | null) => {
      if (pd?.reviews) setPeerList(pd.reviews);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    apiFetch("/api/templates").then((r) => (r.ok ? r.json() : [])).then((t: TemplateRow[]) => setTemplates(t)).catch(() => {});
  }, [open]);
  useEffect(() => {
    void (async () => {
      if (open && report.id) await loadDetail(report.id);
      else { setVersions([]); setAddenda([]); }
    })();
  }, [open, report.id, report.version, loadDetail]);

  const card = useMemo<ModelCard | null>(() => { try { return report.modelCard ? (JSON.parse(report.modelCard) as ModelCard) : null; } catch { return null; } }, [report.modelCard]);

  const tplNormalized = tplQuery.trim().toLocaleLowerCase("tr-TR");
  const tplFiltered = templates.filter((t) => {
    if (t.modality && t.modality !== report.modality) return false;
    if (!tplNormalized) return true;
    return [t.name, t.bodyPart, t.indication, t.protocol].join(" ").toLocaleLowerCase("tr-TR").includes(tplNormalized);
  });

  if (!open) return null;
  const approved = report.status === "onaylandi";
  const canWrite = true;
  const pending = report.findings.filter((f) => (report.findingsApproval[f.id] ?? "bekliyor") === "bekliyor").length;
  const missingReasons = missingReviewReasons(report.findings, report.findingsApproval, report.findingsReason);
  const reasonLines = reviewReasonLines(report.findings, report.findingsApproval, report.findingsReason);
  // Yazarken ham metin tutulur (boşluk silinmesin); kırpma/sadeleştirme kayıt ve çıktı anında yapılır.
  const setReason = (id: string, text: string) =>
    set("findingsReason", { ...report.findingsReason, [id]: text.slice(0, REVIEW_REASON_MAX) });
  const set = <K extends keyof ReportData>(k: K, v: ReportData[K]) => setReport((r) => ({ ...r, [k]: v }));
  const append = (k: "technique" | "findingsText" | "impression" | "recommendation") => (t: string) => setReport((r) => ({ ...r, [k]: (r[k] + (r[k] && !r[k].endsWith(" ") && !r[k].endsWith("\n") ? " " : "") + t).trimStart() }));

  const cycle = (id: string) => {
    const order: FindingApprovalStatus[] = ["bekliyor", "onaylandi", "reddedildi", "duzenlendi"];
    const cur = report.findingsApproval[id] ?? "bekliyor";
    set("findingsApproval", { ...report.findingsApproval, [id]: order[(order.indexOf(cur) + 1) % order.length] });
  };

  const save = async (action: "save" | "approve") => {
    setBusy(true); setError("");
    const res = await onSave(report, action);
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "İşlem başarısız"); return; }
    if (res.data) setReport((r) => ({ ...r, ...res.data }));
    setDialog(false); setEditing(false);
  };

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => String(x.id) === id);
    if (!t) return;
    setReport((r) => ({ ...r, technique: t.technique || r.technique, findingsText: t.findings || r.findingsText, impression: t.impression || r.impression, recommendation: t.recommendation || r.recommendation }));
  };
  const saveTemplate = async () => {
    const name = window.prompt("Şablon adı", `${report.modality} ${report.bodyPart} — özel`);
    if (!name) return;
    const r = await apiFetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, modality: report.modality, bodyPart: report.bodyPart, technique: report.technique, findings: report.findingsText, impression: report.impression, recommendation: report.recommendation }) });
    if (r.ok) apiFetch("/api/templates").then((x) => x.json()).then((t: TemplateRow[]) => setTemplates(t));
  };
  const draftImpression = async () => {
    setBusy(true); setError("");
    const r = await apiFetch("/api/reports/draft-impression", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modality: report.modality, bodyPart: report.bodyPart,
        styleSample: pickStyleSample(
          priorReports.map((r) => ({ impression: r.impression, bodyPart: report.bodyPart, modality: report.modality, status: r.status })),
          { bodyPart: report.bodyPart, modality: report.modality },
        ),
        findings: report.findings.map((f) => ({ label: f.label, detail: f.detail, slice: f.keySliceNumber, category: f.category, severity: f.severity, status: report.findingsApproval[f.id] ?? "bekliyor" })),
      }),
    });
    setBusy(false);
    const d = (await r.json()) as { text?: string; source?: string; error?: string };
    if (!r.ok || !d.text) { setError(d.error ?? "Taslak üretilemedi"); return; }
    set("impression", `${d.text}\n[Taslak — ${d.source === "llm" ? "LLM" : "kural tabanlı"}; hekim doğrulaması gerekir]`);
  };
  /** Yapılandırılmış skordan gelen takip/biyopsi görevini kaydeder. */
  const createScoreTask = async (t: { message: string; intervalDays: number | null; severity?: string }) => {
    if (!report.id) { setError("Önce raporu taslak olarak kaydedin; görevler yalnız kayıtlı rapora bağlanır."); return; }
    const days = t.intervalDays ?? 0;
    const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const r = await apiFetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyUid: report.studyUid,
        message: t.message.slice(0, 2000),
        modality: report.modality,
        bodyRegion: report.bodyPart,
        recommendedIntervalDays: t.intervalDays,
        severity: t.severity ?? "",
        dueDate: due,
        reportId: report.id,
      }),
    });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Görev oluşturulamadı");
  };

  const addMissed = () => {
    const label = window.prompt("AI'nın kaçırdığı bulgu (kısa ad)");
    if (!label) return;
    const slice = Number(window.prompt("Kesit numarası", "1") ?? "1") || 1;
    const f: Finding = {
      id: `m${Date.now()}`, sliceIndex: slice - 1, sliceStart: slice - 1, sliceEnd: slice - 1, keySliceNumber: slice, sliceRangeStr: `Kesit ${slice}`,
      anatomicalLocation: "Hekim girişi", densityOrSignal: "—", sizeMmStr: "—", bbox: null, label, detail: "Radyolog tarafından eklenen bulgu (AI tarafından saptanmadı).",
      category: "Hekim", severity: "orta", confidence: 0, confidenceKind: "none", source: "manual",
    };
    setReport((r) => ({ ...r, findings: [...r.findings, f], findingsApproval: { ...r.findingsApproval, [f.id]: "onaylandi" }, findingsText: `${r.findingsText}\n\n+ ${label} [Kesit ${slice}] (radyolog eklemesi)` }));
  };

  /** İkinci okuma kaydı gönderir (yalnızca onaylı rapor). */
  const sendPeerReview = async () => {
    if (!report.id) return;
    setBusy(true); setPeerMsg(""); setError("");
    try {
      const r = await apiFetch(`/api/reports/${report.id}/peer-reviews`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: peerResult, discrepancyType: peerType, note: peerNote }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; advice?: string };
      if (!r.ok) throw new Error(d.error ?? "Kaydedilemedi");
      setPeerMsg(d.advice ?? "İkinci okuma kaydedildi.");
      setPeerNote("");
      await loadDetail(report.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Kaydedilemedi"); }
    finally { setBusy(false); }
  };

  /** Süreli paylaşım bağlantısı oluşturur ve panoya kopyalar. */
  const createShare = async () => {
    if (!report.id) return;
    setBusy(true); setShareMsg(""); setError("");
    try {
      const r = await apiFetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "report", reportId: report.id, ttlHours: shareTtl }) });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
      if (!r.ok || !d.url) throw new Error(d.error ?? "Bağlantı oluşturulamadı");
      try { await navigator.clipboard.writeText(`${window.location.origin}${d.url}`); setShareMsg("Bağlantı kopyalandı."); }
      catch { setShareMsg(`Bağlantı: ${d.url}`); }
      await loadDetail(report.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Bağlantı oluşturulamadı"); }
    finally { setBusy(false); }
  };

  /** Bağlantıyı kapatır. */
  const revokeShare = async (token: string) => {
    setBusy(true); setShareMsg(""); setError("");
    try {
      const r = await apiFetch(`/api/shares/${token}`, { method: "DELETE" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Kapatılamadı");
      setShareMsg("Bağlantı kapatıldı.");
      if (report.id) await loadDetail(report.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Kapatılamadı"); }
    finally { setBusy(false); }
  };

  /** Raporu DICOM Basic Text SR olarak indirir (onaylıysa "VERIFIED" işaretli; elektronik imza değildir). */
  const downloadSr = () => {
    try {
      const bytes = buildReportSr({
        patientName: report.patientName, patientId: report.patientId, patientSex: report.patientSex, patientAge: report.patientAge,
        studyUid: report.studyUid, studyDate: report.studyDate, institution: report.institution, studyModality: report.modality,
        clinicalInfo: report.clinicalInfo, technique: report.technique, findings: report.findingsText, impression: report.impression, recommendation: report.recommendation,
        measurements: report.measurementsText, approvedBy: report.approvedBy, doctorTitle: report.doctorTitle, approvedAt: report.approvedAt, evidence: srEvidence,
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/dicom" }));
      a.download = `rapor-${report.id ?? "taslak"}.sr.dcm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { setError(e instanceof Error ? e.message : "DICOM SR oluşturulamadı"); }
  };

  /** FHIR dosyasını fetch ile alıp indirir (sunucuda da, statik demoda da çalışır). */
  const downloadFhir = async (id: number) => {
    try {
      const r = await apiFetch(`/api/reports/${id}/fhir`);
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "FHIR dışa aktarılamadı");
      const blob = new Blob([await r.text()], { type: "application/fhir+json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `rapor-${id}.fhir.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : "FHIR dışa aktarılamadı"); }
  };

  /** Raporu sunucudan STOW-RS ile PACS'e gönderir (DICOM SR). */
  const sendToPacs = async (id: number) => {
    setBusy(true); setError("");
    try {
      const r = await apiFetch("/api/pacs/stow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId: id }) });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; stored?: number; pacs?: string; error?: string };
      if (!r.ok) throw new Error(d.error ?? "PACS'e gönderilemedi");
      setNotice(`PACS'e gönderildi: ${d.stored ?? 1} nesne kaydedildi (${d.pacs ?? "PACS"}).`);
    } catch (e) { setError(e instanceof Error ? e.message : "PACS'e gönderilemedi"); }
    finally { setBusy(false); }
  };

  /**
   * Yazdırma: rapor kâğıdı, uygulama düzeninin (sabit yükseklik/overflow) dışında,
   * body'nin doğrudan çocuğu olan geçici bir #print-root içine kopyalanır; böylece
   * tarayıcı yazdırma önizlemesi boş sayfa yerine raporun tamamını (çok sayfa) basar.
   */
  const printReport = () => {
    const paper = document.getElementById("report-paper");
    if (!paper) { window.print(); return; }
    const clone = paper.cloneNode(true) as HTMLElement;
    // Düzenleme modundaki alanların değerleri kopyaya geçmez; düz metne çevrilir.
    const src = paper.querySelectorAll("textarea, input, select");
    clone.querySelectorAll("textarea, input, select").forEach((el, i) => {
      const v = (src[i] as HTMLInputElement | undefined)?.value ?? "";
      const span = document.createElement("div");
      span.style.whiteSpace = "pre-wrap";
      span.textContent = v;
      el.replaceWith(span);
    });
    const root = document.createElement("div");
    root.id = "print-root";
    root.appendChild(clone);
    document.body.appendChild(root);
    const cleanup = () => { root.remove(); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    // Görseller (anahtar kesit) yüklenmeden yazdırmayı başlatma
    const imgs = Array.from(root.querySelectorAll("img")).filter((im) => !im.complete);
    void Promise.all(imgs.map((im) => new Promise<void>((res) => { im.onload = im.onerror = () => res(); })))
      .then(() => setTimeout(() => window.print(), 50));
  };

  const addAddendum = async () => {
    if (!report.id || addText.trim().length < 3) return;
    setBusy(true);
    const r = await apiFetch(`/api/reports/${report.id}/addenda`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: addText }) });
    setBusy(false);
    if (r.ok) { setAddText(""); void loadDetail(report.id); } else setError(((await r.json()) as { error?: string }).error ?? "Addendum eklenemedi");
  };

  const findingSlices = new Set(report.findings
    .filter((f) => f.category !== "Sistem" && f.category !== "ROI" && f.category !== "Görüntü ölçümü" && f.bbox)
    .map((f) => f.sliceIndex));
  const evidenceImages = report.keyImages.filter((image) => findingSlices.has(image.slice));
  const images = evidenceImages.length > 0
    ? evidenceImages.slice(0, 4).map((k) => ({ src: k.dataUrl, cap: `Kesit ${k.slice + 1}${k.note ? ` · ${k.note}` : ""}` }))
    : findingSlices.size === 0 && report.keyImages.length === 0 && report.keyImageDataUrl
      ? [{ src: report.keyImageDataUrl, cap: "Anahtar kesit" }]
      : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-2 backdrop-blur-sm sm:p-4 print:static print:z-auto print:bg-white print:p-0">
      <div className="flex h-full max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#232e40] bg-[#0d121a] shadow-2xl print:max-h-none print:h-auto print:border-none print:bg-white print:shadow-none">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#1e2735] bg-[#0b0f16] px-4 py-3 print:hidden">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-cyan-400">Radyoloji raporu</span>
            <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${approved ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-400" : "border-rose-500/40 bg-rose-500/20 text-rose-300"}`}>
              {approved ? `✓ ONAYLANDI · v${report.version ?? 1} · KİLİTLİ` : "⚠ ONAYLANMAMIŞ TASLAK"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!approved && canWrite && (
              <>
                <button onClick={() => setEditing(!editing)} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold ${editing ? "bg-amber-500 text-slate-950" : "border border-[#2d3b4e] bg-[#141b24] text-slate-200 hover:bg-[#1a2330]"}`}>{editing ? "Düzenlemeyi bitir" : "✎ Düzenle"}</button>
                <button disabled={busy} onClick={() => void save("save")} className="cursor-pointer rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-50">💾 Taslağı kaydet</button>
                <button onClick={() => setDialog(true)} className="cursor-pointer rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:from-emerald-400 hover:to-teal-400">✓ Onayla</button>
              </>
            )}
            <button type="button" onClick={downloadSr} disabled={!approved} title={approved ? "Radyoloji raporu → DICOM Basic Text SR" : "Sadece radyoloji uzmanı onayı sonrası alınabilir"} className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${approved ? "cursor-pointer border-[#2d3b4e] bg-[#141b24] text-slate-200 hover:bg-[#1a2330]" : "cursor-not-allowed border-[#2d3b4e] bg-[#141b24]/50 text-slate-500 opacity-60"}`}>DICOM SR ⬇</button>
            {report.id && <button type="button" onClick={() => { setSigOpen((v) => !v); setSigMsg(""); if (!sigOpen) void loadSignatures(report.id!); }} title="Elektronik imza kaydı (NES değildir; içerik SHA-256 ile mühürlenir)" className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${sigOpen ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-200" : "cursor-pointer border-[#2d3b4e] bg-[#141b24] text-slate-200 hover:bg-[#1a2330]"}`}>✍ İmza kaydı</button>}
            {report.id && <button type="button" onClick={() => void downloadFhir(report.id!)} disabled={!approved} title={approved ? "FHIR DiagnosticReport indir" : "Sadece radyoloji uzmanı onayı sonrası alınabilir"} className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${approved ? "cursor-pointer border-[#2d3b4e] bg-[#141b24] text-slate-200 hover:bg-[#1a2330]" : "cursor-not-allowed border-[#2d3b4e] bg-[#141b24]/50 text-slate-500 opacity-60"}`}>FHIR ⬇</button>}
            {report.id && <button type="button" onClick={() => void sendToPacs(report.id!)} disabled={!approved || busy} title={approved ? "Raporu DICOM SR olarak yapılandırılmış PACS'e gönder (STOW-RS)" : "Sadece radyoloji uzmanı onayı sonrası gönderilebilir"} className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${approved ? "cursor-pointer border-violet-400/50 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20" : "cursor-not-allowed border-[#2d3b4e] bg-[#141b24]/50 text-slate-500 opacity-60"}`}>PACS’e gönder ⇧</button>}
            <button onClick={() => setLetterOpen(true)} title="Hasta dostu sonuç mektubu (TR/EN/DE, sade dil)" className="cursor-pointer rounded-lg border border-emerald-400/50 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-400/10">💬 Hasta mektubu</button>
            <button onClick={approved ? printReport : undefined} disabled={!approved} title={approved ? "Yazdır / PDF olarak kaydet" : "Sadece radyoloji uzmanı onayı sonrası alınabilir"} className={`rounded-lg px-3.5 py-1.5 text-xs font-bold ${approved ? "cursor-pointer bg-cyan-500 text-slate-950 hover:bg-cyan-400" : "cursor-not-allowed bg-slate-600 text-slate-400 opacity-60"}`}>🖨 Yazdır / PDF</button>
            <button onClick={onClose} className="cursor-pointer rounded-lg border border-[#2d3b4e] bg-[#141b24] p-1.5 text-xs text-slate-400 hover:text-slate-100">✕</button>
          </div>
        </div>

        {(error || (!approved && canWrite && (pending > 0 || missingReasons.length > 0))) && (
          <div className="shrink-0 space-y-1 border-b border-[#1e2735] bg-[#0b0f16] px-4 py-2 text-[11px] print:hidden">
            {error && <div className="font-semibold text-rose-300">⚠ {error}</div>}
            {!approved && pending > 0 && <div className="text-amber-300">{pending} bulgu henüz gözden geçirilmedi — tablodaki durum düğmesine tıklayarak Onayla/Reddet/Düzenlendi olarak işaretleyin. Onay için hepsi işaretlenmeli.</div>}
            {!approved && missingReasons.length > 0 && <div className="text-rose-300">{missingReasons.length} reddedilen/düzenlenen bulgu için gerekçe yazılmalı (tablodaki kutu) — gerekçe yoksa rapor onaylanamaz (taslak kaydı yapılabilir).</div>}
          </div>
        )}

        {sigOpen && report.id && (
          <div className="shrink-0 space-y-2 border-b border-[#1e2735] bg-[#0b0f16] px-4 py-3 text-[11px] print:hidden">
            <div className="flex items-center justify-between">
              <span className="font-bold uppercase tracking-wider text-slate-300">Elektronik imza kaydı</span>
              <button onClick={() => setSigOpen(false)} className="cursor-pointer text-slate-500 hover:text-slate-200">✕</button>
            </div>
            <p className="text-slate-500">
              Kayıt; içeriğin SHA-256 hash değeri, imza sahibi, zaman ve yöntemi denetim zincirine yazar.
              Nitelikli elektronik imza (NES) için akreditasyonlu bir sağlayıcı entegrasyonu gerekir.
            </p>
            {!approved && <p className="font-semibold text-amber-300">Rapor henüz onaylanmadı: onaylanmamış içeriğe imza kaydı düşürülemez.</p>}
            <label className="block">
              <span className="mb-1 block font-bold text-slate-400">Yöntem</span>
              <select value={sigMethod} onChange={(e) => setSigMethod(e.target.value as SignatureMethod)} className="w-full rounded-lg border border-[#232e40] bg-[#0e141d] px-2 py-1.5 text-xs text-slate-200">
                {SIGNATURE_METHODS.map((m) => <option key={m.id} value={m.id} disabled={m.qualified}>{m.label}{m.qualified ? " (entegre edilmedi)" : ""}</option>)}
              </select>
            </label>
            <label className="flex items-start gap-2 text-slate-400">
              <input type="checkbox" checked={sigAck} onChange={(e) => setSigAck(e.target.checked)} className="mt-0.5" />
              <span>Kaydın <b>nesne nitelikli elektronik imza olmadığını</b>, yalnızca içerik değişikliğini saptayan bir kayıt olduğunu anladım.</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => void signReport()} disabled={sigBusy || !approved || !sigAck} className="cursor-pointer rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">{sigBusy ? "Kaydediliyor…" : "✍ Kaydı oluştur"}</button>
              {sigMsg && <span className="text-slate-300">{sigMsg}</span>}
            </div>
            {sigRecords.length > 0 && (
              <ul className="space-y-1 border-t border-[#1e2735] pt-2">
                {sigRecords.slice(-5).map((r, i) => (
                  <li key={`${r.signedAt}-${i}`} className="rounded border border-[#1a2230] bg-[#0e141d] px-2 py-1 font-mono text-[10px] text-slate-400">
                    {signatureNote(r)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#1e2735] bg-[#0b0f16] px-4 py-2 text-xs print:hidden">
            <input
              value={tplQuery}
              onChange={(e) => setTplQuery(e.target.value)}
              placeholder="Şablon ara (bölge, endikasyon, protokol)…"
              aria-label="Şablon ara"
              className="w-56 rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1 text-slate-200 outline-none focus:border-cyan-400/50"
            />
            <select defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ""; }} className="max-w-72 rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1 text-slate-200">
              <option value="" disabled>Şablon uygula…</option>
              {tplFiltered.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.indication ? ` — ${t.indication}` : ""}{t.protocol ? ` · ${t.protocol}` : ""}
                </option>
              ))}
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                const m = macroById(e.target.value);
                if (!m) return;
                const target = m.group === "teknik" ? "technique" : m.group === "bulgu" ? "findingsText" : "recommendation";
                append(target)(`${m.text} `);
                e.target.value = "";
              }}
              aria-label="Makro ekle"
              className="max-w-56 rounded border border-[#1e2735] bg-[#0e141d] px-2 py-1 text-slate-200"
            >
              <option value="" disabled>Makro ekle…</option>
              {(Object.keys(MACRO_GROUPS) as MacroGroup[]).map((g) => (
                <optgroup key={g} label={MACRO_GROUPS[g]}>
                  {macrosByGroup(g).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
            <button onClick={() => void saveTemplate()} className="rounded border border-[#2d3b4e] px-2 py-1 text-slate-200 hover:bg-[#1a2330]">Şablon olarak kaydet</button>
            <button disabled={busy} onClick={() => void draftImpression()} className="rounded border border-violet-400/40 px-2 py-1 font-bold text-violet-200 hover:bg-violet-400/10 disabled:opacity-50">✨ Taslak izlenim üret</button>
            <button onClick={addMissed} className="rounded border border-amber-400/40 px-2 py-1 font-bold text-amber-200 hover:bg-amber-400/10">＋ AI&apos;nın kaçırdığı bulgu</button>
            <span className="text-slate-500">Taslak izlenim yalnızca doğruladığınız bulgulara dayanır; hasta kimliği dışarı gönderilmez.</span>
          </div>
        )}

        {editing && (
          <div className="shrink-0 border-b border-[#1e2735] bg-[#0b0f16] px-4 py-2 print:hidden">
            <StructuredScorePanel
              modality={report.modality}
              bodyPart={report.bodyPart}
              onApply={(t) => setReport((r) => ({ ...r, impression: `${r.impression}${r.impression && !r.impression.endsWith("\n") ? "\n" : ""}${t}` }))}
              onCreateTask={createScoreTask}
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto bg-[#070a0f] p-3 sm:p-6 print:overflow-visible print:bg-white print:p-0">
          <div id="report-paper" className="relative mx-auto min-h-[1050px] w-full max-w-[800px] rounded-sm bg-white p-8 text-slate-900 shadow-2xl sm:p-12 print:m-0 print:w-full print:max-w-none print:p-8 print:shadow-none" style={{ fontFamily: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }}>
            <div className="pointer-events-none absolute inset-0 z-0 flex select-none items-center justify-center overflow-hidden">
              <div className={`-rotate-[32deg] whitespace-nowrap font-black uppercase tracking-[0.2em] ${approved ? "text-emerald-500/[0.05]" : "text-rose-500/[0.12]"}`} style={{ fontSize: approved ? 60 : 52 }}>{approved ? "ONAYLANDI" : "ONAYLANMAMIŞ TASLAK"}</div>
            </div>

            <div className="relative z-10 flex min-h-[960px] flex-col justify-between">
              <div>
                <div className="flex items-end justify-between border-b-[3px] border-[#0e7490] pb-2">
                  <h1 className="text-2xl font-black tracking-wider text-[#0e7490]">ATIKVIEWER</h1>
                  <div className="text-right">
                    <div className="text-xs font-black uppercase tracking-wider text-slate-800">Radyoloji raporu</div>
                    <div className="font-mono text-[11px] text-slate-600">{new Date(report.createdAt || createdFallback).toLocaleString("tr-TR")}</div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 border-b border-slate-200 pb-3 text-[11px]">
                  {([["Hasta adı", report.patientName], ["Hasta ID", report.patientId], ["Yaş", report.patientAge || "-"], ["Cinsiyet", report.patientSex || "-"], ["Çalışma tarihi", report.studyDate || "-"], ["Modalite", report.modality], ["Çalışma açıklaması", report.seriesDescription], ["Vücut bölgesi", report.bodyPart], ["Kurum", report.institution]] as const).map(([k, v]) => (
                    <div key={k}><span className="font-bold text-slate-900">{k}: </span><span className="text-slate-800">{v}</span></div>
                  ))}
                </div>

                <div className="mt-3">
                  {!approved ? (
                    <p className="text-[11.5px] font-bold text-[#b91c1c]">Bu rapor radyolog tarafından henüz onaylanmamıştır. Tanı amaçlı kullanılamaz.</p>
                  ) : (
                    <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-bold text-emerald-800">
                      ✓ Radyolog tarafından onaylanmıştır. <span className="font-normal text-emerald-700">({report.doctorTitle} {report.approvedBy} · {report.approvedAt ? new Date(report.approvedAt).toLocaleString("tr-TR") : ""})</span>
                    </div>
                  )}
                  {report.engine === "simulated-sample" && <p className="mt-1 text-[10.5px] font-bold text-amber-700">DEMO: Bulgular örnek vakaya önceden tanımlanmış simülasyondur.</p>}
                </div>

                <div className="mt-5">
                  <h2 className="text-sm font-black uppercase tracking-wide text-[#0e7490]">Rapor</h2>
                  <div className="mt-1 h-0.5 w-full bg-slate-200" />
                  <div className="mt-3 grid grid-cols-1 items-start gap-5 md:grid-cols-12">
                    <div className="flex flex-col gap-3 text-[11.5px] leading-relaxed text-slate-800 md:col-span-8">
                      {report.clinicalInfo && <div><div className="font-bold uppercase text-slate-900">Klinik bilgi</div><p className="mt-0.5 whitespace-pre-wrap">{report.clinicalInfo}</p></div>}
                      <ReportField name="Teknik" rows={3} value={report.technique} editing={editing} onChange={(v) => set("technique", v)} onMic={append("technique")} onClear={() => set("technique", "")} onGotoSlice={onGotoSlice} onClose={onClose} />
                      <ReportField name="Kesit bazlı bulgular" rows={8} value={report.findingsText} editing={editing} onChange={(v) => set("findingsText", v)} onMic={append("findingsText")} onClear={() => set("findingsText", "")} onGotoSlice={onGotoSlice} onClose={onClose} />
                      <ReportField name="Sonuç/İzlenim" rows={3} value={report.impression} editing={editing} onChange={(v) => set("impression", v)} onMic={append("impression")} onClear={() => set("impression", "")} onGotoSlice={onGotoSlice} onClose={onClose} />
                      <ReportField name="Öneri" rows={2} value={report.recommendation} editing={editing} onChange={(v) => set("recommendation", v)} onMic={append("recommendation")} onClear={() => set("recommendation", "")} onGotoSlice={onGotoSlice} onClose={onClose} />

                      {editing && (
                        <div className="rounded border border-slate-300 bg-slate-50 p-2">
                          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-700">ICD-10 önerileri</div>
                          <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                            Rapor metnine göre yaklaşık eşlemedir; kodlama ve doğrulama radyologa aittir.
                            Üzerine basarak izlenim satırına eklenir.
                          </p>
                          {icdAppropriate?.score != null && (
                            <p className="mt-1 text-[10.5px] font-bold text-[#0e7490]">
                              İstem uygunluğu: {icdAppropriate.score}/9 — {icdAppropriate.note}
                            </p>
                          )}
                          {icdSuggest.length === 0 ? (
                            <p className="mt-1 text-[10.5px] italic text-slate-400">Metinde eşleşen öneri yok.</p>
                          ) : (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {icdSuggest.map((c) => {
                                const added = icdCodes.includes(c.code);
                                return (
                                  <button key={c.code} type="button" disabled={added || !isValidIcd10(c.code)}
                                    onClick={() => {
                                      setIcdCodes((p) => [...p, c.code]);
                                      set("impression", `${report.impression}${report.impression && !report.impression.endsWith("\n") ? "\n" : ""}ICD-10: ${c.code} — ${c.label}`);
                                    }}
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${added ? "bg-emerald-100 text-emerald-700" : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"}`}>
                                    {added ? "✓ " : ""}{c.code} · {c.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                      {report.measurementsText && <div><div className="font-bold uppercase text-slate-900">Ölçümler</div><p className="mt-0.5 whitespace-pre-wrap font-mono text-[10.5px]">{report.measurementsText}</p></div>}
                      <p className="mt-1 text-[10px] italic text-slate-500">{report.engine === "image-review" ? "Bu protokol hastalık sınıflandırması yapmaz; kare başına piksel ölçümleri yazdırma raporuna dahil edilmemiştir. Görüntüler radyolog tarafından değerlendirilmelidir." : "Bu çıktı yapay zeka/kural tabanlı veya DEMO desteklidir; hekim doğrulaması gerekir."}</p>
                    </div>
                    <div className="flex flex-col items-center gap-2 md:col-span-4">
                      {images.length === 0 && <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-slate-300 text-[10px] text-slate-400">Anahtar kesit yok</div>}
                      {images.map((im, i) => (
                        <figure key={i} className="w-full max-w-[230px]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={im.src} alt={im.cap} className="block aspect-square w-full rounded-md border-2 border-slate-900 bg-black object-contain" />
                          <figcaption className="mt-0.5 text-center font-mono text-[9.5px] font-bold text-slate-600">{im.cap}</figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <h2 className="text-sm font-black uppercase tracking-wide text-[#0e7490]">{report.engine === "image-review" ? "Otomatik tanısal bulgu yok" : "AI aday bulguları / DEMO ve hekim doğrulaması"}</h2>
                  <div className="mt-1 h-0.5 w-full bg-slate-200" />
                  {report.engine === "image-review" ? (
                    <p className="mt-2 text-[11px] italic text-slate-600">Bu analiz yalnızca piksel dağılımı ölçtü; hastalık adayı üretmedi. Tanısal bulgular radyolog tarafından belirlenmelidir.</p>
                  ) : <table className="mt-2 w-full border-collapse text-[11px]">
                    <thead><tr className="border-b border-slate-300 text-left font-bold text-slate-600"><th className="w-[22%] py-1.5 pr-2">Bulgu / konum</th><th className="w-[18%] py-1.5 pr-2">Kesit</th><th className="w-[40%] py-1.5 pr-2">Açıklama / ölçüm</th><th className="w-[20%] py-1.5 text-right">Radyolog</th></tr></thead>
                    <tbody>
                      {report.findings.length === 0 && <tr><td colSpan={4} className="py-2 italic text-slate-500">Bulgu kaydı yok.</td></tr>}
                      {report.findings.filter((f) => report.engine !== "image-review" || (f.category !== "Görüntü ölçümü" && f.category !== "Sistem")).map((f, i) => {
                        const st = report.findingsApproval[f.id] ?? (approved ? "onaylandi" : "bekliyor");
                        return (
                          <tr key={f.id} className="border-b border-slate-200 align-top">
                            <td className="py-2.5 pr-2 font-bold"><div>{i + 1}. {f.label}</div><div className="mt-0.5 text-[9.5px] font-normal text-slate-500">{f.anatomicalLocation}</div></td>
                            <td className="py-2.5 pr-2"><div className="font-bold text-[#0e7490]">{onGotoSlice && f.category !== "Sistem" ? <button type="button" className="underline decoration-dotted print:no-underline" onClick={() => { onGotoSlice(f.keySliceNumber); onClose(); }}>Kesit {f.keySliceNumber}</button> : `Kesit ${f.keySliceNumber}`}</div><div className="font-mono text-[10px] text-slate-600">{f.sliceRangeStr}</div>{f.zLocationMm !== undefined && <div className="font-mono text-[9px] text-slate-400">z {f.zLocationMm > 0 ? "+" : ""}{f.zLocationMm} mm</div>}</td>
                            <td className="py-2.5 pr-2 leading-snug text-slate-700"><div>{f.detail}</div><div className="mt-1 font-mono text-[9.5px] text-slate-500">{f.densityOrSignal} · {f.sizeMmStr}{fmtConf(f) ? ` · ${fmtConf(f)}` : ""}{f.metrics?.volumeMl !== undefined ? ` · V ${f.metrics.volumeMl} mL` : ""}{f.metrics?.lungRads ? ` · Lung-RADS ${f.metrics.lungRads} eşiği` : ""}</div></td>
                            <td className="py-2.5 text-right font-bold">
                              {!approved && canWrite ? (
                                <button type="button" onClick={() => cycle(f.id)} className={`cursor-pointer rounded border px-2 py-0.5 text-[10px] font-bold print:border-none ${st === "onaylandi" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : st === "reddedildi" ? "border-rose-300 bg-rose-50 text-rose-800" : st === "duzenlendi" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-300 bg-slate-100 text-slate-700"}`}>{STATUS_TR[st]}</button>
                              ) : <span>{STATUS_TR[st]}</span>}
                              {!approved && canWrite && needsReviewReason(st) && (
                                <div className="mt-1 print:hidden">
                                  <textarea
                                    value={report.findingsReason[f.id] ?? ""}
                                    onChange={(e) => setReason(f.id, e.target.value)}
                                    rows={2}
                                    maxLength={REVIEW_REASON_MAX}
                                    placeholder={st === "reddedildi" ? "Ret gerekçesi (zorunlu)" : "Düzenleme gerekçesi (zorunlu)"}
                                    aria-label={`${f.label} için gözden geçirme gerekçesi`}
                                    className={`w-40 max-w-full resize-y rounded border px-1.5 py-1 text-left text-[10px] font-normal ${normalizeReviewReason(report.findingsReason[f.id]) ? "border-slate-300 text-slate-700" : "border-amber-400 bg-amber-50 text-amber-900"}`}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>}
                  {reasonLines.length > 0 && (
                    <div className="mt-2 text-[10px] leading-snug text-slate-600">
                      <div className="font-bold uppercase text-slate-700">Hekim gözden geçirme gerekçeleri</div>
                      <ul className="mt-0.5 list-disc pl-4">
                        {reasonLines.map((r) => (
                          <li key={r.id}><b>{r.label}</b> — {r.status === "reddedildi" ? "reddedildi" : "düzenlendi"}: {r.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {card && (
                  <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-2.5 text-[10px] leading-snug text-slate-600">
                    <div className="font-bold text-slate-700">Yapay zeka yöntemi: {card.name} v{card.version}</div>
                    <div><b>Amaç:</b> {card.intendedUse}</div>
                    <div><b>Yöntem:</b> {card.method}</div>
                    <div><b>Sınırlılıklar:</b> {card.limitations.join(" · ")}</div>
                    <div><b>Klinik doğrulama:</b> {card.validation}</div>
                  </div>
                )}

                {addenda.length > 0 && (
                  <div className="mt-4">
                    <h2 className="text-sm font-black uppercase tracking-wide text-[#0e7490]">Ek raporlar (addendum)</h2>
                    <div className="mt-1 h-0.5 w-full bg-slate-200" />
                    {addenda.map((a) => (
                      <div key={a.id} className="mt-2 text-[11px] text-slate-800"><div className="font-mono text-[9.5px] text-slate-500">{new Date(a.createdAt).toLocaleString("tr-TR")} · {a.createdByName}</div><p className="whitespace-pre-wrap">{a.text}</p></div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-12 pt-4">
                <div className="grid grid-cols-2 gap-8 text-[11.5px]">
                  <div>
                    <div className="font-bold text-slate-900">Raporlayan hekim:</div>
                    <div className="mt-1 font-semibold text-slate-800">{approved ? `${report.doctorTitle} ${report.approvedBy}` : "(onay bekleniyor)"}</div>
                    {approved && <div className="text-[10px] text-slate-600">Sicil/diploma: {report.doctorRegNo}</div>}
                    <div className="mt-6 w-48 border-b border-slate-400" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900">İmza / Kaşe:</div>
                    {approved ? (
                      <div className="mt-1 inline-block rounded border border-emerald-300 bg-emerald-50 p-1.5 font-mono text-[9.5px] text-emerald-800">
                        <div className="font-bold">✓ Yerel onay (kimlik doğrulaması yapılmadı)</div>
                        <div>SHA-256: {report.contentHash?.slice(0, 24)}…</div>
                        <div className="text-[9px] text-emerald-700">Kimlik doğrulanmamıştır; nitelikli elektronik imza (NES) değildir.</div>
                      </div>
                    ) : <div className="mt-1 text-[10px] italic text-slate-500">(onay bekleniyor)</div>}
                    <div className="mt-6 w-48 border-b border-slate-400" />
                  </div>
                </div>
                <div className="mt-6 border-t border-slate-200 pt-2 text-[9.5px] text-slate-500">Bu rapordaki yapay zeka destekli bölümler taslak niteliğindedir ve sorumlu hekim onayı gerektirir.</div>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-4 max-w-[800px] space-y-3 print:hidden">
            {approved && canWrite && report.id && (
              <div className="rounded-lg border border-[#1e2735] bg-[#0b0f16] p-3">
                <div className="text-xs font-bold text-slate-200">Addendum ekle (onaylı rapor değiştirilemez; düzeltme ek olarak kaydedilir)</div>
                <textarea value={addText} onChange={(e) => setAddText(e.target.value)} rows={3} className="mt-2 w-full rounded border border-[#1e2735] bg-[#0e141d] p-2 text-xs text-slate-200" placeholder="Ek bulgu / düzeltme metni…" />
                <button disabled={busy || addText.trim().length < 3} onClick={() => void addAddendum()} className="mt-2 cursor-pointer rounded bg-cyan-500 px-3 py-1 text-xs font-bold text-slate-950 disabled:opacity-40">Addendum kaydet</button>
              </div>
            )}
            {approved && report.id && (
              <div className="rounded-lg border border-[#1e2735] bg-[#0b0f16] p-3 text-xs text-slate-300">
                <div className="font-bold text-slate-200">İkinci okuma / peer review</div>
                <div className="mt-1 text-[11px] text-slate-400">Raporu oluşturan hekim bu kaydı ekleyemez; kayıtlar denetimde görünür.</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select aria-label="İkinci okuma sonucu" value={peerResult} onChange={(e) => setPeerResult(e.target.value as PeerResult)} className="rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
                    {PEER_RESULTS.map((r) => <option key={r} value={r}>{RESULT_LABELS[r]}</option>)}
                  </select>
                  <select aria-label="Uyuşmazlık türü" value={peerType} onChange={(e) => setPeerType(e.target.value)} className="rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
                    <option value="">(tür seç)</option>
                    {["eksik bulgu", "fazladan bulgu", "ölçüm/yerelizasyon hatası", "yanlış yorum", "teknik/kalite", "diğer"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input value={peerNote} onChange={(e) => setPeerNote(e.target.value)} maxLength={4000} placeholder={peerResult === "uyumsuz" ? "Açıklama zorunlu…" : "Not (opsiyonel)"} className="min-w-40 flex-1 rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200" />
                  <button disabled={busy || (peerResult === "uyumsuz" && peerNote.trim().length < 5)} onClick={() => void sendPeerReview()} className="cursor-pointer rounded bg-violet-500 px-3 py-1 text-xs font-bold text-slate-950 hover:bg-violet-400 disabled:opacity-40">Kaydet</button>
                </div>
                {peerMsg && <div className="mt-2 text-emerald-300">✓ {peerMsg}</div>}
                <ul className="mt-2 space-y-1.5">
                  {peerList.length === 0 && <li className="text-slate-500">Henüz ikinci okuma kaydı yok.</li>}
                  {peerList.map((p) => (
                    <li key={p.id} className="rounded border border-[#1a2230] bg-[#0e141d] px-2 py-1.5">
                      <span className="font-mono text-[10.5px] text-cyan-300">{p.result}</span>
                      {p.discrepancyType && <span className="ml-2 text-[10.5px] text-amber-300">{p.discrepancyType}</span>}
                      <span className="ml-2 text-[10.5px] text-slate-500">{p.reviewedByName} · {new Date(p.createdAt).toLocaleString("tr-TR")}</span>
                      {p.note && <div className="mt-0.5 whitespace-pre-wrap text-[11px] text-slate-300">{p.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {approved && report.id && (
              <div className="rounded-lg border border-[#1e2735] bg-[#0b0f16] p-3 text-xs text-slate-300">
                <div className="font-bold text-slate-200">Süreli paylaşım bağlantısı</div>
                <div className="mt-1 text-[11px] text-slate-400">Salt okunur rapor özeti + anahtar kesitler; her erişim denetimde işlenir, süresi gelince ya da siz kapatana kadar geçerlidir.</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select aria-label="Bağlantı süresi" value={shareTtl} onChange={(e) => setShareTtl(Number(e.target.value))} className="rounded border border-[#232e40] bg-[#141b24] px-2 py-1 text-xs text-slate-200">
                    {SHARE_TTL_HOURS.map((h) => <option key={h} value={h}>{h >= 24 ? `${h / 24} gün` : `${h} saat`}</option>)}
                  </select>
                  <button disabled={busy} onClick={() => void createShare()} className="cursor-pointer rounded bg-cyan-500 px-3 py-1 text-xs font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-40">Bağlantı oluştur + kopyala</button>
                </div>
                {shareMsg && <div className="mt-2 text-emerald-300">✓ {shareMsg}</div>}
                <ul className="mt-2 space-y-1.5">
                  {shares.length === 0 && <li className="text-slate-500">Bu rapor için bağlantı yok.</li>}
                  {shares.map((sh) => {
                    const st = shareState(sh);
                    return (
                      <li key={sh.token} className="flex flex-wrap items-center gap-2 rounded border border-[#1a2230] bg-[#0e141d] px-2 py-1.5">
                        <span className="font-mono text-[10.5px] text-cyan-300">…{sh.token.slice(-8)}</span>
                        <span className={`text-[10.5px] font-bold ${st === "aktif" ? "text-emerald-300" : st === "kapatildi" ? "text-rose-300" : "text-amber-300"}`}>{st === "aktif" ? "aktif" : st}</span>
                        <span className="text-[10.5px] text-slate-500">{new Date(sh.expiresAt).toLocaleString("tr-TR")} · {sh.accessCount} erişim</span>
                        {st === "aktif" && <button onClick={() => void revokeShare(sh.token)} className="ml-auto cursor-pointer rounded border border-rose-400/40 px-2 py-0.5 text-[10.5px] font-bold text-rose-200 hover:bg-rose-400/10">Kapat</button>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {report.id && (
              <div className="rounded-lg border border-[#1e2735] bg-[#0b0f16] p-3 text-xs text-slate-300">
                <button onClick={() => setShowVersions((v) => !v)} className="font-bold text-slate-200">{showVersions ? "▾" : "▸"} Sürüm geçmişi ({versions.length})</button>
                {showVersions && <ul className="mt-2 space-y-1 font-mono text-[10.5px]">{versions.map((v) => <li key={v.id}>v{v.versionNo} · {v.action} · {v.createdByName} · {new Date(v.createdAt).toLocaleString("tr-TR")}</li>)}</ul>}
              </div>
            )}
          </div>
        </div>
      </div>

      {dialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl border border-emerald-500/40 bg-[#0d141e] p-5 shadow-2xl">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-100">Raporu onayla</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Onaylandıktan sonra rapor <b>kilitlenir</b>; değişiklik yalnızca addendum ile yapılır.
            </p>
            {leftPlaceholders.length > 0 && (
              <p className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
                ⚠ Raporunda doldurulmamış şablon alanları var: {leftPlaceholders.map((x) => `[${x}]`).join(", ")}. Onaydan önce eksiksiz olması önerilir.
              </p>
            )}
            <div className="mt-3 rounded-md border border-[#232e40] bg-[#141b24] p-2.5 text-xs text-slate-200">
              <div className="font-bold">{user.title} {user.fullName}</div>
              <div className="text-slate-400">Sicil/diploma: {user.regNo || <span className="text-amber-300">tanımlı değil</span>}</div>
              <a href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/yonetim`} className="mt-1 inline-block text-[11px] text-cyan-400 hover:underline">Hekim profilini düzenle →</a>
            </div>
            <p className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
              {sessionIdentity
                ? <>Onay sahibi <b>{user.fullName}</b> olarak oturumla doğrulanmıştır; rapora bu ad yazılır ve içerik SHA-256 ile mühürlenir. Bu, nitelikli elektronik imza (NES) değildir.</>
                : <>⚠ Uygulamada oturumsuz demo modundayız: bu onay kimlik doğrulaması yapmaz. Rapora yukarıdaki ad yazılır ve içerik SHA-256 ile mühürlenir; NES değildir.</>}
            </p>
            {error && <div className="mt-2 text-xs font-semibold text-rose-300">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { setDialog(false); setError(""); }} className="cursor-pointer rounded-lg border border-[#232e40] px-3.5 py-1.5 text-xs text-slate-300 hover:bg-[#1a2330]">İptal</button>
              <button disabled={busy || pending > 0 || missingReasons.length > 0 || !user.fullName.trim()} onClick={() => void save("approve")} className="cursor-pointer rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-40">{busy ? "Onaylanıyor…" : "✓ Onayla ve kilitle"}</button>
            </div>
            {pending > 0 && <div className="mt-2 text-[11px] text-amber-300">{pending} bulgu gözden geçirilmedi.</div>}
            {missingReasons.length > 0 && <div className="mt-2 text-[11px] text-rose-300">{missingReasons.length} bulgu için ret/düzenleme gerekçesi eksik; onay için gerekçe zorunlu.</div>}
          </div>
        </div>
      )}
      {letterOpen && (
        <PatientLetterModal
          source={{
            patientName: report.patientName,
            studyDate: report.studyDate,
            modality: report.modality,
            bodyPart: report.bodyPart,
            findingsText: report.findingsText,
            impression: report.impression,
            recommendation: report.recommendation,
            institution: report.institution,
            approvedBy: report.approvedBy,
            doctorTitle: report.doctorTitle,
            approved: report.status === "onaylandi",
          }}
          onClose={() => setLetterOpen(false)}
        />
      )}
    </div>
  );
}
