/** t-privacy: satır düzeyi rol matrisi + saklama (retention) politikası. */
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEYS ??= randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import {
  canViewReport,
  filterVisibleReports,
  isExpired,
  planRetentionSweep,
  retentionDisabled,
  retentionDays,
  retentionPolicyFromEnv,
  retentionPolicySummary,
  retentionSummary,
  reportAccess,
  type RetentionItem,
  type ReportRow,
  type StudyRow,
} from "../src/lib/privacyPolicy";
import { sweepOnce } from "../scripts/retention-sweep";
import type { UserInfo } from "../src/lib/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`[FAIL] ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, `${label} (beklenen ${JSON.stringify(b)}, geldi ${JSON.stringify(a)})`);
}

const user = (role: UserInfo["role"], id: number): UserInfo => ({
  id, username: `u${id}`, fullName: "X", title: "", regNo: "", role,
});

const report = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: 1, status: "taslak", signatureMeta: "", createdBy: 10, ...over,
});
const study = (over: Partial<StudyRow> = {}): StudyRow => ({
  id: 1, assignedTo: null, ...over,
});

async function main(): Promise<void> {
  // ── 1. Satır düzeyi rol matrisi ────────────────────────────────────────────
  {
    const admin = user("yonetici", 1);
    ok(canViewReport(admin, report({ createdBy: 99 }), study({ assignedTo: 55 })), "yönetici tüm raporlar");

    const radiologist = user("radyolog", 10);
    ok(canViewReport(radiologist, report({ createdBy: 10 }), study()), "radyolog kendi oluşturduğu rapor");
    ok(!canViewReport(radiologist, report({ createdBy: 99 }), study()), "radyolog başkasının raporunu görmez (atanma yok)");
    ok(canViewReport(radiologist, report({ createdBy: 99 }), study({ assignedTo: 10 })), "radyolog kendisine atanmış çalışmanın raporu");
    ok(!canViewReport(radiologist, report({ createdBy: 99 }), study({ assignedTo: 55 })), "radyolog atanmalı değilse görmez");

    const tech = user("teknisyen", 3);
    ok(!canViewReport(tech, report({ createdBy: 3 }), study({ assignedTo: 3 })), "teknisyen hiç rapor görmez");
  }

  // ── 2. reportAccess nedenleri ────────────────────────────────────────────
  {
    const admin = user("yonetici", 1);
    eq(reportAccess(admin, report(), study()).reason, "yönetici: tüm raporlar", "yönetici nedenler");

    const radiologist = user("radyolog", 10);
    eq(reportAccess(radiologist, report({ createdBy: 10 }), study()).ok, true, "radyolog yazar → ok");
    eq(reportAccess(radiologist, report({ createdBy: 10 }), study()).reason, "raporu oluşturdu", "yazar nedeniyler");
    eq(reportAccess(radiologist, report({ createdBy: 99 }), study({ assignedTo: 10 })).ok, true, "radyolog atanan → ok");
    eq(reportAccess(radiologist, report({ createdBy: 99 }), study({ assignedTo: 55 })).ok, false, "radyolog erişim kısılan");

    const tech = user("teknisyen", 3);
    eq(reportAccess(tech, report(), study()).ok, false, "teknisyen erişim kısılan");
  }

  // ── 3. filterVisibleReports ───────────────────────────────────────────────
  {
    const radiologist = user("radyolog", 10);
    const rows = [
      { r: report({ id: 1, createdBy: 10 }), s: study() },
      { r: report({ id: 2, createdBy: 99 }), s: study() },
      { r: report({ id: 3, createdBy: 99 }), s: study({ assignedTo: 10 }) },
      { r: report({ id: 4, createdBy: 99 }), s: study({ assignedTo: 55 }) },
    ];
    const vis = filterVisibleReports(radiologist, rows);
    eq(vis.length, 2, "radyolog 2 rapor görür (1 + 3)");
    eq(vis.map((x) => x.r.id).join(","), "1,3", "gördüğü rapor kimlikleri");

    const tech = user("teknisyen", 3);
    eq(filterVisibleReports(tech, rows).length, 0, "teknisyen hiçbir rapor görmez");

    const admin = user("yonetici", 1);
    eq(filterVisibleReports(admin, rows).length, 4, "yönetici tüm 4 rapor görür");
  }

  // ── 4. Saklama politikası yapılandırma ────────────────────────────────────
  {
    const empty = retentionPolicyFromEnv({});
    eq(empty.reportDays, 0, "tanımlısız → reportDays 0");
    eq(empty.shareDays, 0, "tanımlısız → shareDays 0");
    eq(empty.notificationDays, 0, "tanımlısız → notificationDays 0");
    ok(retentionDisabled(empty), "boş politika kapalı");

    const cfg = retentionPolicyFromEnv({
      PRIVACY_RETENTION_REPORT_DAYS: "730",
      PRIVACY_RETENTION_SHARE_DAYS: "30",
      PRIVACY_RETENTION_NOTIFICATION_DAYS: "180",
    });
    eq(cfg.reportDays, 730, "reportDays");
    eq(cfg.shareDays, 30, "shareDays");
    eq(cfg.notificationDays, 180, "notificationDays");
    ok(!retentionDisabled(cfg), "açık politika aktif");

    // Geçersiz değer → kapalı (yanlışlıkla silme olmaz).
    const bad = retentionPolicyFromEnv({ PRIVACY_RETENTION_REPORT_DAYS: "abc" });
    eq(bad.reportDays, 0, "geçersiz değer → 0 (kapali)");
    const bad2 = retentionPolicyFromEnv({ PRIVACY_RETENTION_REPORT_DAYS: "-5" });
    eq(bad2.reportDays, 0, "negatif değer → 0");

    const sum = retentionPolicySummary(cfg);
    eq(sum.active, true, "özet aktif");
    eq(sum.reportDays, 730, "özet reportDays");
    eq(retentionDays(cfg, "report"), 730, "retentionDays report");
    eq(retentionDays(cfg, "share"), 30, "retentionDays share");
    eq(retentionDays(cfg, "notification"), 180, "retentionDays notification");
  }

  // ── 5. Süre dolumu ───────────────────────────────────────────────────────
  {
    const now = Date.UTC(2026, 0, 15); // 2026-01-15
    const old = new Date(now - 800 * 86_400_000).toISOString(); // ~22 ay önce
    ok(isExpired(old, 730, now), "730 günden eski → expired");
    const fresh = new Date(now - 100 * 86_400_000).toISOString();
    ok(!isExpired(fresh, 730, now), "730 gün içinde → expired değil");
    ok(!isExpired(old, 0, now), "policy kapalı → hiç expired değil");
    ok(!isExpired("bogus", 730, now), "geçersiz tarih → expired değil");

    // Sınır: tam 730 gün → expired değil (cutoff: `t < now - days`).
    const exact = new Date(now - 730 * 86_400_000).toISOString();
    ok(!isExpired(exact, 730, now), "tam sınır değeri expired değil");
    const justOver = new Date(now - 730 * 86_400_000 - 1).toISOString();
    ok(isExpired(justOver, 730, now), "sınır ötesi expired");
  }

  // ── 6. Sweep planı + korunaklı kayıtlar ──────────────────────────────────
  {
    const now = Date.now();
    const policy = { reportDays: 730, shareDays: 30, notificationDays: 180 };
    const items: RetentionItem[] = [
      { id: 1, kind: "report", createdAt: new Date(now - 800 * 86_400_000).toISOString() }, // expired
      { id: 2, kind: "report", createdAt: new Date(now - 100 * 86_400_000).toISOString() }, // kept
      { id: 3, kind: "report", createdAt: new Date(now - 800 * 86_400_000).toISOString(), immutable: true }, // protected
      { id: 4, kind: "share", createdAt: new Date(now - 60 * 86_400_000).toISOString() }, // expired (30g)
      { id: 5, kind: "share", createdAt: new Date(now - 10 * 86_400_000).toISOString() }, // kept
      { id: 6, kind: "notification", createdAt: new Date(now - 200 * 86_400_000).toISOString() }, // expired (180g)
      { id: 7, kind: "notification", createdAt: new Date(now - 50 * 86_400_000).toISOString() }, // kept
    ];
    const plan = planRetentionSweep(items, policy, now);
    eq(plan.toDelete.length, 3, "3 silinecek (1,4,6)");
    eq(plan.toDelete.map((x) => x.id).join(","), "1,4,6", "silinen kimlikler");
    eq(plan.protected.length, 1, "1 korunaklı (imzalı rapor 3)");
    eq(plan.kept.length, 3, "3 korunan (2,5,7)");

    const sum = retentionSummary(plan);
    eq(sum.total, 7, "toplam");
    eq(sum.delete, 3, "silinen");
    eq(sum.protected, 1, "korunaklı");
    eq(sum.kept, 3, "korunan");
    eq(sum.deleteByKind.report, 1, "silinen report");
    eq(sum.deleteByKind.share, 1, "silinen share");
    eq(sum.deleteByKind.notification, 1, "silinen notification");

    // Kapalı politika → hiçbir şey silinmez.
    const closed = planRetentionSweep(items, { reportDays: 0, shareDays: 0, notificationDays: 0 }, now);
    eq(closed.toDelete.length, 0, "kapali politika → silinen yok");
    eq(closed.kept.length, 6, "kapali politika → korunan 6");
  }

  // ── 7. Köprü sweep (gerçek fetch mock) ────────────────────────────────────
  {
    process.env.HIS_BASE_URL = "http://127.0.0.1:3997";
    process.env.HIS_API_KEY = "pk";
    process.env.PRIVACY_RETENTION_REPORT_DAYS = "730";
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
      return new Response(JSON.stringify({
        ok: true,
        deleted: { report: 3, share: 1, notification: 2 },
        policy: { reportDays: 730, shareDays: 30, notificationDays: 180 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const r = await sweepOnce(() => {});
    globalThis.fetch = origFetch;
    ok(r.ok, `sweep başarılı (${r.error ?? ""})`);
    eq(calls.length, 1, "uç 1 kez çağrıldı");
    eq(calls[0]?.url.includes("/api/privacy/retention"), true, "sweep uç adresi");
    eq(calls[0]?.headers?.["x-api-key"], "pk", "sweep x-api-key");
    eq(r.deleted?.report, 3, "sweep rapor silme sayısı");
    eq(r.deleted?.share, 1, "sweep link silme sayısı");
    eq(r.deleted?.notification, 2, "sweep bildirim silme sayısı");

    // Politika kapalı → sweep çalışmaz.
    delete process.env.PRIVACY_RETENTION_REPORT_DAYS;
    const r2 = await sweepOnce(() => {});
    ok(!r2.ok && /kapalı/.test(r2.error ?? ""), `kapalı politika → hata (${r2.error})`);
  }

  // ── 8. Sweep hata yönetimi ───────────────────────────────────────────────
  {
    process.env.PRIVACY_RETENTION_REPORT_DAYS = "730";
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const r = await sweepOnce(() => {});
    globalThis.fetch = orig;
    ok(!r.ok && /401/.test(r.error ?? ""), `401 → hata (${r.error})`);
  }

  console.log(`\n${passed} geçti, ${failed} başarısız`);
  if (failed > 0) process.exit(1);
}

void main().then(
  () => {
    console.log("PRIVACY TEST TAMAMLANDI");
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
