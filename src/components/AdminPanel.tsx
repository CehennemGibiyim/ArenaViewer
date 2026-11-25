"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@/lib/types";
import { AUTH_LABELS, PACS_PRESETS, type PacsAuthType, type PacsConfig } from "@/lib/pacsPresets";

type Tab = "profile" | "sessions" | "users" | "audit" | "ai" | "stats" | "security" | "integration" | "compliance";
interface AuditRow { id: number; ts: string; username: string; action: string; entityType: string; entityId: string; details: string; hash: string }
interface UserRow { id: number; username: string; fullName: string; title: string; regNo: string; role: string; active: boolean; twoFactorEnabled: boolean; lastLoginAt: string | null }
interface SessionRow { id: string; userId: number; username: string; fullName: string; role: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null; ip: string; client: string; state: "aktif" | "suresi-dolmus" | "iptal-edilmis"; current: boolean }
interface RegistryRow { id?: number; name: string; version: string; modality: string; task: string; stage: "aday" | "aktif" | "emekli"; trafficPercent: number; fingerprint: string; notes: string; updatedAt?: string }
interface RegistryState { entries: RegistryRow[]; summary: Record<string, number>; issues: string[] }
interface PerfRow { engine: string; category: string; shown: number; approved: number; rejected: number; edited: number; pending: number; manualAdded: number; ppv: number | null }
interface WorkflowStats {
  total: number; byStatus: Record<string, number>; byModality: Record<string, number>;
  approved: number; medianHours: number | null; p90Hours: number | null; meanHours: number | null;
  pendingDrafts: number; staleDrafts: { olderDays: number; count: number };
  perRadiologist: { name: string; approved: number; medianHours: number | null; p90Hours: number | null }[];
}
interface WeekBucket { weekStart: string; label: string; approved: number; medianHours: number | null; p90Hours: number | null }
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
type PacsForm = PacsConfig & { hasPassword: boolean; hasToken: boolean; hasHeader: boolean };
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

const card = "rounded-xl border border-[#1e2735] bg-[#0b1018] p-4";
const input = "rounded-lg border border-[#1e2735] bg-[#0e141d] px-2.5 py-1.5 text-xs text-slate-100 focus:border-cyan-400/50 focus:outline-none";
const btn = "cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold";

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
  const [perf, setPerf] = useState<{ rows: PerfRow[]; note: string } | null>(null);
  // iş akışı istatistikleri (F4)
  const [stats, setStats] = useState<WorkflowStats | null>(null);
  const [statsNote, setStatsNote] = useState("");
  // Haftalık TAT trendi ve hedef eşiği (f-tat)
  const [weekly, setWeekly] = useState<WeekBucket[]>([]);
  const [tatTargetState, setTatTargetState] = useState<TatTarget | null>(null);
  const [tatAlertList, setTatAlertList] = useState<string[]>([]);
  const [targetHours, setTargetHours] = useState("24");
  const [trendModality, setTrendModality] = useState("");
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
        const r = await api<{ rows: PerfRow[]; note: string }>("/api/ai/performance");
        if (r.ok) setPerf(r.data);
        await loadRegistry();
      }
      if (tab === "stats") await loadStats(targetHoursRef.current, trendModalityRef.current);
      if (["security", "integration", "compliance"].includes(tab)) await loadSettings();
      if (tab === "security") await loadKeyring();
    })();
  }, [tab, loadProfile, loadAudit, loadSiem, loadStats, loadSettings, loadUsers, loadMfa, loadKeyring, loadSessions, loadRegistry]);

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

  const tabs: [Tab, string][] = [["profile", "Profil & MFA"], ["sessions", "Oturumlar"], ["users", "Kullanıcılar"], ["audit", "Denetim kaydı"], ["ai", "AI performans"], ["stats", "İş akışı"], ["security", "Güvenlik & saklama"], ["integration", "Entegrasyon"], ["compliance", "Uyum"]];

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
    <div className="h-screen w-screen overflow-y-auto bg-[#070a0f] text-slate-200">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[#1a2230] bg-[#0b0f16]/95 px-5 py-3 backdrop-blur print:hidden">
        <Link href="/" className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-500/20">← Görüntüleyici</Link>
        <h1 className="font-mono text-sm font-black tracking-[0.15em] text-slate-100">ATIK<span className="text-cyan-400">VIEWER</span> · YÖNETİM</h1>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-400" title={`Rol: ${user.role}`}>{user.title} {user.fullName} · <span className="font-mono text-[10px] text-slate-500">{user.role}</span></span>
          <button className={`${btn} border border-rose-400/40 text-rose-300 hover:bg-rose-400/10`} onClick={() => void apiFetch("/api/auth/logout", { method: "POST" }).finally(() => { window.location.reload(); })}>⎋ Çıkış</button>
        </span>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">
        <div className="flex flex-wrap gap-1.5 print:hidden">
          {tabs.map(([id, l]) => <button key={id} onClick={() => setTab(id)} className={`${btn} ${tab === id ? "bg-cyan-400/15 text-cyan-300 ring-1 ring-cyan-400/40" : "text-slate-400 hover:text-slate-200"}`}>{l}</button>)}
        </div>
        {msg && <div className="mt-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200">{msg}</div>}

        {tab === "profile" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">Profil — hekim bilgileri</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Bu bilgiler onaylanan raporların imza satırına yazılır. Hesabınız oturumla
                bağlıdır; bu ad raporlarda kimliğinizi temsil eder.
              </p>
              <div className="mt-3 grid gap-2">
                <label className="text-[11px] font-semibold text-slate-400">Ad soyad
                  <input value={prof.fullName} onChange={(e) => setProf({ ...prof, fullName: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Ayşe Kaya" />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-semibold text-slate-400">Unvan
                    <input value={prof.title} onChange={(e) => setProf({ ...prof, title: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Uzm. Dr." />
                  </label>
                  <label className="text-[11px] font-semibold text-slate-400">Sicil / diploma no
                    <input value={prof.regNo} onChange={(e) => setProf({ ...prof, regNo: e.target.value })} className={`${input} mt-1 w-full`} placeholder="148291" />
                  </label>
                </div>
              </div>
              <button className={`${btn} mt-3 bg-cyan-500 text-slate-950`} onClick={() => void saveProfile()}>Kaydet</button>
              <div className="mt-3 rounded-lg border border-[#232e40] bg-[#0e141d] p-2.5 text-xs">
                <div className="text-[10px] uppercase tracking-widest text-slate-500">Rapordaki görünüm</div>
                <div className="mt-1 font-semibold text-slate-100">{prof.title} {prof.fullName || "(ad girilmedi)"}</div>
                <div className="text-slate-400">Sicil/diploma: {prof.regNo || "—"}</div>
              </div>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-emerald-300">İki faktörlü doğrulama (MFA)</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Girişe ek olarak, authenticator uygulamasındaki zaman tabanlı kod (TOTP) istenir.
                Yönetici hesapları için MFA <b>zorunlu</b>dur
                {` (${process.env.REQUIRE_TOTP_FOR_ROLES ?? "yonetici"})`}.
              </p>
              {userMsg && tab === "profile" && <div className="mt-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200">{userMsg}</div>}
              {!mfa && <p className="mt-3 text-xs text-slate-500">Durum yüklenmedi.</p>}
              {mfa?.enabled && (
                <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  ✓ MFA açık. Girişlerde kod istenir.
                  <button className={`${btn} mt-2 border border-rose-400/40 text-rose-300 hover:bg-rose-400/10`} onClick={() => void disableMfa()}>MFA&apos;yı kapat</button>
                </div>
              )}
              {!mfa?.enabled && !mfa?.qr && (
                <button className={`${btn} mt-3 bg-emerald-500 text-slate-950`} onClick={() => void startMfa()}>MFA kurulumunu başlat</button>
              )}
              {!mfa?.enabled && mfa?.qr && (
                <div className="mt-3 space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- QR kod önceden üretilmiş veri URL'si; statik dosya değil */}
                  <img src={mfa.qr} alt="MFA QR kodu" className="h-40 w-40 rounded-lg border border-[#232e40] bg-white p-1" />
                  <p className="font-mono text-[10px] break-all text-slate-400">{mfa.secret}</p>
                  <label className="block text-[11px] font-semibold text-slate-400">Doğrulama kodu
                    <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\s/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={`${input} mt-1 w-40 tracking-[0.4em]`} placeholder="000000" />
                  </label>
                  <div className="flex gap-2">
                    <button className={`${btn} bg-emerald-500 text-slate-950 disabled:opacity-40`} disabled={mfaBusy || mfaCode.length !== 6} onClick={() => void enableMfa()}>Doğrula ve aç</button>
                    <button className={`${btn} border border-slate-400/40 text-slate-300`} onClick={() => setMfa({ enabled: false })}>Vazgeç</button>
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-slate-500">Rapor onayı hâlâ kimlik kanıtı değildir; içerik SHA-256 ile mühürlenir, denetim zinciri değişikliği saptar.</p>
            </div>
          </div>
        )}

        {tab === "sessions" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} flex flex-wrap items-center gap-2`}>
              <h2 className="text-sm font-bold text-slate-100">Açık oturumlar</h2>
              <p className="w-full text-[11px] leading-relaxed text-slate-400">
                Her giriş sunucuda bir oturum kaydı oluşturur; buradan kapatılan oturumun çerezi
                süresi dolmamış olsa bile <b>anında geçersiz</b> olur. Liste yalnız IP, istemci ve zaman gösterir — oturum anahtarı hiçbir zaman dışarı verilmez.
              </p>
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                <input type="checkbox" checked={sessAll} onChange={(e) => setSessAll(e.target.checked)} disabled={user.role !== "yonetici"} /> tüm kullanıcıların oturumları (yönetici)
              </label>
              <button className={`${btn} ml-auto border border-slate-500/40 text-slate-300`} onClick={() => void loadSessions()}>↻ Yenile</button>
            </div>
            {sessMsg && <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200">{sessMsg}</div>}
            {!sessSupported && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
                Sunucu tarafı oturum kaydı etkin değil. Şemayı uygulayın: <code>npx drizzle-kit push</code>. O zamana kadar oturumlar yalnız imzalı çerezle taşınır.
              </div>
            )}
            {sessSupported && sessRows.length === 0 && <p className="text-xs text-slate-500">Kayıtlı oturum yok.</p>}
            {sessSupported && sessRows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-[#1a2230]">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-[#0e141d] text-slate-400">
                    <tr>
                      <th className="px-2 py-1.5">Kullanıcı</th><th className="px-2 py-1.5">İstemci</th><th className="px-2 py-1.5">IP</th>
                      <th className="px-2 py-1.5">Başlangıç</th><th className="px-2 py-1.5">Son görülme</th><th className="px-2 py-1.5">Bitiş</th>
                      <th className="px-2 py-1.5">Durum</th><th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {sessRows.map((r) => (
                      <tr key={r.id} className={`border-t border-[#161d28] ${r.current ? "bg-cyan-400/5" : ""}`}>
                        <td className="px-2 py-1.5">{r.fullName}<div className="text-[10px] text-slate-500">{r.username} · {r.role}</div></td>
                        <td className="px-2 py-1.5 text-slate-400">{r.client}</td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-slate-500">{r.ip || "—"}</td>
                        <td className="px-2 py-1.5 text-slate-400">{new Date(r.createdAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5 text-slate-400">{new Date(r.lastSeenAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5 text-slate-400">{new Date(r.expiresAt).toLocaleString("tr-TR")}</td>
                        <td className="px-2 py-1.5">
                          <span className={r.state === "aktif" ? "text-emerald-300" : r.state === "iptal-edilmis" ? "text-rose-300" : "text-slate-500"}>
                            {r.state === "aktif" ? "aktif" : r.state === "iptal-edilmis" ? "iptal edildi" : "süresi doldu"}
                          </span>
                          {r.current && <span className="ml-1 rounded bg-cyan-400/20 px-1 text-[9px] text-cyan-200">bu cihaz</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {r.state === "aktif" && (
                            <button className={`${btn} border border-rose-400/40 px-2 py-0.5 text-rose-300 hover:bg-rose-400/10`} onClick={() => void sessionAction({ action: "revoke", id: Number(r.id) })}>
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
                <button className={`${btn} border border-amber-400/40 text-amber-300 hover:bg-amber-400/10`} onClick={() => void sessionAction({ action: "revoke-others" })}>Bu cihaz dışındaki tüm oturumlarımı kapat</button>
                <button className={`${btn} border border-slate-500/40 text-slate-300`} onClick={() => void sessionAction({ action: "purge-expired" })}>Süresi dolmuş kayıtları temizle (90 gün)</button>
              </div>
            )}
          </div>
        )}

        {tab === "users" && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-slate-100">Kullanıcı hesapları ve roller</h2>
              <button className={`${btn} ml-auto bg-cyan-500 text-slate-950`} onClick={() => setShowUserForm((v) => !v)}>+ Yeni kullanıcı</button>
            </div>
            {userMsg && <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200">{userMsg}</div>}
            {showUserForm && (
              <div className={`${card} grid gap-2 sm:grid-cols-2 lg:grid-cols-3`}>
                <label className="text-[11px] font-semibold text-slate-400">Kullanıcı adı
                  <input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} className={`${input} mt-1 w-full`} placeholder="ornek.doktor" />
                </label>
                <label className="text-[11px] font-semibold text-slate-400">Ad soyad
                  <input value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Ayşe Kaya" />
                </label>
                <label className="text-[11px] font-semibold text-slate-400">Unvan
                  <input value={userForm.title} onChange={(e) => setUserForm({ ...userForm, title: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Uzm. Dr." />
                </label>
                <label className="text-[11px] font-semibold text-slate-400">Sicil
                  <input value={userForm.regNo} onChange={(e) => setUserForm({ ...userForm, regNo: e.target.value })} className={`${input} mt-1 w-full`} />
                </label>
                <label className="text-[11px] font-semibold text-slate-400">Rol
                  <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })} className={`${input} mt-1 w-full`}>
                    <option value="radyolog">radyolog</option>
                    <option value="teknisyen">teknisyen</option>
                    <option value="yonetici">yonetici</option>
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-400">Parola (en az 8, harf+rakam)
                  <input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} className={`${input} mt-1 w-full`} />
                </label>
                <div className="sm:col-span-2 lg:col-span-3">
                  <button className={`${btn} bg-cyan-500 text-slate-950 disabled:opacity-40`} disabled={!userForm.username.trim() || userForm.fullName.trim().length < 3 || userForm.password.length < 8} onClick={() => void createUser()}>Oluştur</button>
                </div>
              </div>
            )}
            <div className={`${card} overflow-x-auto p-0`}>
              <table className="w-full text-[11px]">
                <thead className="bg-[#0b1018] text-left text-slate-500"><tr>{["#", "Kullanıcı", "Ad soyad", "Rol", "MFA", "Son giriş", "Durum", ""].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {userList.map((u) => (
                    <tr key={u.id} className="hover:bg-[#101722]">
                      <td className="px-3 py-2 font-mono text-slate-500">{u.id}</td>
                      <td className="px-3 py-2 text-slate-200">{u.username}{u.id === user.id ? " (siz)" : ""}</td>
                      <td className="px-3 py-2 text-slate-300">{[u.title, u.fullName].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2">
                        <select value={u.role} onChange={(e) => void patchUser(u, { role: e.target.value })} className="rounded border border-[#1e2735] bg-[#0e141d] px-1.5 py-1 text-[10.5px] text-slate-100">
                          <option value="radyolog">radyolog</option><option value="teknisyen">teknisyen</option><option value="yonetici">yonetici</option>
                        </select>
                      </td>
                      <td className={`px-3 py-2 ${u.twoFactorEnabled ? "text-emerald-300" : "text-slate-500"}`}>{u.twoFactorEnabled ? "açık" : "kapalı"}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("tr-TR") : "—"}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => void patchUser(u, { active: !u.active })} className={`${btn} border ${u.active ? "border-rose-400/40 text-rose-300 hover:bg-rose-400/10" : "border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10"}`}>{u.active ? "Pasif yap" : "Etkinleştir"}</button>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => { const p = window.prompt("Yeni parola (en az 8 karakter, harf+rakam):"); if (p) void patchUser(u, { password: p }); }} className={`${btn} border border-slate-400/40 text-slate-300 hover:bg-slate-400/10`}>Parola sıfırla</button>
                      </td>
                    </tr>
                  ))}
                  {userList.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">Kullanıcı yok.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "audit" && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <input value={aq} onChange={(e) => setAq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void loadAudit()} placeholder="Ara: kullanıcı, işlem, kayıt…" className={`${input} w-72`} />
              <button className={`${btn} bg-cyan-500 text-slate-950`} onClick={() => void loadAudit()}>Ara</button>
              <button className={`${btn} border border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10`} onClick={async () => { const r = await api<{ ok: boolean; count: number; brokenAtId?: number; reason?: string }>("/api/audit?verify=1"); setChain(r.data); }}>🔗 Hash zincirini doğrula</button>
              <button className={`${btn} border border-slate-400/40 text-slate-200 hover:bg-slate-400/10`} title="Ekrandaki filtreli listeyi CSV olarak indir" onClick={exportAuditCsv}>⬇ CSV</button>
              <button className={`${btn} border border-violet-400/40 text-violet-200 hover:bg-violet-400/10`} title="SIEM kuyruğunu şimdi boşalt (AUDIT_SIEM_URL gerekir)" onClick={async () => { const r = await api<{ configured: boolean; tried: number; sent: number; failed: number; error?: string }>("/api/audit/export", json("POST", {})); setSiemMsg(r.ok ? (r.data.configured ? `SIEM: ${r.data.sent}/${r.data.tried} gönderildi${r.data.failed ? `, ${r.data.failed} başarısız` : ""}${r.data.error ? ` (${r.data.error})` : ""}` : "AUDIT_SIEM_URL tanımlı değil — olaylar kuyrukta birikiyor.") : "Kuyruk boşaltılamadı (yönetici yetkisi gerekir)"); void loadSiem(); }}>📡 SIEM kuyruğu</button>
              <button className={`${btn} border border-slate-400/40 text-slate-200 hover:bg-slate-400/10`} title="Yazdırma penceresinden 'PDF olarak kaydet' seçin" onClick={() => { document.body.classList.add("print-audit"); window.addEventListener("afterprint", () => document.body.classList.remove("print-audit"), { once: true }); window.print(); }}>🖨 PDF</button>
            </div>
            {siem && (
              <p className="text-[11px] text-slate-400">
                SIEM teslimatı: {siem.configured ? <b className="text-emerald-300">etkin (AUDIT_SIEM_URL)</b> : <b className="text-amber-300">yapılandırılmadı — olaylar kuyrukta</b>} ·
                kuyruk <b className="text-slate-200">{siem.pending}</b> · yeniden denenecek <b className="text-amber-300">{siem.failed}</b> · gönderildi <b className="text-emerald-300">{siem.sent}</b> · vazgeçilen <b className="text-rose-300">{siem.abandoned}</b> (en fazla {siem.maxAttempts} deneme)
              </p>
            )}
            {siemMsg && <p className="text-[11px] text-cyan-300">{siemMsg}</p>}
            {chain && <div className={`rounded-lg border px-3 py-2 text-xs font-semibold ${chain.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/50 bg-rose-500/10 text-rose-300"}`}>{chain.ok ? `✓ Zincir bütün: ${chain.count} kayıt, değişiklik/silme yok.` : `✗ Zincir bozuk (kayıt #${chain.brokenAtId}): ${chain.reason}`}</div>}
            <div className={`${card} audit-print max-h-[60vh] overflow-auto p-0`}>
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-[#0b1018] text-left text-slate-500"><tr>{["#", "Zaman", "Kullanıcı", "İşlem", "Kayıt", "Ayrıntı", "Hash"].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="hover:bg-[#101722]">
                      <td className="border-b border-[#141b26] px-3 py-1.5 font-mono text-slate-500">{a.id}</td>
                      <td className="whitespace-nowrap border-b border-[#141b26] px-3 py-1.5 text-slate-400">{new Date(a.ts).toLocaleString("tr-TR")}</td>
                      <td className="border-b border-[#141b26] px-3 py-1.5 text-slate-200">{a.username}</td>
                      <td className={`border-b border-[#141b26] px-3 py-1.5 font-mono font-bold ${/denied|failed|delete|purge/.test(a.action) ? "text-rose-300" : /approve/.test(a.action) ? "text-emerald-300" : "text-cyan-300"}`}>{a.action}</td>
                      <td className="border-b border-[#141b26] px-3 py-1.5 text-slate-400">{a.entityType}{a.entityId ? `#${a.entityId}` : ""}</td>
                      <td className="max-w-[260px] truncate border-b border-[#141b26] px-3 py-1.5 font-mono text-[10px] text-slate-500" title={a.details}>{a.details}</td>
                      <td className="border-b border-[#141b26] px-3 py-1.5 font-mono text-[10px] text-slate-600">{a.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">{perf?.note ?? "Yükleniyor…"}</div>
            <div className={`${card} overflow-x-auto p-0`}>
              <table className="w-full text-[11.5px]">
                <thead className="text-left text-slate-500"><tr>{["Motor", "Kategori", "Gösterilen", "Onaylanan", "Reddedilen", "Düzenlenen", "Bekleyen", "Kesinlik (PPV)", "AI'nın kaçırdığı (hekim ekledi)"].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {(perf?.rows ?? []).length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">Henüz hekim geri bildirimi yok. Raporlarda bulguları Onayla/Reddet olarak işaretledikçe dolar.</td></tr>}
                  {(perf?.rows ?? []).map((r) => (
                    <tr key={`${r.engine}${r.category}`} className="hover:bg-[#101722]">
                      <td className="border-b border-[#141b26] px-3 py-2 font-mono text-cyan-300">{r.engine}</td><td className="border-b border-[#141b26] px-3 py-2">{r.category}</td>
                      <td className="border-b border-[#141b26] px-3 py-2">{r.shown}</td><td className="border-b border-[#141b26] px-3 py-2 text-emerald-300">{r.approved}</td><td className="border-b border-[#141b26] px-3 py-2 text-rose-300">{r.rejected}</td><td className="border-b border-[#141b26] px-3 py-2 text-amber-300">{r.edited}</td><td className="border-b border-[#141b26] px-3 py-2">{r.pending}</td>
                      <td className="border-b border-[#141b26] px-3 py-2 font-bold">{r.ppv === null ? "—" : `%${Math.round(r.ppv * 100)}`}</td><td className="border-b border-[#141b26] px-3 py-2">{r.manualAdded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "ai" && (
          <div className="mt-4 space-y-3">
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-slate-200">Model kayıt defteri</b>
                <span className="text-[10.5px] text-slate-500">
                  {registry ? `aday ${registry.summary.aday ?? 0} · aktif ${registry.summary.aktif ?? 0} · emekli ${registry.summary.emekli ?? 0}` : "yükleniyor…"}
                </span>
              </div>
              {(registry?.issues ?? []).length > 0 && (
                <ul className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10.5px] text-amber-200">
                  {(registry?.issues ?? []).slice(0, 5).map((i) => <li key={i}>• {i}</li>)}
                </ul>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-[11.5px]">
                  <thead className="text-left text-slate-500"><tr>{["Model", "Sürüm", "Modalite", "Görev", "Aşama", "Trafik", "Parmak izi", "Güncelleme"].map((h) => <th key={h} className="border-b border-[#1a2230] px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>
                    {(registry?.entries ?? []).length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-500">Henüz model kaydı yok. Aşağıdaki formla ilk sürümü ekleyin.</td></tr>}
                    {(registry?.entries ?? []).map((r) => (
                      <tr key={`${r.name}@${r.version}`} className="hover:bg-[#101722]">
                        <td className="border-b border-[#141b26] px-2 py-1.5 font-mono text-cyan-300">{r.name}</td>
                        <td className="border-b border-[#141b26] px-2 py-1.5">{r.version}</td>
                        <td className="border-b border-[#141b26] px-2 py-1.5">{r.modality || "—"}</td>
                        <td className="border-b border-[#141b26] px-2 py-1.5">{r.task || "—"}</td>
                        <td className={`border-b border-[#141b26] px-2 py-1.5 font-bold ${r.stage === "aktif" ? "text-emerald-300" : r.stage === "emekli" ? "text-slate-500" : "text-amber-300"}`}>{r.stage}</td>
                        <td className="border-b border-[#141b26] px-2 py-1.5">%{r.trafficPercent}</td>
                        <td className="max-w-[140px] truncate border-b border-[#141b26] px-2 py-1.5 font-mono text-[10px] text-slate-500" title={r.fingerprint}>{r.fingerprint || "—"}</td>
                        <td className="border-b border-[#141b26] px-2 py-1.5 text-[10px] text-slate-500">{r.updatedAt ? new Date(r.updatedAt).toLocaleString("tr-TR") : "—"}</td>
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
                  <button disabled={regBusy || !regForm.name.trim() || !regForm.version.trim()} onClick={() => void saveModel()} className={`${btn} shrink-0 bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-400/40 disabled:opacity-40`}>Kaydet</button>
                </div>
              </div>
              <div className="text-[10px] leading-relaxed text-slate-500">
                Aynı ad + sürüm üzerine yazılır; aşama değişiklikleri denetim izine ({`model.activate`} / {`model.register`}) yazılır.
                A/B ataması tohum (ör. çalışma UID&apos;si) ile deterministiktir; aynı çalışma her zaman aynı modele düşer.
                Kayıt defteri çıkarım yolunu kendiliğinden değiştirmez — dağıtım planıdır.
              </div>
            </div>
          </div>
        )}

        {tab === "stats" && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3 text-xs text-cyan-200">{statsNote}</div>
            <div className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-xs text-slate-200">Haftalık TAT trendi</b>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <span>Hedef (saat)</span>
                  <input value={targetHours} onChange={(e) => setTargetHours(e.target.value)} className={`${input} w-16`} aria-label="Hedef TAT (saat)" />
                  <select value={trendModality} onChange={(e) => setTrendModality(e.target.value)} aria-label="Modalite süzgeci" className={`${input} w-24`}>
                    <option value="">tümü</option>
                    {Object.keys(stats?.byModality ?? {}).sort().map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button onClick={() => void loadStats(targetHours, trendModality)} className={`${btn} bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-400/40`}>Uygula</button>
                  {tatTargetState && (
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-black ${tatTargetState.status === "hedef-icinde" ? "bg-emerald-500/20 text-emerald-200" : tatTargetState.status === "sinirda" ? "bg-amber-500/20 text-amber-200" : tatTargetState.status === "hedef-disi" ? "bg-rose-500/20 text-rose-200" : "bg-slate-500/20 text-slate-300"}`}>
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
                            <text x={i * bw + bw / 2} y={114} textAnchor="middle" fontSize="9" fill="#64748b">{w.label}</text>
                          </g>
                        );
                      })}
                      <line x1="0" y1={targetY} x2="620" y2={targetY} stroke="#fbbf24" strokeWidth="1" strokeDasharray="4 3" />
                    </>
                  );
                })()}
              </svg>
              <div className="text-[10px] text-slate-500">Çubuklar onaylanan raporların haftalık medyan TAT değeri; kesikli çizgi hedef ({targetHours} sa). Boş haftalar ölçüm yok demektir.</div>
              {tatAlertList.length > 0 && (
                <ul className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10.5px] text-amber-200">
                  {tatAlertList.map((a) => <li key={a}>• {a}</li>)}
                </ul>
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
                      <div className="text-[10px] uppercase tracking-wide text-slate-500">{l}</div>
                      <div className="mt-1 font-mono text-xl font-black text-cyan-300">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className={`${card} overflow-x-auto`}>
                    <h3 className="mb-2 text-xs font-bold text-slate-200">Durum dağılımı</h3>
                    <table className="w-full text-[11.5px]">
                      <tbody>{Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <tr key={k}><td className="py-1 pr-3 text-slate-300">{k}</td><td className="py-1 text-right font-mono text-cyan-300">{v}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className={`${card} overflow-x-auto`}>
                    <h3 className="mb-2 text-xs font-bold text-slate-200">Modalite dağılımı</h3>
                    <table className="w-full text-[11.5px]">
                      <tbody>{Object.entries(stats.byModality).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <tr key={k}><td className="py-1 pr-3 text-slate-300">{k}</td><td className="py-1 text-right font-mono text-cyan-300">{v}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
                <div className={`${card} overflow-x-auto`}>
                  <h3 className="mb-2 text-xs font-bold text-slate-200">Hekim başına onaylanan rapor ve TAT</h3>
                  <table className="w-full text-[11.5px]">
                    <thead className="text-left text-slate-500"><tr>{["Hekim", "Onaylanan", "Medyan TAT", "p90 TAT"].map((h) => <th key={h} className="border-b border-[#1a2230] px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                    <tbody>
                      {stats.perRadiologist.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-500">Henüz onaylanmış rapor yok.</td></tr>}
                      {stats.perRadiologist.map((r) => (
                        <tr key={r.name} className="hover:bg-[#101722]">
                          <td className="border-b border-[#141b26] px-3 py-2 text-slate-200">{r.name}</td>
                          <td className="border-b border-[#141b26] px-3 py-2 font-mono text-emerald-300">{r.approved}</td>
                          <td className="border-b border-[#141b26] px-3 py-2 font-mono">{formatHours(r.medianHours)}</td>
                          <td className="border-b border-[#141b26] px-3 py-2 font-mono">{formatHours(r.p90Hours)}</td>
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
              <h2 className="text-sm font-bold text-slate-100">Şifreleme (hareketsiz veri)</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-300">Hasta adı/kimliği, klinik bilgi, anahtar kesit görüntüleri ve sunucuda saklanan DICOM dosyaları <b>AES-256-GCM</b> ile şifrelenir. Anahtar kaynağı: <b className={status.keySource === "env" ? "text-emerald-300" : "text-amber-300"}>{status.keySource === "env" ? "ortam değişkeni (DATA_ENCRYPTION_KEY)" : "sunucu dosyası (.data/enc.key)"}</b>.</p>
              {status.keySource !== "env" && <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[11px] text-amber-200">Üretimde anahtarı veritabanı/diskten ayrı bir KMS veya gizli yönetim servisinde tutup <code>DATA_ENCRYPTION_KEY</code> (base64, 32 bayt) olarak verin. Anahtar kaybolursa veri geri alınamaz.</p>}
              <div className="mt-3 text-xs text-slate-300">Düz metin kalan kayıt: <b className={status.plaintext.studies + status.plaintext.reports ? "text-rose-300" : "text-emerald-300"}>{status.plaintext.studies} çalışma · {status.plaintext.reports} rapor</b></div>
              <button disabled={status.plaintext.studies + status.plaintext.reports === 0} className={`${btn} mt-3 bg-cyan-500 text-slate-950 disabled:opacity-40`} onClick={async () => { const r = await api<{ studies: number; reports: number; error?: string }>("/api/admin/encrypt-legacy", { method: "POST" }); flash(r.ok ? `Şifrelendi: ${r.data.studies} çalışma, ${r.data.reports} rapor` : r.data.error ?? "Hata"); void loadSettings(); }}>Mevcut kayıtları şifrele</button>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">Anahtar rotasyonu (KMS)</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-300">
                Kayıtlar anahtar kimliği taşır (<code>enc:v2:&lt;kimlik&gt;:…</code>); böylece eski anahtarla şifrelenmiş veri,
                yeni anahtar eklenerek <b>kayıpsız</b> yeniden şifrelenebilir. Sıra: ① yeni anahtar üret → ② <code>.env</code>
                içindeki <code>DATA_ENCRYPTION_KEYS</code> değerine ekle → ③ servisi yeniden başlat → ④ &quot;Rotasyonu çalıştır&quot;
                → ⑤ doğrulandıktan sonra eski anahtarı listeden çıkar.
              </p>
              <div className="mt-3 space-y-1 text-[11px] text-slate-400">
                {(keyring?.keys ?? []).map((k) => (
                  <div key={k.kid} className="flex items-center gap-2">
                    <code className={k.current ? "text-emerald-300" : "text-amber-300"}>{k.kid}</code>
                    <span>{k.current ? "aktif (yazar)" : "yalnız okuma"}</span>
                  </div>
                ))}
                {!keyring && <span>Anahtar halkası okunamadı (Yönetim → Güvenlik sekmesini yenileyin).</span>}
              </div>
              {keyring?.rotation && (
                <p className="mt-2 text-[11px] text-slate-300">Rotasyon durumu: <b>{keyring.rotation.summary}</b></p>
              )}
              {newKey && (
                <div className="mt-2 rounded border border-cyan-400/30 bg-cyan-400/5 p-2 text-[10.5px] text-cyan-100">
                  <div className="font-bold">Yeni anahtar (yalnız bir kez gösterilir — güvenli kasaya yazın):</div>
                  <code className="mt-1 block break-all text-[10px] text-cyan-200">{newKey.key}</code>
                  <div className="mt-1 text-slate-300">DATA_ENCRYPTION_KEYS =</div>
                  <code className="block break-all text-[10px] text-slate-200">{newKey.dataEncryptionKeys}</code>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={`${btn} bg-slate-700 text-slate-100`} onClick={async () => {
                  const r = await api<{ key: string; kid: string; dataEncryptionKeys: string; error?: string }>("/api/admin/keyring", json("POST", { action: "generate" }));
                  if (r.ok) { setNewKey(r.data); flash(`Yeni anahtar üretildi (${r.data.kid})`); } else flash(r.data.error ?? "Anahtar üretilemedi");
                }}>Yeni anahtar üret</button>
                <button className={`${btn} bg-cyan-500 text-slate-950 disabled:opacity-40`} disabled={rotateBusy || (keyring?.rotation?.pending ?? 0) === 0} onClick={async () => {
                  setRotateBusy(true);
                  const r = await api<{ written: number; remaining: number; percent: number; note: string; error?: string }>("/api/admin/keyring", json("POST", { action: "rotate" }));
                  setRotateBusy(false);
                  flash(r.ok ? `${r.data.written} kayıt yeniden şifrelendi (%${r.data.percent}, kalan ${r.data.remaining})` : r.data.error ?? "Rotasyon başarısız");
                  void loadKeyring();
                }}>{rotateBusy ? "Rotasyon…" : "Rotasyonu çalıştır"}</button>
                <button className={`${btn} bg-slate-700 text-slate-100 disabled:opacity-40`} disabled={!newKey} onClick={async () => {
                  if (!newKey) return;
                  const r = await api<{ dataEncryptionKeys: string; note: string; error?: string }>("/api/admin/keyring", json("POST", { action: "drop-old", currentKey: newKey.key }));
                  flash(r.ok ? "Eski anahtarlar çıkarıldı — yeni değeri .env'e yazın" : r.data.error ?? "Atma başarısız");
                  if (r.ok) setNewKey({ ...newKey, dataEncryptionKeys: r.data.dataEncryptionKeys });
                }}>Eski anahtarları çıkar</button>
              </div>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">Saklama politikası</h2>
              <p className="mt-2 text-xs text-slate-300">Onaylanmamış taslak raporlar bu süreden sonra silinir (0 = otomatik silme kapalı). Onaylı raporlar silinmez.</p>
              <div className="mt-3 flex items-center gap-2">
                <input type="number" min={0} defaultValue={settings.retentionDraftDays} id="ret" className={`${input} w-24`} />
                <span className="text-xs text-slate-400">gün</span>
                <button className={`${btn} bg-cyan-500 text-slate-950`} onClick={() => void saveSettings({ retentionDraftDays: Number((document.getElementById("ret") as HTMLInputElement).value) })}>Kaydet</button>
                <button className={`${btn} border border-rose-400/40 text-rose-300 hover:bg-rose-400/10`} onClick={async () => { if (!window.confirm("Süresi dolan taslaklar kalıcı olarak silinecek. Devam?")) return; const r = await api<{ deleted: number; error?: string }>("/api/admin/purge-drafts", { method: "POST" }); flash(r.ok ? `${r.data.deleted} taslak silindi` : r.data.error ?? "Hata"); }}>Süresi dolanları sil</button>
              </div>
              <h2 className="mt-5 text-sm font-bold text-slate-100">Kayıt sayıları</h2>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">{Object.entries(status.totals).map(([k, v]) => <div key={k} className="rounded border border-[#1e2735] bg-[#0e141d] p-2"><div className="text-lg font-black text-cyan-300">{v}</div><div className="text-slate-500">{k}</div></div>)}</div>
              <Link href="/gizlilik" className="mt-4 inline-block text-xs text-cyan-400 hover:underline">KVKK aydınlatma metni şablonu →</Link>
            </div>
          </div>
        )}

        {tab === "integration" && settings && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">PACS — DICOMweb (QIDO-RS / WADO-RS)</h2>
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
                  <label className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1"><input type="checkbox" checked={pacs.allowSelfSigned} onChange={(e) => setPacs({ ...pacs, allowSelfSigned: e.target.checked })} /> self-signed sertifikaya izin ver</span>
                    <span className="flex items-center gap-1"><input type="checkbox" checked={pacs.includefield} onChange={(e) => setPacs({ ...pacs, includefield: e.target.checked })} /> includefield kullan</span>
                    <span className="flex items-center gap-1">sonuç sınırı
                      <input type="number" min={1} max={1000} className={input} style={{ width: 72 }} value={pacs.limit} onChange={(e) => setPacs({ ...pacs, limit: Number(e.target.value) || 50 })} />
                    </span>
                  </label>
                  <input className={input} placeholder="MWL kökü (farklıysa) — ör. https://pacs/dcm4chee-arc/aets/AET/rs" value={mwlEndpoints.mwlRoot} onChange={(e) => setMwlEndpoints({ ...mwlEndpoints, mwlRoot: e.target.value })} />
                  <input className={input} placeholder="DIMSE C-FIND köprüsü — ör. http://127.0.0.1:2580/cfind" value={mwlEndpoints.dimseUrl} onChange={(e) => setMwlEndpoints({ ...mwlEndpoints, dimseUrl: e.target.value })} />
                  <p className="text-[10.5px] text-slate-500">İş listesi (MWL) bu sırayla denenir: MWL kökü → DICOMweb → DIMSE köprüsü. Köprü süreci: <code className="text-slate-400">npm run mwl:cfind</code>. Köprü ayarını kaydetmek için aşağıdaki Kaydet düğmesi tüm alanları yazar.</p>
                  <textarea className={`${input} h-16 w-full resize-none`} placeholder="Kurum notları (AE başlığı, port, conformance statement vb.)" value={pacs.notes} onChange={(e) => setPacs({ ...pacs, notes: e.target.value })} />
                  {pacsHint && <p className="text-[11px] text-cyan-300/90">💡 {pacsHint}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <button className={`${btn} bg-cyan-500 text-slate-950`} onClick={() => void savePacs()}>Kaydet</button>
                    <button className={`${btn} bg-slate-700 text-slate-100 disabled:opacity-50`} disabled={pacsTesting} onClick={() => void testPacs()}>
                      {pacsTesting ? "Test ediliyor…" : "Bağlantıyı test et"}
                    </button>
                    <span className="text-[10.5px] text-slate-500">{settings.env.pacsAuth ? "ortam: PACS_AUTH_HEADER tanımlı" : "ortam: PACS_AUTH_HEADER yok"}</span>
                  </div>
                  {pacsTest && (
                    <ul className="grid gap-1">
                      {pacsTest.steps.map((s, i) => (
                        <li key={`${s.name}-${i}`} className={`rounded border px-2 py-1 text-[11px] ${s.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-200"}`}>
                          <b>{s.name}</b> {s.http !== null ? `· HTTP ${s.http}` : "· ağ"}{s.ms ? ` · ${s.ms} ms` : ""} — {s.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p className="mt-3 text-[11px] text-slate-500">
                Kimlik bilgileri sunucuda AES-256-GCM ile şifrelenir; istekler tarayıcıdan değil uygulama sunucusundan gider (CORS/PHI riski yok).
                DIMSE (C-FIND/C-MOVE) doğrudan desteklenmez — yalnızca DICOMweb uçları veya Orthanc/dcm4chee kapısı kullanın.
              </p>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">Kritik bulgu bildirimi (e-posta · SMS · çağrı · webhook)</h2>
              <input id="hook" defaultValue={settings.criticalWebhookUrl} placeholder="https://… (eski tek webhook, POST JSON)" className={`${input} mt-3 w-full`} />
              <p className="mt-2 text-[11px] text-slate-500">Kritik/yüksek aday bulguda uygulama içi bildirim + aşağıdaki kanallara POST. Aynı olay tüm kanallara <b>kimliksiz</b> gider (önem, çalışma UID, modalite, kısa mesaj) — hasta adı/numarası gönderilmez. Kurumun SMTP relay&apos;i, SMS/pager ağ geçidi veya mobil-push köprüsü tek bir HTTP uç noktası olarak tanımlanır.</p>
              <textarea id="chans" defaultValue={settings.notifyChannels} rows={8} spellCheck={false}
                placeholder={'[\n  {"kind":"email","url":"https://mail.kurum.local/notify","to":"radyolog@kurum.local","minSeverity":"yuksek"},\n  {"kind":"sms","url":"https://sms.kurum.local/send","to":"+90555…"},\n  {"kind":"pager","url":"https://pager.kurum.local/push","to":"0042","minSeverity":"kritik"},\n  {"kind":"webhook","url":"https://bridge.kurum.local/push","minSeverity":"orta"}\n]'}
                className={`${input} mt-3 w-full font-mono text-[11px]`} />
              <p className="mt-1 text-[10.5px] text-slate-500">Varsayılan eşikler: webhook/e-posta <b>yüksek</b>, SMS/çağrı <b>kritik</b>. <code>enabled:false</code> ile kanalı kapatabilirsiniz. Geçersiz kayıt listeyi bozmaz; hata mesajı gösterilir.</p>
              {!!settings.notifyChannelErrors?.length && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-amber-300">{settings.notifyChannelErrors.map((e, i) => <li key={i}>⚠ {e}</li>)}</ul>
              )}
              {notifyTest && (
                <ul className="mt-2 space-y-0.5 text-[11px]">
                  {notifyTest.results.length === 0 && <li className="text-slate-400">Tanımlı kanal yok — test gönderilmedi.</li>}
                  {notifyTest.results.map((r) => (
                    <li key={r.id} className={r.ok ? "text-emerald-300" : "text-rose-300"}>
                      {r.ok ? "✓" : "✕"} {r.id} ({r.kind}) {r.status !== null ? `· HTTP ${r.status}` : "· ağ"} · {r.ms} ms{r.error ? ` — ${r.error}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button className={`${btn} bg-cyan-500 text-slate-950`} onClick={() => void saveSettings({ criticalWebhookUrl: (document.getElementById("hook") as HTMLInputElement).value, notifyChannels: (document.getElementById("chans") as HTMLTextAreaElement).value })}>Kaydet</button>
                <button className={`${btn} border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10`} disabled={notifyTesting}
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
              <h2 className="text-sm font-bold text-slate-100">HBYS / RIS istem alımı</h2>
              <p className="mt-2 text-xs text-slate-300">Durum: {settings.env.his ? <b className="text-emerald-300">etkin (HIS_API_KEY tanımlı)</b> : <b className="text-amber-300">kapalı — HIS_API_KEY tanımlayın</b>}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-[#080c12] p-2 text-[10.5px] text-slate-300">{`POST /api/his/orders\nx-api-key: <HIS_API_KEY>\n{"patientName":"…","patientId":"…","accessionNumber":"A123",\n "modality":"CT","bodyPart":"BEYİN","description":"Beyin BT"}`}</pre>
              <p className="mt-2 text-[11px] text-slate-500">HL7 v2 (MLLP) alıcısı ayrı süreçle çalışır: <code>npm run hl7:mllp</code> (ORM^O01/ORU^R01 → ACK + sipariş). Modality Worklist: <code>npm run mwl:cfind</code> köprüsü ve Çalışma listesi → İş listesi (MWL). Rapor çıktısı: <code>/api/reports/&#123;id&#125;/fhir</code> (FHIR R4 DiagnosticReport).</p>
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-slate-100">Üretken yapay zeka (taslak izlenim)</h2>
              <p className="mt-2 text-xs text-slate-300">Durum: {settings.env.llm ? <b className="text-emerald-300">etkin (LLM_API_URL + LLM_API_KEY)</b> : <b className="text-amber-300">yapılandırılmadı — kural tabanlı yedek kullanılır</b>}</p>
              <p className="mt-2 text-[11px] text-slate-500">OpenAI uyumlu uç nokta. Yalnızca hekimin doğruladığı bulgu metinleri gönderilir; hasta adı/kimliği gönderilmez. Çıktı her zaman &quot;taslak&quot; etiketlidir. KVKK açısından yurt dışı aktarımı değerlendirin.</p>
            </div>
          </div>
        )}

        {tab === "compliance" && settings && (
          <div className="mt-4 space-y-2">
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200">Aşağıdakiler <b>kodla tamamlanamayan</b>, kurum/üretici tarafından yürütülmesi gereken süreçlerdir. Bu liste yalnızca takip içindir; hukuki/regülasyon danışmanlığı değildir. Bulgu gösteren yapay zeka yazılımı çoğu yargı alanında tıbbi cihaz yazılımı sayılır.</div>
            {COMPLIANCE.map((c) => (
              <div key={c.id} className={`${card} flex items-center gap-3 py-3`}>
                <div className="min-w-0 flex-1"><div className="text-[12.5px] font-bold text-slate-100">{c.t}</div>{c.h && <div className="text-[11px] text-slate-500">{c.h}</div>}</div>
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
