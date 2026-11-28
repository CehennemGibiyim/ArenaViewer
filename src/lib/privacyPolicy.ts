/**
 * t-privacy — satır düzeyi rol matrisi + saklama (retention) politikası.
 *
 * Saf karar çekirdeği: hangi kullanıcı hangi raporu görebilir, hangi kayıt
 * saklama süresi dolduğunda silinebilir — DB ve HTTP olarak dışarıda.
 *
 * **Satır düzeyi rol matrisi** (`canViewReport`): bugün her yetkili tüm raporları
 * görebiliyor; burada yonetici tümünü, radyolog yalnızca kendi oluşturduğu ya da
 * kendisine atanmış çalışmanın raporunu, teknisyen hiçbir raporu görmez.
 *
 * **Saklama politikası** (`planRetentionSweep`): `PRIVACY_RETENTION_*_DAYS`
 * ayarlarından doğan politika; tanımlı değilse **hiçbir şey silinmez**
 * (yanlışlıkla veri kaybı, KVKK ihlalinden büyük hata — `auditArchivePlan`
 * deseni). Imzalı (onaylı) raporlar **korunaklı** — hukuki kayıt olarak
 * saklama politikasına tabi değildir.
 */
import type { UserInfo } from "@/lib/types";

export type RetentionKind = "report" | "share" | "notification";

/** Saf karar çekirdeği için row görünümleri. */
export interface ReportRow {
  id: number;
  /** taslak | onaylandi */
  status: string;
  /** imzalandıysa boş değil; hukuki kayıt → korunaklı */
  signatureMeta: string;
  createdBy: number | null;
}

export interface StudyRow {
  id: number;
  assignedTo: number | null;
}

export interface RetentionItem {
  id: number;
  kind: RetentionKind;
  createdAt: string | Date;
  /** Korunaklı kayıt (imzalı rapor) — saklama politikasına tabi değildir. */
  immutable?: boolean;
}

/**
 * Satır düzeyi erişim matrisi. Yoksullama yerine kesin kısıt:
 *  - yonetici: tüm raporlar;
 *  - radyolog: kendi oluşturduğu (createdBy) ya da kendisine atanmış çalışma
 *    (study.assignedTo)ın raporu;
 *  - teknisyen: hiçbir rapor (raporlar hekim çalıştırması).
 */
export function canViewReport(user: UserInfo, report: ReportRow, study: StudyRow): boolean {
  if (user.role === "yonetici") return true;
  if (user.role === "radyolog") {
    return report.createdBy === user.id || study.assignedTo === user.id;
  }
  return false;
}

/** Nedenle erişim kararı (uit/uyarı metni için). */
export function reportAccess(user: UserInfo, report: ReportRow, study: StudyRow): { ok: boolean; reason: string } {
  if (user.role === "yonetici") return { ok: true, reason: "yönetici: tüm raporlar" };
  if (user.role === "radyolog") {
    if (report.createdBy === user.id) return { ok: true, reason: "raporu oluşturdu" };
    if (study.assignedTo === user.id) return { ok: true, reason: "çalışma kendisine atanmış" };
    return { ok: false, reason: "raporlara erişim sınırlı (yazarı/atananı değil)" };
  }
  return { ok: false, reason: "teknisyen rapor erişimine sahip değildir" };
}

/** Birincil filtre: kullanıcının görebileceği rapor satırları. */
export function filterVisibleReports<T extends { r: ReportRow; s: StudyRow }>(user: UserInfo, rows: T[]): T[] {
  return rows.filter((x) => canViewReport(user, x.r, x.s));
}

/** Saklama politikası (gün başına). 0 = kapalı (hiçbir şey silinmez). */
export interface RetentionPolicy {
  reportDays: number;
  shareDays: number;
  notificationDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  reportDays: 0,
  shareDays: 0,
  notificationDays: 0,
};

/** Ortamdan politikayı okur; tanımlı/geçerli olmayan değer → 0 (kapali). */
export function retentionPolicyFromEnv(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const days = (v: string | undefined): number => {
    const raw = (v ?? "").trim();
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) || n < 0 ? 0 : Math.floor(n);
  };
  return {
    reportDays: days(env.PRIVACY_RETENTION_REPORT_DAYS),
    shareDays: days(env.PRIVACY_RETENTION_SHARE_DAYS),
    notificationDays: days(env.PRIVACY_RETENTION_NOTIFICATION_DAYS),
  };
}

/** Belirli bir türü kapalı mu? */
export function retentionDays(policy: RetentionPolicy, kind: RetentionKind): number {
  return kind === "report" ? policy.reportDays : kind === "share" ? policy.shareDays : policy.notificationDays;
}

/** Kayıt saklama süresini aştı mı? `days <= 0` → kapalı → hiçbiri expired değildir. */
export function isExpired(createdAt: string | Date, days: number, now = Date.now()): boolean {
  if (days <= 0) return false;
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return t < now - days * 86_400_000;
}

/**
 * Silme planını üretir: pencere dışı + korunaklı olmayan kayıtlar `toDelete`,
 * korunaklı kayıtlar `protected`, pencere içi kayıtlar `kept`.
 */
export function planRetentionSweep(
  items: RetentionItem[],
  policy: RetentionPolicy,
  now = Date.now()
): { toDelete: RetentionItem[]; protected: RetentionItem[]; kept: RetentionItem[] } {
  const toDelete: RetentionItem[] = [];
  const protected_: RetentionItem[] = [];
  const kept: RetentionItem[] = [];
  for (const item of items) {
    if (item.immutable) {
      protected_.push(item);
      continue;
    }
    if (isExpired(item.createdAt, retentionDays(policy, item.kind), now)) {
      toDelete.push(item);
    } else {
      kept.push(item);
    }
  }
  return { toDelete, protected: protected_, kept };
}

/** Plan özeti (uç/script çıktısı). */
export function retentionSummary(plan: { toDelete: RetentionItem[]; protected: RetentionItem[]; kept: RetentionItem[] }) {
  const count = (k: RetentionKind, arr: RetentionItem[]) => arr.filter((i) => i.kind === k).length;
  return {
    total: plan.toDelete.length + plan.protected.length + plan.kept.length,
    delete: plan.toDelete.length,
    protected: plan.protected.length,
    kept: plan.kept.length,
    deleteByKind: {
      report: count("report", plan.toDelete),
      share: count("share", plan.toDelete),
      notification: count("notification", plan.toDelete),
    },
  };
}

/** Politika özeti (uç GET / script başlangıç çıktısı). */
export function retentionPolicySummary(policy: RetentionPolicy) {
  const open = (d: number) => d > 0;
  return {
    reportDays: policy.reportDays,
    shareDays: policy.shareDays,
    notificationDays: policy.notificationDays,
    active: open(policy.reportDays) || open(policy.shareDays) || open(policy.notificationDays),
  };
}

/** Tüm tür kapalıysa politika kapalıdır. */
export function retentionDisabled(policy: RetentionPolicy): boolean {
  return !retentionPolicySummary(policy).active;
}
