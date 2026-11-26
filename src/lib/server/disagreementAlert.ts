/**
 * Uyuşmazlık eşiği aşılınca yönetici uyarısı — sunucu tarafı (t-automation).
 *
 * /api/ai/performance GET sırasında çağrılır. Eşik ve en az karar sayısı
 * src/lib/disagreementAlert.ts içinde tanımlıdır (varsayılan %30 / ≥10 karar).
 * Idempotency: `aiDisagreementAlerted` ayarında (JSON {anahtar: {rate, at}})
 * uyarılan durum tutulur; oran yükselmedikçe yeniden gönderim YAPILMAZ.
 * Eşik altına düşen kategori listeden düşer (yeniden yükselirse yeniden uyarır).
 *
 * Kanal tanımlı değilse mesaj düşmez ama denetim kaydı (`ai.disagreement_alert`)
 * her zaman düşer — sessiz uyarı kaybı olmaz, yalnız gürültüsüz olur.
 */
import { audit } from "@/lib/server/audit";
import type { Actor } from "@/lib/server/audit";
import { loadNotifyChannels, sendToChannels, summarizeSend } from "@/lib/server/notifyDispatch";
import { getSetting, setSetting } from "@/lib/server/settings";
import {
  findDisagreementAlerts,
  summarizeReasonClasses,
  reasonClassDigestText,
  DISAGREEMENT_THRESHOLD,
  MIN_DECIDED,
} from "@/lib/disagreementAlert";
import type { CategoryDisagreement, ReasonDigestEntry } from "@/lib/aiDisagreement";
import type { NotifyEvent } from "@/lib/notifyChannels";

const SETTING_KEY = "aiDisagreementAlerted";

interface AlertedState {
  rate: number;
  at: string;
}

async function readState(): Promise<Record<string, AlertedState>> {
  try {
    const raw = await getSetting(SETTING_KEY);
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, AlertedState>;
  } catch {
    // Bozuk kayıt → uyarı durumunu sıfırla (bir kez daha uyarır, sessiz kalmaktansa gürültü).
  }
  return {};
}

export interface AlertOutcome {
  /** Eşiği aşan kategori sayısı. */
  total: number;
  /** Bu çağrıda gerçekten gönderilen uyarı sayısı. */
  sent: number;
  threshold: number;
  minDecided: number;
  reasonClasses: ReturnType<typeof summarizeReasonClasses>;
}

export async function checkAndAlertDisagreement(
  categories: CategoryDisagreement[],
  reasons: ReasonDigestEntry[],
  actor: Actor | null
): Promise<AlertOutcome> {
  const alerts = findDisagreementAlerts(categories);
  const reasonClasses = summarizeReasonClasses(reasons, 6);
  const digestText = reasonClassDigestText(reasonClasses.slice(0, 3));
  const state = await readState();
  const next: Record<string, AlertedState> = {};

  // Önceki durumda olup artık eşikte olmayan anahtarlar kaydedilmez → prune.
  for (const a of alerts) {
    next[`${a.engine}|${a.category}`] = { rate: a.disagreementRate, at: new Date().toISOString() };
  }

  // Liste dışındaki (düşüş/öğrenme) anahtarların düşürülmesi setSetting ile otomatik olur.
  const toSend = alerts.filter((a) => {
    const prev = state[`${a.engine}|${a.category}`];
    // Oranını korumuş ya da düşürmüşse yeniden uyarma; yalnız yeni/yükselen uyarır.
    return !prev || prev.rate < a.disagreementRate;
  });

  let sent = 0;
  if (toSend.length > 0) {
    const { channels, errors } = await loadNotifyChannels();
    for (const a of toSend) {
      const ev: NotifyEvent = {
        kind: "ai_disagreement",
        severity: "yuksek",
        studyUid: "",
        message: `AI uyuşmazlığı %${Math.round(a.disagreementRate * 100)} — Motor "${a.engine}", kategori "${a.category}" (${a.decided} karar: ${a.rejected} ret, ${a.edited} düzenleme). Gerekçe sınıfları: ${digestText}. Ayrıntı: Yönetim → AI`,
        at: new Date().toISOString(),
      };
      const results = await sendToChannels(channels, ev);
      await audit(actor, "ai.disagreement_alert", "ai-model", `${a.engine}|${a.category}`, {
        engine: a.engine,
        category: a.category,
        decided: a.decided,
        rejected: a.rejected,
        edited: a.edited,
        rate: Math.round(a.disagreementRate * 1000) / 1000,
        threshold: DISAGREEMENT_THRESHOLD,
        minDecided: MIN_DECIDED,
        ...summarizeSend(results),
        channelErrors: errors,
      });
      sent++;
    }
  }

  await setSetting(SETTING_KEY, JSON.stringify(next));
  return { total: alerts.length, sent, threshold: DISAGREEMENT_THRESHOLD, minDecided: MIN_DECIDED, reasonClasses };
}
