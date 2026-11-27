"use client";

/**
 * GitHub Pages (statik demo) — Yönetim paneli için KURGUSAL örnek veri.
 *
 * Sunucu/veritabanı yoktur; bu modül `/api/*` isteklerini ağa göndermeden TARAYICI
 * İÇİNDE, modül düzeyinde tutulan bellek içi örnek kayıtla karşılar. AdminPanel
 * gerçek bileşeniyle aynen çalışır; yalnızca yanıtlar kurgusaldır:
 *   - Tüm kullanıcılar/hekimler/audit satırları "(örnek)"/"(demo)" etiketlidir.
 *   - Hiçbir hasta verisi yoktur; hiçbir yanıt dış ağa çıkmaz.
 *   - Değişiklikler (kullanıcı oluşturma, ayar kaydı, oturum kapatma…) yalnızca
 *     bu sayfa oturumunda geçerlidir; yenilenince örnek veriye döner.
 * Yalnızca scripts/prepare-pages.sh tarafından Pages derlemesine eklenir
 * (tam sürümde /yonetim gerçek sunucu uçlarına konuşur).
 */

import { evaluateEnv, parsePrometheus, summarizeChecks, type EnvSnapshot } from "@/lib/adminHealth";
import { summarizeFeedback, type CleanCase, type FeedbackFinding } from "@/lib/feedbackLoop";
import { CALIB_MIN_CASES, chooseThreshold, calibrationQuality, fitIsotonic, reviewDecision, type CalibCase } from "@/lib/calibration";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fail = (error: string, status = 400) => json({ error }, status);

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3600_000, DAY = 24 * HOUR;

// ── Kurgusal kullanıcılar ────────────────────────────────────────────────────
const seedUsers = () => [
  { id: 1, username: "demo", fullName: "Demo Radyolog (örnek)", title: "Uzm. Dr.", regNo: "000000", role: "yonetici", active: true, twoFactorEnabled: false, lastLoginAt: iso(2 * HOUR) },
  { id: 2, username: "a.demir", fullName: "Ayşe Demir (örnek)", title: "Uzm. Dr.", regNo: "112233", role: "radyolog", active: true, twoFactorEnabled: true, lastLoginAt: iso(26 * HOUR) },
  { id: 3, username: "m.kaya", fullName: "Mehmet Kaya (örnek)", title: "Tekniker", regNo: "445566", role: "teknisyen", active: true, twoFactorEnabled: false, lastLoginAt: iso(7 * DAY) },
  { id: 4, username: "eski.kullanici", fullName: "Eski Personel (örnek)", title: "Uzm. Dr.", regNo: "778899", role: "radyolog", active: false, twoFactorEnabled: false, lastLoginAt: null as string | null },
];
let users = seedUsers();

// ── Kurgusal oturumlar ───────────────────────────────────────────────────────
const seedSessions = () => [
  { id: "1", userId: 1, username: "demo", fullName: "Demo Radyolog (örnek)", role: "yonetici", createdAt: iso(2 * HOUR), lastSeenAt: iso(60_000), expiresAt: iso(-10 * HOUR), revokedAt: null, ip: "192.0.2.41", client: "Chrome 130 · Windows", state: "aktif" as const, current: true },
  { id: "2", userId: 1, username: "demo", fullName: "Demo Radyolog (örnek)", role: "yonetici", createdAt: iso(3 * DAY), lastSeenAt: iso(3 * DAY - HOUR), expiresAt: iso(3 * DAY - 14 * HOUR), revokedAt: null, ip: "198.51.100.7", client: "Firefox 133 · Linux", state: "suresi-dolmus" as const, current: false },
  { id: "3", userId: 2, username: "a.demir", fullName: "Ayşe Demir (örnek)", role: "radyolog", createdAt: iso(26 * HOUR), lastSeenAt: iso(25 * HOUR), expiresAt: iso(-2 * HOUR), revokedAt: null, ip: "203.0.113.19", client: "Safari 19 · iPhone", state: "aktif" as const, current: false },
  { id: "4", userId: 2, username: "a.demir", fullName: "Ayşe Demir (örnek)", role: "radyolog", createdAt: iso(30 * DAY), lastSeenAt: iso(29 * DAY), expiresAt: iso(20 * DAY), revokedAt: iso(29 * DAY), ip: "192.0.2.77", client: "Chrome 129 · macOS", state: "iptal-edilmis" as const, current: false },
];
let sessions = seedSessions();

// ── Kurgusal denetim kayıtları ───────────────────────────────────────────────
const auditSeed: [string, string, string, string][] = [
  ["demo", "report.approve", "rapor#1184", "rapor onaylandı · sürüm 3 · SHA-256 mühürlü (örnek)"],
  ["a.demir", "study.open", "çalışma#3420", "BT toraks açıldı (örnek)"],
  ["demo", "findings.review", "rapor#1184", "3 bulgu onaylandı, 1 bulgu düzenlendi — gerekçe: 'boyut hekim ölçümüyle düzeltildi' (örnek)"],
  ["m.kaya", "study.import", "çalışma#3419", "Klasörden 214 DICOM içe aktarıldı (örnek)"],
  ["a.demir", "report.draft", "rapor#1183", "taslak kaydedildi (örnek)"],
  ["demo", "login.success", "oturum", "başarılı giriş · MFA kapalı (örnek)"],
  ["demo", "pacs.query", "pacs", "QIDO-RS: 21 çalışma listelendi (örnek)"],
  ["a.demir", "report.approve", "rapor#1179", "rapor onaylandı · sürüm 2 (örnek)"],
  ["sistem", "notify.sweep", "bildirim#882", "kritik bildirim 30 dk içinde alınmadı → eskalasyon (örnek)"],
  ["demo", "study.measure", "çalışma#3418", "6 ölçüm + 2 anahtar kesit kaydedildi (örnek)"],
  ["eski.kullanici", "login.failed", "oturum", "hatalı parola (5/5 sonrası kilit) (örnek)"],
  ["a.demir", "ai.feedback", "bulgu#5521", "nodül adayı reddedildi — gerekçe: 'vasküler kesit' (örnek)"],
  ["demo", "export.fhir", "rapor#1179", "FHIR R4 DiagnosticReport indirildi (örnek)"],
  ["m.kaya", "study.anonymize", "çalışma#3411", "anonim DICOM ZIP indirildi (örnek)"],
  ["demo", "settings.update", "ayar#retention", "taslak saklama 30 gün olarak ayarlandı (örnek)"],
  ["a.demir", "report.addendum", "rapor#1172", "addendum eklendi (örnek)"],
  ["demo", "keyring.status", "güvenlik", "anahtar halkası görüntülendi (örnek)"],
  ["demo", "audit.export", "denetim", "CSV dışa aktarıldı (128 kayıt, filtreli) (örnek)"],
];
const fakeHash = (i: number) => ((i * 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
const seedAudit = () =>
  auditSeed.map(([username, action, entity, details], i) => ({
    id: 5200 - i,
    ts: iso((i + 1) * 47 * 60_000),
    username,
    action,
    entityType: entity.split("#")[0],
    entityId: entity.split("#")[1] ?? "",
    details,
    hash: fakeHash(i + 7),
  }));

// ── Hekim geri bildirim döngüsü (a-feedback) — demo verisi AYNI saf hesapla üretilir ──
// `summarizeFeedback` üretim ucunda da kullanıldığı için demo, gerçek hesabı gösterir;
// yalnız girdi satırları kurgusaldır (ve ekranda DEMO olarak etiketlenir).
const demoFeedbackInput: FeedbackFinding[] = (() => {
  const out: FeedbackFinding[] = [];
  const add = (engine: string, category: string, n: number, decision: FeedbackFinding["decision"], o: Partial<FeedbackFinding> = {}) => {
    for (let i = 0; i < n; i++) out.push({ id: `${engine}-${category}-${decision}-${i}`, engine, category, label: o.label ?? "örnek aday", manual: false, score: null, decision, ...o });
  };
  // CXR: 14 sınıf — yüksek kesinlik, birkaç kaçırılan
  add("cxr-densenet121 (Medical_X)", "Akciğer grafisi — 14 sınıf", 161, "onaylandi", { score: 0.92 });
  add("cxr-densenet121 (Medical_X)", "Akciğer grafisi — 14 sınıf", 13, "duzenlendi", { score: 0.71 });
  add("cxr-densenet121 (Medical_X)", "Akciğer grafisi — 14 sınıf", 19, "reddedildi", { score: 0.58, reason: "Penetrasyon düşük; grafi teknik olarak yetersiz (örnek)" });
  add("cxr-densenet121 (Medical_X)", "Akciğer grafisi — 14 sınıf", 21, "bekliyor");
  add("cxr-densenet121 (Medical_X)", "Hekim", 6, "onaylandi", { manual: true, label: "AI kaçırdı: ince pnömotoraks (örnek)" });
  // BT nodül: orta kesinlik, daha çok kaçırılan
  add("monai-lung-nodule-ct", "BT toraks — nodül adayı", 59, "onaylandi", { score: 0.83 });
  add("monai-lung-nodule-ct", "BT toraks — nodül adayı", 8, "duzenlendi", { score: 0.62 });
  add("monai-lung-nodule-ct", "BT toraks — nodül adayı", 22, "reddedildi", { score: 0.44, reason: "Vasküler kesit; nodül değil — çap hekime göre 4 mm (örnek)" });
  add("monai-lung-nodule-ct", "BT toraks — nodül adayı", 8, "bekliyor");
  add("monai-lung-nodule-ct", "Hekim", 11, "onaylandi", { manual: true, label: "AI kaçırdı: 6 mm solid nodül (örnek)" });
  // BT beyin ICH
  add("ct-head-ich", "BT beyin — intrakraniyal kanama adayı", 104, "onaylandi", { score: 0.95 });
  add("ct-head-ich", "BT beyin — intrakraniyal kanama adayı", 5, "duzenlendi", { score: 0.77 });
  add("ct-head-ich", "BT beyin — intrakraniyal kanama adayı", 11, "reddedildi", { score: 0.51, reason: "Kalsifikasyon/artefakt; kanama değil (örnek)" });
  add("ct-head-ich", "BT beyin — intrakraniyal kanama adayı", 12, "bekliyor");
  add("ct-head-ich", "Hekim", 3, "onaylandi", { manual: true, label: "AI kaçırdı: küçük subdural hematom (örnek)" });
  return out;
})();
const demoFeedback = (() => {
  const clean: CleanCase[] = [
    ...Array.from({ length: 38 }, () => ({ engine: "cxr-densenet121 (Medical_X)", category: "—", clean: true })),
    ...Array.from({ length: 24 }, () => ({ engine: "monai-lung-nodule-ct", category: "—", clean: true })),
    ...Array.from({ length: 31 }, () => ({ engine: "ct-head-ich", category: "—", clean: true })),
    // Okunmamış/taslak çalışma "negatif" sayılmaz — bilinçli olarak clean:false
    ...Array.from({ length: 9 }, () => ({ engine: "ct-head-ich", category: "—", clean: false })),
  ];
  const r = summarizeFeedback(demoFeedbackInput, clean);
  // Kalibrasyon demo: üretimle AYNI hesap (ısotonik + ECE + eşik önerisi).
  const calibCases: CalibCase[] = demoFeedbackInput
    .filter((f) => !f.manual && f.score !== null)
    .map((f) => ({ score: f.score as number, label: f.decision === "onaylandi" ? 1 : f.decision === "reddedildi" ? 0 : null }));
  const calibration = fitIsotonic(calibCases);
  const quality = calibrationQuality(calibration.ok ? 0.061 : null);
  const chosen = chooseThreshold(calibCases, calibration);
  const lowConfidence = demoFeedbackInput
    .filter((f) => !f.manual && f.score !== null)
    .map((f) => ({ f, d: reviewDecision(f.score as number, calibration) }))
    .filter((x) => x.d.action === "incele")
    .slice(0, 50)
    .map(({ f, d }) => ({
      engine: f.engine, category: f.category, label: f.label,
      raw: d.raw, calibrated: d.calibrated, why: d.why,
      slice: f.slice ?? null, studyRef: f.studyRef ?? null,
    }));
  return {
    ...r,
    calibration: {
      ...calibration,
      ece: calibration.ok ? 0.061 : null,
      quality: quality.level,
      qualityNote: quality.note,
      cases: calibCases.length,
      minCases: CALIB_MIN_CASES,
    },
    thresholds: {
      chosen,
      showAt: chosen?.threshold ?? 0.7,
      inspectAt: Math.max(0.3, (chosen?.threshold ?? 0.7) - 0.3),
      note: chosen
        ? `Kesinlik ≥ %${Math.round(chosen.precision * 100)} hedefiyle en yüksek duyarlılığı veren eşik ${chosen.threshold.toFixed(2)}. ÖNERİDİR — üretim eşiği değişikliği klinik onay gerektirir.`
        : `Eşik önerisi için en az ${CALIB_MIN_CASES} etiketli bulgu gerekir.`,
    },
    lowConfidence,
    generatedAt: new Date(NOW).toISOString(),
    sample: { reportsScanned: 260, reportsApproved: 214, findings: demoFeedbackInput.length, cleanStudies: clean.filter((c) => c.clean).length, limit: 5000 },
    specificitySource: "onaylı-raporda-bulgu-yok (demo)",
    note: r.note + " Özgüllük 'onaylı raporda bulgu yok' proxy'siyle hesaplanır; altın standart (patoloji/takip) verisi yoktur.",
  };
})();

// ── Kurgusal AI performans verisi ────────────────────────────────────────────
const perfRows = [
  { engine: "cxr-densenet121 (Medical_X)", category: "Akciğer grafisi — 14 sınıf", shown: 214, approved: 161, rejected: 19, edited: 13, pending: 21, manualAdded: 6 },
  { engine: "monai-lung-nodule-ct", category: "BT toraks — nodül adayı", shown: 87, approved: 59, rejected: 22, edited: 8, pending: 8, manualAdded: 2 },
  { engine: "ct-head-ich", category: "BT beyin — intrakraniyal kanama adayı", shown: 132, approved: 104, rejected: 11, edited: 5, pending: 12, manualAdded: 3 },
  { engine: "kural-tabanli", category: "Kural motoru (yedek)", shown: 390, approved: 201, rejected: 74, edited: 22, pending: 93, manualAdded: 11 },
].map((r) => ({ ...r, ppv: r.approved + r.rejected + r.edited > 0 ? r.approved / (r.approved + r.rejected + r.edited) : null }));
const disagreement = (() => {
  const decidedRows = perfRows.filter((r) => r.engine !== "kural-tabanli");
  const categories = decidedRows.map((r) => {
    const decided = r.approved + r.rejected + r.edited;
    return {
      engine: r.engine, category: r.category, decided,
      approved: r.approved, rejected: r.rejected, edited: r.edited,
      disagreementRate: decided > 0 ? (r.rejected + r.edited) / decided : null,
    };
  });
  const decided = decidedRows.reduce((s, r) => s + r.approved + r.rejected + r.edited, 0);
  const rejected = decidedRows.reduce((s, r) => s + r.rejected, 0);
  const edited = decidedRows.reduce((s, r) => s + r.edited, 0);
  return {
    categories,
    reasons: [
      { engine: "cxr-densenet121 (Medical_X)", category: "Effüzyon adayı", label: "Sağ efüzyon adayı", status: "reddedildi" as const, reason: "Penetrasyon düşük; grafi teknik olarak yetersiz (örnek)" },
      { engine: "monai-lung-nodule-ct", category: "Nodül adayı", label: "Sol üst lob 9 mm aday", status: "duzenlendi" as const, reason: "Vasküler kesit; nodül değil — çap hekime göre 4 mm (örnek)" },
    ],
    tally: { decided, rejected, edited, rate: decided > 0 ? (rejected + edited) / decided : null, withReason: 2 },
    // Örnek uyarı durumu: statik demoda da yeni banner'ın nasıl göründüğünü göstermek için.
    alert: { total: 1, sent: 1, threshold: 0.3, minDecided: 10, reasonClasses: [{ cls: "teknik", label: "Teknik/protokol", count: 2 }] },
  };
})();

// ── Kurgusal model kayıt defteri ─────────────────────────────────────────────
interface RegistryRow { id: number; name: string; version: string; modality: string; task: string; stage: "aday" | "aktif" | "emekli"; trafficPercent: number; fingerprint: string; notes: string; updatedAt: string }
const seedRegistry = (): RegistryRow[] => [
  { id: 1, name: "medical-x-cxr-densenet121", version: "1.0.0", modality: "DX", task: "cxr-classification", stage: "aktif", trafficPercent: 100, fingerprint: "sha256:demo-9f3a2c1b", notes: "Medical_X, NIH ChestX-ray14, Apache-2.0 (örnek kayıt)", updatedAt: iso(40 * DAY) },
  { id: 2, name: "monai-lung-nodule-ct-detection", version: "0.2.0", modality: "CT", task: "nodule-detection", stage: "aday", trafficPercent: 0, fingerprint: "sha256:demo-71bd402e", notes: "RetinaNet + ResNet50-3D, LUNA16 (örnek kayıt)", updatedAt: iso(9 * DAY) },
  { id: 3, name: "ct-head-ich", version: "1.1.0", modality: "CT", task: "ich-detection", stage: "aday", trafficPercent: 0, fingerprint: "sha256:demo-b204e71a", notes: "ianpan/ct-head-hemorrhage-detection (örnek kayıt)", updatedAt: iso(2 * DAY) },
];
let registry = seedRegistry();
const registryState = () => {
  const summary: Record<string, number> = { aday: 0, aktif: 0, emekli: 0 };
  for (const e of registry) summary[e.stage] = (summary[e.stage] ?? 0) + 1;
  const issues: string[] = ["Demo: 'aday' aşamasındaki modeller çıkarım yoluna bağlı değildir — kayıt defteri bir dağıtım planıdır."];
  const activeTraffic = registry.filter((e) => e.stage === "aktif").reduce((s, e) => s + e.trafficPercent, 0);
  if (activeTraffic !== 100 && registry.some((e) => e.stage === "aktif")) issues.push(`Aktif modellerin trafik toplamı %${activeTraffic} (%100 olması önerilir).`);
  return { entries: registry.slice(), summary, issues };
};

// ── Kurgusal iş akışı istatistikleri ─────────────────────────────────────────
const weekLabel = (weeksAgo: number) => new Date(NOW - weeksAgo * 7 * DAY).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
const weekly = [
  { weekStart: iso(8 * 7 * DAY), label: weekLabel(8), approved: 38, medianHours: 26.4, p90Hours: 61 },
  { weekStart: iso(7 * 7 * DAY), label: weekLabel(7), approved: 41, medianHours: 18.2, p90Hours: 44 },
  { weekStart: iso(6 * 7 * DAY), label: weekLabel(6), approved: 44, medianHours: 12.6, p90Hours: 33 },
  { weekStart: iso(5 * 7 * DAY), label: weekLabel(5), approved: 39, medianHours: 11.1, p90Hours: 29 },
  { weekStart: iso(4 * 7 * DAY), label: weekLabel(4), approved: 47, medianHours: 9.4, p90Hours: 25 },
  { weekStart: iso(3 * 7 * DAY), label: weekLabel(3), approved: 52, medianHours: 8.6, p90Hours: 22 },
  { weekStart: iso(2 * 7 * DAY), label: weekLabel(2), approved: 49, medianHours: 7.9, p90Hours: 19 },
  { weekStart: iso(1 * 7 * DAY), label: weekLabel(1), approved: 46, medianHours: 7.5, p90Hours: 17 },
];
const stats = {
  total: 1284,
  byStatus: { onaylandi: 1180, taslak: 74, addendum: 30 },
  byModality: { CT: 420, MR: 380, US: 210, DX: 160, MG: 64, PT: 50 },
  approved: 1180,
  medianHours: 7.5,
  meanHours: 11.2,
  p90Hours: 30,
  pendingDrafts: 74,
  staleDrafts: { olderDays: 7, count: 9 },
  perRadiologist: [
    { name: "Ayşe Demir (örnek)", approved: 402, medianHours: 6.8, p90Hours: 18 },
    { name: "Demo Radyolog (örnek)", approved: 371, medianHours: 7.5, p90Hours: 24 },
    { name: "Eski Personel (örnek)", approved: 244, medianHours: 9.9, p90Hours: 33 },
    { name: "İkinci Okuyucu (örnek)", approved: 163, medianHours: 11.3, p90Hours: 39 },
  ],
};

// ── Kurgusal ayarlar / durum / anahtar halkası ───────────────────────────────
const seedSettings = () => ({
  retentionDraftDays: 30,
  criticalWebhookUrl: "",
  notifyChannels:
    '[\n  {"kind":"webhook","url":"https://hooks.kurum.local/atik","minSeverity":"yuksek"},\n  {"kind":"email","url":"https://mail.kurum.local/notify","to":"radyoloji@kurum.local","minSeverity":"kritik","enabled":false}\n]',
  notifyChannelErrors: [] as string[],
  peerReviewSamplePct: 5,
  pacsBaseUrl: "",
  pacs: {
    name: "", kind: "orthanc", qidoRoot: "", wadoRoot: "",
    auth: { type: "none", username: "", password: "", token: "", headerName: "", headerValue: "" },
    tls: { caPem: "", clientCertPem: "", clientKeyPem: "" },
    allowSelfSigned: false, limit: 50, includefield: false, notes: "",
    hasPassword: false, hasToken: false, hasHeader: false, hasClientKey: false,
  },
  pacsMwl: { mwlRoot: "", dimseUrl: "" },
  compliance: "{}",
  env: { llm: false, his: true, pacsAuth: false, keySource: "env" },
});
let settings = seedSettings();

const status = {
  keySource: "env",
  plaintext: { studies: 0, reports: 0 },
  totals: { "rapor": 1284, "çalışma": 3420, "kullanıcı": 4, "denetim kaydı": 5210 },
  retentionDraftDays: 30,
};

const keyring = {
  current: "k2026-02",
  keys: [
    { kid: "k2025-06", since: iso(170 * DAY), current: false },
    { kid: "k2026-02", since: iso(28 * DAY), current: true },
  ],
  rotation: { summary: "Tüm kayıtlar güncel anahtarla okunabilir (örnek)", pending: 0 },
};

let demoTotpEnabled = false;

// ── İstek yönlendirici ───────────────────────────────────────────────────────
async function route(method: string, url: URL, init?: RequestInit): Promise<Response | null> {
  const p = url.pathname.replace(/\/+$/, "");
  const body = async <T,>(): Promise<T | null> => {
    try { return JSON.parse(String(init?.body ?? "")) as T; } catch { return null; }
  };

  if (p === "/api/auth/logout" && method === "POST") return json({ ok: true });

  // Profil & MFA
  if (p === "/api/profile" && method === "GET") {
    const u = users.find((x) => x.id === 1)!;
    return json({ user: { id: u.id, username: u.username, fullName: u.fullName.replace(" (örnek)", ""), title: u.title, regNo: u.regNo, role: u.role } });
  }
  if (p === "/api/profile" && method === "PATCH") {
    const b = await body<{ fullName?: string; title?: string; regNo?: string }>();
    const u = users.find((x) => x.id === 1)!;
    if (b?.fullName) u.fullName = `${b.fullName.trim()} (örnek)`;
    if (b?.title !== undefined) u.title = b.title;
    if (b?.regNo !== undefined) u.regNo = b.regNo;
    return json({ ok: true });
  }
  if (p === "/api/profile/totp") {
    if (method === "GET") return json({ enabled: demoTotpEnabled });
    if (method === "POST") { demoTotpEnabled = true; return json({ ok: true }); }
    if (method === "DELETE") { demoTotpEnabled = false; return json({ ok: true }); }
  }

  // Kullanıcılar
  if (p === "/api/users") {
    if (method === "GET") return json({ users: users.slice() });
    if (method === "POST") {
      const b = await body<{ username?: string; fullName?: string; title?: string; regNo?: string; role?: string; password?: string }>();
      const username = (b?.username ?? "").trim();
      if (!username || (b?.password ?? "").length < 8) return fail("Kullanıcı adı ve en az 8 karakter parola gerekli (örnek kural)");
      const row = { id: users.reduce((m, x) => Math.max(m, x.id), 0) + 1, username, fullName: b?.fullName ?? username, title: b?.title ?? "", regNo: b?.regNo ?? "", role: b?.role ?? "radyolog", active: true, twoFactorEnabled: false, lastLoginAt: null as string | null };
      users = [...users, row];
      return json({ ok: true, id: row.id });
    }
    if (method === "PATCH") {
      const b = await body<{ id?: number; role?: string; active?: boolean; password?: string }>();
      const u = users.find((x) => x.id === b?.id);
      if (!u) return fail("Kullanıcı bulunamadı", 404);
      if (b?.role) u.role = b.role;
      if (b?.active !== undefined) u.active = b.active;
      // Parola değişikliği yalnız bellek içi panelde görünür; hiçbir yere yazılmaz.
      return json({ ok: true });
    }
  }

  // Oturumlar
  if (p === "/api/auth/sessions") {
    if (method === "GET") {
      const scope = url.searchParams.get("scope") ?? "own";
      const rows = scope === "all" ? sessions : sessions.filter((s) => s.userId === 1);
      return json({ supported: true, sessions: rows, note: "DEMO: oturum kayıtları kurgusaldır; kapatma işlemi yalnız bu sayfa oturumunda etkilidir." });
    }
    if (method === "POST") {
      const b = await body<{ action?: string; id?: number }>();
      if (b?.action === "revoke") {
        const target = Number(b.id);
        let n = 0;
        sessions = sessions.map((s) => {
          if (Number(s.id) === target && s.state === "aktif") { n++; return { ...s, state: "iptal-edilmis" as const, revokedAt: new Date().toISOString() }; }
          return s;
        });
        return json({ ok: true, revoked: n });
      }
      if (b?.action === "revoke-others") {
        let n = 0;
        sessions = sessions.map((s) => {
          if (!s.current && s.state === "aktif") { n++; return { ...s, state: "iptal-edilmis" as const, revokedAt: new Date().toISOString() }; }
          return s;
        });
        return json({ ok: true, revoked: n });
      }
      if (b?.action === "purge-expired") {
        const before = sessions.length;
        sessions = sessions.filter((s) => s.state === "aktif");
        return json({ ok: true, deleted: before - sessions.length });
      }
      return fail("Bilinmeyen action");
    }
  }

  // Denetim kaydı
  if (p === "/api/audit" && method === "GET") {
    if (url.searchParams.get("verify") === "1") return json({ ok: true, count: 5210 });
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const rows = seedAudit().filter((a) => !q || `${a.username} ${a.action} ${a.entityType} ${a.details}`.toLowerCase().includes(q));
    return json(rows);
  }
  if (p === "/api/audit/export") {
    if (method === "GET" && url.searchParams.get("siem") === "stats") {
      return json({ pending: 0, failed: 0, sent: 144, abandoned: 0, configured: false, maxAttempts: 6 });
    }
    if (method === "POST") return json({ configured: false, tried: 0, sent: 0, failed: 0, error: "AUDIT_SIEM_URL tanımlı değil (demo)" });
  }

  // AI performans + model kayıt defteri
  if (p === "/api/ai/performance" && method === "GET") {
    return json({
      rows: perfRows,
      note: "DEMO VERİSİ — kurumunuzda bu tablo veritabanındaki hekim kararlarından üretilir. PPV klinik kesinlik değildir.",
      disagreement,
    });
  }
  // Hekim geri bildirim döngüsü (a-feedback) — üretimle AYNI saf hesap, kurgusal girdiyle.
  if (p === "/api/ai/feedback" && method === "GET") return json(demoFeedback);
  if (p === "/api/ai/registry") {
    if (method === "GET") return json(registryState());
    if (method === "POST") {
      const b = await body<{ name?: string; version?: string; modality?: string; task?: string; stage?: RegistryRow["stage"]; trafficPercent?: number; notes?: string }>();
      const name = (b?.name ?? "").trim(), version = (b?.version ?? "").trim();
      if (!name || !version) return fail("Model adı ve sürüm gerekli");
      const trafficPercent = Math.max(0, Math.min(100, Math.round(Number(b?.trafficPercent) || 0)));
      const existing = registry.find((e) => e.name === name && e.version === version);
      if (existing) {
        existing.modality = b?.modality ?? existing.modality;
        existing.task = b?.task ?? existing.task;
        existing.stage = b?.stage ?? existing.stage;
        existing.trafficPercent = trafficPercent;
        existing.notes = b?.notes ?? existing.notes;
        existing.updatedAt = new Date().toISOString();
      } else {
        registry = [...registry, { id: registry.reduce((m, e) => Math.max(m, e.id), 0) + 1, name, version, modality: b?.modality ?? "", task: b?.task ?? "", stage: b?.stage ?? "aday", trafficPercent, fingerprint: `sha256:demo-${Date.now().toString(16)}`, notes: b?.notes ?? "", updatedAt: new Date().toISOString() }];
      }
      return json(registryState());
    }
  }

  // ── Sistem sağlığı (demo): gerçek uçla **aynı** saf değerlendirici (`evaluateEnv`) ──
  if (p === "/api/admin/health" && method === "GET") {
    const demoEnv: EnvSnapshot = {
      authMode: "hesap", requireTls: "0", hstsMaxAge: "", keySource: "env", keyCount: 2,
      databaseUrl: false, llmConfigured: false, metricsToken: false,
      auditSiemUrl: false, auditSyslogHost: false, storage: "fs:./.data (demo)", nodeEnv: "production",
      appVersion: "0.2.0", ingestApiKey: false, hisApiKey: false, requireTotpRoles: "yonetici",
    };
    const checks = evaluateEnv(demoEnv);
    const summary = summarizeChecks(checks);
    const metricsText = [
      "# HELP atik_db_up Veritabanı bağlantısı 1/0", "# TYPE atik_db_up gauge", "atik_db_up 0",
      "# HELP atik_reports_total Rapor sayısı", "# TYPE atik_reports_total gauge",
      'atik_reports_total{status="onaylandi"} 1180', 'atik_reports_total{status="taslak"} 37',
      "# TYPE atik_studies_total gauge", 'atik_studies_total{work_status="okunuyor"} 6',
      "# TYPE atik_audit_events_total counter", "atik_audit_events_total 5210",
    ].join("\n");
    return json({
      generatedAt: new Date().toISOString(),
      env: demoEnv,
      checks,
      summary,
      health: { ready: null, live: true, error: "statik demoda veritabanı yok" },
      metrics: { ok: true, parsed: parsePrometheus(metricsText) },
      note: "DEMO VERİSİ — değerlendirme kuralları gerçek uçla aynıdır; ölçümler kurgusaldır ve canlı sunucudan okunmaz.",
    });
  }

  // ── Yedekleme & DR tatbikatı (demo): kurgusal manifest, gerçek rapor biçimi ──
  if (p === "/api/admin/backup/drill") {
    if (method === "GET") {
      return json({
        last: {
          at: iso(2 * DAY), ok: true,
          summary: "4 dosya · 4 sağlam · prova başarılı",
          checked: 4, healthy: 4, extra: 0,
          restoreTrial: { ran: true, ok: true, written: 4, failed: 0 },
          notes: ["DEMO — dosya adları ve özetler kurgusaldır; depo erişimi yoktur."],
          source: "fs:./.data (demo)", appVersion: "0.2.0",
        },
        readiness: { level: "ok", text: "Son yedek 2 gün önce ve doğrulandı. (demo)" },
        store: "fs:./.data (demo)",
      });
    }
    if (method === "POST") {
      const files = [
        { key: "demo/2026/11/ct-beyin-001.dcm", state: "saglam" },
        { key: "demo/2026/11/ct-beyin-002.dcm", state: "saglam" },
        { key: "demo/2026/11/mr-diz-014.dcm", state: "saglam" },
        { key: "demo/2026/11/cxr-220.dcm", state: "saglam" },
      ] as const;
      const report = {
        ok: true, checked: files.length, healthy: files.length, extra: [],
        results: files.map((f, i) => ({
          key: f.key, state: f.state,
          expected: `demo${String(i + 1).padStart(4, "0")}`.repeat(8).slice(0, 64),
          actual: `demo${String(i + 1).padStart(4, "0")}`.repeat(8).slice(0, 64),
          size: 1_048_576 * (i + 1),
        })),
        restoreTrial: { ran: true, ok: true, written: files.length, failed: 0 },
        summary: `${files.length} dosya · ${files.length} sağlam · prova başarılı`,
        notes: ["DEMO — tatbikat tarayıcıda koşar; gerçek depo/anahtar doğrulanmaz."],
      };
      return json({ ok: true, report, record: { ...report, at: new Date().toISOString() }, readiness: { level: "ok", text: "DEMO — son tatbikat başarılı." } });
    }
  }

  // ── Paylaşım bağlantıları (demo): token'lar kurgusal, gerçek /paylas sayfası yok ──
  if (p === "/api/shares") {
    if (method === "GET") {
      return json({
        shares: [
          { id: 3, token: "d3m0" + "a".repeat(44), kind: "report", reportId: 1184, createdByName: "Demo Radyolog (örnek)", expiresAt: iso(-3 * DAY), revokedAt: null, accessCount: 7, lastAccessAt: iso(5 * HOUR), createdAt: iso(4 * DAY) },
          { id: 2, token: "d3m0" + "b".repeat(44), kind: "report", reportId: 1179, createdByName: "Ayşe Demir (örnek)", expiresAt: iso(-20 * DAY), revokedAt: null, accessCount: 2, lastAccessAt: iso(2 * DAY), createdAt: iso(3 * DAY) },
          { id: 1, token: "d3m0" + "c".repeat(44), kind: "report", reportId: 1172, createdByName: "Demo Radyolog (örnek)", expiresAt: iso(10 * DAY), revokedAt: iso(9 * DAY), accessCount: 19, lastAccessAt: iso(9 * DAY), createdAt: iso(12 * DAY) },
        ],
      });
    }
    if (method === "POST") return fail("Statik demoda paylaşım bağlantısı oluşturulamaz (sunucu gerekir)", 503);
  }
  if (/^\/api\/shares\/[0-9a-f]{48}$/.test(p) && method === "DELETE") return json({ ok: true, revoked: true });

  // ── Gölge mod özeti (demo) ──
  if (p === "/api/shadow/summary" && method === "GET") {
    return json({
      ok: true, total: 9,
      summary: [
        { engine: "monai-lung-nodule-ct", model: "0.3.2-demo", count: 5, findings: 11, firstAt: iso(6 * DAY), lastAt: iso(4 * HOUR) },
        { engine: "ich-brain-ct", model: "1.1.0-demo", count: 3, findings: 4, firstAt: iso(5 * DAY), lastAt: iso(1 * DAY) },
        { engine: "cxr-densenet121", model: "medx-demo", count: 1, findings: 2, firstAt: iso(2 * DAY), lastAt: iso(2 * DAY) },
      ],
    });
  }

  // İş akışı istatistikleri + ikinci okuma gözetimi
  if (p === "/api/reports/stats" && method === "GET") {
    const targetHours = Math.max(1, Number(url.searchParams.get("targetHours") ?? "24") || 24);
    const modality = url.searchParams.get("modality") ?? "";
    const statsNote = `DEMO VERİSİ — kurumunuzda bu tablo raporlar tablosundan hesaplanır. TAT = onay − oluşturulma.${modality ? ` Süzgeç: ${modality} (örnek veri süzülmedi).` : ""}`;
    const ratio = stats.medianHours / targetHours;
    const target = {
      status: ratio <= 1 ? "hedef-icinde" : ratio <= 1.25 ? "sinirda" : "hedef-disi",
      targetHours,
      ratio,
      note: "DEMO — hedef karşılaştırması örnek verilerle yapılır.",
    };
    const overWeeks = weekly.filter((w) => (w.medianHours ?? 0) > targetHours);
    const alerts = overWeeks.map((w) => `${w.label} haftasında medyan TAT ${w.medianHours} sa — hedef ${targetHours} sa üzerinde (örnek)`);
    return json({ stats, note: statsNote, weekly, target, alerts });
  }
  if (p === "/api/reports/peer-stats" && method === "GET") {
    return json({
      stats: {
        total: 57,
        agreementRate: 0.93,
        byScore: [
          { score: 1, label: "RADPEER 1 — Uyumlu", count: 44, pct: 77 },
          { score: 2, label: "RADPEER 2 — Anlamsız fark", count: 9, pct: 16 },
          { score: 3, label: "RADPEER 3 — Anlamlı fark", count: 4, pct: 7 },
        ],
        byDiscrepancy: [
          { type: "Bulgu atlanması", count: 3 },
          { type: "Ölçüm farkı", count: 2 },
          { type: "Karar farkı", count: 1 },
        ],
        byReviewer: [
          { name: "Ayşe Demir (örnek)", count: 24, disagreements: 2, disagreementRate: 2 / 24 },
          { name: "Demo Radyolog (örnek)", count: 19, disagreements: 2, disagreementRate: 2 / 19 },
          { name: "İkinci Okuyucu (örnek)", count: 14, disagreements: 0, disagreementRate: 0 },
        ],
        needsFollowUp: [
          { id: 901, reportId: 1183, reviewedByName: "Ayşe Demir (örnek)", note: "T1 gluteus'ta kontrastlanma farkı gözden kaçmış (örnek)", createdAt: iso(13 * DAY) },
        ],
        note: "DEMO VERİSİ",
      },
      target: { ratePct: 5, expected: 59, reviewed: 57, remaining: 2, met: false, note: "DEMO — hedef: onaylı raporların %5'i ikinci okumaya gider." },
      samplePct: 5,
      approvedReports: 1180,
      queue: [1211, 1219, 1226],
      note: "DEMO VERİSİ — örneklem kuyruğu kurgusaldır (deterministik örnekleme bu sayfada uygulanmaz).",
    });
  }

  // Ayarlar + durum + saklama
  if (p === "/api/settings") {
    if (method === "GET") return json(settings);
    if (method === "PUT") {
      const b = await body<Record<string, unknown>>();
      if (b && typeof b === "object") {
        const keep = ["retentionDraftDays", "criticalWebhookUrl", "notifyChannels", "compliance", "peerReviewSamplePct", "pacsBaseUrl"] as const;
        for (const k of keep) if (k in b) (settings as Record<string, unknown>)[k] = b[k];
        if (b.pacs && typeof b.pacs === "object") settings = { ...settings, pacs: { ...settings.pacs, ...(b.pacs as Record<string, unknown>), hasPassword: settings.pacs.hasPassword, hasToken: settings.pacs.hasToken, hasHeader: settings.pacs.hasHeader, hasClientKey: settings.pacs.hasClientKey, auth: { ...settings.pacs.auth, ...((b.pacs as { auth?: Record<string, unknown> }).auth ?? {}) }, tls: { ...settings.pacs.tls, ...(((b.pacs as { tls?: Record<string, unknown> }).tls ?? {})) } } };
        if (b.pacsMwl && typeof b.pacsMwl === "object") settings = { ...settings, pacsMwl: { ...settings.pacsMwl, ...(b.pacsMwl as Record<string, unknown>) } };
      }
      return json({ ok: true });
    }
  }
  if (p === "/api/admin/status" && method === "GET") return json(status);
  if (p === "/api/admin/encrypt-legacy" && method === "POST") return json({ studies: 0, reports: 0 });
  if (p === "/api/admin/purge-drafts" && method === "POST") return json({ deleted: 2 });

  // PACS bağlantı testi (kurgusal başarı)
  if (p === "/api/pacs/test" && method === "GET") {
    return json({
      ok: true,
      steps: [
        { name: "QIDO-RS çalışma araması", ok: true, http: 200, ms: 42, message: "21 çalışma döndü (örnek yanıt)" },
        { name: "WADO-RS erişimi", ok: true, http: 200, ms: 38, message: "Örnek instance metadata okundu" },
        { name: "WADO-RS kare getirme", ok: true, http: 200, ms: 35, message: "1 kare (dekompresyon gerekmez)" },
      ],
    });
  }

  // Kritik bildirim kanalları — test
  if (p === "/api/notifications/test" && method === "POST") {
    return json({ results: [{ id: "demo-webhook", kind: "webhook", ok: true, status: 200, ms: 58, error: undefined }] });
  }

  // Anahtar halkası
  if (p === "/api/admin/keyring") {
    if (method === "GET") return json(keyring);
    if (method === "POST") {
      const b = await body<{ action?: string }>();
      if (b?.action === "generate") {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const key = btoa(String.fromCharCode(...bytes));
        return json({ key, kid: `k-demo-${Date.now().toString(16)}`, dataEncryptionKeys: `k2025-06:…, k2026-02:…, k-demo:… (değerler örnektir)` });
      }
      if (b?.action === "rotate") return json({ written: 12, remaining: 0, percent: 100, note: "DEMO — yeniden şifrelenen kayıt sayısı kurgusaldır." });
      if (b?.action === "drop-old") return json({ dataEncryptionKeys: "k2026-02:… (örnek değer)", note: "DEMO — eski anahtar listeden çıkarıldı (kurgusal)." });
      return fail("Bilinmeyen action");
    }
  }

  // Erişim anomalileri (KVKK) — kurgusal örnek: yönetici demoda uyarı bandını görür
  if (p === "/api/security/access-anomaly" && method === "GET") {
    return json({
      generatedAt: new Date().toISOString(),
      windowDays: 7,
      scannedAuditRows: 1284,
      scannedAttempts: 23,
      anomalies: [
        { kind: "toplu-okuma", key: "toplu-okuma|ornek.kullanici", actor: "ornek.kullanici", severity: "yuksek", title: "Kısa sürede çok sayıda farklı çalışma açıldı", detail: "10 dakikada 31 farklı çalışma (eşik 25). Nedenini kişiye sorun; öğretici/toplu iş meşru olabilir. (örnek)", count: 31, windowMin: 10, firstAt: iso(3 * HOUR), lastAt: iso(3 * HOUR - 8 * 60_000) },
        { kind: "tek-hasta-yogun", key: "tek-hasta-yogun|a.demir|3420", actor: "a.demir", severity: "orta", title: "Aynı çalışmayı kısa sürede tekrar tekrar açtı", detail: "1 saatte aynı çalışma (#3420) 13 kez açıldı (eşik 12). Kendi hastası olmayabilir; manuel doğrulama gerekir. (örnek)", count: 13, windowMin: 60, firstAt: iso(26 * HOUR), lastAt: iso(26 * HOUR - 35 * 60_000), entityId: "3420" },
        { kind: "mesai-disi", key: "mesai-disi|m.kaya", actor: "m.kaya", severity: "izle", title: "Mesai dışı saatlerde çok sayıda görüntüleme", detail: "22:00–07:00 arasında 19 görüntüleme (eşik 15). Nöbet/talebe meşru olabilir; yalnız desen olarak izlenir. (örnek)", count: 19, windowMin: null, firstAt: iso(5 * DAY), lastAt: iso(4 * DAY) },
      ],
      alert: { total: 3, high: 1, sent: 1 },
      note: "DEMO VERİSİ — Heuristik desendir; tek başına suistimal kanıtı değildir. Alarm sesiyle ölçülen her satır için kişiye haber verip denetim kaydındaki gerçek satırları inceleyin. (örnek)",
    });
  }

  return null;
}

if (typeof window !== "undefined" && !(window as unknown as { __adminDemoShim?: boolean }).__adminDemoShim) {
  (window as unknown as { __adminDemoShim?: boolean }).__adminDemoShim = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^\/api\//.test(raw)) {
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      try {
        const res = await route(method, new URL(raw, window.location.origin), init);
        if (res) return res;
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Yerel işlem hatası", 500);
      }
      return fail("Statik demo: bu uç yalnızca tam sürümde çalışır", 503);
    }
    return orig(input, init);
  };
}

export default function StaticAdminShim() {
  return null;
}
