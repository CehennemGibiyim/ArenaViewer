import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  channelsFromEnv,
  deliverCritical,
  idempotencyKey,
  type Attempt,
  type ChannelConfig,
  type ChannelKind,
  type DeliverySummary,
  type NotificationPayload,
} from "@/lib/notifyChannels";

/**
 * Bildirim teslimat kaydı (a-notify) — kanal başına kanıt.
 *
 * Tablo çalışma anında `CREATE TABLE IF NOT EXISTS` ile hazırlanır (projedeki
 * `audit_delivery` deseninin aynısı): kurulumda ek geçiş adımı gerekmez ve
 * eski kurulumlar bozulmaz.
 *
 * Neden tablo gerekli: "iletildi" bilgisi denetim kaydında metin olarak
 * durursa *hangi kanalın* ne zaman/kaç denemede iletildiği sorgulanamaz.
 * Hasta güvenliği denetiminde (ör. "SMS 3 denemede iletilemedi") bu sorgu
 * zorunludur.
 */
let ready = false;

export async function ensureNotifyDeliveryTable() {
  if (ready) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS notify_delivery (
    id serial PRIMARY KEY,
    notification_id integer,
    event text NOT NULL DEFAULT 'critical_finding',
    severity text NOT NULL DEFAULT '',
    channel text NOT NULL,
    status text NOT NULL,
    http_status integer,
    attempts integer NOT NULL DEFAULT 1,
    latency_ms integer NOT NULL DEFAULT 0,
    dedupe_key text NOT NULL DEFAULT '',
    last_error text NOT NULL DEFAULT '',
    created_at timestamp NOT NULL DEFAULT now()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS notify_delivery_key_idx ON notify_delivery (dedupe_key, channel)`));
  ready = true;
}

/** Ortamdan kanal listesi (yalnız sunucu). */
export function configuredChannels(): ChannelConfig[] {
  return channelsFromEnv(process.env as Record<string, string | undefined>);
}

/** Daha önce başarıyla iletilmiş kanallar (idempotency). */
export async function alreadyDelivered(p: NotificationPayload): Promise<ChannelKind[]> {
  await ensureNotifyDeliveryTable();
  const key = idempotencyKey(p);
  const rows = await db.execute<{ channel: string }>(
    sql`SELECT DISTINCT channel FROM notify_delivery WHERE dedupe_key = ${key} AND status = 'gonderildi'`,
  );
  const list = (rows as unknown as { rows?: { channel: string }[] }).rows ?? (rows as unknown as { channel: string }[]);
  return (Array.isArray(list) ? list : []).map((r) => r.channel as ChannelKind);
}

/**
 * Kritik bildirimi iletir ve her denemeyi kaydeder.
 *
 * Idempotency: aynı bildirim kimliği için başarıyla iletilmiş kanal atlanır;
 * böylece eskalasyon/tekrar çağrılarında hekim aynı SMS'i iki kez almaz.
 */
export async function deliverAndRecord(p: NotificationPayload): Promise<DeliverySummary & { channels: { kind: ChannelKind; enabled: boolean; targets: number }[] }> {
  await ensureNotifyDeliveryTable();
  const available = configuredChannels();
  const sentBefore = await alreadyDelivered(p);
  const summary = await deliverCritical(p, available, { alreadySent: sentBefore });
  const key = idempotencyKey(p);

  for (const a of summary.attempts) {
    await db.execute(sql`INSERT INTO notify_delivery
      (notification_id, event, severity, channel, status, http_status, attempts, latency_ms, dedupe_key, last_error)
      VALUES (${p.notificationId ?? null}, ${p.event}, ${p.severity}, ${a.channel}, ${a.status},
              ${a.httpStatus ?? null}, ${attemptsOf(a)}, ${a.ms}, ${key}, ${a.error ?? ""})`);
  }
  return {
    ...summary,
    channels: available.map((c) => ({ kind: c.kind, enabled: c.enabled && !!c.url, targets: c.targets.length })),
  };
}

/** Bir kanalın deneme sayısı (kalıcı hatada 1, geçici hatada yeniden denendi). */
function attemptsOf(a: Attempt): number {
  return a.status === "gecici-hata" ? 3 : a.status === "atlandi" ? 0 : 1;
}

export interface DeliveryRow {
  id: number;
  notificationId: number | null;
  event: string;
  severity: string;
  channel: string;
  status: string;
  httpStatus: number | null;
  latencyMs: number;
  createdAt: string;
}

/** Son teslimatlar (yönetici ekranı). */
export async function recentDeliveries(limit = 50, notificationId?: number): Promise<DeliveryRow[]> {
  await ensureNotifyDeliveryTable();
  const rows = notificationId
    ? await db.execute(sql`SELECT id, notification_id, event, severity, channel, status, http_status, latency_ms, created_at
        FROM notify_delivery WHERE notification_id = ${notificationId} ORDER BY id DESC LIMIT ${limit}`)
    : await db.execute(sql`SELECT id, notification_id, event, severity, channel, status, http_status, latency_ms, created_at
        FROM notify_delivery ORDER BY id DESC LIMIT ${limit}`);
  const list = ((rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])) as Record<string, unknown>[];
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: Number(r.id),
    notificationId: r.notification_id === null || r.notification_id === undefined ? null : Number(r.notification_id),
    event: String(r.event ?? ""),
    severity: String(r.severity ?? ""),
    channel: String(r.channel ?? ""),
    status: String(r.status ?? ""),
    httpStatus: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    latencyMs: Number(r.latency_ms ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
  }));
}

/** Kanal durumu (yönetici kartı). */
export function channelHealth() {
  return configuredChannels().map((c) => ({
    kind: c.kind,
    enabled: c.enabled && !!c.url,
    targets: c.targets.length,
    // URL'in yalnız şeması/host'u gösterilir; sır/query yazılmaz.
    host: (() => {
      try { return c.url ? new URL(c.url).host : ""; } catch { return ""; }
    })(),
  }));
}

/** Bir bildirimin teslimat özeti: "sms:gonderildi(200) email:gecici-hata(503)". */
export async function deliverySummaryFor(notificationId: number): Promise<{ ok: boolean; rows: DeliveryRow[] }> {
  const rows = await recentDeliveries(20, notificationId);
  return { ok: rows.length > 0, rows };
}

/** Idempotency anahtarının dışa açık biçimi (test/telemetri). */
export { idempotencyKey };

/** Tek kanal + bildirim eşleşmesinde zaten gönderilmiş mi (hızlı sorgu). */
export async function wasSent(notificationId: number, channel: ChannelKind): Promise<boolean> {
  await ensureNotifyDeliveryTable();
  const rows = await db.execute<{ id: number }>(sql`SELECT id FROM notify_delivery
    WHERE notification_id = ${notificationId} AND channel = ${channel} AND status = 'gonderildi' LIMIT 1`);
  const list = ((rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])) as unknown[];
  return Array.isArray(list) && list.length > 0;
}
