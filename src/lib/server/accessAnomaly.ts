/**
 * Erişim anomalisi uyarıları — sunucu tarafı.
 *
 * `/api/security/access-anomaly` (GET, yönetici) tarafından çağrılır. Son 7 günün
 * denetim kaydını (en çok 4000 satır) ve başarısız giriş denemelerini (en çok 2000)
 * tarar; yalnızca YÜKSEK önemdeki YENİ anomaliler için bildirim gönderir ve
 * denetim kaydına `security.access_anomaly` yazar.
 *
 * Idempotency: `accessAnomalyAlerted` ayarında görülen anahtarlar tutulur;
 * anahtar listede varsa yeniden göndermez. Anomaliler düzelince/kaybolunca
 * anahtar listeden düşer; yeniden oluşursa yeniden uyarır.
 *
 * Kanal tanımlı değilse mesaj düşmez ama denetim kaydı yine yazılır; "izle"
 * ve "orta" anomaliler yalnız raporda görünür (bildirim spam'i olmasın).
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, loginAttempts } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import type { Actor } from "@/lib/server/audit";
import { getSetting, setSetting } from "@/lib/server/settings";
import { loadNotifyChannels, sendToChannels, summarizeSend } from "@/lib/server/notifyDispatch";
import {
  analyzeAuditRows,
  analyzeLoginAttempts,
  mergeAnomalies,
  type AccessAnomaly,
} from "@/lib/accessAnomaly";
import type { NotifyEvent } from "@/lib/notifyChannels";

const SETTING_KEY = "accessAnomalyAlerted";
const WINDOW_DAYS = 7;
const AUDIT_LIMIT = 4000;
const ATTEMPT_LIMIT = 2000;

async function readAlerted(): Promise<Set<string>> {
  try {
    const raw = await getSetting(SETTING_KEY);
    const parsed: unknown = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // Bozuk kayıt → sıfırla (bir kez daha görsün)
  }
  return new Set();
}

export interface AccessAnomalyAlertOutcome {
  /** Rapordaki toplam anomali sayısı (tüm önem düzeyleri). */
  total: number;
  /** Yüksek önemdeki anomali sayısı. */
  high: number;
  /** Bu çağrıda gerçekten gönderilen bildirim sayısı. */
  sent: number;
}

export async function checkAndAlertAccessAnomalies(
  anomalies: AccessAnomaly[],
  actor: Actor | null
): Promise<AccessAnomalyAlertOutcome> {
  const high = anomalies.filter((a) => a.severity === "yuksek");
  const previous = await readAlerted();
  const toSend = high.filter((a) => !previous.has(a.key));

  let sent = 0;
  if (toSend.length > 0) {
    const { channels, errors } = await loadNotifyChannels();
    for (const a of toSend) {
      const ev: NotifyEvent = {
        kind: "security_anomaly",
        severity: "yuksek",
        studyUid: "",
        message: `Erişim anomalisi — ${a.title}: ${a.actor} · ${a.count} olay. ${a.detail}`,
        at: new Date().toISOString(),
      };
      const results = await sendToChannels(channels, ev);
      await audit(actor, "security.access_anomaly", "access-anomaly", a.key, {
        kind: a.kind,
        actor: a.actor,
        severity: a.severity,
        count: a.count,
        windowMin: a.windowMin,
        ...summarizeSend(results),
        channelErrors: errors,
      });
      sent++;
    }
  }

  // Yalnız hâlâ-varolan yüksek anomalileri sakla; düzelmiş olanlar listeden düşer.
  await setSetting(SETTING_KEY, JSON.stringify(high.map((a) => a.key)));
  return { total: anomalies.length, high: high.length, sent };
}

export interface AccessAnomalyReport {
  generatedAt: string;
  windowDays: number;
  scannedAuditRows: number;
  scannedAttempts: number;
  anomalies: AccessAnomaly[];
  alert: AccessAnomalyAlertOutcome;
  note: string;
}

export async function buildAccessAnomalyReport(actor: Actor | null): Promise<AccessAnomalyReport> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const auditRows = await db
    .select({
      userId: auditLogs.userId,
      username: auditLogs.username,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      ts: auditLogs.ts,
    })
    .from(auditLogs)
    .where(gte(auditLogs.ts, since))
    .orderBy(desc(auditLogs.id))
    .limit(AUDIT_LIMIT);
  const attempts = await db
    .select({ username: loginAttempts.username, ip: loginAttempts.ip, ok: loginAttempts.ok, at: loginAttempts.at, reason: loginAttempts.reason })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ok, false), gte(loginAttempts.at, since)))
    .orderBy(desc(loginAttempts.id))
    .limit(ATTEMPT_LIMIT);

  const anomalies = mergeAnomalies(analyzeAuditRows(auditRows), analyzeLoginAttempts(attempts));
  const alert = await checkAndAlertAccessAnomalies(anomalies, actor);
  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    scannedAuditRows: auditRows.length,
    scannedAttempts: attempts.length,
    anomalies,
    alert,
    note:
      "Heuristik desendir; tek başına suistimal kanıtı değildir. Alarm sesiyle ölçülen her satır için kişiye haber verip denetim kaydındaki gerçek satırları inceleyin. Nöbetçi hekim/öğretmen seansları meşru olarak alarm üretebilir.",
  };
}
