import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import { archiveStatus, runArchive, verifyArchiveDir } from "@/lib/server/auditArchive";

export const dynamic = "force-dynamic";

/**
 * Denetim arşivi (g-audit-export).
 *
 * Neden yönetici tetikli ve neden silme yok:
 *  - Denetim tablosu DB tetikleyicisiyle DELETE'e kapalıdır; bu uç **kopyalar**
 *    (şifreli, imzalı manifestolu). Saklama politikasının fiziksel silme kısmı
 *    DB tarafında (partisyon/bakım penceresi) uygulanır; burada "sildim" demek
 *    yalan olurdu.
 *  - Zamanlayıcı yok (depoda cron altyapısı yok): kurum kendi cron/K8s CronJob
 *    tanımından `POST /api/audit/archive` çağırır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  if (sp.get("verify") === "1") return NextResponse.json(await verifyArchiveDir());
  return NextResponse.json(await archiveStatus());
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const run = await runArchive();
  await audit(a.user, "audit.archive", "audit", 0, {
    archived: run.archived, days: run.days, chain: run.manifest ? "ok" : "yok", purge: run.purge,
  });
  return NextResponse.json(run);
}
