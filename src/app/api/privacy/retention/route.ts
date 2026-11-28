import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { retentionSweep } from "@/lib/server/privacyRepo";
import {
  retentionPolicyFromEnv,
  retentionPolicySummary,
} from "@/lib/privacyPolicy";

export const dynamic = "force-dynamic";

/**
 * Saklama (retention) politikası — t-privacy.
 *
 * - `GET`: politika özeti ( hangi tür açık, kaç gün).
 * - `POST`: sweep çalıştırır — politika kapalıysa hiçbir şey silinmez; açıksa
 *   pencere dışı kayıtlar silinir (imzalı raporlar korunaklı), her silme
 *   `privacy.retention_delete` denetimiyle kaydedilir.
 *
 * Sadece yönetici çalıştırabilir (kurallı silme, hatalı silme riski yüksek).
 */
export async function GET() {
  const policy = retentionPolicyFromEnv();
  return NextResponse.json({
    policy: retentionPolicySummary(policy),
    note: policy.reportDays || policy.shareDays || policy.notificationDays
      ? "Politika açık — sweep silme yapabilir (imzalı raporlar korunaklı)."
      : "Politika kapalı — hiçbir kayıt silinmez (AUDIT_RETENTION_DAYS deseni).",
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const policy = retentionPolicyFromEnv();
  try {
    const out = await retentionSweep(a.user, policy);
    await audit(a.user, "privacy.retention_sweep", "privacy", "", {
      report: out.deleted.report,
      share: out.deleted.share,
      notification: out.deleted.notification,
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
