/**
 * Saklama (retention) sweep süreci — t-privacy.
 *
 * Politika kapalıysa hiçbir şey silinmez (yanlışlıkla veri kaybı, KVKK ihlalinden
 * büyük hata — `auditArchivePlan` deseni). Açıksa `/api/privacy/retention` uça
 * sweep çalıştırır (yonetici kimliği: HIS_API_KEY ile x-api-key).
 *
 * Kullanım:
 *   PRIVACY_RETENTION_REPORT_DAYS=730 npm run privacy:sweep -- --once
 *   (tek tur: --once; kalıcı süreçte döngü)
 *
 * Çıkış kodu: 0 = sweep tamam, 1 = hata, 2 = yapılandırma hatası (politika kapalı).
 */
import { retentionPolicyFromEnv, retentionPolicySummary } from "../src/lib/privacyPolicy";

/** Uç adresi + anahtar: her sweep'te env'den okunur (testler env'i değiştirebilir). */
const baseUrl = () => (process.env.HIS_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const apiKey = () => process.env.HIS_API_KEY || "";

/** Tek sweep döngüsü; uç eşleme/silme kararını taşır. */
export async function sweepOnce(
  log: (m: string) => void = console.log
): Promise<{ ok: boolean; error?: string; deleted?: { report: number; share: number; notification: number } }> {
  const policy = retentionPolicyFromEnv();
  const summary = retentionPolicySummary(policy);
  if (!summary.active) {
    return { ok: false, error: "retention politikası kapalı (PRIVACY_RETENTION_*_DAYS tanımlı değil)" };
  }
  try {
    const res = await fetch(`${baseUrl()}/api/privacy/retention`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `uç ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; deleted?: { report: number; share: number; notification: number } } | null;
    log(`[privacy] sweep tamam: ${JSON.stringify(data?.deleted ?? {})}`);
    return { ok: true, deleted: data?.deleted };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── main: ödüllü çalışma zamanı ──────────────────────────────────────────────
async function main(): Promise<void> {
  const policy = retentionPolicyFromEnv();
  if (!retentionPolicySummary(policy).active) {
    console.error("[privacy] yapılandırma hatası: retention politikası kapalı");
    process.exit(2);
  }
  const once = process.argv.includes("--once");
  for (;;) {
    const r = await sweepOnce();
    if (!r.ok) {
      console.error(`[privacy] sweep hatası: ${r.error}`);
      process.exit(1);
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, 86_400_000)); // 24s'de bir
  }
}

if (process.argv[1] && /retention-sweep(\.ts|\.js)?$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[privacy] beklenmeyen hata: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
