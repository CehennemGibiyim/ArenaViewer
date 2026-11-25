/**
 * Kapanış döngüsü kanıt paketi ve dış iletişim defteri — d-close-loop.
 *
 * Mevcut durum: `closeLoopRules.ts` süre politikasını/durum makinesini,
 * `/api/notifications?escalation=1` + `sweep` eskalasyonu, `notifyDelivery` ise
 * kanal teslimatını yönetiyor. Eksik kalan iki parça burada tamamlanır:
 *
 *  1. **Kanıt paketi** (`loopEvidence`): bir bildirimin yaşam çevrimi tek
 *     belgede toplanır — oluşturma → hatırlatma → eskalasyon → alınma → iletim.
 *     Her adımın zaman damgası, gecikmesi ve politika karşılaştırması yazılır;
 *     eksik adım **"kanıt yok"** olarak işaretlenir (uydurma tamamlanmaz).
 *     Denetçi "kritik sonuç kime, ne zaman iletildi?" sorusunu tek belgeden
 *     yanıtlayabilir.
 *  2. **Dış iletişim defteri** (`commLog`): e-posta/SMS/telefon araması gibi
 *     uygulama dışı iletişimin kaydı. Sağlayıcı kurumda olsa bile "aradım,
 *     kimse çıkmadı" bilgisi kayıt altına alınır; bu kayıt olmadan döngü
 *     "iletildi" sayılmaz (`closable`).
 *
 * Klinik karar aracı değildir; kayıt/denetim yardımcısıdır.
 */

import { escalationMessage, ESCALATION_ROLES, loopStatus, policyFor, type LoopPolicy, type LoopRow, type LoopState } from "./closeLoopRules";

export type CommChannel = "telefon" | "eposta" | "sms" | "yuz-yuze" | "pacs-mesaj" | "diger";

export const COMM_CHANNELS: { id: CommChannel; label: string }[] = [
  { id: "telefon", label: "Telefon" },
  { id: "eposta", label: "E-posta" },
  { id: "sms", label: "SMS" },
  { id: "yuz-yuze", label: "Yüz yüze" },
  { id: "pacs-mesaj", label: "PACS/HBYS mesajı" },
  { id: "diger", label: "Diğer" },
];

export interface CommEntry {
  id: number;
  notificationId: number;
  at: string;
  channel: CommChannel;
  /** Kime (rol/kişi adı) */
  toWhom: string;
  /** Görüşüldü mü; false ise "ulaşılamadı" */
  reached: boolean;
  /** Kısa not (450 karakter) */
  note: string;
  /** Kaydı giren kullanıcı */
  byName: string;
}

export interface CommInput {
  notificationId: number;
  channel: string;
  toWhom: string;
  reached: boolean;
  note?: string;
}

/** İletişim kaydını doğrular; geçersiz alan varsa **kayıt yapılmaz**. */
export function validateComm(input: CommInput, now = new Date()): { ok: true; entry: Omit<CommEntry, "id" | "byName"> } | { ok: false; error: string } {
  if (!Number.isInteger(input.notificationId) || input.notificationId <= 0) return { ok: false, error: "Bildirim kimliği geçersiz" };
  const channel = COMM_CHANNELS.find((c) => c.id === input.channel);
  if (!channel) return { ok: false, error: `Kanal geçersiz: ${input.channel || "(boş)"}` };
  const toWhom = (input.toWhom ?? "").trim().slice(0, 80);
  if (!toWhom) return { ok: false, error: "Kime iletildiği yazılmalı (rol veya kişi)" };
  if (typeof input.reached !== "boolean") return { ok: false, error: "reached alanı boolean olmalı" };
  return {
    ok: true,
    entry: {
      notificationId: input.notificationId,
      at: now.toISOString(),
      channel: input.channel as CommChannel,
      toWhom,
      reached: input.reached,
      note: (input.note ?? "").trim().slice(0, 450),
    },
  };
}

export interface EvidenceStep {
  /** oluşturuldu | hatırlatma | eskalasyon | alındı | iletim | dış-iletişim */
  key: string;
  label: string;
  at: string | null;
  /** Oluşturmadan bu adıma geçen dakika */
  minutes: number | null;
  /** Politika hedefi (dk) veya null */
  target: number | null;
  /** Hedef içinde mi; ölçüm/hedef yoksa null */
  withinTarget: boolean | null;
  /** Kanıt var mı (zaman damgası) */
  present: boolean;
  detail: string;
}

export interface LoopEvidence {
  notificationId: number;
  severity: string;
  state: LoopState;
  ageMinutes: number;
  policy: LoopPolicy;
  steps: EvidenceStep[];
  /** Döngü kapatılabilir mi: alındı + (iletim kanıtı veya dış iletişim kaydı) */
  closable: boolean;
  /** Eksik kanıtlar (denetçiye) */
  gaps: string[];
  /** Tek satır özet */
  headline: string;
  /** Denetim/rapor için metin */
  text: string;
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
};

const diffMin = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  return d < 0 ? null : Math.round(d);
};

export interface ReminderRecord {
  at: string;
  channel?: string;
}

/**
 * Kanıt paketi. Hatırlatma/iletişim kayıtları dışarıdan verilir (veritabanı
 * şeması bildirim tablosunda bunları tutmaz; çağıran `commLog`/denetim
 * satırlarından toplar).
 */
export function loopEvidence(
  row: LoopRow,
  opts: { reminders?: ReminderRecord[]; comms?: CommEntry[]; now?: number } = {},
): LoopEvidence {
  const now = opts.now ?? Date.now();
  const st = loopStatus(row, now);
  const created = iso(row.createdAt);
  const ackAt = iso(row.ackAt);
  const relayedAt = iso(row.relayedAt);
  const escalatedAt = iso(row.escalatedAt);
  const comms = (opts.comms ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
  const reminders = (opts.reminders ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));

  const steps: EvidenceStep[] = [];
  const push = (key: string, label: string, at: string | null, target: number | null, detail: string) => {
    const minutes = diffMin(created, at);
    steps.push({ key, label, at, minutes, target, withinTarget: minutes === null || target === null ? null : minutes <= target, present: !!at, detail });
  };

  push("olusturuldu", "Oluşturuldu", created, null, created ? "Bildirim kaydı açıldı." : "Oluşturma zamanı okunamadı.");
  push("hatirlatma", "Hatırlatma", reminders[0]?.at ?? null, st.policy.ackMinutes, reminders.length ? `${reminders.length} hatırlatma gönderildi (son: ${reminders[reminders.length - 1].at}).` : "Hatırlatma kaydı yok.");
  push("eskalasyon", "Eskalasyon", escalatedAt, st.policy.escalateMinutes, escalatedAt ? "Eskalasyon kaydı var." : st.policy.escalateMinutes === null ? "Bu önem derecesinde eskalasyon politikası yok." : "Eskalasyon yapılmadı.");
  push("alindi", "Alındı", ackAt, st.policy.ackMinutes, ackAt ? "Hekim bildirimi aldı." : "Alınma kaydı YOK.");
  push("iletim", "İletim kanıtı", relayedAt, null, relayedAt ? "İletim (relayedTo/relayedAt) kayıtlı." : "İletim kanıtı yok.");
  if (comms.length) {
    const last = comms[comms.length - 1];
    push("dis-iletisim", "Dış iletişim", last.at, null, `${comms.length} dış iletişim kaydı; son: ${COMM_CHANNELS.find((c) => c.id === last.channel)?.label ?? last.channel} → ${last.toWhom}${last.reached ? "" : " (ulaşılamadı)"}.`);
  } else {
    push("dis-iletisim", "Dış iletişim", null, null, "Dış iletişim kaydı yok.");
  }

  const gaps: string[] = [];
  if (!ackAt) gaps.push("Alınma (ACK) kaydı yok.");
  if (!relayedAt && comms.length === 0) gaps.push("İletim kanıtı da dış iletişim kaydı da yok.");
  if (!relayedAt && comms.length > 0 && !comms.some((c) => c.reached)) gaps.push("Dış iletişim denendi ama hiçbirinde ulaşıldı olarak işaretlenmedi.");
  if (st.policy.escalateMinutes !== null && !escalatedAt && st.ageMinutes >= st.policy.escalateMinutes) {
    gaps.push(`Eskalasyon süresi (${st.policy.escalateMinutes} dk) aşıldı ama eskalasyon kaydı yok.`);
  }
  if (row.escalated && !escalatedAt) gaps.push("Eskalasyon işaretli ama zaman damgası yok.");

  const reached = comms.some((c) => c.reached);
  const closable = !!ackAt && (!!relayedAt || reached);
  const headline = closable
    ? `Döngü kapatılabilir: ${row.severity} bildirim #${row.id} alındı${relayedAt ? " ve iletildi" : " ve dış iletişimle ulaştırıldı"}.`
    : `Döngü AÇIK: ${row.severity} bildirim #${row.id} — ${gaps.length ? gaps[0] : "kanıt eksik"}`;

  const lines = [
    `Kanıt paketi — bildirim #${row.id} (${row.severity})`,
    `Durum: ${st.state} · yaş ${st.ageMinutes} dk · politika: alınma ${st.policy.ackMinutes} dk${st.policy.escalateMinutes !== null ? `, eskalasyon ${st.policy.escalateMinutes} dk` : ""}`,
    ...steps.filter((s) => s.present || s.key === "alindi" || s.key === "iletim").map((s) => `- ${s.label}: ${s.at ?? "YOK"}${s.minutes !== null ? ` (+${s.minutes} dk)` : ""}${s.withinTarget === false ? " — HEDEF DIŞI" : ""} · ${s.detail}`),
    `Kapatılabilir: ${closable ? "evet" : "hayır"}`,
    ...gaps.map((g) => `⚠ ${g}`),
    "Bu paket denetim amaçlıdır; klinik değerlendirme hekime aittir.",
  ];
  return { notificationId: row.id, severity: row.severity, state: st.state, ageMinutes: st.ageMinutes, policy: st.policy, steps, closable, gaps, headline, text: lines.join("\n") };
}

/** Eskalasyon mesajı sarmalayıcı (politika + hedef doğrulaması). */
export function buildEscalation(row: LoopRow, target: { role: string; contact: string }, now = Date.now()): { ok: boolean; message: string; error?: string } {
  const known = ESCALATION_ROLES.some((r) => r.id === target.role);
  if (!known) return { ok: false, message: "", error: `Eskalasyon hedefi geçersiz: ${target.role || "(boş)"}` };
  const st = loopStatus(row, now);
  if (st.state === "alinmis" || st.state === "iletildi") {
    return { ok: false, message: "", error: "Bildirim alınmış; eskalasyon gerekmez." };
  }
  return { ok: true, message: escalationMessage(row, st, target) };
}

/** Politika tablosu (panoda gösterim). */
export function policyTable(): { severity: string; ackMinutes: number; escalateMinutes: number | null }[] {
  return (["kritik", "yuksek", "orta", "dusuk", "bilgi"] as const).map((s) => {
    const p = policyFor(s);
    return { severity: s, ackMinutes: p.ackMinutes, escalateMinutes: p.escalateMinutes };
  });
}

/** Dış iletişim defteri CSV'si. */
export function commCsv(entries: CommEntry[]): string {
  const head = ["Bildirim", "Zaman", "Kanal", "Kime", "Ulaşıldı", "Not", "Kaydeden"];
  const rows = entries.map((e) => [
    String(e.notificationId),
    e.at,
    COMM_CHANNELS.find((c) => c.id === e.channel)?.label ?? e.channel,
    e.toWhom,
    e.reached ? "evet" : "hayır",
    e.note.replace(/;/g, ","),
    e.byName,
  ]);
  return [head, ...rows].map((r) => r.join(";")).join("\n");
}
