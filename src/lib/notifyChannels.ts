/**
 * Kritik bulgu bildirim kanalları (a-notify) — saf, test edilebilir çekirdek.
 *
 * Amaç: uygulama içi bildirime ek olarak **e-posta / SMS / çağrı cihazı / webhook**
 * kanallarına aynı olayı iletmek. Taşıma katmanı bilinçli olarak sade HTTP JSON:
 * kurumun SMTP relay'i, SMS/pager ağ geçidi veya mobil push köprüsü tek bir
 * POST noktası olarak tanımlanır. Böylece sağlayıcı sözleşmesi kurumda kalır,
 * uygulama tarafında ek bağımlılık/SDK gerekmez.
 *
 * Gizlilik: olay yükü **kimliksizdir** — yalnız önem derecesi, çalışma UID'si,
 * modalite, seri açıklaması ve zaman taşınır. Hasta adı/numarası hiçbir kanala
 * gönderilmez; bulgu metni hekimin teyit edeceği kısa bir cümledir.
 */

export type NotifyKind = "webhook" | "email" | "sms" | "pager";
export const NOTIFY_KINDS: readonly NotifyKind[] = ["webhook", "email", "sms", "pager"];

export type Severity = "kritik" | "yuksek" | "orta" | "dusuk" | "bilgi";
export const SEVERITIES: readonly Severity[] = ["kritik", "yuksek", "orta", "dusuk", "bilgi"];

const RANK: Record<Severity, number> = { kritik: 4, yuksek: 3, orta: 2, dusuk: 1, bilgi: 0 };

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/** `a` en az `b` kadar acil mi? */
export function severityAtLeast(a: Severity, b: Severity): boolean {
  return RANK[a] >= RANK[b];
}

export interface NotifyChannel {
  /** Kararlı kimlik (ayarlarda görünür, denetim kaydında geçer). */
  id: string;
  kind: NotifyKind;
  /** HTTP(S) POST adresi — kurumun ağ geçidi. */
  url: string;
  /** E-posta adresi / telefon / çağrı cihazı numarası (webhook'ta boş). */
  to?: string;
  /** Bu kanal yalnız bu önem ve üstünde tetiklenir (tür varsayılanı aşağıda). */
  minSeverity: Severity;
  enabled: boolean;
}

export const MAX_CHANNELS = 20;
const MAX_URL = 512;
const MAX_TO = 160;

/**
 * Tür başına varsayılan önem eşiği. Webhook/e-posta `yuksek` (eski davranış:
 * kritik ve yüksek aday bulgular), SMS/çağrı cihazı yalnız `kritik` — gereksiz
 * uyarı yorgunluğunu önlemek için.
 */
const DEFAULT_MIN: Record<NotifyKind, Severity> = { webhook: "yuksek", email: "yuksek", sms: "kritik", pager: "kritik" };

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

export function isHttpUrl(v: string): boolean {
  return HTTP_URL.test(v.trim()) && v.trim().length <= MAX_URL;
}

export interface ParseResult {
  channels: NotifyChannel[];
  /** Kullanıcıya gösterilecek doğrulama hataları (kanal düşürülür, kayıt bozulmaz). */
  errors: string[];
}

/**
 * `notifyChannels` ayarını (JSON dizi) tolere ederek çözer. Bozuk kayıt tüm
 * listeyi düşürmez: geçersiz kanal atlanır, hata metni döner.
 */
export function parseChannels(raw: string | null | undefined): ParseResult {
  const errors: string[] = [];
  if (!raw || !raw.trim()) return { channels: [], errors };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { channels: [], errors: ["Kanallar: geçersiz JSON"] };
  }
  if (!Array.isArray(data)) return { channels: [], errors: ["Kanallar: bir dizi bekleniyordu"] };
  const seen = new Set<string>();
  const out: NotifyChannel[] = [];
  for (const item of data.slice(0, MAX_CHANNELS * 2)) {
    if (out.length >= MAX_CHANNELS) {
      errors.push(`Kanallar: en çok ${MAX_CHANNELS} kanal tanımlanabilir`);
      break;
    }
    if (!item || typeof item !== "object") {
      errors.push("Kanallar: nesne olmayan kayıt atlandı");
      continue;
    }
    const c = item as Record<string, unknown>;
    const kind = c.kind;
    if (typeof kind !== "string" || !(NOTIFY_KINDS as readonly string[]).includes(kind)) {
      errors.push(`Kanallar: bilinmeyen tür "${String(kind)}" atlandı`);
      continue;
    }
    const url = typeof c.url === "string" ? c.url.trim() : "";
    if (!isHttpUrl(url)) {
      errors.push(`Kanallar: ${kind} için geçerli http(s) adresi gerekir`);
      continue;
    }
    const to = typeof c.to === "string" ? c.to.trim().replace(/[\r\n]/g, " ").slice(0, MAX_TO) : "";
    if (kind !== "webhook" && !to) {
      errors.push(`Kanallar: ${kind} için alıcı ("to") gerekir`);
      continue;
    }
    let id = typeof c.id === "string" ? c.id.trim().slice(0, 40) : "";
    if (!id || seen.has(id)) id = `${kind}-${out.length + 1}`;
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    const minSeverity = isSeverity(c.minSeverity) ? c.minSeverity : DEFAULT_MIN[kind as NotifyKind];
    out.push({ id, kind: kind as NotifyKind, url, to: to || undefined, minSeverity, enabled: c.enabled !== false });
  }
  return { channels: out, errors };
}

/** Kanalları tekrar JSON'a yazar (normalize edilmiş biçim). */
export function serializeChannels(channels: NotifyChannel[]): string {
  return JSON.stringify(
    channels.map((c) => ({
      id: c.id,
      kind: c.kind,
      url: c.url,
      ...(c.to ? { to: c.to } : {}),
      minSeverity: c.minSeverity,
      ...(c.enabled ? {} : { enabled: false }),
    }))
  );
}

export interface NotifyEvent {
  /** critical_finding (varsayılan) | ai_disagreement — gövde/başlık etiketini belirler. */
  kind?: "critical_finding" | "ai_disagreement";
  severity: Severity;
  /** DICOM StudyInstanceUID — hasta kimliği değildir (ai_disagreement'ta boş olabilir). */
  studyUid: string;
  /** Kısa, kimliksiz olay cümlesi. */
  message: string;
  modality?: string;
  at?: string;
}

/** Bu olayda tetiklenecek kanallar (etkin + önem eşiği tutan). */
export function dispatchTargets(channels: NotifyChannel[], ev: NotifyEvent): NotifyChannel[] {
  return channels.filter((c) => c.enabled && severityAtLeast(ev.severity, c.minSeverity));
}

/** SMS/çağrı metni: tek satır, en çok `max` karakter (GSM-7 varsayımı). */
export function smsText(ev: NotifyEvent, max = 160): string {
  const sev = ev.severity.toUpperCase();
  const head = `${sev} ${ev.modality ? ev.modality + " " : ""}`.trim();
  const tail = `UID ${ev.studyUid.slice(0, 24)}`;
  const room = Math.max(0, max - head.length - tail.length - 2);
  const msg = ev.message.length > room ? ev.message.slice(0, Math.max(0, room - 1)) + "…" : ev.message;
  return `${head} ${msg} ${tail}`.replace(/\s+/g, " ").trim().slice(0, max);
}

export function emailSubject(ev: NotifyEvent): string {
  const mod = ev.modality ? `${ev.modality} · ` : "";
  if (ev.kind === "ai_disagreement") return `[${ev.severity.toUpperCase()}] AI uyuşmazlık uyarısı · ${ev.message.slice(0, 60)}`;
  return `[${ev.severity.toUpperCase()}] Kritik bulgu · ${mod}${ev.studyUid.slice(0, 32)}`;
}

function emailBody(ev: NotifyEvent): string {
  if (ev.kind === "ai_disagreement") {
    return [
      "ArenaViewer — AI uyuşmazlık uyarısı (yöneticiye)",
      "",
      `Önem: ${ev.severity}`,
      `Zaman: ${ev.at ?? new Date().toISOString()}`,
      "",
      ev.message,
      "",
      "Bu uyarı, bir kategori için hekim kararlarının modelle uyuşmazlık oranının eşiği aştığına işaret eder.",
      "Ayrıntı: Yönetim → AI sekmesi. Modelin yeniden eğitilmesi kurumun model sahibi sürecindedir; bu bildirim modeli kendiliğinden değiştirmez.",
    ].join("\n");
  }
  return [
    "ArenaViewer — kritik bulgu bildirimi",
    "",
    `Önem: ${ev.severity}`,
    `Modalite: ${ev.modality ?? "-"}`,
    `Çalışma UID: ${ev.studyUid || "-"}`,
    `Zaman: ${ev.at ?? new Date().toISOString()}`,
    "",
    ev.message,
    "",
    "Bu mesaj yapay zeka aday bulgusudur; radyolog teyidi olmadan klinik karar için kullanılamaz.",
    "Hasta kimliği bu bildirime dahil edilmemiştir; ayrıntı için uygulamaya giriş yapın.",
  ].join("\n");
}

export interface DispatchRequest {
  channel: NotifyChannel;
  url: string;
  body: Record<string, unknown>;
}

/**
 * Kanal başına HTTP isteği gövdesi. `webhook` gövdesi eski (tek webhook)
 * biçimiyle aynıdır — mevcut köprüler bozulmaz.
 */
export function buildRequest(ch: NotifyChannel, ev: NotifyEvent): DispatchRequest {
  const base = { event: ev.kind === "ai_disagreement" ? "ai_disagreement" : "critical_finding", severity: ev.severity, studyUid: ev.studyUid, message: ev.message, at: ev.at ?? new Date().toISOString() };
  if (ch.kind === "webhook") return { channel: ch, url: ch.url, body: base };
  if (ch.kind === "email") {
    return { channel: ch, url: ch.url, body: { ...base, channel: "email", to: ch.to, subject: emailSubject(ev), text: emailBody(ev) } };
  }
  if (ch.kind === "sms") {
    return { channel: ch, url: ch.url, body: { ...base, channel: "sms", to: ch.to, text: smsText(ev) } };
  }
  return {
    channel: ch,
    url: ch.url,
    body: {
      ...base,
      channel: "pager",
      to: ch.to,
      text: smsText(ev, 120),
      priority: ev.severity === "kritik" ? "high" : "normal",
    },
  };
}

/** Olay için tüm istekler (sıra: ayarlardaki sıra). */
export function planDispatch(channels: NotifyChannel[], ev: NotifyEvent): DispatchRequest[] {
  return dispatchTargets(channels, ev).map((c) => buildRequest(c, ev));
}

/** Test gönderimi için sabit, kimliksiz örnek olay. */
export const TEST_EVENT: NotifyEvent = {
  severity: "kritik",
  studyUid: "1.2.826.0.1.3680043.10.1000.1.2.3.4.5.6",
  message: "TEST: yapay zeka aday bulgusu — radyolog teyidi gerekir",
  modality: "CT",
};
