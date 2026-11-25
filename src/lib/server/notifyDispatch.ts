import { parseChannels, planDispatch, type NotifyChannel, type NotifyEvent } from "@/lib/notifyChannels";
import { getSetting } from "@/lib/server/settings";

export interface SendResult {
  id: string;
  kind: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

/**
 * Bildirim kanallarını ayarlardan yükler. Eski tek `criticalWebhookUrl`
 * ayarı, `<legacy-webhook>` kimlikli bir webhook kanalı olarak eklenir —
 * mevcut kurulumlar çalışmaya devam eder.
 */
export async function loadNotifyChannels(): Promise<{ channels: NotifyChannel[]; errors: string[] }> {
  const { channels, errors } = parseChannels(await getSetting("notifyChannels"));
  const legacy = (await getSetting("criticalWebhookUrl")).trim();
  if (legacy && !channels.some((c) => c.url === legacy)) {
    channels.unshift({ id: "legacy-webhook", kind: "webhook", url: legacy, minSeverity: "yuksek", enabled: true });
  }
  return { channels, errors };
}

/**
 * Olayı kanallara iletir. Her istek 8 sn ile sınırlıdır; bir kanalın hatası
 * diğerlerini engellemez ve çağrı hiçbir zaman istisna fırlatmaz (bildirim
 * yan etkisi analiz yanıtını bozmamalı).
 */
export async function sendToChannels(
  channels: NotifyChannel[],
  ev: NotifyEvent,
  timeoutMs = 8000
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  // Gövde biçimi tek kaynaktan gelir (src/lib/notifyChannels.ts → buildRequest).
  for (const req of planDispatch(channels, ev)) {
    const started = Date.now();
    try {
      const r = await fetch(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      results.push({ id: req.channel.id, kind: req.channel.kind, ok: r.ok, status: r.status, ms: Date.now() - started });
    } catch (e) {
      const error = e instanceof Error ? (e.name === "TimeoutError" ? "zaman aşımı" : e.message) : "hata";
      results.push({ id: req.channel.id, kind: req.channel.kind, ok: false, status: null, ms: Date.now() - started, error });
    }
  }
  return results;
}

/** Denetim kaydı için kısa özet (URL/adres yazılmaz, hasta verisi yok). */
export function summarizeSend(results: SendResult[]): Record<string, unknown> {
  return {
    channels: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => r.id),
  };
}
