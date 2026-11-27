"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@/lib/types";
import { AUTH_LABELS, PACS_PRESETS, type PacsAuthType, type PacsConfig } from "@/lib/pacsPresets";
import {
  backupAge, backupState, formatBytes, formatMetricValue, maskShareToken, shareRemaining, shadowRows,
  summarizeChecks, type CheckLevel, type EnvCheck, type ParsedMetric,
} from "@/lib/adminHealth";
import { drReadiness, type DrillReport } from "@/lib/backupDrill";

type Tab = "profile" | "sessions" | "users" | "audit" | "ai" | "stats" | "security" | "integration" | "compliance" | "health" | "backup" | "sharing";
interface AuditRow { id: number; ts: string; username: string; action: string; entityType: string; entityId: string; details: string; hash: string }
interface UserRow { id: number; username: string; fullName: string; title: string; regNo: string; role: string; active: boolean; twoFactorEnabled: boolean; lastLoginAt: string | null }
interface SessionRow { id: string; userId: number; username: string; fullName: string; role: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null; ip: string; client: string; state: "aktif" | "suresi-dolmus" | "iptal-edilmis"; current: boolean }
interface RegistryRow { id?: number; name: string; version: string; modality: string; task: string; stage: "aday" | "aktif" | "emekli"; trafficPercent: number; fingerprint: string; notes: string; updatedAt?: string }
interface RegistryState { entries: RegistryRow[]; summary: Record<string, number>; issues: string[] }
interface PerfRow { engine: string; category: string; shown: number; approved: number; rejected: number; edited: number; pending: number; manualAdded: number; ppv: number | null }
interface AccessAnomalyRow { kind: string; key: string; actor: string; severity: "yuksek" | "orta" | "izle"; title: string; detail: string; count: number; windowMin: number | null; firstAt: string; lastAt: string; entityId?: string }
interface AccessAnomalyReport { generatedAt: string; windowDays: number; scannedAuditRows: number; scannedAttempts: number; anomalies: AccessAnomalyRow[]; alert: { total: number; high: number; sent: number }; note: string }

/** /api/admin/health yanıtı — tüm alanlar sunucudan; sır değeri taşınmaz. */
interface HealthOut {
  generatedAt: string;
  checks: EnvCheck[];
  summary: { ok: number; uyari: number; kritik: number; bilgi: number; total: number };
  health: { ready: boolean | null; live: boolean | null; error?: string };
  metrics: { ok: boolean; parsed: ParsedMetric[]; error?: string };
  /** Hız sınırı deposu (g-webhard): paylaşımlı mı, sağlığı ne? */
  rateStore?: {
    kind: "redis" | "memory";
    shared: boolean;
    warning: string | null;
    health: { ok: boolean; kind: "redis" | "memory"; detail: string } | null;
  };
  note: string;
}
/** Paylaşım bağlantısı satırı (sunucu `ShareRow`). */
interface ShareRowView {
  id: number; token: string; kind: string; reportId: number | null; createdByName: string;
  expiresAt: string; revokedAt: string | null; accessCount: number; lastAccessAt: string | null; createdAt: string;
}
interface ShadowRowView { engine: string; model: string; count: number; findings: number; firstAt: string | null; lastAt: string | null }

interface DisagreementCategory { engine: string; category: string; decided: number; approved: number; rejected: number; edited: number; disagreementRate: number | null }
interface DisagreementReason { engine: string; category: string; label: string; status: "reddedildi" | "duzenlendi"; reason: string }
interface ReasonClassDigest { cls: string; label: string; count: number }
interface DisagreementAlertInfo { total: number; sent: number; threshold: number; minDecided: number; reasonClasses: ReasonClassDigest[] }
/** Hekim geri bildirim döngüsü (a-feedback) — `GET /api/ai/feedback` yanıtı. */
interface FeedbackEngineRow {
  engine: string; shown: number; approved: number; rejected: number; edited: number; pending: number;
  missed: number; decidedAi: number; sensitivity: number | null; specificity: number | null;
  ppv: number | null; trueNegatives: number | null;
  sensitivityCI: [number, number] | null; ppvCI: [number, number] | null;
}
interface FeedbackCategoryRow {
  engine: string; category: string; shown: number; approved: number; rejected: number; edited: number;
  pending: number; decidedAi: number; ppv: number | null; ppvCI: [number, number] | null;
}
interface FeedbackReport {
  engines: FeedbackEngineRow[];
  rows: FeedbackCategoryRow[];
  falsePositives: { engine: string; category: string; label: string; reason: string; slice: number | null; studyRef: string | null; at: string | null; score: number | null }[];
  missed: { engine: string; category: string; label: string; slice: number | null; studyRef: string | null; at: string | null }[];
  totals: { aiShown: number; decided: number; approved: number; rejected: number; edited: number; missed: number; cleanStudies: number; sensitivity: number | null; specificity: number | null; ppv: number | null };
  thresholdCurve: { threshold: number; recall: number | null; precision: number | null; kept: number; dropped: number }[];
  suggestedThreshold: number | null; suggestedThresholdWhy: string;
  calibration?: CalibrationView;
  thresholds?: ThresholdView;
  lowConfidence?: LowConfRow[];
  warnings: string[]; note: string; generatedAt?: string;
  sample?: { reportsScanned: number; reportsApproved: number; findings: number; cleanStudies: number; limit: number };
  specificitySource?: string;
}

/** Kalibrasyon (a-uncert) — `GET /api/ai/feedback` içindeki `calibration`. */
interface CalibrationView {
  kind: "isotonic";
  blocks: { lo: number; hi: number; n: number; p: number }[];
  n: number; ok: boolean; reason: string; inSample: true; meanShift: number | null;
  ece: number | null; quality: "iyi" | "orta" | "zayif" | "bilinmiyor"; qualityNote: string;
  cases: number; minCases: number;
}
interface ThresholdView {
  chosen: { threshold: number; precision: number; recall: number; kept: number } | null;
  showAt: number; inspectAt: number; note: string;
}
interface LowConfRow {
  engine: string; category: string; label: string; raw: number; calibrated: number;
  why: string; slice: number | null; studyRef: string | null;
}

interface DisagreementStats {
  categories: DisagreementCategory[];
  reasons: DisagreementReason[];
  tally: { decided: number; rejected: number; edited: number; rate: number | null; withReason: number };
  alert?: DisagreementAlertInfo | null;
  alertError?: string | null;
}
interface WorkflowStats {
  total: number; byStatus: Record<string, number>; byModality: Record<string, number>;
  approved: number; medianHours: number | null; p90Hours: number | null; meanHours: number | null;
  pendingDrafts: number; staleDrafts: { olderDays: number; count: number };
  perRadiologist: { name: string; approved: number; medianHours: number | null; p90Hours: number | null }[];
}
interface WeekBucket { weekStart: string; label: string; approved: number; medianHours: number | null; p90Hours: number | null }
interface PeerScoreBucket { score: 1 | 2 | 3; label: string; count: number; pct: number }
interface PeerStats {
  total: number; agreementRate: number | null;
  byScore: PeerScoreBucket[];
  byDiscrepancy: { type: string; count: number }[];
  byReviewer: { name: string; count: number; disagreements: number; disagreementRate: number | null }[];
  needsFollowUp: { id: number; reportId: number; reviewedByName: string; note: string; createdAt: string }[];
  note: string;
}
interface PeerTarget { ratePct: number; expected: number; reviewed: number; remaining: number; met: boolean; note: string }
interface TatTarget { status: "hedef-icinde" | "sinirda" | "hedef-disi" | "bilinmiyor"; targetHours: number; ratio: number | null; note: string }
interface Status { keySource: string; plaintext: { studies: number; reports: number }; totals: Record<string, number>; retentionDraftDays: number }
type Settings = {
  retentionDraftDays: number;
  criticalWebhookUrl: string;
  /** Kritik bulgu kanalları: e-posta/SMS/çağrı/webhook (JSON dizi metni). */
  notifyChannels?: string;
  notifyChannelErrors?: string[];
  pacsBaseUrl: string;
  pacs: PacsForm;
  /** MWL ek uçları: ayrı DICOMweb MWL kökü ve/veya DIMSE C-FIND köprüsü. */
  pacsMwl?: { mwlRoot: string; dimseUrl: string };
  compliance: string;
  env: { llm: boolean; his: boolean; pacsAuth: boolean; keySource: string };
};
/** Sunucu sır alanlarını boş döndürür; varlıkları bu bayraklarla bildirir. */
type PacsForm = PacsConfig & { hasPassword: boolean; hasToken: boolean; hasHeader: boolean; hasClientKey: boolean };
type PacsTestOut = { ok: boolean; steps: { name: string; ok: boolean; http: number | null; ms: number; message: string }[] };

const COMPLIANCE = [
  { id: "intended", t: "Amaçlanan kullanım (intended use) belgesi", h: "Hangi modalite/endikasyon, hangi kullanıcı, karar desteği düzeyi." },
  { id: "class", t: "Tıbbi cihaz yazılımı sınıflandırması (AB MDR / TİTCK)", h: "Tanıyı etkileyen bilgi sağlayan yazılım genellikle düzenlemeye tabidir." },
  { id: "qms", t: "Kalite yönetim sistemi (ISO 13485)", h: "" },
  { id: "lifecycle", t: "Yazılım yaşam döngüsü (IEC 62304) ve sürüm yönetimi", h: "" },
  { id: "risk", t: "Risk yönetimi dosyası (ISO 14971)", h: "Otomasyon yanlılığı, yanlış negatif, veri bozulması." },
  { id: "clinical", t: "Klinik değerlendirme / performans çalışması", h: "Gölge mod + kendi verinizde duyarlılık/özgüllük (AI Performans sekmesi veri toplar)." },
  { id: "usability", t: "Kullanılabilirlik mühendisliği (IEC 62366)", h: "" },
  { id: "cyber", t: "Siber güvenlik: sızma testi, yedekleme, felaket kurtarma", h: "" },
  { id: "kvkk", t: "KVKK: VERBİS kaydı, aydınlatma metni, etki analizi", h: "/gizlilik şablonunu kurumunuza göre doldurun." },
  { id: "nes", t: "Nitelikli elektronik imza (NES) sağlayıcı entegrasyonu", h: "Mevcut onay parola ile yeniden doğrulamadır; NES değildir." },
  { id: "pacs", t: "PACS/HBYS bağlantı testleri (kurum ortamında)", h: "" },
  { id: "pms", t: "Satış sonrası gözetim ve olay bildirimi", h: "" },
];

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T }> {
  const r = await apiFetch(url, init);
  return { ok: r.ok, data: (await r.json().catch(() => ({}))) as T };
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
import { formatHours } from "@/lib/workflowStats";
import { apiFetch } from "@/lib/csrfClient";

const card = "rounded-xl border border-[var(--t30)] bg-[var(--t06)] p-4";
const input = "rounded-lg border border-[var(--t30)] bg-[var(--t10)] px-2.5 py-1.5 text-xs text-[var(--sl100)] focus:border-cyan-400/50 focus:outline-none";
const btn = "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold";
/** Paylaşım listesindeki süresi dolmuş bağlantılar için tek satır bilgi. */
function expiredHint(rows: { expiresAt: string; revokedAt: string | null }[]): string {
  const now = new Date();
  const n = rows.filter((r) => !r.revokedAt && new Date(r.expiresAt) <= now).length;
  return n > 0 ? `${n} bağlantının süresi dolmuş (kapatılmasa da erişilemez).` : "";
}

const LEVEL_STYLE: Record<CheckLevel, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-[var(--ac-emerald200)]",
  uyari: "border-amber-500/40 bg-amber-500/10 text-[var(--ac-amber200)]",
  kritik: "border-rose-500/50 bg-rose-500/10 text-[var(--ac-rose200)]",
  bilgi: "border-[var(--t32)] bg-[var(--t10)] text-[var(--sl300)]",
};
const LEVEL_LABEL: Record<CheckLevel, string> = { ok: "TAMAM", uyari: "UYARI", kritik: "KRİTİK", bilgi: "BİLGİ" };

export default function AdminPanel({ user }: { user: UserInfo }) {
  const [tab, setTab] = useState<Tab>("profile");
  const [msg, setMsg] = useState("");
  // Model kayıt defteri (a-modelops)
  const [registry, setRegistry] = useState<RegistryState | null>(null);
  const [regForm, setRegForm] = useState({ name: "", version: "", modality: "CT", task: "nodule", stage: "aday" as RegistryRow["stage"], trafficPercent: "0", notes: "" });
  const [regBusy, setRegBusy] = useState(false);
  const [notifyTesting, setNotifyTesting] = useState(false);
  const [notifyTest, setNotifyTest] = useState<{ results: { id: string; kind: string; ok: boolean; status: number | null; ms: number; error?: string }[] } | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };
  const loadRegistry = useCallback(async () => {
    const r = await api<RegistryState>("/api/ai/registry");
    if (r.ok) setRegistry(r.data);
  }, []);

  // hekim profili (rapor imzasında görünecek ad)
  const [prof, setProf] = useState({ fullName: user.fullName, title: user.title, regNo: user.regNo });
  const loadProfile = useCallback(async () => {
    const r = await api<{ user: UserInfo }>("/api/profile");
    if (r.ok && r.data.user) setProf({ fullName: r.data.user.fullName, title: r.data.user.title, regNo: r.data.user.regNo });
  }, []);
  // denetim
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [aq, setAq] = useState("");
  const [chain, setChain] = useState<{ ok: boolean; count: number; brokenAtId?: number; reason?: string } | null>(null);
  const [siem, setSiem] = useState<{ pending: number; failed: number; sent: number; abandoned: number; configured: boolean; maxAttempts: number } | null>(null);
  const [siemMsg, setSiemMsg] = useState("");
  const loadAudit = useCallback(async () => { const r = await api<AuditRow[]>(`/api/audit?limit=300&q=${encodeURIComponent(aq)}`); if (r.ok) setAudit(r.data); }, [aq]);
  const loadSiem = useCallback(async () => { const r = await api<{ pending: number; failed: number; sent: number; abandoned: number; configured: boolean; maxAttempts: number }>("/api/audit/export?siem=stats"); if (r.ok) setSiem(r.data); }, []);
  // AI
  const [perf, setPerf] = useState<{ rows: PerfRow[]; note: string; disagreement?: DisagreementStats } | null>(null);
  const [fb, setFb] = useState<FeedbackReport | null>(null);
  const [fbError, setFbError] = useState("");
  // Sistem sağlığı (g-metrics + ortam denetimi) — Yönetim → Sağlık
  const [health, setHealth] = useState<HealthOut | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthErr, setHealthErr] = useState("");
  const loadHealth = useCallback(async () => {
    setHealthBusy(true); setHealthErr("");
    const r = await api<HealthOut & { error?: string }>("/api/admin/health");
    if (r.ok) setHealth(r.data);
    else setHealthErr(r.data?.error ?? "Sistem sağlığı okunamadı");
    setHealthBusy(false);
  }, []);
  // Yedekleme / DR tatbikatı — Yönetim → Yedekleme
  const [drill, setDrill] = useState<{ last: (DrillReport & { at: string; summary: string }) | null; readiness: { level: CheckLevel; text: string }; store: string } | null>(null);
  const [drillBusy, setDrillBusy] = useState(false);
  const [drillOut, setDrillOut] = useState<DrillReport | null>(null);
  const [drillErr, setDrillErr] = useState("");
  const loadDrill = useCallback(async () => {
    const r = await api<{ last: (DrillReport & { at: string }) | null; readiness: { level: CheckLevel; text: string }; store: string; error?: string }>("/api/admin/backup/drill");
    if (r.ok) setDrill({ last: r.data.last, readiness: r.data.readiness, store: r.data.store });
  }, []);
  const runDrillNow = async (restoreTrial: boolean) => {
    setDrillBusy(true); setDrillErr(""); setDrillOut(null);
    const r = await api<{ ok: boolean; report: DrillReport; readiness: { level: CheckLevel; text: string }; error?: string }>("/api/admin/backup/drill", json("POST", { restoreTrial }));
    setDrillBusy(false);
    if (!r.ok) { setDrillErr(r.data?.error ?? "Tatbikat koşulamadı"); return; }
    setDrillOut(r.data.report);
    flash(r.data.report.ok ? "Tatbikat başarılı: yedek geri yüklenebilir." : "Tatbikat HATALI — ayrıntı ekranda.");
    await loadDrill();
  };
  // Paylaşım bağlantıları — Yönetim → Paylaşım
  const [shares, setShares] = useState<ShareRowView[]>([]);
  const [sharesErr, setSharesErr] = useState("");
  const [shareBusy, setShareBusy] = useState("");
  const loadShares = useCallback(async () => {
    setSharesErr("");
    const r = await api<{ shares: ShareRowView[]; error?: string }>("/api/shares");
    if (r.ok) setShares(r.data.shares ?? []);
    else setSharesErr(r.data?.error ?? "Paylaşım bağlantıları okunamadı");
  }, []);
  const revokeShareNow = async (token: string) => {
    setShareBusy(token);
    const r = await api<{ ok?: boolean; error?: string }>(`/api/shares/${token}`, { method: "DELETE" });
    setShareBusy("");
    flash(r.ok ? "Paylaşım bağlantısı kapatıldı." : r.data?.error ?? "Bağlantı kapatılamadı");
    await loadShares();
  };
  // Gölge mod özeti (t-validation) — Yönetim → AI sekmesindeki kart
  const [shadow, setShadow] = useState<{ total: number; summary: ShadowRowView[]; error?: string } | null>(null);
  const loadShadow = useCallback(async () => {
    const r = await api<{ total: number; summary: ShadowRowView[]; error?: string }>("/api/shadow/summary");
    if (r.ok) setShadow({ total: r.data.total ?? 0, summary: r.data.summary ?? [] });
    else setShadow({ total: 0, summary: [], error: r.data?.error ?? "Gölge mod özeti alınamadı" });
  }, []);
  // iş akışı istatistikleri (F4)
  const [stats, setStats] = useState<WorkflowStats | null>(null);
  const [statsNote, setStatsNote] = useState("");
  // Haftalık TAT trendi ve hedef eşiği (f-tat)
  const [weekly, setWeekly] = useState<WeekBucket[]>([]);
  const [tatTargetState, setTatTargetState] = useState<TatTarget | null>(null);
  const [tatAlertList, setTatAlertList] = useState<string[]>([]);
  const [targetHours, setTargetHours] = useState("24");
  const [trendModality, setTrendModality] = useState("");
  // İkinci okuma gözetim panosu (d-peer)
  const [peer, setPeer] = useState<{ stats: PeerStats; target: PeerTarget; samplePct: number; approvedReports: number; queue: number[]; note: string } | null>(null);
  const [peerPct, setPeerPct] = useState("5");
  const targetHoursRef = useRef("24");
  const trendModalityRef = useRef("");
  useEffect(() => { targetHoursRef.current = targetHours; }, [targetHours]);
  useEffect(() => { trendModalityRef.current = trendModality; }, [trendModality]);
  const loadStats = useCallback(async (target = "24", modality = "") => {
    const params = new URLSearchParams();
    if (Number(target) > 0) params.set("targetHours", target);
    if (modality) params.set("modality", modality);
    const q = params.toString() ? `?${params.toString()}` : "";
    const r = await api<{ stats: WorkflowStats; note: string; weekly?: WeekBucket[]; target?: TatTarget; alerts?: string[] }>(`/api/reports/stats${q}`);
    if (r.ok && r.data.stats) {
      setStats(r.data.stats);
      setStatsNote(r.data.note);
      setWeekly(r.data.weekly ?? []);
      setTatTargetState(r.data.target ?? null);
      setTatAlertList(r.data.alerts ?? []);
    }
  }, []);
  const loadPeer = useCallback(async () => {
    const r = await api<{ stats: PeerStats; target: PeerTarget; samplePct: number; approvedReports: number; queue: number[]; note: string }>("/api/reports/peer-stats");
    if (r.ok) { setPeer(r.data); setPeerPct(String(r.data.samplePct ?? 5)); }
  }, []);
  // güvenlik / ayarlar
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [comp, setComp] = useState<Record<string, string>>({});
  // PACS formu (ayarlar ayrı state'te tutulur ki test/Kaydet sırasında elle düzenler kaybolmasın)
  const [pacs, setPacs] = useState<PacsForm | null>(null);
  const [pacsHint, setPacsHint] = useState("");
  // Anahtar halkası (g-kms): kimlikler + rotasyon durumu; `newKey` yalnız bir kez gösterilir.
  const [keyring, setKeyring] = useState<{ current: string; keys: { kid: string; since: string; current: boolean }[]; rotation: { summary: string; pending: number } } | null>(null);
  const [newKey, setNewKey] = useState<{ key: string; kid: string; dataEncryptionKeys: string } | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [mwlEndpoints, setMwlEndpoints] = useState<{ mwlRoot: string; dimseUrl: string }>({ mwlRoot: "", dimseUrl: "" });
  const [pacsTest, setPacsTest] = useState<PacsTestOut | null>(null);
  const [pacsTesting, setPacsTesting] = useState(false);
  // kullanıcı hesapları (F1) ve MFA kurulumu (F2)
  const [userList, setUserList] = useState<UserRow[]>([]);
  const [userMsg, setUserMsg] = useState("");
  const [showUserForm, setShowUserForm] = useState(false);
  const [userForm, setUserForm] = useState({ username: "", fullName: "", title: "", regNo: "", role: "radyolog", password: "" });
  const [mfa, setMfa] = useState<{ enabled: boolean; secret?: string; qr?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const userFlash = (m: string) => { setUserMsg(m); setTimeout(() => setUserMsg(""), 4500); };
  const loadSettings = useCallback(async () => {
    const [s, st] = await Promise.all([api<Settings>("/api/settings"), api<Status>("/api/admin/status")]);
    if (s.ok) {
      setSettings(s.data);
      setPacs(s.data.pacs);
      setMwlEndpoints(s.data.pacsMwl ?? { mwlRoot: "", dimseUrl: "" });
      try { setComp(JSON.parse(s.data.compliance || "{}")); } catch { setComp({}); }
    }
    if (st.ok) setStatus(st.data);
  }, []);

  const loadUsers = useCallback(async () => {
    const r = await api<{ users: UserRow[] }>("/api/users");
    if (r.ok) setUserList(r.data.users);
  }, []);
  const loadKeyring = useCallback(async () => {
    const r = await api<{ current: string; keys: { kid: string; since: string; current: boolean }[]; rotation: { summary: string; pending: number } }>("/api/admin/keyring");
    if (r.ok) setKeyring(r.data);
  }, []);
  // Erişim anomalileri (KVKK): son 7 günün denetim + giriş denemesi taraması
  const [anomaly, setAnomaly] = useState<AccessAnomalyReport | null>(null);
  const [anomalyBusy, setAnomalyBusy] = useState(false);
  const [anomalyError, setAnomalyError] = useState("");
  const loadAnomalies = useCallback(async () => {
    setAnomalyBusy(true);
    setAnomalyError("");
    const r = await api<AccessAnomalyReport & { error?: string }>("/api/security/access-anomaly");
    if (r.ok) setAnomaly(r.data);
    else setAnomalyError(r.data?.error ?? "Erişim anomalisi raporu alınamadı");
    setAnomalyBusy(false);
  }, []);

  // oturum yönetimi (w-auth): açık oturumlar, bu cihaz işareti, iptal
  const [sessRows, setSessRows] = useState<SessionRow[]>([]);
  const [sessAll, setSessAll] = useState(false);
  const [sessMsg, setSessMsg] = useState("");
  const [sessSupported, setSessSupported] = useState(true);
  const loadSessions = useCallback(async () => {
    const r = await api<{ supported: boolean; sessions: SessionRow[]; note?: string }>(`/api/auth/sessions?history=1&scope=${sessAll ? "all" : "own"}`);
    if (r.ok) {
      setSessRows(r.data.sessions ?? []);
      setSessSupported(r.data.supported !== false);
      if (r.data.note) setSessMsg(r.data.note);
    }
  }, [sessAll]);
  const sessionAction = async (body: Record<string, unknown>) => {
    const r = await api<{ ok?: boolean; revoked?: number; deleted?: number; error?: string }>("/api/auth/sessions", json("POST", body));
    setSessMsg(r.ok ? `İşlem tamam: ${r.data.revoked ?? r.data.deleted ?? 0} oturum kapatıldı.` : r.data.error ?? "Hata");
    void loadSessions();
  };

  const loadMfa = useCallback(async () => {
    const r = await api<{ enabled: boolean; secret?: string; qr?: string }>("/api/profile/totp");
    if (r.ok) setMfa({ enabled: r.data.enabled });
  }, []);

  useEffect(() => {
    void (async () => {
      if (tab === "profile") { await loadProfile(); await loadMfa(); }
      if (tab === "sessions") await loadSessions();
      if (tab === "users") await loadUsers();
      if (tab === "audit") { await loadAudit(); await loadSiem(); }
      if (tab === "ai") {
        const r = await api<{ rows: PerfRow[]; note: string; disagreement?: DisagreementStats }>("/api/ai/performance");
        if (r.ok) setPerf(r.data);
        // Duyarlılık/özgüllük + yanlış pozitif listesi (a-feedback). Ayrı uç: pano yükü büyümesin.
        const f = await api<FeedbackReport>("/api/ai/feedback");
        if (f.ok) { setFb(f.data); setFbError(""); }
        else setFbError((f.data as unknown as { error?: string })?.error ?? "Geri bildirim özeti alınamadı.");

        await loadRegistry();
        await loadShadow();
      }
      if (tab === "health") await loadHealth();
      if (tab === "backup") await loadDrill();
      if (tab === "sharing") await loadShares();
      if (tab === "stats") { await loadStats(targetHoursRef.current, trendModalityRef.current); await loadPeer(); }
      if (["security", "integration", "compliance"].includes(tab)) await loadSettings();
      if (tab === "security") { await loadKeyring(); await loadAnomalies(); }
    })();
  }, [tab, loadProfile, loadAudit, loadSiem, loadStats, loadSettings, loadUsers, loadMfa, loadKeyring, loadSessions, loadRegistry, loadPeer, loadAnomalies, loadHealth, loadDrill, loadShares, loadShadow]);

  const saveSettings = async (patch: Record<string, unknown>) => {
    const r = await api<{ error?: string }>("/api/settings", json("PUT", patch));
    flash(r.ok ? "Kaydedildi" : r.data.error ?? "Hata");
    void loadSettings();
  };

  // PACS: formu sunucuya yazar, ardından depolanmış ayarla bağlantı testi çalıştırır.
  const pacsPayload = (c: PacsForm) => ({
    name: c.name,
    kind: c.kind,
    qidoRoot: c.qidoRoot.trim(),
    wadoRoot: c.wadoRoot.trim(),
    allowSelfSigned: c.allowSelfSigned,
    limit: c.limit,
    includefield: c.includefield,
    notes: c.notes,
    auth: { type: c.auth.type, username: c.auth.username, password: c.auth.password, token: c.auth.token, headerName: c.auth.headerName, headerValue: c.auth.headerValue },
    tls: { caPem: c.tls.caPem, clientCertPem: c.tls.clientCertPem, clientKeyPem: c.tls.clientKeyPem },
  });

  const savePacs = async (): Promise<boolean> => {
    if (!pacs) return false;
    const r = await api<{ error?: string }>("/api/settings", json("PUT", { pacs: pacsPayload(pacs), pacsMwl: mwlEndpoints }));
    if (!r.ok) { flash(r.data.error ?? "PACS kaydedilemedi"); return false; }
    flash("PACS kaydedildi");
    return true;
  };

  const testPacs = async () => {
    if (!pacs) return;
    setPacsTesting(true);
    setPacsTest(null);
    if (!(await savePacs())) { setPacsTesting(false); return; }
    const r = await api<PacsTestOut & { error?: string }>("/api/pacs/test");
    setPacsTest(
      r.ok
        ? r.data
        : { ok: false, steps: [{ name: "Test", ok: false, http: null, ms: 0, message: r.data.error ?? "Test çalıştırılamadı" }] },
    );
    setPacsTesting(false);
  };
  const saveProfile = async () => {
    const r = await api<{ error?: string }>("/api/profile", json("PATCH", prof));
    flash(r.ok ? "Profil kaydedildi" : r.data.error ?? "Hata");
    void loadProfile();
  };

  // ── Kullanıcı hesapları (F1) ────────────────────────────────────────────────
  const createUser = async () => {
    const r = await api<{ ok?: boolean; id?: number; error?: string }>("/api/users", json("POST", userForm));
    if (!r.ok) { userFlash(r.data.error ?? "Kullanıcı oluşturulamadı"); return; }
    userFlash(`Kullanıcı oluşturuldu (#${r.data.id}).`);
    setUserForm({ username: "", fullName: "", title: "", regNo: "", role: "radyolog", password: "" });
    setShowUserForm(false);
    void loadUsers();
  };
  const patchUser = async (u: UserRow, patch: Record<string, unknown>) => {
    const r = await api<{ ok?: boolean; error?: string }>("/api/users", json("PATCH", { id: u.id, ...patch }));
    userFlash(r.ok ? "Kaydedildi" : r.data.error ?? "Hata");
    void loadUsers();
  };

  // ── MFA kurulumu (F2) ───────────────────────────────────────────────────────
  const startMfa = async () => {
    const r = await api<{ secret?: string; qr?: string }>("/api/profile/totp");
    if (r.ok && r.data.secret) setMfa({ enabled: false, secret: r.data.secret, qr: r.data.qr });
  };
  const enableMfa = async () => {
    if (!mfa?.secret) return;
    setMfaBusy(true);
    const r = await api<{ ok?: boolean; error?: string }>("/api/profile/totp", json("POST", { secret: mfa.secret, code: mfaCode }));
    setMfaBusy(false);
    if (!r.ok) { userFlash(r.data.error ?? "Kod doğrulanamadı"); return; }
    userFlash("İki faktörlü doğrulama açıldı.");
    setMfaCode("");
    void loadMfa();
  };
  const disableMfa = async () => {
    const r = await api<{ ok?: boolean; error?: string }>("/api/profile/totp", { method: "DELETE" });
    userFlash(r.ok ? "İki faktörlü doğrulama kapatıldı" : r.data.error ?? "Hata");
    void loadMfa();
  };

  // Denetim kaydını (ekrandaki filtreli/sınırlı liste) CSV olarak indir
  const exportAuditCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const head = ["#", "Zaman", "Kullanıcı", "İşlem", "Kayıt", "Ayrıntı", "Hash"];
    const rows = audit.map((a) => [
      String(a.id),
      new Date(a.ts).toLocaleString("tr-TR"),
      a.username,
      a.action,
      `${a.entityType}${a.entityId ? `#${a.entityId}` : ""}`,
      a.details,
      a.hash,
    ].map(esc).join(","));
    const csv = "\ufeff" + [head.map(esc).join(","), ...rows].join("\r\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    el.download = `denetim-kaydi-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(el.href), 3000);
    flash(`CSV indirildi (${audit.length} kayıt${aq ? ", filtreli" : ""}). Tüm geçmiş için arama kutusunu boş bırakıp yenileyin.`);
  };

  const tabs: [Tab, string][] = [["profile", "Profil & MFA"], ["sessions", "Oturumlar"], ["users", "Kullanıcılar"], ["audit", "Denetim kaydı"], ["ai", "AI performans"], ["stats", "İş akışı"], ["security", "Güvenlik & saklama"], ["backup", "Yedekleme & DR"], ["sharing", "Paylaşım"], ["health", "Sistem sağlığı"], ["integration", "Entegrasyon"], ["compliance", "Uyum"]];

  const savePeerPct = async () => {
    const n = Number(peerPct);
    if (!Number.isFinite(n)) { flash("Örneklem oranı sayı olmalı."); return; }
    await saveSettings({ peerReviewSamplePct: Math.max(0, Math.min(100, Math.round(n))) });
    await loadPeer();
  };

  const saveModel = async () => {
    setRegBusy(true);
    const r = await api<RegistryState & { error?: string }>("/api/ai/registry", json("POST", {
      ...regForm,
      trafficPercent: Number(regForm.trafficPercent.replace(",", ".")),
    }));
    setRegBusy(false);
    if (!r.ok) { flash(r.data?.error ?? "Model kaydı başarısız."); return; }
    setRegistry({ entries: r.data.entries ?? [], summary: r.data.summary ?? {}, issues: r.data.issues ?? [] });
    flash(`${regForm.name} ${regForm.version} kaydedildi (${regForm.stage}).`);
  };

  return (
    <div className="doc-page min-h-dvh w-full bg-[var(--t02)] text-[var(--sl200)]">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--t25)] bg-[var(--t05)]/95 px-5 py-3 backdrop-blur print:hidden">
        <Link href="/" className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-[var(--ac-cyan300)] hover:bg-cyan-500/20">← Görüntüleyici</Link>
        <h1 className="font-mono text-sm font-black tracking-[0.15em] text-[var(--sl100)]">ATIK<span className="text-[var(--ac-cyan400)]">VIEWER</span> · YÖNETİM</h1>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-xs text-[var(--sl400)]" title={`Rol: ${user.role}`}>{user.title} {user.fullName} · <span className="font-mono text-[10px] text-[var(--sl500)]">{user.role}</span></span>
          <Link href="/resimlianlatim" prefetch={false} className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-[var(--ac-cyan300)] hover:bg-cyan-500/20" title="Resimli anlatım: adım adım görsel kullanım kılavuzu">🖼 Kılavuz</Link>
          <button className={`${btn} border border-rose-400/40 text-[var(--ac-rose300)] hover:bg-rose-400/10`} onClick={() => void apiFetch("/api/auth/logout", { method: "POST" }).finally(() => { window.location.reload(); })}>⎋ Çıkış</button>
        </span>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">
        <div className="flex flex-wrap gap-1.5 print:hidden">
          {tabs.map(([id, l]) => <button key={id} onClick={() => setTab(id)} className={`${btn} ${tab === id ? "bg-cyan-400/15 text-[var(--ac-cyan300)] ring-1 ring-cyan-400/40" : "text-[var(--sl400)] hover:text-[var(--sl200)]"}`}>{l}</button>)}
        </div>
        {msg && <div className="mt-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-[var(--ac-cyan200)]">{msg}</div>}

        {tab === "profile" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Profil — hekim bilgileri</h2>
              <p className="mt-2 text-xs leading-relaxed text-[var(--sl400)]">
                Bu bilgiler onaylanan raporların imza satırına yazılır. Hesabınız oturumla
                bağlıdır; bu ad raporlarda kimliğinizi temsil eder.
              </p>
              <div className="mt-3 grid gap-2">
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Ad soyad
                  <input value={prof.fullName} onChange={(e) => setProf({ ...prof, fullName: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Ayşe Kaya" />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-semibold text-[var(--sl400)]">Unvan
                    <input value={prof.title} onChange={(e) => setProf({ ...prof, title: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Uzm. Dr." />
                  </label>
                  <label className="text-[11px] font-semibold text-[var(--sl400)]">Sicil / diploma no
                    <input value={prof.regNo} onChange={(e) => setProf({ ...prof, regNo: e.target.value })} className={`${input} mt-1 w-full`} placeholder="148291" />
                  </label>
                </div>
              </div>
              <button className={`${btn} mt-3 bg-cyan-500 text-[var(--sl950)]`} onClick={() => void saveProfile()}>Kaydet</button>
              <div className="mt-3 rounded-lg border border-[var(--t34)] bg-[var(--t10)] p-2.5 text-xs">
                <div className="text-[10px] uppercase tracking-widest text-[var(--sl500)]">Rapordaki görünüm</div>
                <div className="mt-1 font-semibold text-[var(--sl100)]">{prof.title} {prof.fullName || "(ad girilmedi)"}</div>
                <div className="text-[var(--sl400)]">Sicil/diploma: {prof.regNo || "—"}</div>
              </div>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--ac-emerald300)]">İki faktörlü doğrulama (MFA)</h2>
              <p className="mt-2 text-xs leading-relaxed text-[var(--sl400)]">
                Girişe ek olarak, authenticator uygulamasındaki zaman tabanlı kod (TOTP) istenir.
                Yönetici hesapları için MFA <b>zorunlu</b>dur
                {` (${process.env.REQUIRE_TOTP_FOR_ROLES ?? "yonetici"})`}.
              </p>
              {userMsg && tab === "profile" && <div className="mt-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-[var(--ac-cyan200)]">{userMsg}</div>}
              {!mfa && <p className="mt-3 text-xs text-[var(--sl500)]">Durum yüklenmedi.</p>}
              {mfa?.enabled && (
                <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-[var(--ac-emerald200)]">
                  ✓ MFA açık. Girişlerde kod istenir.
                  <button className={`${btn} mt-2 border border-rose-400/40 text-[var(--ac-rose300)] hover:bg-rose-400/10`} onClick={() => void disableMfa()}>MFA&apos;yı kapat</button>
                </div>
              )}
              {!mfa?.enabled && !mfa?.qr && (
                <button className={`${btn} mt-3 bg-emerald-500 text-[var(--sl950)]`} onClick={() => void startMfa()}>MFA kurulumunu başlat</button>
              )}
              {!mfa?.enabled && mfa?.qr && (
                <div className="mt-3 space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- QR kod önceden üretilmiş veri URL'si; statik dosya değil */}
                  <img src={mfa.qr} alt="MFA QR kodu" className="h-40 w-40 rounded-lg border border-[var(--t34)] bg-white p-1" />
                  <p className="font-mono text-[10px] break-all text-[var(--sl400)]">{mfa.secret}</p>
                  <label className="block text-[11px] font-semibold text-[var(--sl400)]">Doğrulama kodu
                    <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\s/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={`${input} mt-1 w-40 tracking-[0.4em]`} placeholder="000000" />
                  </label>
                  <div className="flex gap-2">
                    <button className={`${btn} bg-emerald-500 text-[var(--sl950)] disabled:opacity-40`} disabled={mfaBusy || mfaCode.length !== 6} onClick={() => void enableMfa()}>Doğrula ve aç</button>
                    <button className={`${btn} border border-[var(--sl400)]/40 text-[var(--sl300)]`} onClick={() => setMfa({ enabled: false })}>Vazgeç</button>
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-[var(--sl500)]">Rapor onayı hâlâ kimlik kanıtı değildir; içerik SHA-256 ile mühürlenir, denetim zinciri değişikliği saptar.</p>
            </div>
          </div>
        )}

        {tab === "sessions" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} flex flex-wrap items-center gap-2`}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Açık oturumlar</h2>
              <p className="w-full text-[11px] leading-relaxed text-[var(--sl400)]">
                Her giriş sunucuda bir oturum kaydı oluşturur; buradan kapatılan oturumun çerezi
                süresi dolmamış olsa bile <b>anında geçersiz</b> olur. Liste yalnız IP, istemci ve zaman gösterir — oturum anahtarı hiçbir zaman dışarı verilmez.
              </p>
              <label className="flex items-center gap-1 text-[11px] text-[var(--sl400)]">
                <input type="checkbox" checked={sessAll} onChange={(e) => setSessAll(e.target.checked)} disabled={user.role !== "yonetici"} /> tüm kullanıcıların oturumları (yönetici)
              </label>
              <button className={`${btn} ml-auto border border-[var(--sl500)]/40 text-[var(--sl300)]`} onClick={() => void loadSessions()}>↻ Yenile</button>
            </div>
            {sessMsg && <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-[var(--ac-cyan200)]">{sessMsg}</div>}
            {!sessSupported && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-[var(--ac-amber200)]">
                Sunucu tarafı oturum kaydı etkin değil. Şemayı uygulayın: <code>npx drizzle-kit push</code>. O zamana kadar oturumlar yalnız imzalı çerezle taşınır.
              </div>
            )}
            {sessSupported && sessRows.length === 0 && <p className="text-xs text-[var(--sl500)]">Kayıtlı oturum yok.</p>}
            {sessSupported && sessRows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-[var(--t25)]">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-[var(--t10)] text-[var(--sl400)]">
                    <tr>
                      <th className="px-2 py-1.5">Kullanıcı</th><th className="px-2 py-1.5">İstemci</th><th className="px-2 py-1.5">IP</th>
                      <th className="px-2 py-1.5">Başlangıç</th><th className="px-2 py-1.5">Son görülme</th><th className="px-2 py-1.5">Bitiş</th>
                      <th className="px-2 py-1.5">Durum</th><th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {sessRows.map((r) => (
                      <tr key={r.id} className={`border-t border-[var(--t21)] ${r.current ? "bg-cyan-400/5" : ""}`}>
                        <td className="px-2 py-1.5">{r.fullName}<div className="text-[10px] text-[var(--sl500)]">{r.username} · {r.role}</div></td>
                        <td className="px-2 py-1.5 text-[var(--sl400)]">{r.client}</td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-[var(--sl500)]">{r.ip || "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--sl400)]">{new Date(r.createdAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5 text-[var(--sl400)]">{new Date(r.lastSeenAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5 text-[var(--sl400)]">{new Date(r.expiresAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5">
                          <span className={r.state === "aktif" ? "text-[var(--ac-emerald300)]" : r.state === "iptal-edilmis" ? "text-[var(--ac-rose300)]" : "text-[var(--sl500)]"}>
                            {r.state === "aktif" ? "aktif" : r.state === "iptal-edilmis" ? "iptal edildi" : "süresi doldu"}
                          </span>
                          {r.current && <span className="ml-1 rounded bg-cyan-400/20 px-1 text-[9px] text-[var(--ac-cyan200)]">bu cihaz</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {r.state === "aktif" && (
                            <button className={`${btn} border border-rose-400/40 px-2 py-0.5 text-[var(--ac-rose300)] hover:bg-rose-400/10`} onClick={() => void sessionAction({ action: "revoke", id: Number(r.id) })}>
                              {r.current ? "Bu cihazı kapat" : "Kapat"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sessSupported && (
              <div className="flex flex-wrap gap-2">
                <button className={`${btn} border border-amber-400/40 text-[var(--ac-amber300)] hover:bg-amber-400/10`} onClick={() => void sessionAction({ action: "revoke-others" })}>Bu cihaz dışındaki tüm oturumlarımı kapat</button>
                <button className={`${btn} border border-[var(--sl500)]/40 text-[var(--sl300)]`} onClick={() => void sessionAction({ action: "purge-expired" })}>Süresi dolmuş kayıtları temizle (90 gün)</button>
              </div>
            )}
          </div>
        )}

        {tab === "users" && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-[var(--sl100)]">Kullanıcı hesapları ve roller</h2>
              <button className={`${btn} ml-auto bg-cyan-500 text-[var(--sl950)]`} onClick={() => setShowUserForm((v) => !v)}>+ Yeni kullanıcı</button>
            </div>
            {userMsg && <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-[var(--ac-cyan200)]">{userMsg}</div>}
            {showUserForm && (
              <div className={`${card} grid gap-2 sm:grid-cols-2 lg:grid-cols-3`}>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Kullanıcı adı
                  <input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} className={`${input} mt-1 w-full`} placeholder="ornek.doktor" />
                </label>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Ad soyad
                  <input value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Ayşe Kaya" />
                </label>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Unvan
                  <input value={userForm.title} onChange={(e) => setUserForm({ ...userForm, title: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Uzm. Dr." />
                </label>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Sicil
                  <input value={userForm.regNo} onChange={(e) => setUserForm({ ...userForm, regNo: e.target.value })} className={`${input} mt-1 w-full`} />
                </label>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Rol
                  <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })} className={`${input} mt-1 w-full`}>
                    <option value="radyolog">radyolog</option>
                    <option value="teknisyen">teknisyen</option>
                    <option value="yonetici">yonetici</option>
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-[var(--sl400)]">Parola (en az 8, harf+rakam)
                  <input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} className={`${input} mt-1 w-full`} />
                </label>
                <div className="sm:col-span-2 lg:col-span-3">
                  <button className={`${btn} bg-cyan-500 text-[var(--sl950)] disabled:opacity-40`} disabled={!userForm.username.trim() || userForm.fullName.trim().length < 3 || userForm.password.length < 8} onClick={() => void createUser()}>Oluştur</button>
                </div>
              </div>
            )}
            <div className={`${card} overflow-x-auto p-0`}>
              <table className="w-full text-[11px]">
                <thead className="bg-[var(--t06)] text-left text-[var(--sl500)]"><tr>{["#", "Kullanıcı", "Ad soyad", "Rol", "MFA", "Son giriş", "Durum", ""].map((h) => <th key={h} className="border-b border-[var(--t25)] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {userList.map((u) => (
                    <tr key={u.id} className="hover:bg-[var(--t14)]">
                      <td className="px-3 py-2 font-mono text-[var(--sl500)]">{u.id}</td>
                      <td className="px-3 py-2 text-[var(--sl200)]">{u.username}{u.id === user.id ? " (siz)" : ""}</td>
                      <td className="px-3 py-2 text-[var(--sl300)]">{[u.title, u.fullName].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2">
                        <select value={u.role} onChange={(e) => void patchUser(u, { role: e.target.value })} className="rounded border border-[var(--t30)] bg-[var(--t10)] px-1.5 py-1 text-[10.5px] text-[var(--sl100)]">
                          <option value="radyolog">radyolog</option><option value="teknisyen">teknisyen</option><option value="yonetici">yonetici</option>
                        </select>
                      </td>
                      <td className={`px-3 py-2 ${u.twoFactorEnabled ? "text-[var(--ac-emerald300)]" : "text-[var(--sl500)]"}`}>{u.twoFactorEnabled ? "açık" : "kapalı"}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-[var(--sl500)]">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("tr-TR") : "—"}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => void patchUser(u, { active: !u.active })} className={`${btn} border ${u.active ? "border-rose-400/40 text-[var(--ac-rose300)] hover:bg-rose-400/10" : "border-emerald-400/40 text-[var(--ac-emerald300)] hover:bg-emerald-400/10"}`}>{u.active ? "Pasif yap" : "Etkinleştir"}</button>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => { const p = window.prompt("Yeni parola (en az 8 karakter, harf+rakam):"); if (p) void patchUser(u, { password: p }); }} className={`${btn} border border-[var(--sl400)]/40 text-[var(--sl300)] hover:bg-[var(--sl400)]/10`}>Parola sıfırla</button>
                      </td>
                    </tr>
                  ))}
                  {userList.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--sl500)]">Kullanıcı yok.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <input value={aq} onChange={(e) => setAq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void loadAudit()} placeholder="Ara: kullanıcı, işlem, kayıt…" className={`${input} w-72`} />
              <button className={`${btn} bg-cyan-500 text-[var(--sl950)]`} onClick={() => void loadAudit()}>Ara</button>
              <button className={`${btn} border border-emerald-400/40 text-[var(--ac-emerald300)] hover:bg-emerald-400/10`} onClick={async () => { const r = await api<{ ok: boolean; count: number; brokenAtId?: number; reason?: string }>("/api/audit?verify=1"); setChain(r.data); }}>🔗 Hash zincirini doğrula</button>
              <button className={`${btn} border border-[var(--sl400)]/40 text-[var(--sl200)] hover:bg-[var(--sl400)]/10`} title="Ekrandaki filtreli listeyi CSV olarak indir" onClick={exportAuditCsv}>⬇ CSV</button>
              <button className={`${btn} border border-violet-400/40 text-[var(--ac-violet200)] hover:bg-violet-400/10`} title="SIEM kuyruğunu şimdi boşalt (AUDIT_SIEM_URL gerekir)" onClick={async () => { const r = await api<{ configured: boolean; tried: number; sent: number; failed: number; error?: string }>("/api/audit/export", json("POST", {})); setSiemMsg(r.ok ? (r.data.configured ? `SIEM: ${r.data.sent}/${r.data.tried} gönderildi${r.data.failed ? `, ${r.data.failed} başarısız` : ""}${r.data.error ? ` (${r.data.error})` : ""}` : "AUDIT_SIEM_URL tanımlı değil — olaylar kuyrukta birikiyor.") : "Kuyruk boşaltılamadı (yönetici yetkisi gerekir)"); void loadSiem(); }}>📡 SIEM kuyruğu</button>
              <button className={`${btn} border border-[var(--sl400)]/40 text-[var(--sl200)] hover:bg-[var(--sl400)]/10`} title="Yazdırma penceresinden 'PDF olarak kaydet' seçin" onClick={() => { document.body.classList.add("print-audit"); window.addEventListener("afterprint", () => document.body.classList.remove("print-audit"), { once: true }); window.print(); }}>🖨 PDF</button>
            </div>
            {siem && (
              <p className="text-[11px] text-[var(--sl400)]">
                SIEM teslimatı: {siem.configured ? <b className="text-[var(--ac-emerald300)]">etkin (AUDIT_SIEM_URL)</b> : <b className="text-[var(--ac-amber300)]">yapılandırılmadı — olaylar kuyrukta</b>} ·
                kuyruk <b className="text-[var(--sl200)]">{siem.pending}</b> · yeniden denenecek <b className="text-[var(--ac-amber300)]">{siem.failed}</b> · gönderildi <b className="text-[var(--ac-emerald300)]">{siem.sent}</b> · vazgeçilen <b className="text-[var(--ac-rose300)]">{siem.abandoned}</b> (en fazla {siem.maxAttempts} deneme)
              </p>
            )}
            {siemMsg && <p className="text-[11px] text-[var(--ac-cyan300)]">{siemMsg}</p>}
            {chain && <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${chain.ok ? "border-emerald-500/40 bg-emerald-500/10 text-[var(--ac-emerald300)]" : "border-rose-500/50 bg-rose-500/10 text-[var(--ac-rose300)]"}`}>{chain.ok ? `✓ Zincir bütün: ${chain.count} kayıt, değişiklik/silme yok.` : `✗ Zincir bozuk (kayıt #${chain.brokenAtId}): ${chain.reason}`}</div>}
            <div className={`${card} audit-print max-h-[60vh] overflow-auto p-0`}>
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-[var(--t06)] text-left text-[var(--sl500)]"><tr>{["#", "Zaman", "Kullanıcı", "İşlem", "Kayıt", "Ayrıntı", "Hash"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="hover:bg-[var(--t14)]">
                      <td className="border-b border-[var(--t18)] px-3 py-1.5 font-mono text-[var(--sl500)]">{a.id}</td>
                      <td className="whitespace-nowrap border-b border-[var(--t18)] px-3 py-1.5 text-[var(--sl400)]">{new Date(a.ts).toLocaleString("tr-TR")}</td>
                      <td className="border-b border-[var(--t18)] px-3 py-1.5 text-[var(--sl200)]">{a.username}</td>
                      <td className={`border-b border-[var(--t18)] px-3 py-1.5 font-mono font-bold ${/denied|failed|delete|purge/.test(a.action) ? "text-[var(--ac-rose300)]" : /approve/.test(a.action) ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-cyan300)]"}`}>{a.action}</td>
                      <td className="border-b border-[var(--t18)] px-3 py-1.5 text-[var(--sl400)]">{a.entityType}{a.entityId ? `#${a.entityId}` : ""}</td>
                      <td className="max-w-[260px] truncate border-b border-[var(--t18)] px-3 py-1.5 font-mono text-[10px] text-[var(--sl500)]" title={a.details}>{a.details}</td>
                      <td className="border-b border-[var(--t18)] px-3 py-1.5 font-mono text-[10px] text-[var(--sl600)]">{a.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-[var(--ac-amber200)]">{perf?.note ?? "Yükleniyor…"}</div>
            {/* Gölge mod (t-validation): AI adayları rapora girmeden ölçülür — /api/shadow/summary */}
            <div className={`${card} space-y-1.5`} data-testid="shadow-summary">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">Gölge mod özeti</b>
                <span className="text-[10.5px] text-[var(--sl500)]">
                  {shadow ? `${shadow.total} kayıt · ${shadowRows(shadow.summary).totalFindings} aday bulgu` : "yükleniyor…"}
                  {shadowRows(shadow?.summary ?? []).lastAt ? ` · son ${new Date(shadowRows(shadow?.summary ?? []).lastAt!).toLocaleString("tr-TR")}` : ""}
                </span>
              </div>
              <p className="text-[10.5px] leading-snug text-[var(--sl500)]">
                NEXT_PUBLIC_AI_SHADOW_MODE=true iken AI adayları rapora/ekrana girmez; yalnız kaydedilir. Bu tablo, doğrulanmamış modelin
                üretimde sessizce ölçülmesini sağlar — burada gösterilen sayılar klinik doğruluk değildir.
              </p>
              {shadow?.error && <p className="text-[10.5px] text-[var(--ac-amber300)]">{shadow.error}</p>}
              {shadow && shadow.summary.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-left text-[var(--sl500)]"><tr>{["Motor", "Model", "Kayıt", "Aday bulgu", "İlk", "Son"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
                    <tbody>
                      {shadow.summary.map((r) => (
                        <tr key={`${r.engine}${r.model}`}>
                          <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[10.5px] text-[var(--ac-cyan300)]">{r.engine}</td>
                          <td className="border-b border-[var(--t18)] px-2 py-1">{r.model}</td>
                          <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{r.count}</td>
                          <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[var(--ac-amber300)]">{r.findings}</td>
                          <td className="border-b border-[var(--t18)] px-2 py-1 text-[10px] text-[var(--sl500)]">{r.firstAt ? new Date(r.firstAt).toLocaleString("tr-TR") : "—"}</td>
                          <td className="border-b border-[var(--t18)] px-2 py-1 text-[10px] text-[var(--sl500)]">{r.lastAt ? new Date(r.lastAt).toLocaleString("tr-TR") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className={`${card} overflow-x-auto p-0`}>
              <table className="w-full text-[11.5px]">
                <thead className="text-left text-[var(--sl500)]"><tr>{["Motor", "Kategori", "Gösterilen", "Onaylanan", "Reddedilen", "Düzenlenen", "Bekleyen", "Kesinlik (PPV)", "AI'nın kaçırdığı (hekim ekledi)"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {(perf?.rows ?? []).length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-[var(--sl500)]">Henüz hekim geri bildirimi yok. Raporlarda bulguları Onayla/Reddet olarak işaretledikçe dolar.</td></tr>}
                  {(perf?.rows ?? []).map((r) => (
                    <tr key={`${r.engine}${r.category}`} className="hover:bg-[var(--t14)]">
                      <td className="border-b border-[var(--t18)] px-3 py-2 font-mono text-[var(--ac-cyan300)]">{r.engine}</td><td className="border-b border-[var(--t18)] px-3 py-2">{r.category}</td>
                      <td className="border-b border-[var(--t18)] px-3 py-2">{r.shown}</td><td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--ac-emerald300)]">{r.approved}</td><td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--ac-rose300)]">{r.rejected}</td><td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--ac-amber300)]">{r.edited}</td><td className="border-b border-[var(--t18)] px-3 py-2">{r.pending}</td>
                      <td className="border-b border-[var(--t18)] px-3 py-2 font-bold">{r.ppv === null ? "—" : `%${Math.round(r.ppv * 100)}`}</td><td className="border-b border-[var(--t18)] px-3 py-2">{r.manualAdded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Hekim geri bildirim döngüsü (a-feedback): duyarlılık / özgüllük + yanlış pozitif listesi.
                Kaynak: yalnız onaylı raporlardaki hekim kararları. Altın standart yok → "hekimle uyum". */}
            <div className={`${card} space-y-2`} data-testid="feedback-loop">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">Duyarlılık · özgüllük · yanlış pozitifler</b>
                <span className="text-[10.5px] text-[var(--sl500)]">
                  {fb
                    ? `${fb.totals.decided} karar · ${fb.totals.missed} "AI kaçırdı" · ${fb.totals.cleanStudies} temiz çalışma`
                    : fbError || "yükleniyor…"}
                </span>
              </div>
              {fb && fb.warnings.length > 0 && (
                <ul className="space-y-0.5 text-[10.5px] text-[var(--ac-amber300)]">
                  {fb.warnings.map((w) => <li key={w}>• {w}</li>)}
                </ul>
              )}
              {fb && (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {([
                      ["Duyarlılık", fb.totals.sensitivity, "AI'nın yakaladığı / (yakaladığı + hekimin eklediği)"],
                      ["Özgüllük", fb.totals.specificity, "Temiz çalışma / (temiz + reddedilen). Altın standart yok: 'onaylı raporda bulgu yok' proxy'si"],
                      ["Kesinlik (PPV)", fb.totals.ppv, "(Onay + düzenleme) / (onay + düzenleme + ret)"],
                    ] as [string, number | null, string][]).map(([label, v, hint]) => (
                      <div key={label} className="rounded-lg border border-[var(--t25)] bg-[var(--t10)] px-3 py-2" title={hint}>
                        <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">{label}</div>
                        <div className="font-mono text-lg font-bold text-[var(--sl100)]">{v === null ? "—" : `%${Math.round(v * 100)}`}</div>
                        <div className="text-[9.5px] leading-tight text-[var(--sl600)]">{hint}</div>
                      </div>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-left text-[var(--sl500)]"><tr>{["Motor", "Gösterilen", "Duyarlılık (%95 GA)", "Özgüllük", "Kesinlik", "Kaçırdığı"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
                      <tbody>
                        {fb.engines.length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-center text-[var(--sl500)]">Onaylı raporda AI adayı yok.</td></tr>}
                        {fb.engines.map((e) => (
                          <tr key={e.engine} className="hover:bg-[var(--t14)]">
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[10.5px] text-[var(--ac-cyan300)]">{e.engine}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{e.shown}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">
                              {e.sensitivity === null ? "—" : `%${Math.round(e.sensitivity * 100)}`}
                              {e.sensitivityCI && <span className="ml-1 text-[9.5px] text-[var(--sl500)]">[%{Math.round(e.sensitivityCI[0] * 100)}–%{Math.round(e.sensitivityCI[1] * 100)}]</span>}
                            </td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{e.specificity === null ? "—" : `%${Math.round(e.specificity * 100)}`}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{e.ppv === null ? "—" : `%${Math.round(e.ppv * 100)}`}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[var(--ac-amber300)]">{e.missed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {fb.thresholdCurve.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10.5px] text-[var(--sl400)]">
                        Eşik eğrisi {fb.suggestedThreshold !== null
                          ? <>— öneri <b className="font-mono text-[var(--ac-cyan300)]">{fb.suggestedThreshold.toFixed(1)}</b></>
                          : "— öneri yok"}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[10.5px]">
                          <thead className="text-left text-[var(--sl500)]"><tr>{["Eşik", "Kesinlik", "Duyarlılık", "Tutulan", "Elenen"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1 font-semibold">{h}</th>)}</tr></thead>
                          <tbody>
                            {fb.thresholdCurve.map((p) => (
                              <tr key={p.threshold} className={p.threshold === fb.suggestedThreshold ? "bg-cyan-500/10" : ""}>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{p.threshold.toFixed(1)}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{p.precision === null ? "—" : `%${Math.round(p.precision * 100)}`}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{p.recall === null ? "—" : `%${Math.round(p.recall * 100)}`}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{p.kept}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[var(--sl500)]">{p.dropped}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] leading-snug text-[var(--sl500)]">{fb.suggestedThresholdWhy}</p>
                    </div>
                  )}
                  <div className="grid gap-2 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[10.5px] font-semibold text-[var(--ac-rose300)]">Yanlış pozitifler ({fb.falsePositives.length})</div>
                      <div className="max-h-44 overflow-y-auto rounded border border-[var(--t25)]">
                        <table className="w-full text-[10.5px]">
                          <tbody>
                            {fb.falsePositives.length === 0 && <tr><td className="px-2 py-3 text-center text-[var(--sl500)]">Reddedilen aday yok.</td></tr>}
                            {fb.falsePositives.map((f, i) => (
                              <tr key={`${f.engine}${f.label}${i}`} className="hover:bg-[var(--t14)]">
                                <td className="border-b border-[var(--t18)] px-2 py-1 align-top">
                                  <div className="font-semibold text-[var(--sl200)]">{f.label}</div>
                                  <div className="text-[9.5px] text-[var(--sl500)]">{f.engine} · {f.category}{f.slice !== null ? ` · kesit ${f.slice}` : ""}{f.score !== null ? ` · skor ${f.score.toFixed(2)}` : ""}</div>
                                </td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 align-top text-[var(--sl400)]">{f.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[10.5px] font-semibold text-[var(--ac-amber300)]">AI&apos;nın kaçırdıkları ({fb.totals.missed})</div>
                      <div className="max-h-44 overflow-y-auto rounded border border-[var(--t25)]">
                        <table className="w-full text-[10.5px]">
                          <tbody>
                            {fb.missed.length === 0 && <tr><td className="px-2 py-3 text-center text-[var(--sl500)]">Hekim henüz &quot;AI kaçırdı&quot; bulgusu eklemedi.</td></tr>}
                            {fb.missed.map((m, i) => (
                              <tr key={`${m.engine}${m.label}${i}`} className="hover:bg-[var(--t14)]">
                                <td className="border-b border-[var(--t18)] px-2 py-1">
                                  <div className="font-semibold text-[var(--sl200)]">{m.label}</div>
                                  <div className="text-[9.5px] text-[var(--sl500)]">{m.engine}{m.slice !== null ? ` · kesit ${m.slice}` : ""}</div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] leading-snug text-[var(--sl500)]">
                    {fb.note}
                    {fb.sample && <> Örneklem: {fb.sample.reportsApproved}/{fb.sample.reportsScanned} onaylı rapor.</>}
                    {fb.specificitySource && fb.specificitySource !== "yok" && <> Özgüllük kaynağı: {fb.specificitySource}.</>}
                  </p>
                </>
              )}
            </div>

            {/* Kalibrasyon (a-uncert): ısotonik eşleme + ECE + eşik önerisi + düşük güven kuyruğu. */}
            <div className={`${card} space-y-2`} data-testid="calibration">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">Güven kalibrasyonu (ısotonik) ve incelenecek adaylar</b>
                <span className="text-[10.5px] text-[var(--sl500)]">
                  {fb?.calibration
                    ? `${fb.calibration.cases} etiketli bulgu · ${fb.calibration.ok ? `${fb.calibration.blocks.length} blok` : "eşleme yok"}`
                    : "yükleniyor…"}
                </span>
              </div>
              {fb?.calibration && (
                <>
                  {!fb.calibration.ok ? (
                    <p className="text-[10.5px] leading-snug text-[var(--ac-amber300)]">
                      {fb.calibration.reason} Skorlar <b>düzeltilmeden</b> gösterilir; ekrandaki yüzde kalibre olasılık değildir.
                    </p>
                  ) : (
                    <>
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="rounded-lg border border-[var(--t25)] bg-[var(--t10)] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">ECE (kalibrasyon hatası)</div>
                          <div className="font-mono text-lg font-bold text-[var(--sl100)]">{fb.calibration.ece === null ? "—" : fb.calibration.ece.toFixed(3)}</div>
                          <div className="text-[9.5px] leading-tight text-[var(--sl600)]">{fb.calibration.qualityNote}</div>
                        </div>
                        <div className="rounded-lg border border-[var(--t25)] bg-[var(--t10)] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">Ortalama düzeltme</div>
                          <div className="font-mono text-lg font-bold text-[var(--sl100)]">{fb.calibration.meanShift === null ? "—" : `%${(fb.calibration.meanShift * 100).toFixed(1)}`}</div>
                          <div className="text-[9.5px] leading-tight text-[var(--sl600)]">|kalibre − ham| ortalaması: skoru ne kadar düzeltiyoruz</div>
                        </div>
                        <div className="rounded-lg border border-[var(--t25)] bg-[var(--t10)] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">Önerilen eşik</div>
                          <div className="font-mono text-lg font-bold text-[var(--ac-cyan300)]">{fb.thresholds?.chosen ? fb.thresholds.chosen.threshold.toFixed(2) : "—"}</div>
                          <div className="text-[9.5px] leading-tight text-[var(--sl600)]">
                            {fb.thresholds?.chosen
                              ? `kesinlik %${Math.round(fb.thresholds.chosen.precision * 100)} · duyarlılık %${Math.round(fb.thresholds.chosen.recall * 100)}`
                              : fb.thresholds?.note ?? "yeterli veri yok"}
                          </div>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[10.5px]">
                          <thead className="text-left text-[var(--sl500)]"><tr>{["Skor aralığı", "n", "Kalibre olasılık"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1 font-semibold">{h}</th>)}</tr></thead>
                          <tbody>
                            {fb.calibration.blocks.map((b, i) => (
                              <tr key={i}>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{b.lo === b.hi ? b.lo.toFixed(2) : `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}`}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">{b.n}</td>
                                <td className="border-b border-[var(--t18)] px-2 py-1 font-mono">%{Math.round(b.p * 100)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] leading-snug text-[var(--sl500)]">
                        {fb.thresholds?.note} Isotonik eşleme <b>örneklem-içidir</b> (eğitim = ölçüm verisi): dış doğrulama değildir.
                        Ters (azalan) ilişki görülen modellerde eşleme reddedilir ve skor düzeltilmez.
                      </p>
                    </>
                  )}
                  <div>
                    <div className="mb-1 text-[10.5px] font-semibold text-[var(--ac-amber300)]">
                      Hekim incelesin — düşük güven ({fb.lowConfidence?.length ?? 0})
                    </div>
                    <div className="max-h-40 overflow-y-auto rounded border border-[var(--t25)]">
                      <table className="w-full text-[10.5px]">
                        <tbody>
                          {(fb.lowConfidence ?? []).length === 0 && <tr><td className="px-2 py-3 text-center text-[var(--sl500)]">İncelenecek aday yok (yeterli skorlu aday ya da kalibrasyon bekleniyor).</td></tr>}
                          {(fb.lowConfidence ?? []).map((r, i) => (
                            <tr key={i} className="hover:bg-[var(--t14)]">
                              <td className="border-b border-[var(--t18)] px-2 py-1">
                                <div className="font-semibold text-[var(--sl200)]">{r.label}</div>
                                <div className="text-[9.5px] text-[var(--sl500)]">
                                  {r.engine} · {r.category}
                                  {r.slice !== null ? ` · kesit ${r.slice}` : ""}
                                  {" · "}ham %{Math.round(r.raw * 100)} → kalibre %{Math.round(r.calibrated * 100)}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* AI uyuşmazlık uyarısı banner'ı (src/lib/disagreementAlert.ts) */}
            {perf?.disagreement?.alert && perf.disagreement.alert.total > 0 && (
              <div role="alert" className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-3" data-testid="ai-disagreement-alert">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-xs font-black text-[var(--ac-rose300)]">⚠ {perf.disagreement.alert.total} kategoride AI↔hekim uyuşmazlığı eşiği (%{Math.round(perf.disagreement.alert.threshold * 100)} / ≥{perf.disagreement.alert.minDecided} karar) aşıldı</b>
                  <span className="text-[10.5px] font-mono text-[var(--ac-rose200)]/80">{perf.disagreement.alert.sent > 0 ? `${perf.disagreement.alert.sent} bildirim kanallara gönderildi` : "yeni eşik aşımı yok (mevcut uyarılar görüldü)"}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--ac-rose200)]/90">
                  {perf.disagreement.alert.reasonClasses.map((d) => <span key={d.cls}>{d.label}: <b>{d.count}</b></span>)}
                </div>
                <p className="mt-1 text-[9.5px] leading-snug text-[var(--ac-rose200)]/60">Gerekçe sınıflandırması kural tabanlıdır (LLM yok). Modelin yeniden eğitilmesi kurumun model sahibi sürecindedir; bu uyarı modeli değiştirmez. Ayrıntı: Yönetim → AI ve denetim kaydı «ai.disagreement_alert».</p>
              </div>
            )}
            {perf?.disagreement?.alertError && (
              <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[10.5px] text-[var(--ac-amber200)]">AI uyuşmazlık uyarısı üretilemedi: {perf.disagreement.alertError}</div>
            )}

            {/* AI önerisi ↔ hekim kararı uyuşmazlığı (src/lib/aiDisagreement.ts) */}
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">AI önerisi ↔ hekim kararı uyuşmazlığı</b>
                <span className="text-[10.5px] text-[var(--sl500)]">
                  {perf?.disagreement
                    ? `${perf.disagreement.tally.decided} karar · ${perf.disagreement.tally.rejected} ret · ${perf.disagreement.tally.edited} düzenleme · uyuşmazlık ${perf.disagreement.tally.rate === null ? "—" : `%${Math.round(perf.disagreement.tally.rate * 100)}`} · ${perf.disagreement.tally.withReason} gerekçe`
                    : "veri yok"}
                </span>
              </div>
              <p className="text-[10.5px] leading-snug text-[var(--sl500)]">
                Uyuşmazlık = hekimin reddettiği veya düzenlediği bulgu. Bu oran klinik doğruluk (duyarlılık/özgüllük) değildir; yalnız hekim kararlarına dayanır.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-left text-[var(--sl500)]"><tr>{["Motor", "Kategori", "Karar", "Ret", "Düzenleme", "Uyuşmazlık"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>
                    {(perf?.disagreement?.categories ?? []).length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-[var(--sl500)]">Henüz karar verilmiş bulgu yok. Raporda bulguları Onayla/Reddet/Düzenlendi olarak işaretleyin.</td></tr>}
                    {(perf?.disagreement?.categories ?? []).map((c) => (
                      <tr key={`${c.engine}|${c.category}`} className="hover:bg-[var(--t14)]">
                        <td className="border-b border-[var(--t18)] px-3 py-2 font-mono text-[var(--ac-cyan300)]">{c.engine}</td>
                        <td className="border-b border-[var(--t18)] px-3 py-2">{c.category}</td>
                        <td className="border-b border-[var(--t18)] px-3 py-2">{c.decided}</td>
                        <td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--ac-rose300)]">{c.rejected}</td>
                        <td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--ac-amber300)]">{c.edited}</td>
                        <td className={`border-b border-[var(--t18)] px-3 py-2 font-bold ${(c.disagreementRate ?? 0) >= 0.5 ? "text-[var(--ac-rose300)]" : "text-[var(--sl200)]"}`}>{c.disagreementRate === null ? "—" : `%${Math.round(c.disagreementRate * 100)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(perf?.disagreement?.alert?.reasonClasses?.length ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--sl400)]">
                  <span className="font-semibold text-[var(--sl300)]">Gerekçe sınıfları (model geri besleme özeti):</span>
                  {perf!.disagreement!.alert!.reasonClasses.map((d) => <span key={d.cls}>{d.label}: <b className="text-[var(--sl200)]">{d.count}</b></span>)}
                </div>
              )}
              {(perf?.disagreement?.reasons ?? []).length > 0 && (
                <div className="space-y-1">
                  <b className="text-[11px] text-[var(--sl300)]">Hekim gerekçeleri (en çok 20)</b>
                  <ul className="space-y-0.5 text-[10.5px] leading-snug text-[var(--sl400)]">
                    {(perf?.disagreement?.reasons ?? []).map((x, i) => (
                      <li key={`${x.category}-${i}`}>
                        <span className="font-mono text-[var(--sl500)]">{x.engine}</span> · <span className="text-[var(--sl300)]">{x.category}</span> ·{" "}
                        <span className={x.status === "reddedildi" ? "text-[var(--ac-rose300)]" : "text-[var(--ac-amber300)]"}>{x.status === "reddedildi" ? "ret" : "düzenleme"}</span>{" "}
                        — <b className="text-[var(--sl300)]">{x.label}</b>: {x.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">Model kayıt defteri</b>
                <span className="text-[10.5px] text-[var(--sl500)]">
                  {registry ? `aday ${registry.summary.aday ?? 0} · aktif ${registry.summary.aktif ?? 0} · emekli ${registry.summary.emekli ?? 0}` : "yükleniyor…"}
                </span>
              </div>
              {(registry?.issues ?? []).length > 0 && (
                <ul className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10.5px] text-[var(--ac-amber200)]">
                  {(registry?.issues ?? []).slice(0, 5).map((i) => <li key={i}>• {i}</li>)}
                </ul>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-[11.5px]">
                  <thead className="text-left text-[var(--sl500)]"><tr>{["Model", "Sürüm", "Modalite", "Görev", "Aşama", "Trafik", "Parmak izi", "Güncelleme"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>
                    {(registry?.entries ?? []).length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-[var(--sl500)]">Henüz model kaydı yok. Aşağıdaki formla ilk sürümü ekleyin.</td></tr>}
                    {(registry?.entries ?? []).map((r) => (
                      <tr key={`${r.name}@${r.version}`} className="hover:bg-[var(--t14)]">
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 font-mono text-[var(--ac-cyan300)]">{r.name}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5">{r.version}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5">{r.modality || "—"}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5">{r.task || "—"}</td>
                        <td className={`border-b border-[var(--t18)] px-2 py-1.5 font-bold ${r.stage === "aktif" ? "text-[var(--ac-emerald300)]" : r.stage === "emekli" ? "text-[var(--sl500)]" : "text-[var(--ac-amber300)]"}`}>{r.stage}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5">%{r.trafficPercent}</td>
                        <td className="max-w-[140px] truncate border-b border-[var(--t18)] px-2 py-1.5 font-mono text-[10px] text-[var(--sl500)]" title={r.fingerprint}>{r.fingerprint || "—"}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 text-[10px] text-[var(--sl500)]">{r.updatedAt ? new Date(r.updatedAt).toLocaleString("tr-TR") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid gap-1.5 md:grid-cols-6">
                <input className={input} placeholder="model adı" value={regForm.name} onChange={(e) => setRegForm((f) => ({ ...f, name: e.target.value }))} />
                <input className={input} placeholder="sürüm" value={regForm.version} onChange={(e) => setRegForm((f) => ({ ...f, version: e.target.value }))} />
                <input className={input} placeholder="modalite (CT)" value={regForm.modality} onChange={(e) => setRegForm((f) => ({ ...f, modality: e.target.value }))} />
                <input className={input} placeholder="görev (nodule)" value={regForm.task} onChange={(e) => setRegForm((f) => ({ ...f, task: e.target.value }))} />
                <select className={input} value={regForm.stage} onChange={(e) => setRegForm((f) => ({ ...f, stage: e.target.value as RegistryRow["stage"] }))}>
                  {["aday", "aktif", "emekli"].map((st) => <option key={st} value={st}>{st}</option>)}
                </select>
                <div className="flex items-center gap-1">
                  <input className={`${input} w-full`} placeholder="trafik %" value={regForm.trafficPercent} onChange={(e) => setRegForm((f) => ({ ...f, trafficPercent: e.target.value }))} />
                  <button disabled={regBusy || !regForm.name.trim() || !regForm.version.trim()} onClick={() => void saveModel()} className={`${btn} shrink-0 bg-cyan-400/15 text-[var(--ac-cyan200)] ring-1 ring-cyan-400/40 disabled:opacity-40`}>Kaydet</button>
                </div>
              </div>
              <div className="text-[10px] leading-relaxed text-[var(--sl500)]">
                Aynı ad + sürüm üzerine yazılır; aşama değişiklikleri denetim izine ({`model.activate`} / {`model.register`}) yazılır.
                A/B ataması tohum (ör. çalışma UID&apos;si) ile deterministiktir; aynı çalışma her zaman aynı modele düşer.
                Kayıt defteri çıkarım yolunu kendiliğinden değiştirmez — dağıtım planıdır.
              </div>
            </div>
          </div>
        )}

        {tab === "stats" && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3 text-xs text-[var(--ac-cyan200)]">{statsNote}</div>
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">Haftalık TAT trendi</b>
                <div className="flex items-center gap-1 text-[11px] text-[var(--sl400)]">
                  <span>Hedef (saat)</span>
                  <input value={targetHours} onChange={(e) => setTargetHours(e.target.value)} className={`${input} w-16`} aria-label="Hedef TAT (saat)" />
                  <select value={trendModality} onChange={(e) => setTrendModality(e.target.value)} aria-label="Modalite süzgeci" className={`${input} w-24`}>
                    <option value="">tümü</option>
                    {Object.keys(stats?.byModality ?? {}).sort().map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button onClick={() => void loadStats(targetHours, trendModality)} className={`${btn} bg-cyan-400/15 text-[var(--ac-cyan200)] ring-1 ring-cyan-400/40`}>Uygula</button>
                  {tatTargetState && (
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-black ${tatTargetState.status === "hedef-icinde" ? "bg-emerald-500/20 text-[var(--ac-emerald200)]" : tatTargetState.status === "sinirda" ? "bg-amber-500/20 text-[var(--ac-amber200)]" : tatTargetState.status === "hedef-disi" ? "bg-rose-500/20 text-[var(--ac-rose200)]" : "bg-[var(--sl500)]/20 text-[var(--sl300)]"}`}>
                      {tatTargetState.status === "hedef-icinde" ? "HEDEF İÇİNDE" : tatTargetState.status === "sinirda" ? "SINIRDA" : tatTargetState.status === "hedef-disi" ? "HEDEF DIŞI" : "VERİ YOK"}
                    </span>
                  )}
                </div>
              </div>
              <svg viewBox="0 0 620 120" className="w-full" role="img" aria-label="Haftalık TAT trendi">
                {(() => {
                  const max = Math.max(1, ...weekly.map((w) => w.medianHours ?? 0), Number(targetHours) || 24);
                  const bw = 620 / Math.max(1, weekly.length);
                  const targetY = 100 - ((Number(targetHours) || 24) / max) * 90;
                  return (
                    <>
                      {weekly.map((w, i) => {
                        const h = ((w.medianHours ?? 0) / max) * 90;
                        const over = w.medianHours !== null && w.medianHours > (Number(targetHours) || 24);
                        return (
                          <g key={w.weekStart}>
                            <rect x={i * bw + 4} y={100 - h} width={Math.max(2, bw - 8)} height={Math.max(0.5, h)} fill={over ? "#fb7185" : "#22d3ee"} opacity="0.75">
                              <title>{`${w.label}: medyan ${w.medianHours ?? "—"} sa · ${w.approved} rapor`}</title>
                            </rect>
                            <text x={i * bw + bw / 2} y={114} textAnchor="middle" fontSize="9" fill="var(--t42)">{w.label}</text>
                          </g>
                        );
                      })}
                      <line x1="0" y1={targetY} x2="620" y2={targetY} stroke="#fbbf24" strokeWidth="1" strokeDasharray="4 3" />
                    </>
                  );
                })()}
              </svg>
              <div className="text-[10px] text-[var(--sl500)]">Çubuklar onaylanan raporların haftalık medyan TAT değeri; kesikli çizgi hedef ({targetHours} sa). Boş haftalar ölçüm yok demektir.</div>
              {tatAlertList.length > 0 && (
                <ul className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10.5px] text-[var(--ac-amber200)]">
                  {tatAlertList.map((a) => <li key={a}>• {a}</li>)}
                </ul>
              )}
            </div>
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-[var(--sl200)]">İkinci okuma (RADPEER)</b>
                <div className="flex items-center gap-1 text-[11px] text-[var(--sl400)]">
                  <span>Örneklem %</span>
                  <input value={peerPct} onChange={(e) => setPeerPct(e.target.value)} className={`${input} w-16`} aria-label="İkinci okuma örneklem oranı" />
                  <button onClick={() => void savePeerPct()} className={`${btn} bg-cyan-400/15 text-[var(--ac-cyan200)] ring-1 ring-cyan-400/40`}>Kaydet</button>
                  {peer && (
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-black ${peer.target.met ? "bg-emerald-500/20 text-[var(--ac-emerald200)]" : "bg-amber-500/20 text-[var(--ac-amber200)]"}`}>
                      {peer.target.met ? "HEDEF TAMAM" : `${peer.target.remaining} RAPOR KALDI`}
                    </span>
                  )}
                </div>
              </div>
              {!peer && <div className="text-[11px] text-[var(--sl500)]">Yükleniyor…</div>}
              {peer && (
                <>
                  <div className="text-[10.5px] text-[var(--sl500)]">
                    {peer.stats.note} · onaylı rapor {peer.approvedReports} · hedef {peer.target.expected} okuma ({peer.target.reviewed} yapıldı)
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--sl500)]">RADPEER dağılımı</div>
                      {peer.stats.byScore.map((b) => (
                        <div key={b.score} className="mt-1">
                          <div className="flex justify-between text-[10.5px] text-[var(--sl400)]"><span>{b.label}</span><span className="font-mono">{b.count} (%{b.pct})</span></div>
                          <div className="mt-0.5 h-1.5 rounded bg-[var(--t17)]">
                            <div className={`h-1.5 rounded ${b.score === 3 ? "bg-rose-400" : b.score === 2 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, b.pct)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--sl500)]">Uyuşmazlık türleri</div>
                      {peer.stats.byDiscrepancy.length === 0 && <div className="mt-1 text-[10.5px] text-[var(--sl500)]">Anlamlı fark kaydı yok.</div>}
                      {peer.stats.byDiscrepancy.map((d) => <div key={d.type} className="mt-1 flex justify-between text-[10.5px] text-[var(--sl400)]"><span>{d.type}</span><span className="font-mono">{d.count}</span></div>)}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--sl500)]">Hekim başına</div>
                      {peer.stats.byReviewer.length === 0 && <div className="mt-1 text-[10.5px] text-[var(--sl500)]">Kayıt yok.</div>}
                      {peer.stats.byReviewer.slice(0, 5).map((r) => (
                        <div key={r.name} className="mt-1 flex justify-between text-[10.5px] text-[var(--sl400)]">
                          <span className="truncate">{r.name}</span>
                          <span className="font-mono">{r.count} okuma · {r.disagreements} uyumsuz{r.disagreementRate !== null ? ` (%${Math.round(r.disagreementRate * 100)})` : ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {peer.stats.needsFollowUp.length > 0 && (
                    <div className="rounded border border-rose-400/40 bg-rose-400/10 px-2 py-1 text-[10.5px] text-[var(--ac-rose200)]">
                      Takip gerektiren {peer.stats.needsFollowUp.length} uyumsuz okuma: {peer.stats.needsFollowUp.map((r) => `#${r.reportId} (${r.reviewedByName || "isimsiz"})`).join(", ")}
                    </div>
                  )}
                  {peer.queue.length > 0 && (
                    <div className="text-[10px] text-[var(--sl500)]">Örneklem kuyruğu (ilk 50): {peer.queue.slice(0, 12).join(", ")}{peer.queue.length > 12 ? "…" : ""}</div>
                  )}
                  <div className="text-[10px] text-[var(--sl500)]">{peer.note}</div>
                </>
              )}
            </div>
            {!stats && <div className={`${card}`}>Yükleniyor…</div>}
            {stats && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Toplam rapor", String(stats.total)],
                    ["Onaylanan", String(stats.approved)],
                    ["Ortalama TAT", formatHours(stats.meanHours)],
                    ["Medyan TAT", formatHours(stats.medianHours)],
                    ["p90 TAT", formatHours(stats.p90Hours)],
                    ["Bekleyen taslak", String(stats.pendingDrafts)],
                    [`${stats.staleDrafts.olderDays}+ gündür taslak`, String(stats.staleDrafts.count)],
                    ["Modalite çeşidi", String(Object.keys(stats.byModality).length)],
                  ].map(([l, v]) => (
                    <div key={l} className={card}>
                      <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">{l}</div>
                      <div className="mt-1 font-mono text-xl font-black text-[var(--ac-cyan300)]">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className={`${card} overflow-x-auto`}>
                    <h3 className="mb-2 text-xs font-bold text-[var(--sl200)]">Durum dağılımı</h3>
                    <table className="w-full text-[11.5px]">
                      <tbody>{Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <tr key={k}><td className="py-1 pr-3 text-[var(--sl300)]">{k}</td><td className="py-1 text-right font-mono text-[var(--ac-cyan300)]">{v}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className={`${card} overflow-x-auto`}>
                    <h3 className="mb-2 text-xs font-bold text-[var(--sl200)]">Modalite dağılımı</h3>
                    <table className="w-full text-[11.5px]">
                      <tbody>{Object.entries(stats.byModality).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <tr key={k}><td className="py-1 pr-3 text-[var(--sl300)]">{k}</td><td className="py-1 text-right font-mono text-[var(--ac-cyan300)]">{v}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
                <div className={`${card} overflow-x-auto`}>
                  <h3 className="mb-2 text-xs font-bold text-[var(--sl200)]">Hekim başına onaylanan rapor ve TAT</h3>
                  <table className="w-full text-[11.5px]">
                    <thead className="text-left text-[var(--sl500)]"><tr>{["Hekim", "Onaylanan", "Medyan TAT", "p90 TAT"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                    <tbody>
                      {stats.perRadiologist.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-[var(--sl500)]">Henüz onaylanmış rapor yok.</td></tr>}
                      {stats.perRadiologist.map((r) => (
                        <tr key={r.name} className="hover:bg-[var(--t14)]">
                          <td className="border-b border-[var(--t18)] px-3 py-2 text-[var(--sl200)]">{r.name}</td>
                          <td className="border-b border-[var(--t18)] px-3 py-2 font-mono text-[var(--ac-emerald300)]">{r.approved}</td>
                          <td className="border-b border-[var(--t18)] px-3 py-2 font-mono">{formatHours(r.medianHours)}</td>
                          <td className="border-b border-[var(--t18)] px-3 py-2 font-mono">{formatHours(r.p90Hours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "security" && status && settings && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Şifreleme (hareketsiz veri)</h2>
              <p className="mt-2 text-xs leading-relaxed text-[var(--sl300)]">Hasta adı/kimliği, klinik bilgi, anahtar kesit görüntüleri ve sunucuda saklanan DICOM dosyaları <b>AES-256-GCM</b> ile şifrelenir. Anahtar kaynağı: <b className={status.keySource === "env" ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-amber300)]"}>{status.keySource === "env" ? "ortam değişkeni (DATA_ENCRYPTION_KEY)" : "sunucu dosyası (.data/enc.key)"}</b>.</p>
              {status.keySource !== "env" && <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[11px] text-[var(--ac-amber200)]">Üretimde anahtarı veritabanı/diskten ayrı bir KMS veya gizli yönetim servisinde tutup <code>DATA_ENCRYPTION_KEY</code> (base64, 32 bayt) olarak verin. Anahtar kaybolursa veri geri alınamaz.</p>}
              <div className="mt-3 text-xs text-[var(--sl300)]">Düz metin kalan kayıt: <b className={status.plaintext.studies + status.plaintext.reports ? "text-[var(--ac-rose300)]" : "text-[var(--ac-emerald300)]"}>{status.plaintext.studies} çalışma · {status.plaintext.reports} rapor</b></div>
              <button disabled={status.plaintext.studies + status.plaintext.reports === 0} className={`${btn} mt-3 bg-cyan-500 text-[var(--sl950)] disabled:opacity-40`} onClick={async () => { const r = await api<{ studies: number; reports: number; error?: string }>("/api/admin/encrypt-legacy", { method: "POST" }); flash(r.ok ? `Şifrelendi: ${r.data.studies} çalışma, ${r.data.reports} rapor` : r.data.error ?? "Hata"); void loadSettings(); }}>Mevcut kayıtları şifrele</button>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Anahtar rotasyonu (KMS)</h2>
              <p className="mt-2 text-xs leading-relaxed text-[var(--sl300)]">
                Kayıtlar anahtar kimliği taşır (<code>enc:v2:&lt;kimlik&gt;:…</code>); böylece eski anahtarla şifrelenmiş veri,
                yeni anahtar eklenerek <b>kayıpsız</b> yeniden şifrelenebilir. Sıra: ① yeni anahtar üret → ② <code>.env</code>
                içindeki <code>DATA_ENCRYPTION_KEYS</code> değerine ekle → ③ servisi yeniden başlat → ④ &quot;Rotasyonu çalıştır&quot;
                → ⑤ doğrulandıktan sonra eski anahtarı listeden çıkar.
              </p>
              <div className="mt-3 space-y-1 text-[11px] text-[var(--sl400)]">
                {(keyring?.keys ?? []).map((k) => (
                  <div key={k.kid} className="flex items-center gap-2">
                    <code className={k.current ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-amber300)]"}>{k.kid}</code>
                    <span>{k.current ? "aktif (yazar)" : "yalnız okuma"}</span>
                  </div>
                ))}
                {!keyring && <span>Anahtar halkası okunamadı (Yönetim → Güvenlik sekmesini yenileyin).</span>}
              </div>
              {keyring?.rotation && (
                <p className="mt-2 text-[11px] text-[var(--sl300)]">Rotasyon durumu: <b>{keyring.rotation.summary}</b></p>
              )}
              {newKey && (
                <div className="mt-2 rounded border border-cyan-400/30 bg-cyan-400/5 p-2 text-[10.5px] text-[var(--ac-cyan100)]">
                  <div className="font-bold">Yeni anahtar (yalnız bir kez gösterilir — güvenli kasaya yazın):</div>
                  <code className="mt-1 block break-all text-[10px] text-[var(--ac-cyan200)]">{newKey.key}</code>
                  <div className="mt-1 text-[var(--sl300)]">DATA_ENCRYPTION_KEYS =</div>
                  <code className="block break-all text-[10px] text-[var(--sl200)]">{newKey.dataEncryptionKeys}</code>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={`${btn} bg-[var(--sl700)] text-[var(--sl100)]`} onClick={async () => {
                  const r = await api<{ key: string; kid: string; dataEncryptionKeys: string; error?: string }>("/api/admin/keyring", json("POST", { action: "generate" }));
                  if (r.ok) { setNewKey(r.data); flash(`Yeni anahtar üretildi (${r.data.kid})`); } else flash(r.data.error ?? "Anahtar üretilemedi");
                }}>Yeni anahtar üret</button>
                <button className={`${btn} bg-cyan-500 text-[var(--sl950)] disabled:opacity-40`} disabled={rotateBusy || (keyring?.rotation?.pending ?? 0) === 0} onClick={async () => {
                  setRotateBusy(true);
                  const r = await api<{ written: number; remaining: number; percent: number; note: string; error?: string }>("/api/admin/keyring", json("POST", { action: "rotate" }));
                  setRotateBusy(false);
                  flash(r.ok ? `${r.data.written} kayıt yeniden şifrelendi (%${r.data.percent}, kalan ${r.data.remaining})` : r.data.error ?? "Rotasyon başarısız");
                  void loadKeyring();
                }}>{rotateBusy ? "Rotasyon…" : "Rotasyonu çalıştır"}</button>
                <button className={`${btn} bg-[var(--sl700)] text-[var(--sl100)] disabled:opacity-40`} disabled={!newKey} onClick={async () => {
                  if (!newKey) return;
                  const r = await api<{ dataEncryptionKeys: string; note: string; error?: string }>("/api/admin/keyring", json("POST", { action: "drop-old", currentKey: newKey.key }));
                  flash(r.ok ? "Eski anahtarlar çıkarıldı — yeni değeri .env'e yazın" : r.data.error ?? "Atma başarısız");
                  if (r.ok) setNewKey({ ...newKey, dataEncryptionKeys: r.data.dataEncryptionKeys });
                }}>Eski anahtarları çıkar</button>
              </div>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Saklama politikası</h2>
              <p className="mt-2 text-xs text-[var(--sl300)]">Onaylanmamış taslak raporlar bu süreden sonra silinir (0 = otomatik silme kapalı). Onaylı raporlar silinmez.</p>
              <div className="mt-3 flex items-center gap-2">
                <input type="number" min={0} defaultValue={settings.retentionDraftDays} id="ret" className={`${input} w-24`} />
                <span className="text-xs text-[var(--sl400)]">gün</span>
                <button className={`${btn} bg-cyan-500 text-[var(--sl950)]`} onClick={() => void saveSettings({ retentionDraftDays: Number((document.getElementById("ret") as HTMLInputElement).value) })}>Kaydet</button>
                <button className={`${btn} border border-rose-400/40 text-[var(--ac-rose300)] hover:bg-rose-400/10`} onClick={async () => { if (!window.confirm("Süresi dolan taslaklar kalıcı olarak silinecek. Devam?")) return; const r = await api<{ deleted: number; error?: string }>("/api/admin/purge-drafts", { method: "POST" }); flash(r.ok ? `${r.data.deleted} taslak silindi` : r.data.error ?? "Hata"); }}>Süresi dolanları sil</button>
              </div>
              <h2 className="mt-5 text-sm font-bold text-[var(--sl100)]">Kayıt sayıları</h2>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">{Object.entries(status.totals).map(([k, v]) => <div key={k} className="rounded border border-[var(--t30)] bg-[var(--t10)] p-2"><div className="text-lg font-black text-[var(--ac-cyan300)]">{v}</div><div className="text-[var(--sl500)]">{k}</div></div>)}</div>
              <Link href="/gizlilik" className="mt-4 inline-block text-xs text-[var(--ac-cyan400)] hover:underline">KVKK aydınlatma metni şablonu →</Link>
            </div>
            <div className={`${card} md:col-span-2`} data-testid="access-anomaly-panel">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold text-[var(--sl100)]">Erişim anomalileri (KVKK)</h2>
                  <p className="mt-1 text-[10.5px] text-[var(--sl500)]">Son {anomaly?.windowDays ?? 7} gün tarandı · {anomaly ? `${anomaly.scannedAuditRows} denetim satırı + ${anomaly.scannedAttempts} başarısız giriş` : "yükleniyor…"}</p>
                </div>
                <button className={`${btn} border border-[var(--sl600)]/60 text-[var(--sl200)] hover:bg-[var(--sl700)]/40 disabled:opacity-40`} disabled={anomalyBusy} onClick={() => void loadAnomalies()}>{anomalyBusy ? "Taranıyor…" : "Yeniden tara"}</button>
              </div>
              {anomalyError && <p role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-[var(--ac-amber200)]">{anomalyError}</p>}
              {anomaly && anomaly.alert.sent > 0 && <p role="alert" className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-[10.5px] text-[var(--ac-rose200)]">{anomaly.alert.sent} yeni yüksek anomalide bildirimler kanallara iletildi (denetim kaydı: «security.access_anomaly»).</p>}
              {anomaly && anomaly.anomalies.length === 0 && <p className="mt-3 text-xs font-semibold text-[var(--ac-emerald300)]">Son {anomaly.windowDays} günde kural dışı erişim deseni tespit edilmedi.</p>}
              {anomaly && anomaly.anomalies.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {anomaly.anomalies.map((a) => {
                    const sev = a.severity === "yuksek"
                      ? "border-rose-500/50 bg-rose-500/10 text-[var(--ac-rose300)]"
                      : a.severity === "orta"
                        ? "border-amber-500/40 bg-amber-500/10 text-[var(--ac-amber300)]"
                        : "border-[var(--sl600)]/60 bg-[var(--sl700)]/20 text-[var(--sl300)]";
                    return (
                      <li key={a.key} className="rounded-lg border border-[var(--t30)] bg-[var(--t10)] p-2.5" data-testid="access-anomaly-item">
                        <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
                          <span className={`rounded border px-1.5 py-0.5 font-bold uppercase ${sev}`}>{a.severity}</span>
                          <b className="text-[var(--sl100)]">{a.title}</b>
                          <code className="text-[var(--sl500)]">{a.actor}</code>
                          <span className="ml-auto font-mono text-[var(--sl500)]">{a.count} olay{a.windowMin ? ` / ${a.windowMin} dk` : ""}</span>
                        </div>
                        <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--sl400)]">{a.detail}</p>
                        {a.firstAt && (
                          <p className="mt-1 font-mono text-[9.5px] text-[var(--sl600)]">{new Date(a.firstAt).toLocaleString("tr-TR")} → {new Date(a.lastAt).toLocaleString("tr-TR")}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {anomaly && <p className="mt-3 text-[9.5px] leading-snug text-[var(--sl600)]">{anomaly.note}</p>}
            </div>
          </div>
        )}

        {tab === "health" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} flex flex-wrap items-center gap-2`}>
              <b className="text-sm text-[var(--sl100)]">Sistem sağlığı ve ortam denetimi</b>
              <span className="text-[11px] text-[var(--sl500)]">
                Değerler bu sunucudan okunur; sırlar (anahtar, parola, jeton) hiçbir zaman gösterilmez.
              </span>
              <button className={`${btn} ml-auto bg-cyan-500 text-[var(--sl950)] disabled:opacity-40`} disabled={healthBusy} onClick={() => void loadHealth()}>
                {healthBusy ? "Okunuyor…" : "↻ Yenile"}
              </button>
            </div>
            {healthErr && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-[var(--ac-rose200)]">{healthErr}</div>}
            {health && (
              <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {([
                    ["Tamam", health.summary.ok, "ok"],
                    ["Uyarı", health.summary.uyari, "uyari"],
                    ["Kritik", health.summary.kritik, "kritik"],
                    ["Bilgi", health.summary.bilgi, "bilgi"],
                  ] as [string, number, CheckLevel][]).map(([l, n, lvl]) => (
                    <div key={l} className={`rounded-xl border p-3 ${LEVEL_STYLE[lvl]}`}>
                      <div className="text-[10px] font-bold uppercase tracking-widest opacity-80">{l}</div>
                      <div className="mt-0.5 font-mono text-2xl font-black">{n}</div>
                    </div>
                  ))}
                </div>
                <div className={`${card} flex flex-wrap items-center gap-3 text-xs`}>
                  <span className="font-semibold text-[var(--sl300)]">Uçlar:</span>
                  <span className={`rounded px-2 py-0.5 font-mono text-[10.5px] ${health.health.live ? "bg-emerald-500/15 text-[var(--ac-emerald300)]" : "bg-rose-500/15 text-[var(--ac-rose300)]"}`}>
                    liveness {health.health.live === null ? "bilinmiyor" : health.health.live ? "yanıt veriyor" : "YANIT YOK"}
                  </span>
                  <span className={`rounded px-2 py-0.5 font-mono text-[10.5px] ${health.health.ready ? "bg-emerald-500/15 text-[var(--ac-emerald300)]" : "bg-rose-500/15 text-[var(--ac-rose300)]"}`}>
                    readiness {health.health.ready === null ? "bilinmiyor" : health.health.ready ? "hazır" : "HAZIR DEĞİL"}
                  </span>
                  <span className={`rounded px-2 py-0.5 font-mono text-[10.5px] ${health.metrics.ok ? "bg-emerald-500/15 text-[var(--ac-emerald300)]" : "bg-amber-500/15 text-[var(--ac-amber300)]"}`}>
                    /api/metrics {health.metrics.ok ? `${health.metrics.parsed.length} seri` : health.metrics.error ?? "okunamadı"}
                  </span>
                  <span className="ml-auto text-[10.5px] text-[var(--sl500)]">okuma: {new Date(health.generatedAt).toLocaleString("tr-TR")}</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {health.checks.map((c) => (
                    <div key={c.id} className={`rounded-lg border p-3 ${LEVEL_STYLE[c.level]}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <b className="text-[12px] text-[var(--sl100)]">{c.label}</b>
                        <span className="rounded border border-current/30 px-1.5 py-0.5 font-mono text-[9px] font-black">{LEVEL_LABEL[c.level]}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[11px]">{c.value}</div>
                      <p className="mt-1 text-[10.5px] leading-relaxed opacity-90">{c.hint}</p>
                      {c.doc && <p className="mt-0.5 font-mono text-[9.5px] opacity-70">belge: {c.doc}</p>}
                    </div>
                  ))}
                </div>
                <div className={`${card} space-y-2`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <b className="text-xs text-[var(--sl200)]">Prometheus metrikleri (ayrıştırılmış)</b>
                    <span className="text-[10.5px] text-[var(--sl500)]">kaynak: /api/metrics · yalnız toplu sayımlar</span>
                  </div>
                  {!health.metrics.ok && <p className="text-[11px] text-[var(--ac-amber300)]">Metrik ucu okunamadı: {health.metrics.error ?? "bilinmeyen hata"}</p>}
                  {health.metrics.ok && health.metrics.parsed.length === 0 && <p className="text-[11px] text-[var(--sl500)]">Metrik döndü ama seri yok.</p>}
                  {health.metrics.parsed.map((m) => (
                    <div key={m.name} className="rounded border border-[var(--t25)] p-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <code className="font-mono text-[11px] text-[var(--ac-cyan300)]">{m.name}</code>
                        <span className="rounded border border-[var(--t32)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--sl400)]">{m.type}</span>
                      </div>
                      {m.help && <div className="text-[10px] text-[var(--sl500)]">{m.help}</div>}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-[var(--sl300)]">
                        {m.points.map((p, i) => (
                          <span key={i}>
                            {Object.keys(p.labels).length > 0 && <span className="text-[var(--sl500)]">{Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(" ")}{" "}</span>}
                            <b className="text-[var(--ac-cyan200)]">{formatMetricValue(p.value)}</b>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {health.rateStore && (
                  <div className={`${card} space-y-1`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <b className="text-xs text-[var(--sl200)]">Hız sınırı deposu</b>
                      <span className="text-[10.5px] text-[var(--sl500)]">
                        {health.rateStore.shared ? "paylaşımlı (örnekler arası)" : "süreç belleği"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                      <span className={health.rateStore.shared ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-amber300)]"}>
                        {health.rateStore.kind}
                      </span>
                      {health.rateStore.health && (
                        <span className={health.rateStore.health.ok ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-red300)]"}>
                          {health.rateStore.health.ok ? "sağlıklı" : "FAIL-OPEN"}
                        </span>
                      )}
                    </div>
                    {health.rateStore.health && (
                      <p className="text-[10.5px] leading-relaxed text-[var(--sl400)]">{health.rateStore.health.detail}</p>
                    )}
                    {health.rateStore.warning && (
                      <p className="text-[10.5px] leading-relaxed text-[var(--ac-amber300)]">{health.rateStore.warning}</p>
                    )}
                    {!health.rateStore.shared && (
                      <p className="text-[10px] leading-relaxed text-[var(--sl500)]">
                        Tek örnekte sorun değil; birden çok örnekte gerçek sınır örnek sayısıyla çarpılır — REDIS_URL tanımlayın.
                      </p>
                    )}
                  </div>
                )}
                <p className="text-[10.5px] leading-relaxed text-[var(--sl500)]">{health.note}</p>
              </>
            )}
            {!health && !healthBusy && <p className="text-xs text-[var(--sl500)]">Sağlık verisi yüklenmedi.</p>}
          </div>
        )}

        {tab === "backup" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} flex flex-wrap items-center gap-2`}>
              <b className="text-sm text-[var(--sl100)]">Yedekleme ve felaket kurtarma (DR) tatbikatı</b>
              <span className="text-[11px] text-[var(--sl500)]">depo: {drill?.store ?? "…"}</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <button className={`${btn} bg-cyan-500 text-[var(--sl950)] disabled:opacity-40`} disabled={drillBusy} onClick={() => void runDrillNow(true)}>
                  {drillBusy ? "Koşuluyor…" : "▶ Tatbikatı koş (geri yükleme provası ile)"}
                </button>
                <button className={`${btn} border border-[var(--sl400)]/40 text-[var(--sl300)] disabled:opacity-40`} disabled={drillBusy} onClick={() => void runDrillNow(false)}>
                  Özet denetimi (provasız)
                </button>
                <a className={`${btn} border border-emerald-400/40 text-[var(--ac-emerald300)] hover:bg-emerald-400/10`} href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/admin/backup?download=1`}>⤓ Manifest indir</a>
              </div>
            </div>
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-[11px] leading-relaxed text-[var(--ac-amber200)]">
              Tatbikat manifestteki <b>her dosyanın özetini yeniden hesaplar</b> ve isteğe bağlı olarak baytları geçici bir
              yazıcıya yazıp geri okur. Depoya <b>yazmaz</b>, dosya <b>silmez</b>. Manifest indirmek yedek değildir: veritabanı
              yedeği <code>pg_dump</code> ile alınır (docs/YEDEK_VE_DR.md) ve yedek şifreleme anahtarı ayrıca saklanmalıdır.
            </p>
            {drillErr && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-[var(--ac-rose200)]">{drillErr}</div>}
            {drill?.readiness && (
              <div className={`rounded-lg border p-3 text-xs ${LEVEL_STYLE[drill.readiness.level]}`}>
                <b className="mr-2">{LEVEL_LABEL[drill.readiness.level]}</b>{drill.readiness.text}
                {drill.last && <span className="ml-2 text-[10.5px] opacity-80">son tatbikat: {new Date(drill.last.at).toLocaleString("tr-TR")}</span>}
              </div>
            )}
            {(drillOut ?? drill?.last) && (() => {
              const r: DrillReport = (drillOut ?? (drill?.last as unknown as DrillReport));
              return (
                <div className="space-y-3">
                  <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${r.ok ? "border-emerald-500/40 bg-emerald-500/10 text-[var(--ac-emerald200)]" : "border-rose-500/50 bg-rose-500/10 text-[var(--ac-rose200)]"}`}>
                    {r.ok ? "✓" : "✗"} {r.summary}
                  </div>
                  {r.restoreTrial && (
                    <p className="text-[11px] text-[var(--sl300)]">
                      Geri yükleme provası: {r.restoreTrial.ran ? (r.restoreTrial.ok ? "başarılı" : "BAŞARISIZ") : "yapılmadı"} · yazılan {r.restoreTrial.written} · başarısız {r.restoreTrial.failed}
                    </p>
                  )}
                  {(r.notes?.length ?? 0) > 0 && (
                    <ul className="space-y-0.5 text-[11px] text-[var(--ac-amber200)]">{r.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
                  )}
                  {r.extra.length > 0 && (
                    <p className="text-[10.5px] text-[var(--sl500)]">Manifestte olmayan dosyalar: {r.extra.slice(0, 12).join(", ")}{r.extra.length > 12 ? "…" : ""}</p>
                  )}
                  <div className={`${card} max-h-[50vh] overflow-auto p-0`}>
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-[var(--t06)] text-left text-[var(--sl500)]">
                        <tr>{["Dosya", "Durum", "Boyut", "Beklenen özet", "Okunan özet"].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1.5 font-semibold">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {r.results.map((f) => (
                          <tr key={f.key}>
                            <td className="max-w-[280px] truncate border-b border-[var(--t18)] px-2 py-1 font-mono text-[10px] text-[var(--sl300)]" title={f.key}>{f.key}</td>
                            <td className={`border-b border-[var(--t18)] px-2 py-1 font-bold ${f.state === "saglam" ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-rose300)]"}`}>{f.state}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[10px] text-[var(--sl400)]">{formatBytes(f.size)}</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[9.5px] text-[var(--sl500)]">{f.expected.slice(0, 16)}…</td>
                            <td className="border-b border-[var(--t18)] px-2 py-1 font-mono text-[9.5px] text-[var(--sl500)]">{f.actual ? `${f.actual.slice(0, 16)}…` : "—"}</td>
                          </tr>
                        ))}
                        {r.results.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-[var(--sl500)]">Doğrulanacak dosya yok — depo boş olabilir.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
            <div className={`${card} space-y-1 text-[11px] leading-relaxed text-[var(--sl400)]`}>
              <b className="text-[var(--sl200)]">DR kontrol listesi</b>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>Veritabanı: <code>pg_dump</code> günlük; geri yükleme ayrı sunucuda denenmeli.</li>
                <li>Şifreleme anahtarı: <code>DATA_ENCRYPTION_KEYS</code> yedekten <b>ayrı</b> saklanır (anahtarsız yedek açılamaz).</li>
                <li>Nesne deposu: yaşam döngüsü + nesne kilidi (WORM) kurum politikasına göre.</li>
                <li>Tatbikat kaydı: her çalıştırma denetim zincirine <code>backup.drill</code> olarak yazılır.</li>
              </ul>
            </div>
          </div>
        )}

        {tab === "sharing" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} flex flex-wrap items-center gap-2`}>
              <b className="text-sm text-[var(--sl100)]">Süreli paylaşım bağlantıları</b>
              <span className="text-[11px] text-[var(--sl500)]">yalnız onaylı rapor paylaşılır; her erişim sayılır ve denetlenir</span>
              <button className={`${btn} ml-auto border border-[var(--sl500)]/40 text-[var(--sl300)]`} onClick={() => void loadShares()}>↻ Yenile</button>
            </div>
            {sharesErr && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-[var(--ac-rose200)]">{sharesErr}</div>}
            {(() => {
              const now = new Date();
              const active = shares.filter((x) => !x.revokedAt && new Date(x.expiresAt) > now).length;
              const revoked = shares.filter((x) => x.revokedAt).length;
              const expired = shares.length - active - revoked;
              const accesses = shares.reduce((n, x) => n + (x.accessCount ?? 0), 0);
              return (
                <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
                  {[["Bağlantı", shares.length], ["Aktif", active], ["Kapatıldı", revoked], ["Erişim (toplam)", accesses]].map(([l, v]) => (
                    <div key={String(l)} className={card}>
                      <div className="text-[10px] uppercase tracking-wide text-[var(--sl500)]">{l}</div>
                      <div className="mt-0.5 font-mono text-xl font-black text-[var(--ac-cyan300)]">{String(v)}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {expiredHint(shares) && <p className="text-[10.5px] text-[var(--sl500)]">{expiredHint(shares)}</p>}
            <div className={`${card} overflow-x-auto p-0`}>
              <table className="w-full text-[11px]">
                <thead className="bg-[var(--t06)] text-left text-[var(--sl500)]">
                  <tr>{["Token", "Oluşturan", "Rapor", "Oluşturma", "Bitiş", "Durum", "Erişim", ""].map((h) => <th key={h} className="border-b border-[var(--t25)] px-2 py-1.5 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {shares.map((x) => {
                    const rem = shareRemaining(x.expiresAt, x.revokedAt);
                    return (
                      <tr key={x.id} className="hover:bg-[var(--t14)]">
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 font-mono text-[10px] text-[var(--sl300)]" title="Tam token yalnız oluşturma anında gösterilir">
                          {maskShareToken(x.token)}
                          <a className="ml-1 text-[var(--ac-cyan400)] hover:underline" href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/paylas/${x.token}`} target="_blank" rel="noreferrer">aç ↗</a>
                        </td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 text-[var(--sl300)]">{x.createdByName || "—"}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 font-mono text-[10px] text-[var(--sl400)]">{x.reportId ? `#${x.reportId}` : x.kind}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 text-[10px] text-[var(--sl500)]">{new Date(x.createdAt).toLocaleString("tr-TR")}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 text-[10px] text-[var(--sl500)]">{new Date(x.expiresAt).toLocaleString("tr-TR")}</td>
                        <td className={`border-b border-[var(--t18)] px-2 py-1.5 font-semibold ${x.revokedAt ? "text-[var(--sl500)]" : rem.hours === 0 ? "text-[var(--sl500)]" : "text-[var(--ac-emerald300)]"}`}>{rem.text}</td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 font-mono text-[10px] text-[var(--sl400)]">
                          {x.accessCount}{x.lastAccessAt ? <span className="ml-1 text-[var(--sl600)]">(son {new Date(x.lastAccessAt).toLocaleDateString("tr-TR")})</span> : null}
                        </td>
                        <td className="border-b border-[var(--t18)] px-2 py-1.5 text-right">
                          {!x.revokedAt && new Date(x.expiresAt) > new Date() ? (
                            <button className={`${btn} border border-rose-400/40 px-2 py-0.5 text-[var(--ac-rose300)] hover:bg-rose-400/10 disabled:opacity-40`} disabled={shareBusy === x.token} onClick={() => void revokeShareNow(x.token)}>Kapat</button>
                          ) : <span className="text-[10px] text-[var(--sl600)]">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {shares.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-[var(--sl500)]">Kayıtlı paylaşım bağlantısı yok. Rapor ekranındaki “Paylaş” düğmesi ya da görüntüleyicideki `Dışa aktar ▾ → Anonim kesit paylaş` ile oluşturulur.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="text-[10.5px] leading-relaxed text-[var(--sl500)]">
              Token tam olarak yalnız oluşturulduğu anda gösterilir; burada ilk 8 karakter görünür (denetim kaydıyla aynı).
              Bağlantı kapatıldığında süresi dolmamış olsa bile erişim anında reddedilir (410); görüntü paylaşımlarında
              kapalı bağlantının anonim JPEG paketi nesne deposundan da silinir.
            </p>
          </div>
        )}

        {tab === "integration" && settings && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">PACS — DICOMweb (QIDO-RS / WADO-RS)</h2>
              {pacs && (
                <div className="mt-3 grid gap-2">
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="PACS önceden ayarla"
                      className={`${input} shrink-0`}
                      value=""
                      onChange={(e) => {
                        const p = PACS_PRESETS[Number(e.target.value)];
                        if (!p) return;
                        setPacs({ ...pacs, ...p.fill, kind: p.kind, auth: { ...pacs.auth, ...(p.fill.auth ?? {}) } });
                        setPacsHint(p.hint);
                      }}
                    >
                      <option value="">Önceden ayarla…</option>
                      {PACS_PRESETS.map((p, i) => (
                        <option key={p.label} value={i}>{p.label}</option>
                      ))}
                    </select>
                    <input className={`${input} flex-1`} placeholder="Bağlantı adı (ör. Radyoloji PACS)" value={pacs.name} onChange={(e) => setPacs({ ...pacs, name: e.target.value })} />
                  </div>
                  <input className={input} placeholder="QIDO-RS kökü — ör. https://pacs.kurum.local/dicom-web" value={pacs.qidoRoot} onChange={(e) => setPacs({ ...pacs, qidoRoot: e.target.value })} />
                  <input className={input} placeholder="WADO-RS kökü (farklıysa; boş bırakılırsa QIDO kökü kullanılır)" value={pacs.wadoRoot} onChange={(e) => setPacs({ ...pacs, wadoRoot: e.target.value })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Kimlik tipi" className={`${input} shrink-0`} value={pacs.auth.type} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, type: e.target.value as PacsAuthType } })}>
                      {Object.entries(AUTH_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    {pacs.auth.type === "basic" && (
                      <>
                        <input className={`${input} w-32`} placeholder="Kullanıcı adı" value={pacs.auth.username} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, username: e.target.value } })} />
                        <input type="password" className={`${input} w-36`} placeholder={pacs.hasPassword ? "•••• (kayıtlı)" : "Parola"} value={pacs.auth.password} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, password: e.target.value } })} />
                      </>
                    )}
                    {pacs.auth.type === "bearer" && (
                      <input type="password" className={`${input} flex-1`} placeholder={pacs.hasToken ? "•••• (kayıtlı)" : "Bearer token / OIDC jetonu"} value={pacs.auth.token} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, token: e.target.value } })} />
                    )}
                    {pacs.auth.type === "header" && (
                      <>
                        <input className={`${input} w-40`} placeholder="Başlık adı (X-Api-Key)" value={pacs.auth.headerName} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, headerName: e.target.value } })} />
                        <input type="password" className={`${input} flex-1`} placeholder={pacs.hasHeader ? "•••• (kayıtlı)" : "Başlık değeri"} value={pacs.auth.headerValue} onChange={(e) => setPacs({ ...pacs, auth: { ...pacs.auth, headerValue: e.target.value } })} />
                      </>
                    )}
                  </div>
                  <details className="rounded border border-[var(--t25)] p-2">
                    <summary className="cursor-pointer text-[11px] text-[var(--sl400)]">TLS / mTLS — kurumsal PACS (opsiyonel){pacs.tls.clientCertPem || pacs.hasClientKey ? " · kayıtlı" : ""}</summary>
                    <div className="mt-2 grid gap-1.5">
                      <textarea className={`${input} h-14 w-full font-mono text-[10px]`} placeholder="CA (PEM) — kurumsal CA'nın kök/ara sertifikası; boşsa sistem CA'ları kullanılır" value={pacs.tls.caPem} onChange={(e) => setPacs({ ...pacs, tls: { ...pacs.tls, caPem: e.target.value } })} />
                      <textarea className={`${input} h-14 w-full font-mono text-[10px]`} placeholder="İstemci sertifikası (PEM) — mTLS isteyen PACS'lar için; anahtarla birlikte verilmeli" value={pacs.tls.clientCertPem} onChange={(e) => setPacs({ ...pacs, tls: { ...pacs.tls, clientCertPem: e.target.value } })} />
                      <textarea className={`${input} h-14 w-full font-mono text-[10px]`} placeholder={pacs.hasClientKey ? "•••• (kayıtlı — değiştirmek için yapıştırın)" : "İstemci özel anahtarı (PEM) — sunucuda AES-256-GCM ile şifreli saklanır"} value={pacs.tls.clientKeyPem} onChange={(e) => setPacs({ ...pacs, tls: { ...pacs.tls, clientKeyPem: e.target.value } })} />
                      <p className="text-[10px] leading-snug text-[var(--sl500)]">AET/IP beyaz listesi, VPN ve AE başlığı PACS altyapısının işidir — notlar alanına yazın. CA/istemci sertifikası gizli değildir; özel anahtar şifrelenir ve yönetim ekranına geri gösterilmez. mTLS için sertifika ve anahtar birlikte girilmelidir.</p>
                    </div>
                  </details>
                  <label className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--sl400)]">
                    <span className="flex items-center gap-1"><input type="checkbox" checked={pacs.allowSelfSigned} onChange={(e) => setPacs({ ...pacs, allowSelfSigned: e.target.checked })} /> self-signed sertifikaya izin ver</span>
                    <span className="flex items-center gap-1"><input type="checkbox" checked={pacs.includefield} onChange={(e) => setPacs({ ...pacs, includefield: e.target.checked })} /> includefield kullan</span>
                    <span className="flex items-center gap-1">sonuç sınırı
                      <input type="number" min={1} max={1000} className={input} style={{ width: 72 }} value={pacs.limit} onChange={(e) => setPacs({ ...pacs, limit: Number(e.target.value) || 50 })} />
                    </span>
                  </label>
                  <input className={input} placeholder="MWL kökü (farklıysa) — ör. https://pacs/dcm4chee-arc/aets/AET/rs" value={mwlEndpoints.mwlRoot} onChange={(e) => setMwlEndpoints({ ...mwlEndpoints, mwlRoot: e.target.value })} />
                  <input className={input} placeholder="DIMSE C-FIND köprüsü — ör. http://127.0.0.1:2580/cfind" value={mwlEndpoints.dimseUrl} onChange={(e) => setMwlEndpoints({ ...mwlEndpoints, dimseUrl: e.target.value })} />
                  <p className="text-[10.5px] text-[var(--sl500)]">İş listesi (MWL) bu sırayla denenir: MWL kökü → DICOMweb → DIMSE köprüsü. Köprü süreci: <code className="text-[var(--sl400)]">npm run mwl:cfind</code>. Köprü ayarını kaydetmek için aşağıdaki Kaydet düğmesi tüm alanları yazar.</p>
                  <textarea className={`${input} h-16 w-full resize-none`} placeholder="Kurum notları (AE başlığı, port, conformance statement vb.)" value={pacs.notes} onChange={(e) => setPacs({ ...pacs, notes: e.target.value })} />
                  {pacsHint && <p className="text-[11px] text-[var(--ac-cyan300)]/90">💡 {pacsHint}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <button className={`${btn} bg-cyan-500 text-[var(--sl950)]`} onClick={() => void savePacs()}>Kaydet</button>
                    <button className={`${btn} bg-[var(--sl700)] text-[var(--sl100)] disabled:opacity-50`} disabled={pacsTesting} onClick={() => void testPacs()}>
                      {pacsTesting ? "Test ediliyor…" : "Bağlantıyı test et"}
                    </button>
                    <span className="text-[10.5px] text-[var(--sl500)]">{settings.env.pacsAuth ? "ortam: PACS_AUTH_HEADER tanımlı" : "ortam: PACS_AUTH_HEADER yok"}</span>
                  </div>
                  {pacsTest && (
                    <ul className="grid gap-1">
                      {pacsTest.steps.map((s, i) => (
                        <li key={`${s.name}-${i}`} className={`rounded border px-2 py-1 text-[11px] ${s.ok ? "border-emerald-500/30 bg-emerald-500/10 text-[var(--ac-emerald200)]" : "border-rose-500/30 bg-rose-500/10 text-[var(--ac-rose200)]"}`}>
                          <b>{s.name}</b> {s.http !== null ? `· HTTP ${s.http}` : "· ağ"}{s.ms ? ` · ${s.ms} ms` : ""} — {s.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p className="mt-3 text-[11px] text-[var(--sl500)]">
                Kimlik bilgileri sunucuda AES-256-GCM ile şifrelenir; istekler tarayıcıdan değil uygulama sunucusundan gider (CORS/PHI riski yok).
                DIMSE (C-FIND/C-MOVE) doğrudan desteklenmez — yalnızca DICOMweb uçları veya Orthanc/dcm4chee kapısı kullanın.
              </p>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Kritik bulgu bildirimi (e-posta · SMS · çağrı · webhook)</h2>
              <input id="hook" defaultValue={settings.criticalWebhookUrl} placeholder="https://… (eski tek webhook, POST JSON)" className={`${input} mt-3 w-full`} />
              <p className="mt-2 text-[11px] text-[var(--sl500)]">Kritik/yüksek aday bulguda uygulama içi bildirim + aşağıdaki kanallara POST. Aynı olay tüm kanallara <b>kimliksiz</b> gider (önem, çalışma UID, modalite, kısa mesaj) — hasta adı/numarası gönderilmez. Kurumun SMTP relay&apos;i, SMS/pager ağ geçidi veya mobil-push köprüsü tek bir HTTP uç noktası olarak tanımlanır.</p>
              <textarea id="chans" defaultValue={settings.notifyChannels} rows={8} spellCheck={false}
                placeholder={'[\n  {"kind":"email","url":"https://mail.kurum.local/notify","to":"radyolog@kurum.local","minSeverity":"yuksek"},\n  {"kind":"sms","url":"https://sms.kurum.local/send","to":"+90555…"},\n  {"kind":"pager","url":"https://pager.kurum.local/push","to":"0042","minSeverity":"kritik"},\n  {"kind":"webhook","url":"https://bridge.kurum.local/push","minSeverity":"orta"}\n]'}
                className={`${input} mt-3 w-full font-mono text-[11px]`} />
              <p className="mt-1 text-[10.5px] text-[var(--sl500)]">Varsayılan eşikler: webhook/e-posta <b>yüksek</b>, SMS/çağrı <b>kritik</b>. <code>enabled:false</code> ile kanalı kapatabilirsiniz. Geçersiz kayıt listeyi bozmaz; hata mesajı gösterilir.</p>
              {!!settings.notifyChannelErrors?.length && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--ac-amber300)]">{settings.notifyChannelErrors.map((e, i) => <li key={i}>⚠ {e}</li>)}</ul>
              )}
              {notifyTest && (
                <ul className="mt-2 space-y-0.5 text-[11px]">
                  {notifyTest.results.length === 0 && <li className="text-[var(--sl400)]">Tanımlı kanal yok — test gönderilmedi.</li>}
                  {notifyTest.results.map((r) => (
                    <li key={r.id} className={r.ok ? "text-[var(--ac-emerald300)]" : "text-[var(--ac-rose300)]"}>
                      {r.ok ? "✓" : "✕"} {r.id} ({r.kind}) {r.status !== null ? `· HTTP ${r.status}` : "· ağ"} · {r.ms} ms{r.error ? ` — ${r.error}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button className={`${btn} bg-cyan-500 text-[var(--sl950)]`} onClick={() => void saveSettings({ criticalWebhookUrl: (document.getElementById("hook") as HTMLInputElement).value, notifyChannels: (document.getElementById("chans") as HTMLTextAreaElement).value })}>Kaydet</button>
                <button className={`${btn} border border-cyan-400/40 text-[var(--ac-cyan200)] hover:bg-cyan-400/10`} disabled={notifyTesting}
                  onClick={async () => {
                    setNotifyTesting(true); setNotifyTest(null);
                    const r = await api<{ error?: string; results: { id: string; kind: string; ok: boolean; status: number | null; ms: number; error?: string }[] }>("/api/notifications/test", { method: "POST" });
                    setNotifyTesting(false);
                    if (!r.ok) { flash(r.data.error ?? "Test gönderilemedi"); setNotifyTest({ results: [] }); return; }
                    setNotifyTest({ results: r.data.results });
                    flash(r.data.results.every((x) => x.ok) ? "Test iletildi" : "Bazı kanallar başarısız");
                  }}>{notifyTesting ? "Gönderiliyor…" : "Test gönder"}</button>
              </div>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">HBYS / RIS istem alımı</h2>
              <p className="mt-2 text-xs text-[var(--sl300)]">Durum: {settings.env.his ? <b className="text-[var(--ac-emerald300)]">etkin (HIS_API_KEY tanımlı)</b> : <b className="text-[var(--ac-amber300)]">kapalı — HIS_API_KEY tanımlayın</b>}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-[var(--t45)] p-2 text-[10.5px] text-[var(--sl300)]">{`POST /api/his/orders\nx-api-key: <HIS_API_KEY>\n{"patientName":"…","patientId":"…","accessionNumber":"A123",\n "modality":"CT","bodyPart":"BEYİN","description":"Beyin BT"}`}</pre>
              <p className="mt-2 text-[11px] text-[var(--sl500)]">HL7 v2 (MLLP) alıcısı ayrı süreçle çalışır: <code>npm run hl7:mllp</code> (ORM^O01/ORU^R01 → ACK + sipariş). Modality Worklist: <code>npm run mwl:cfind</code> köprüsü ve Çalışma listesi → İş listesi (MWL). Rapor çıktısı: <code>/api/reports/&#123;id&#125;/fhir</code> (FHIR R4 DiagnosticReport).</p>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-[var(--sl100)]">Üretken yapay zeka (taslak izlenim)</h2>
              <p className="mt-2 text-xs text-[var(--sl300)]">Durum: {settings.env.llm ? <b className="text-[var(--ac-emerald300)]">etkin (LLM_API_URL + LLM_API_KEY)</b> : <b className="text-[var(--ac-amber300)]">yapılandırılmadı — kural tabanlı yedek kullanılır</b>}</p>
              <p className="mt-2 text-[11px] text-[var(--sl500)]">OpenAI uyumlu uç nokta. Yalnızca hekimin doğruladığı bulgu metinleri gönderilir; hasta adı/kimliği gönderilmez. Çıktı her zaman &quot;taslak&quot; etiketlidir. KVKK açısından yurt dışı aktarımı değerlendirin.</p>
            </div>
          </div>
        )}

        {tab === "compliance" && settings && (
          <div className="mt-4 space-y-2">
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-[var(--ac-amber200)]">Aşağıdakiler <b>kodla tamamlanamayan</b>, kurum/üretici tarafından yürütülmesi gereken süreçlerdir. Bu liste yalnızca takip içindir; hukuki/regülasyon danışmanlığı değildir. Bulgu gösteren yapay zeka yazılımı çoğu yargı alanında tıbbi cihaz yazılımı sayılır.</div>
            {COMPLIANCE.map((c) => (
              <div key={c.id} className={`${card} flex items-center gap-3 py-3`}>
                <div className="min-w-0 flex-1"><div className="text-[12.5px] font-bold text-[var(--sl100)]">{c.t}</div>{c.h && <div className="text-[11px] text-[var(--sl500)]">{c.h}</div>}</div>
                <select value={comp[c.id] ?? "yapilmadi"} onChange={(e) => { const n = { ...comp, [c.id]: e.target.value }; setComp(n); void saveSettings({ compliance: JSON.stringify(n) }); }} className={input}>
                  <option value="yapilmadi">Yapılmadı</option><option value="devam">Devam ediyor</option><option value="tamam">Tamamlandı</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
