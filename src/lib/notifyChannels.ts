/**
 * Kritik bulgu bildirimi — çok kanallı teslimat (a-notify).
 *
 * Neden ayrı modül: bildirim "gönderdim" demekle kapanmaz; **kanıt** gerekir.
 * Radyolog kritik bir bulguyu 10 dakika içinde iletmezse hasta güvenliği
 * riskidir. Bu modül üç soruyu yanıtlar:
 *
 *  1. **Hangi kanal, hangi sırayla?** (kanal zinciri: önce hızlı/ucuz olan,
 *     yüksek önemde paralel) — `channelsFor()`.
 *  2. **Denendi mi, ulaştı mı?** Her deneme için durum + sağlayıcı yanıtı +
 *     süre; kalıcı hata (4xx), geçici hata (5xx/ağ) ve zaman aşımı ayrılır —
 *     yalnız geçici hatalar yeniden denenir.
 *  3. **Tekrar gönderim var mı?** Aynı olay (idempotency anahtarı) iki kez
 *     iletilmez; hekim bildirimi iki kez almaz.
 *
 * Kanal adaptörleri saf/enjekte edilebilir: `fetch` benzeri bir taşıyıcı alır,
 * testte ağa çıkmadan SMTP/SMS/webhook davranışı doğrulanır. Hiçbir sağlayıcı
 * anahtarı koda gömülmez; tümü ortam değişkeninden okunur.
 */

export type ChannelKind = "webhook" | "email" | "sms" | "push";

export interface ChannelConfig {
  kind: ChannelKind;
  /** Kanal etkin mi (ortam değişkenleri tam mı). */
  enabled: boolean;
  /** POST hedefi (webhook/SMS/push) veya SMTP köprüsü. */
  url: string;
  /** SMTP köprüsünde alıcı listesi; SMS'te numara listesi. */
  targets: string[];
}

/** Önem sırası: kritik → tüm kanallar; düşükte yalnız webhook. */
export function channelsFor(severity: string, available: ChannelConfig[]): ChannelConfig[] {
  const on = available.filter((c) => c.enabled && !!c.url);
  const order: ChannelKind[] = ["webhook", "email", "sms", "push"];
  const sorted = [...on].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (severity === "kritik") return sorted;
  if (severity === "yuksek") return sorted.filter((c) => c.kind !== "push");
  // orta/düşük/bilgi: yalnız webhook + e-posta (SMS/çağrı gürültü yaratır)
  return sorted.filter((c) => c.kind === "webhook" || c.kind === "email");
}

/** Ortam değişkenlerinden kanal yapılandırması (sır koda gömülmez). */
export function channelsFromEnv(env: Record<string, string | undefined>): ChannelConfig[] {
  const list = (s: string | undefined) => (s ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return [
    { kind: "webhook", enabled: !!(env.CRITICAL_WEBHOOK_URL ?? env.criticalWebhookUrl), url: env.CRITICAL_WEBHOOK_URL ?? env.criticalWebhookUrl ?? "", targets: [] },
    {
      kind: "email",
      enabled: !!(env.NOTIFY_EMAIL_URL && list(env.NOTIFY_EMAIL_TO).length),
      url: env.NOTIFY_EMAIL_URL ?? "",
      targets: list(env.NOTIFY_EMAIL_TO),
    },
    {
      kind: "sms",
      enabled: !!(env.NOTIFY_SMS_URL && list(env.NOTIFY_SMS_TO).length),
      url: env.NOTIFY_SMS_URL ?? "",
      targets: list(env.NOTIFY_SMS_TO),
    },
    {
      kind: "push",
      enabled: !!(env.NOTIFY_PUSH_URL && list(env.NOTIFY_PUSH_TO).length),
      url: env.NOTIFY_PUSH_URL ?? "",
      targets: list(env.NOTIFY_PUSH_TO),
    },
  ];
}

export interface NotificationPayload {
  event: "critical_finding" | "escalation" | "followup_due";
  severity: string;
  studyUid: string;
  message: string;
  /** Bildirim kimliği — idempotency anahtarı olarak da kullanılır. */
  notificationId?: number | null;
  at: string;
}

/** Kanal başına gönderim gövdesi (sağlayıcıdan bağımsız, düz JSON). */
export function payloadFor(kind: ChannelKind, p: NotificationPayload): unknown {
  const base = { ...p, channel: kind };
  if (kind === "email") {
    return {
      ...base,
      subject: `[${severityLabel(p.severity)}] Kritik bulgu — ${p.studyUid || "çalışma"}`,
      text: p.message,
    };
  }
  if (kind === "sms") {
    // SMS uzunluğu: 160 karakter sınırı; mesaj kırpılır, kesildiği işaretlenir.
    const text = p.message.length > 160 ? `${p.message.slice(0, 157)}…` : p.message;
    return { ...base, text, sender: "RADYOLOJI" };
  }
  if (kind === "push") {
    return { ...base, title: `Kritik bulgu (${severityLabel(p.severity)})`, body: p.message.slice(0, 200) };
  }
  return base;
}

/** Önem düzeyinin Türkçe büyük harf etiketi (i → İ). */
export function severityLabel(severity: string): string {
  const map: Record<string, string> = { kritik: "KRİTİK", yuksek: "YÜKSEK", orta: "ORTA", dusuk: "DÜŞÜK", bilgi: "BİLGİ" };
  return map[severity] ?? severity.toLocaleUpperCase("tr-TR");
}

export type AttemptStatus = "gonderildi" | "gecici-hata" | "kalici-hata" | "atlandi";

export interface Attempt {
  channel: ChannelKind;
  status: AttemptStatus;
  /** HTTP durum kodu (varsa). */
  httpStatus?: number;
  /** Milisaniye cinsinden süre. */
  ms: number;
  /** Sağlayıcı hata metni (kısaltılmış, sır içermez). */
  error?: string;
}

/** Tek denemenin yeniden denenebilir olup olmadığı. */
export function retryable(status: AttemptStatus): boolean {
  return status === "gecici-hata";
}

export const MAX_ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 8000;

/** Taşıyıcı: gerçek `fetch` ya da testte sahte. */
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status };
};

/**
 * Bir kanala gönderir; kalıcı hatada beklemez, geçici hatada geri çekilmeli
 * (200 ms → 800 ms) yeniden dener. Süre dolduğunda `gecici-hata` döner.
 */
export async function sendToChannel(
  cfg: ChannelConfig,
  p: NotificationPayload,
  opts: { transport?: Transport; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; maxAttempts?: number } = {},
): Promise<Attempt> {
  if (!cfg.enabled || !cfg.url) return { channel: cfg.kind, status: "atlandi", ms: 0 };
  const transport = opts.transport ?? defaultTransport;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  const body = JSON.stringify(payloadFor(cfg.kind, p));
  let last: Attempt = { channel: cfg.kind, status: "kalici-hata", ms: 0 };

  for (let i = 0; i < max; i++) {
    const t0 = Date.now();
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS) : undefined;
      const res = await transport(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey(p) },
        body,
        signal,
      });
      const ms = Date.now() - t0;
      if (res.ok) return { channel: cfg.kind, status: "gonderildi", httpStatus: res.status, ms };
      // 408/429 ve 5xx geçici; 4xx kalıcı (istek düzeltilmeden tekrar anlamsız).
      const temporary = res.status === 408 || res.status === 429 || res.status >= 500;
      last = { channel: cfg.kind, status: temporary ? "gecici-hata" : "kalici-hata", httpStatus: res.status, ms, error: `HTTP ${res.status}` };
      if (!temporary) return last;
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = /timeout|abort/i.test(msg);
      last = { channel: cfg.kind, status: "gecici-hata", ms, error: (timeout ? "zaman aşımı" : msg).slice(0, 120) };
    }
    if (i < max - 1) await sleep(200 * 4 ** i);
  }
  return last;
}

/** Aynı olay için sabit anahtar: bildirim kimliği varsa o, yoksa içerik özeti. */
export function idempotencyKey(p: NotificationPayload): string {
  if (p.notificationId !== null && p.notificationId !== undefined) return `notify-${p.notificationId}`;
  const s = `${p.event}|${p.severity}|${p.studyUid}|${p.message.slice(0, 80)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `notify-h${h.toString(16)}`;
}

export interface DeliverySummary {
  attempts: Attempt[];
  sent: ChannelKind[];
  failed: ChannelKind[];
  /** Canlı kanal yoksa true (yalnız uygulama içi zil vardır). */
  noneConfigured: boolean;
  /** Denetim satırına yazılacak özet (sır yok). */
  auditText: string;
  /** Kullanıcıya gösterilecek satır. */
  displayText: string;
}

/**
 * Bildirimi seçilen kanallara iletir (kanallar paralel; bir kanalın hatası
 * diğerini durdurmaz). Aynı `notificationId` için önceden gönderilmiş kanal
 * atlanır — `alreadySent` ile geçilir.
 */
export async function deliverCritical(
  p: NotificationPayload,
  available: ChannelConfig[],
  opts: { transport?: Transport; sleep?: (ms: number) => Promise<void>; alreadySent?: ChannelKind[]; maxAttempts?: number } = {},
): Promise<DeliverySummary> {
  const chosen = channelsFor(p.severity, available).filter((c) => !(opts.alreadySent ?? []).includes(c.kind));
  if (!chosen.length) {
    const anyConfigured = available.some((c) => c.enabled && !!c.url);
    return {
      attempts: [],
      sent: [],
      failed: [],
      noneConfigured: !anyConfigured,
      auditText: anyConfigured ? "kanal yok (önem düzeyi)" : "sağlayıcı yapılandırılmadı",
      displayText: anyConfigured
        ? "Bu önem düzeyi için dış kanal seçilmedi; uygulama içi bildirim geçerli."
        : "Dış bildirim kanalı yapılandırılmamış (yalnız uygulama içi bildirim).",
    };
  }
  const attempts = await Promise.all(chosen.map((c) => sendToChannel(c, p, opts)));
  const sent = attempts.filter((a) => a.status === "gonderildi").map((a) => a.channel);
  const failed = attempts.filter((a) => a.status !== "gonderildi" && a.status !== "atlandi").map((a) => a.channel);
  const label = (k: ChannelKind) => ({ webhook: "webhook", email: "e-posta", sms: "SMS", push: "push" })[k];
  const okText = sent.length ? `İletildi: ${sent.map(label).join(", ")}` : "Hiçbir kanal iletilmedi";
  const failText = failed.length ? ` · başarısız: ${failed.map(label).join(", ")}` : "";
  return {
    attempts,
    sent,
    failed,
    noneConfigured: false,
    auditText: attempts.map((a) => `${a.channel}:${a.status}${a.httpStatus ? `(${a.httpStatus})` : ""}`).join(" "),
    displayText: `${okText}${failText}`,
  };
}

/** Kaç kanalın yapılandırıldığı (yönetici ekranı için). */
export function channelStatus(available: ChannelConfig[]): { kind: ChannelKind; enabled: boolean; targets: number }[] {
  return available.map((c) => ({ kind: c.kind, enabled: c.enabled && !!c.url, targets: c.targets.length }));
}
