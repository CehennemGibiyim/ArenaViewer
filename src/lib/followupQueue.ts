/**
 * Takip önerisi görevleri — çalışma listesi kuralları (d-followup).
 *
 * Mevcut durum: onaylı rapordaki "Öneri" metni göreve dönüşüyor, durum/süre
 * tutuluyordu; EKSİK olan tarih disipliniydi: yaklaşan son tarih uyarısı,
 * geciken görev görünürlüğü ve sonucun (HBYS/RIS iadesi) göreve bağlanması.
 *
 * Bu modül DB'siz kural katmanıdır; çalışma listesi ve bildirimler buradan
 * beslenir. Klinik karar üretmez, yalnız iş akışını izler.
 */

export type FollowupStatus = "acik" | "tamamlandi" | "iptal";

export interface FollowupTask {
  id: number;
  kind?: string;
  status: FollowupStatus;
  dueDate: string; // YYYY-MM-DD, boş olabilir
  severity: string;
  message: string;
  modality?: string;
  bodyRegion?: string;
  studyUid?: string;
  reportId?: number | null;
  /** Sonuç kaydı (HBYS iadesi / sonraki tetkik) */
  outcome?: string;
  outcomeAt?: string | null;
  completedAt?: string | null;
}

export type DueBucket = "geciken" | "bugun" | "yaklasan" | "ileri" | "tarihsiz" | "kapali";

/** Yaklaşan sayılma penceresi (gün). */
export const UPCOMING_DAYS = 14;

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** `dueDate` (YYYY-MM-DD) → gece yarısı zaman damgası; geçersizse null. */
export function parseDue(dueDate: string): number | null {
  const s = (dueDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00`).getTime();
  // 2026-11-32 gibi taşan tarihler JS'te kayar; geri kontrolle eleyin.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

/** Görevin sonuç tarihine göre kovası. */
export function dueBucket(t: FollowupTask, now = Date.now()): DueBucket {
  if (t.status !== "acik") return "kapali";
  const due = parseDue(t.dueDate);
  if (due === null) return "tarihsiz";
  const today = startOfDay(now);
  const days = Math.round((due - today) / DAY);
  if (days < 0) return "geciken";
  if (days === 0) return "bugun";
  if (days <= UPCOMING_DAYS) return "yaklasan";
  return "ileri";
}

export const BUCKET_LABEL: Record<DueBucket, string> = {
  geciken: "Geciken",
  bugun: "Bugün",
  yaklasan: `Yaklaşan (${UPCOMING_DAYS} gün)`,
  ileri: "İleri tarihli",
  tarihsiz: "Tarihsiz",
  kapali: "Kapalı",
};

/** Kalan gün (negatif = gecikme). */
export function daysLeft(t: FollowupTask, now = Date.now()): number | null {
  const due = parseDue(t.dueDate);
  if (due === null) return null;
  return Math.round((due - startOfDay(now)) / DAY);
}

export interface FollowupSummary {
  buckets: Record<DueBucket, FollowupTask[]>;
  open: number;
  overdue: number;
  dueToday: number;
  upcoming: number;
  /** Bildirim üretilmesi gereken görevler (geciken + bugün + yaklaşan) */
  alerting: FollowupTask[];
  /** Öncelik sıralı açık görev listesi (geciken → yaklaşan → ileri → tarihsiz) */
  ordered: FollowupTask[];
}

const ORDER: DueBucket[] = ["geciken", "bugun", "yaklasan", "ileri", "tarihsiz", "kapali"];

/**
 * Görevleri kovalara ayırır. Öncelik: geciken > bugün > yaklaşan > ileri >
 * tarihsiz; eşit kovada kritik önem öne geçer.
 */
export function summarizeFollowups(tasks: FollowupTask[], now = Date.now()): FollowupSummary {
  const buckets: Record<DueBucket, FollowupTask[]> = { geciken: [], bugun: [], yaklasan: [], ileri: [], tarihsiz: [], kapali: [] };
  for (const t of tasks) buckets[dueBucket(t, now)].push(t);
  const RANK: Record<string, number> = { kritik: 0, yuksek: 1, orta: 2, dusuk: 3, bilgi: 4 };
  const sev = (s: string) => RANK[s ?? ""] ?? 5;
  for (const b of ORDER) {
    buckets[b].sort((a, x) => {
      const d = (parseDue(a.dueDate) ?? Number.MAX_SAFE_INTEGER) - (parseDue(x.dueDate) ?? Number.MAX_SAFE_INTEGER);
      return d !== 0 ? d : sev(a.severity) - sev(x.severity);
    });
  }
  const ordered = ORDER.filter((b) => b !== "kapali").flatMap((b) => buckets[b]);
  return {
    buckets,
    open: ordered.length,
    overdue: buckets.geciken.length,
    dueToday: buckets.bugun.length,
    upcoming: buckets.yaklasan.length,
    alerting: [...buckets.geciken, ...buckets.bugun, ...buckets.yaklasan],
    ordered,
  };
}

/** Yaklaşan/geciken görev için bildirim metni. */
export function followupAlert(task: FollowupTask, now = Date.now()): string | null {
  if (task.status !== "acik") return null;
  const b = dueBucket(task, now);
  const d = daysLeft(task, now);
  const parts = `Takip görevi #${task.id}${task.modality ? ` · ${task.modality}` : ""}${task.bodyRegion ? ` · ${task.bodyRegion}` : ""}`;
  if (b === "geciken") return `${parts}: son tarih ${task.dueDate} — ${(d ?? 0) * -1} gün GECİKTİ.`;
  if (b === "bugun") return `${parts}: son tarih BUGÜN (${task.dueDate}).`;
  if (b === "yaklasan") return `${parts}: son tarih ${task.dueDate} — ${d} gün kaldı.`;
  return null;
}

/**
 * HBYS/RIS iadesi eşleme: gelen sonuç kaydı hangi göreve ait?
 * Eşleşme sırası: rapor kimliği → çalışma UID'si → hasta/bölge+modalite
 * (yalnız tek aday varsa; belirsizse eşleşme YAPILMAZ).
 */
export interface ReturnedResult {
  reportId?: number | null;
  studyUid?: string;
  modality?: string;
  bodyRegion?: string;
  text: string;
  at?: string;
}

export function matchReturnedResult(r: ReturnedResult, tasks: FollowupTask[]): { task: FollowupTask | null; reason: string } {
  const open = tasks.filter((t) => t.status === "acik");
  if (r.reportId != null) {
    const hit = open.find((t) => t.reportId === r.reportId);
    if (hit) return { task: hit, reason: "Rapor kimliği eşleşti" };
  }
  if (r.studyUid) {
    const hit = open.find((t) => t.studyUid && t.studyUid === r.studyUid);
    if (hit) return { task: hit, reason: "Çalışma UID eşleşti" };
  }
  const mod = (r.modality ?? "").toUpperCase();
  const region = (r.bodyRegion ?? "").toLocaleUpperCase("tr-TR");
  const cands = open.filter(
    (t) => (!mod || (t.modality ?? "").toUpperCase() === mod) && (!region || (t.bodyRegion ?? "").toLocaleUpperCase("tr-TR") === region),
  );
  if (cands.length === 1) return { task: cands[0], reason: "Tek aday (modalite/bölge)" };
  if (cands.length > 1) return { task: null, reason: `${cands.length} aday var — hekim seçmelidir` };
  return { task: null, reason: "Eşleşen açık görev yok" };
}

/** Sonuç kaydıyla görevi kapatma (metin + zaman). */
export function closeWithOutcome(t: FollowupTask, r: ReturnedResult, now = Date.now()): FollowupTask {
  const stamp = r.at ?? new Date(now).toISOString();
  return {
    ...t,
    status: "tamamlandi",
    completedAt: stamp,
    outcome: (r.text ?? "").trim().slice(0, 2000),
    outcomeAt: stamp,
  };
}

/** Çalışma listesi CSV'si (görev tarihçesi). */
export function followupCsv(tasks: FollowupTask[], now = Date.now()): string {
  const rows = [
    ["Takip görevleri", ""],
    ["#", "Durum", "Kova", "Son tarih", "Kalan gün", "Önem", "Modalite", "Bölge", "Mesaj", "Sonuç", "Sonuç zamanı"],
    ...tasks.map((t) => [
      String(t.id),
      t.status,
      dueBucket(t, now),
      t.dueDate || "—",
      daysLeft(t, now) === null ? "—" : String(daysLeft(t, now)),
      t.severity,
      t.modality ?? "",
      t.bodyRegion ?? "",
      t.message.replace(/[\r\n;]+/g, " ").slice(0, 300),
      (t.outcome ?? "").replace(/[\r\n;]+/g, " ").slice(0, 300),
      t.outcomeAt ?? "",
    ]),
  ];
  return rows.map((r) => r.join(";")).join("\n");
}
