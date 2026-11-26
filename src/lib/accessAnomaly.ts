/**
 * Erişim anomalisi tespiti — saf çekirdek (yeni fikir: KVKK erişim denetimi).
 *
 * Denetim kaydındaki (audit_logs) ve giriş denemesi (login_attempts) satırlarını
 * tarayıp insanlara **bakılması gereken** desenleri deterministik olarak çıkarır:
 *
 *   toplu-okuma      → aynı kullanıcı 10 dakikada ≥ 25 farklı çalışma açtı
 *   tek-hasta-yogun  → aynı kullanıcı 1 saatte aynı çalışmayı ≥ 12 kez açtı
 *   mesai-disi       → 22:00–07:00 arası ≥ 15 görüntüleme (izleme önceliği)
 *   toplu-disari     → 7 günde ≥ 6 dışa aktarım/veri çıkışı (paylaşım açma,
 *                      dış erişim, PACS gönderimi, FHIR ihracı); ≥ 20 → yüksek
 *   giris-denemesi   → 15 dakikada aynı kullanıcı için ≥ 8 veya aynı IP için
 *                      ≥ 20 başarısız giriş
 *
 * SINIRLILIK (dürüst kapsam):
 * - Heuristiktir; disiplin kanıtı DEĞİLDİR. Nöbetçi hekim, toplu iş ya da
 *   öğretici seans meşru olarak alarmı tetikleyebilir. Her bulgu, kişiye
 *   sorulmadan işlem yapılmamalıdır; denetim kaydındaki gerçek satırlar
 *   incelenmelidir.
 * - Yalnız verilen penceredeki satırlar görülür; sessiz/sonran veri yoktur.
 * - Saat dilimi sunucunun yerel saatini kullanır (ts Date'e çevrilmiş olmalı).
 * - study.open satırlarında entityId çalışmanın veritabanı kimliğidir; hasta
 *   bağlantısı çalışma listesiyle eşleştirilerek kurulmalıdır.
 */
export interface AuditRowLite {
  userId: number | null;
  username: string;
  action: string;
  entityType: string;
  entityId: string;
  /** ISO metin ya da Date — ikisi de kabul edilir. */
  ts: string | Date;
}

export interface LoginAttemptLite {
  username: string;
  ip: string;
  ok: boolean;
  at: string | Date;
  reason?: string;
}

export type AnomalyKind = "toplu-okuma" | "tek-hasta-yogun" | "mesai-disi" | "toplu-disari" | "giris-denemesi";
export type AnomalySeverity = "yuksek" | "orta" | "izle";

export interface AccessAnomaly {
  kind: AnomalyKind;
  /** Kararlı anahtar (kind|kimlik[|entity]) — bildirim idempotency'si için. */
  key: string;
  actor: string;
  severity: AnomalySeverity;
  title: string;
  detail: string;
  count: number;
  windowMin: number | null;
  firstAt: string;
  lastAt: string;
  /** tek-hasta-yogun için çalışmanın kimliği. */
  entityId?: string;
}

export const BULK_READ_MIN = 25;
export const BULK_READ_WINDOW_MIN = 10;
export const SINGLE_PATIENT_MIN = 12;
export const SINGLE_PATIENT_WINDOW_MIN = 60;
export const OFF_HOURS_MIN = 15;
export const OFF_HOURS_START = 22; // 22:00
export const OFF_HOURS_END = 7; // 07:00 (haricî)
export const EXPORT_MIN = 6;
export const EXPORT_HIGH = 20;
export const LOGIN_FAIL_USER_MIN = 8;
export const LOGIN_FAIL_IP_MIN = 20;
export const LOGIN_FAIL_WINDOW_MIN = 15;

const READ_ACTIONS = new Set(["study.open", "report.view", "report.peer_review_view", "pacs.retrieve", "pacs.retrieve_frames"]);
// Dışarı veri çıkışı / paylaşım (istinat: src içindeki gerçek eylem adları):
// report.export_fhir, share.create, share.access (bağlantıya dışarıdan erişim), pacs.send_* (PACS'e gönderim)
const EXPORT_ACTION = /^(report\.export|share\.create|share\.access|pacs\.send_)/i;
// share.access denetimi anonim (actor=null) yazıldığından, anlamlı kova bağlantının kendisidir:
// tek bağlantı beklenenden sık açılıyorsa olası sızıntı sinyali.
const exportKey = (r: AuditRowLite) => (r.action === "share.access" && r.entityId ? `bağlantı ${r.entityId}` : actorOf(r));

const toDate = (v: string | Date): Date | null => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};
const iso = (d: Date) => d.toISOString();

/** Aynı kullanıcı için pencere içindeki en yüksek farklı-anahtar sayısı (iki işaretçi). */
function maxDistinctInWindow(rows: { t: Date; key: string }[], windowMin: number): { max: number; from: Date | null; to: Date | null } {
  if (rows.length === 0) return { max: 0, from: null, to: null };
  const sorted = [...rows].sort((a, b) => a.t.getTime() - b.t.getTime());
  let best = 0;
  let bestFrom: Date | null = null;
  let bestTo: Date | null = null;
  let lo = 0;
  const counts = new Map<string, number>();
  let distinct = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    const add = sorted[hi];
    const c = (counts.get(add.key) ?? 0) + 1;
    counts.set(add.key, c);
    if (c === 1) distinct++;
    // pencereyi [t-window, t] daralt
    const limit = add.t.getTime() - windowMin * 60_000;
    while (lo < hi && sorted[lo].t.getTime() < limit) {
      const rem = sorted[lo];
      const rc = (counts.get(rem.key) ?? 1) - 1;
      if (rc === 0) { counts.delete(rem.key); distinct--; } else counts.set(rem.key, rc);
      lo++;
    }
    if (distinct > best) {
      best = distinct;
      bestFrom = sorted[lo].t;
      bestTo = add.t;
    }
  }
  return { max: best, from: bestFrom, to: bestTo };
}

/** Aynı kullanıcı için pencere içindeki en yüksek olay sayısı (farklı anahtar şartı yok). */
function maxCountInWindow(rows: { t: Date }[], windowMin: number): { max: number; from: Date | null; to: Date | null } {
  if (rows.length === 0) return { max: 0, from: null, to: null };
  const sorted = [...rows].sort((a, b) => a.t.getTime() - b.t.getTime());
  let best = 0;
  let bestFrom: Date | null = null;
  let bestTo: Date | null = null;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    const limit = sorted[hi].t.getTime() - windowMin * 60_000;
    while (lo < hi && sorted[lo].t.getTime() < limit) lo++;
    const n = hi - lo + 1;
    if (n > best) {
      best = n;
      bestFrom = sorted[lo].t;
      bestTo = sorted[hi].t;
    }
  }
  return { max: best, from: bestFrom, to: bestTo };
}

const actorOf = (r: AuditRowLite) => (r.username?.trim() || (r.userId !== null ? `#${r.userId}` : "bilinmeyen"));

/** Denetim satırlarından anomalileri çıkarır. Deterministik; sıra severity'e göre. */
export function analyzeAuditRows(rows: AuditRowLite[]): AccessAnomaly[] {
  const out: AccessAnomaly[] = [];
  const parsed = rows
    .map((r) => ({ r, t: toDate(r.ts) }))
    .filter((x): x is { r: AuditRowLite; t: Date } => x.t !== null);

  // 1) Toplu okuma — yalnız study.open (çalışma kimliği uzayında farklı say)
  const byActorReads = new Map<string, { t: Date; key: string }[]>();
  for (const { r, t } of parsed) {
    if (r.action !== "study.open" || !r.entityId) continue;
    const a = actorOf(r);
    (byActorReads.get(a) ?? byActorReads.set(a, []).get(a)!).push({ t, key: r.entityId });
  }
  for (const [actor, list] of byActorReads) {
    const win = maxDistinctInWindow(list, BULK_READ_WINDOW_MIN);
    if (win.max >= BULK_READ_MIN) {
      out.push({
        kind: "toplu-okuma",
        key: `toplu-okuma|${actor}`,
        actor,
        severity: "yuksek",
        title: "Kısa sürede çok sayıda farklı çalışma açıldı",
        detail: `${BULK_READ_WINDOW_MIN} dakikada ${win.max} farklı çalışma (eşik ${BULK_READ_MIN}). Nedenini kişiye sorun; öğretici/toplu iş meşru olabilir.`,
        count: win.max,
        windowMin: BULK_READ_WINDOW_MIN,
        firstAt: win.from ? iso(win.from) : "",
        lastAt: win.to ? iso(win.to) : "",
      });
    }
  }

  // 2) Tek çalışmaya yoğun erişim — study.open, aynı entityId
  const byActorEntity = new Map<string, Map<string, { t: Date }[]>>();
  for (const { r, t } of parsed) {
    if (r.action !== "study.open" || r.entityType !== "study" || !r.entityId) continue;
    const a = actorOf(r);
    const m = byActorEntity.get(a) ?? new Map();
    (m.get(r.entityId) ?? m.set(r.entityId, []).get(r.entityId)!).push({ t });
    byActorEntity.set(a, m);
  }
  for (const [actor, m] of byActorEntity) {
    for (const [entityId, list] of m) {
      const win = maxCountInWindow(list, SINGLE_PATIENT_WINDOW_MIN);
      if (win.max >= SINGLE_PATIENT_MIN) {
        out.push({
          kind: "tek-hasta-yogun",
          key: `tek-hasta-yogun|${actor}|${entityId}`,
          actor,
          severity: "orta",
          title: "Aynı çalışmayı kısa sürede tekrar tekrar açtı",
          detail: `1 saatte aynı çalışma (#${entityId}) ${win.max} kez açıldı (eşik ${SINGLE_PATIENT_MIN}). Kendi hastası olmayabilir; manuel doğrulama gerekir.`,
          count: win.max,
          windowMin: SINGLE_PATIENT_WINDOW_MIN,
          firstAt: win.from ? iso(win.from) : "",
          lastAt: win.to ? iso(win.to) : "",
          entityId,
        });
      }
    }
  }

  // 3) Mesai dışı görüntüleme — izleme önceliği
  const byActorOff = new Map<string, { t: Date }[]>();
  for (const { r, t } of parsed) {
    if (!READ_ACTIONS.has(r.action)) continue;
    const h = t.getHours();
    if (h < OFF_HOURS_END || h >= OFF_HOURS_START) {
      const a = actorOf(r);
      (byActorOff.get(a) ?? byActorOff.set(a, []).get(a)!).push({ t });
    }
  }
  for (const [actor, list] of byActorOff) {
    if (list.length >= OFF_HOURS_MIN) {
      const sorted = [...list].sort((a, b) => a.t.getTime() - b.t.getTime());
      out.push({
        kind: "mesai-disi",
        key: `mesai-disi|${actor}`,
        actor,
        severity: "izle",
        title: "Mesai dışı saatlerde çok sayıda görüntüleme",
        detail: `22:00–07:00 arasında ${list.length} görüntüleme (eşik ${OFF_HOURS_MIN}). Nöbet/talebe meşru olabilir; yalnız desen olarak izlenir.`,
        count: list.length,
        windowMin: null,
        firstAt: iso(sorted[0].t),
        lastAt: iso(sorted[sorted.length - 1].t),
      });
    }
  }

  // 4) Toplu dışa aktarım / veri çıkışı
  const byActorOut = new Map<string, { t: Date }[]>();
  for (const { r, t } of parsed) {
    if (!EXPORT_ACTION.test(r.action)) continue;
    const a = exportKey(r);
    (byActorOut.get(a) ?? byActorOut.set(a, []).get(a)!).push({ t });
  }
  for (const [actor, list] of byActorOut) {
    if (list.length >= EXPORT_MIN) {
      const sorted = [...list].sort((a, b) => a.t.getTime() - b.t.getTime());
      const severity: AnomalySeverity = list.length >= EXPORT_HIGH ? "yuksek" : "orta";
      out.push({
        kind: "toplu-disari",
        key: `toplu-disari|${actor}`,
        actor,
        severity,
        title: "Sık dışa aktarım / paylaşım / PACS gönderimi",
        detail: `${list.length} dışa aktarım ya da paylaşım işlemi (eşik ${EXPORT_MIN}; yüksek eşik ${EXPORT_HIGH}). Hedef kurumlara bakın (share/pacs/fhir).`,
        count: list.length,
        windowMin: null,
        firstAt: iso(sorted[0].t),
        lastAt: iso(sorted[sorted.length - 1].t),
      });
    }
  }

  return sortAnomalies(out);
}

/** Başarısız giriş denemelerinden anomalileri çıkarır. */
export function analyzeLoginAttempts(attempts: LoginAttemptLite[]): AccessAnomaly[] {
  const out: AccessAnomaly[] = [];
  const parsed = attempts
    .map((r) => ({ r, t: toDate(r.at) }))
    .filter((x): x is { r: LoginAttemptLite; t: Date } => x.t !== null && x.r.ok === false);

  const byUser = new Map<string, { t: Date }[]>();
  const byIp = new Map<string, { t: Date }[]>();
  for (const { r, t } of parsed) {
    const u = r.username?.trim();
    if (u) (byUser.get(u) ?? byUser.set(u, []).get(u)!).push({ t });
    const ip = r.ip?.trim();
    if (ip) (byIp.get(ip) ?? byIp.set(ip, []).get(ip)!).push({ t });
  }
  for (const [username, list] of byUser) {
    const win = maxCountInWindow(list, LOGIN_FAIL_WINDOW_MIN);
    if (win.max >= LOGIN_FAIL_USER_MIN) {
      out.push({
        kind: "giris-denemesi",
        key: `giris-denemesi|user:${username}`,
        actor: username,
        severity: "yuksek",
        title: "Kaba kuvvet giriş denemesi (kullanıcı)",
        detail: `${LOGIN_FAIL_WINDOW_MIN} dakikada ${win.max} başarısız giriş (eşik ${LOGIN_FAIL_USER_MIN}). Hesap kilitlenmiş olmalı; parola sıfırlama ve IP kaynağını doğrulayın.`,
        count: win.max,
        windowMin: LOGIN_FAIL_WINDOW_MIN,
        firstAt: win.from ? iso(win.from) : "",
        lastAt: win.to ? iso(win.to) : "",
      });
    }
  }
  for (const [ip, list] of byIp) {
    const win = maxCountInWindow(list, LOGIN_FAIL_WINDOW_MIN);
    if (win.max >= LOGIN_FAIL_IP_MIN) {
      out.push({
        kind: "giris-denemesi",
        key: `giris-denemesi|ip:${ip}`,
        actor: ip,
        severity: "yuksek",
        title: "Kaba kuvvet giriş denemesi (IP)",
        detail: `${LOGIN_FAIL_WINDOW_MIN} dakikada ${ip} adresinden ${win.max} başarısız giriş (eşik ${LOGIN_FAIL_IP_MIN}). Kaynağı güvenlik duvarında/vekilde engelleyin.`,
        count: win.max,
        windowMin: LOGIN_FAIL_WINDOW_MIN,
        firstAt: win.from ? iso(win.from) : "",
        lastAt: win.to ? iso(win.to) : "",
      });
    }
  }
  return sortAnomalies(out);
}

const SEV_RANK: Record<AnomalySeverity, number> = { yuksek: 0, orta: 1, izle: 2 };

export function sortAnomalies(list: AccessAnomaly[]): AccessAnomaly[] {
  return [...list].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count || a.key.localeCompare(b.key));
}

/** İki listeyi birleştirir (denetim + giriş denemeleri), kararlı sırada döner. */
export function mergeAnomalies(...lists: AccessAnomaly[][]): AccessAnomaly[] {
  return sortAnomalies(lists.flat());
}
