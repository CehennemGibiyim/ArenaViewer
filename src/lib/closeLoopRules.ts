/**
 * Kritik sonuç kapanış döngüsü kuralları (d-close-loop).
 *
 * Mevcut durum: "alındı" (ack), "iletildi" kanıtı (relayedTo/At) ve eskalasyon
 * bayrağı vardı; ancak SÜRE denetimi yoktu — bir bildirim saatlerce okunmadan
 * kalabilirdi. Burada süre eşikleri ve ikinci hekim/kurum eskalasyonu SAF kural
 * olarak tanımlanır (DB'siz, test edilebilir); sunucu katmanı bunları uygular.
 *
 * Eşikler (kurum politikasıyla değiştirilebilir):
 *   kritik  → 15 dk içinde alınmalı, 30 dk'da eskalasyon
 *   yüksek  → 60 dk içinde alınmalı, 120 dk'da eskalasyon
 *   diğer   → 4 saat içinde alınmalı, eskalasyon yok (bilgi amaçlı)
 */

export type Severity = "kritik" | "yuksek" | "orta" | "dusuk" | "bilgi";

export interface LoopRow {
  id: number;
  severity: string;
  createdAt: Date | string;
  ackAt?: Date | string | null;
  relayedAt?: Date | string | null;
  escalated?: boolean;
  escalatedAt?: Date | string | null;
}

export interface LoopPolicy {
  /** Alınması gereken süre (dakika) */
  ackMinutes: number;
  /** Eskalasyon süresi (dakika); null = eskalasyon yok */
  escalateMinutes: number | null;
}

const POLICY: Record<Severity, LoopPolicy> = {
  kritik: { ackMinutes: 15, escalateMinutes: 30 },
  yuksek: { ackMinutes: 60, escalateMinutes: 120 },
  orta: { ackMinutes: 240, escalateMinutes: null },
  dusuk: { ackMinutes: 240, escalateMinutes: null },
  bilgi: { ackMinutes: 240, escalateMinutes: null },
};

export function policyFor(severity: string): LoopPolicy {
  return POLICY[(severity as Severity)] ?? POLICY.bilgi;
}

export type LoopState =
  | "yeni"                     // henüz alınmadı, süresi dolmadı
  | "gecikmis"                 // alınmadı ve ack süresi aştı
  | "eskalasyon-gerekli"       // alınmadı, eskalasyon süresi aştı, eskalasyon yapılmadı
  | "eskale-edildi"
  | "iletildi"                 // alındı + iletim kanıtı var
  | "alinmis";                 // alındı, iletim kanıtı yok

export interface LoopStatus {
  state: LoopState;
  /** Oluşturmadan bu yana geçen dakika */
  ageMinutes: number;
  /** Alınması için kalan dakika (negatif = gecikme) */
  dueInMinutes: number;
  severity: Severity;
  policy: LoopPolicy;
  /** Kullanıcıya gösterilecek kısa etiket */
  label: string;
  /** Bu satır için hatırlatma üretilmeli mi */
  remind: boolean;
}

const dt = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Satırın kapanış döngüsü durumunu hesaplar. `now` enjekte edilebilir (test). */
export function loopStatus(r: LoopRow, now = Date.now()): LoopStatus {
  const sev = ((r.severity ?? "") as Severity);
  const policy = policyFor(r.severity);
  const created = dt(r.createdAt) ?? now;
  const ageMinutes = Math.max(0, Math.floor((now - created) / 60000));
  const ackAt = dt(r.ackAt);
  const relayedAt = dt(r.relayedAt);
  const escalatedAt = dt(r.escalatedAt);
  const dueInMinutes = policy.ackMinutes - ageMinutes;

  if (ackAt) {
    return {
      state: relayedAt ? "iletildi" : "alinmis",
      ageMinutes, dueInMinutes, severity: sev, policy,
      label: relayedAt ? "alındı + iletildi" : "alındı (iletim kanıtı yok)",
      remind: false,
    };
  }
  const escalateDue = policy.escalateMinutes !== null && ageMinutes >= policy.escalateMinutes;
  if (r.escalated || escalatedAt) {
    return { state: "eskale-edildi", ageMinutes, dueInMinutes, severity: sev, policy, label: "eskale edildi — alındı bekleniyor", remind: true };
  }
  if (escalateDue) {
    return { state: "eskalasyon-gerekli", ageMinutes, dueInMinutes, severity: sev, policy, label: `SÜRE AŞILDI (${ageMinutes} dk) — eskalasyon gerekli`, remind: true };
  }
  if (ageMinutes >= policy.ackMinutes) {
    return { state: "gecikmis", ageMinutes, dueInMinutes, severity: sev, policy, label: `gecikmiş (${ageMinutes} dk)`, remind: true };
  }
  return { state: "yeni", ageMinutes, dueInMinutes, severity: sev, policy, label: "yeni", remind: false };
}

/** Eskalasyon hedefi: birincil hekim dışında ikinci hekim/kurum. */
export interface EscalationTarget {
  /** "ikinci-hekim" | "sorumlu-uzman" | "kurum-nobet" */
  role: string;
  /** Kişi/kurum adı veya iletişim (boşsa kurum panosuna düşer) */
  contact: string;
}

export const ESCALATION_ROLES: { id: string; label: string }[] = [
  { id: "ikinci-hekim", label: "İkinci hekim (aynı kurum)" },
  { id: "sorumlu-uzman", label: "Sorumlu uzman / bölüm şefi" },
  { id: "kurum-nobet", label: "Kurum nöbet hattı" },
];

/** Eskalasyon mesajı: kim, neden, ne kadar gecikti. */
export function escalationMessage(r: LoopRow, s: LoopStatus, target: EscalationTarget): string {
  const sev = r.severity || "bilgi";
  return [
    `[ESKALASYON · ${sev.toUpperCase()}] Bildirim #${r.id} ${s.ageMinutes} dk boyunca alınmadı.`,
    `Hedef: ${ESCALATION_ROLES.find((x) => x.id === target.role)?.label ?? target.role}${target.contact ? ` — ${target.contact}` : ""}.`,
    `Politika: alınma süresi ${s.policy.ackMinutes} dk${s.policy.escalateMinutes !== null ? `, eskalasyon ${s.policy.escalateMinutes} dk` : ", eskalasyon yok"}.`,
    "Lütfen bulguyu inceleyip 'alındı' ve 'iletildi' kaydını tamamlayın.",
  ].join(" ");
}

/** Denetim kaydı için kısa özet (SIEM/HBYS ile birleştirmeye uygun). */
export function loopAuditDetails(r: LoopRow, s: LoopStatus): Record<string, string | number | boolean> {
  return {
    severity: r.severity,
    state: s.state,
    ageMinutes: s.ageMinutes,
    ackMinutesPolicy: s.policy.ackMinutes,
    escalateMinutesPolicy: s.policy.escalateMinutes ?? -1,
    relayed: !!r.relayedAt,
    escalated: !!r.escalated,
  };
}

/** Bir satır için hatırlatma üretilmeli mi (tekrar üretimi engellemek için damga). */
const REMIND_EVERY_MIN = 15;
export function shouldRemind(r: LoopRow, s: LoopStatus, lastReminderAt?: Date | string | null, now = Date.now()): boolean {
  if (!s.remind) return false;
  const last = dt(lastReminderAt);
  if (last === null) return true;
  return now - last >= REMIND_EVERY_MIN * 60000;
}
