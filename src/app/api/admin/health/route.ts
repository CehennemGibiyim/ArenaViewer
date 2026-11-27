import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { keySource, getKeyring } from "@/lib/server/crypto";
import { fileStorage } from "@/lib/server/storage";
import { APP_VERSION } from "@/lib/version";
import { evaluateEnv, parsePrometheus, summarizeChecks, type EnvSnapshot } from "@/lib/adminHealth";

export const dynamic = "force-dynamic";

/**
 * Yönetim → Sistem sağlığı sekmesinin tek veri kaynağı (yalnız yönetici).
 *
 * Neden ayrı uç: panelin ortam bayraklarını, sağlık uçlarını ve Prometheus
 * metriklerini **tarayıcıdan** ayrı ayrı çağırması hem gürültü hem de
 * METRICS_TOKEN varsa imkânsızdı (jeton sunucuda kalmalı). Burada metrikler
 * sunucu tarafında okunup ayrıştırılmış olarak verilir; hiçbir sır değeri
 * (anahtar, parola, jeton) yanıta yazılmaz.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;

  // Anahtar sayısı: halka okunamazsa 0 (uydurma yok).
  let keyCount = 0;
  try {
    keyCount = getKeyring().keys.size;
  } catch {
    keyCount = 0;
  }

  const env: EnvSnapshot = {
    authMode: process.env.AUTH_MODE ?? "",
    requireTls: process.env.REQUIRE_TLS ?? "0",
    hstsMaxAge: process.env.HSTS_MAX_AGE ?? "",
    keySource: keySource(),
    keyCount,
    databaseUrl: !!process.env.DATABASE_URL,
    llmConfigured: !!process.env.LLM_API_URL && !!process.env.LLM_API_KEY,
    metricsToken: !!process.env.METRICS_TOKEN,
    auditSiemUrl: !!process.env.AUDIT_SIEM_URL,
    auditSyslogHost: !!process.env.AUDIT_SYSLOG_HOST,
    storage: (() => {
      try {
        return fileStorage().describe();
      } catch {
        return "bilinmiyor";
      }
    })(),
    nodeEnv: process.env.NODE_ENV ?? "",
    appVersion: APP_VERSION,
    ingestApiKey: !!process.env.INGEST_API_KEY,
    hisApiKey: !!process.env.HIS_API_KEY,
    requireTotpRoles: process.env.REQUIRE_TOTP_FOR_ROLES ?? "yonetici",
  };

  const checks = evaluateEnv(env);
  const summary = summarizeChecks(checks);

  // Metrikler: kendi ucumuzu HTTP üzerinden çağırmak yerine aynı süreçte
  // üretilen metni okuruz; METRICS_TOKEN yalnız dış erişimi sınırlar.
  let metrics: { ok: boolean; parsed: ReturnType<typeof parsePrometheus>; error?: string } = { ok: false, parsed: [] };
  try {
    const origin = req.nextUrl.origin;
    const headers: Record<string, string> = {};
    if (process.env.METRICS_TOKEN) headers.authorization = `Bearer ${process.env.METRICS_TOKEN}`;
    const r = await fetch(`${origin}/api/metrics`, { headers, cache: "no-store" });
    if (r.ok) metrics = { ok: true, parsed: parsePrometheus(await r.text()) };
    else metrics = { ok: false, parsed: [], error: `metrik ucu HTTP ${r.status}` };
  } catch (e) {
    metrics = { ok: false, parsed: [], error: e instanceof Error ? e.message : "metrik okunamadı" };
  }

  // Sağlık uçları: readiness DB'ye bağlı; liveness süreçte.
  const health: { ready: boolean | null; live: boolean | null; error?: string } = { ready: null, live: null };
  try {
    const base = req.nextUrl.origin;
    const [ready, live] = await Promise.all([
      fetch(`${base}/api/health/ready`, { cache: "no-store" }),
      fetch(`${base}/api/health/live`, { cache: "no-store" }),
    ]);
    health.ready = ready.ok;
    health.live = live.ok;
  } catch (e) {
    health.error = e instanceof Error ? e.message : "sağlık uçları okunamadı";
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    env,
    checks,
    summary,
    health,
    metrics,
    /** Panelin gösterdiği uyarı: veri yoksa \"sağlıklı\" denmez. */
    note: metrics.ok && health.ready !== null
      ? "Tüm değerler bu sunucudan okundu."
      : "Bazı değerler okunamadı — eksik alanlar 'bilinmiyor' olarak gösterilir, tahmin edilmez.",
  });
}
