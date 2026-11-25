import { NextRequest, NextResponse } from "next/server";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Row {
  engine: string;
  model: string;
  cardVersion: string;
  category: string;
  shown: number;
  approved: number;
  rejected: number;
  edited: number;
  pending: number;
  manualAdded: number;
  approvalShare: number | null;
}

/** Rapor kararları araştırma amaçlı iş akışı istatistikleridir; model doğrulaması değildir. */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  // Aynı çalışma için tekrarlanan raporlar sonucu şişirmesin: son rapor (taslak dahil).
  const rs = await db.selectDistinctOn([reports.studyId], {
    f: reports.findingsJson, ap: reports.findingsApproval, e: reports.engine,
    model: reports.aiModel, card: reports.modelCard, status: reports.status,
  }).from(reports).orderBy(asc(reports.studyId), desc(reports.id));
  const map = new Map<string, Row>();
  let draftReports = 0;
  for (const r of rs) {
    if (r.status !== "onaylandi") draftReports++;
    // Kart bir istemci beyanıdır; çalıştırılan ağırlık dosyasının doğrulanmış sürümü değildir.
    let cardVersion = "Bilinmiyor";
    try {
      const card = JSON.parse(r.card) as { version?: unknown } | null;
      if (card && typeof card.version === "string" && card.version.trim()) cardVersion = card.version.trim().slice(0, 128);
    } catch { /* Eski/bozuk kartlar bilinmiyor olarak ayrılır. */ }
    const findings = Array.isArray(r.f) ? r.f as Finding[] : [];
    const ap = r.ap && typeof r.ap === "object" && !Array.isArray(r.ap) ? r.ap as Record<string, FindingApprovalStatus> : {};
    for (const f of findings) {
      if (!f || typeof f !== "object" || f.category === "Sistem" || f.category === "ROI") continue;
      const engine = r.e || "Bilinmiyor", model = r.model || "Belirtilmemiş", category = f.category || "Belirtilmemiş";
      const key = JSON.stringify([engine, model, cardVersion, category]);
      const row = map.get(key) ?? { engine, model, cardVersion, category, shown: 0, approved: 0, rejected: 0, edited: 0, pending: 0, manualAdded: 0, approvalShare: null };
      if (f.source === "manual") { row.manualAdded++; map.set(key, row); continue; }
      row.shown++;
      const status = ap[f.id] ?? "bekliyor";
      if (status === "onaylandi") row.approved++;
      else if (status === "reddedildi") row.rejected++;
      else if (status === "duzenlendi") row.edited++;
      else row.pending++;
      map.set(key, row);
    }
  }
  const rows = [...map.values()].map(r => ({ ...r, approvalShare: r.approved + r.rejected ? r.approved / (r.approved + r.rejected) : null }));
  return NextResponse.json({
    rows,
    reportCount: rs.length,
    draftReports,
    // Eski API alanı korunur; hekim kararları gerçek etiket olmadığı için ECE hesaplanmaz.
    calibration: [],
    note: "Yalnız her çalışmanın son raporu (taslaklar dahil) sayılır. Onay payı, yalnız onay ve ret verilen adaylar arasındaki iş akışı oranıdır; düzenlenen ve bekleyenler paydada yoktur. Klinik PPV, duyarlılık, özgüllük veya kalibrasyon değildir. Hekim eklemeleri doğrulanmış yanlış negatif sayısı değildir. Kart sürümü raporda beyan edilen bilgidir, kullanılan ağırlığın kimliği doğrulanmamıştır. Tekrarlanan analizler ve seçilim yanlılığı sonuçları etkileyebilir.",
  }, { headers: { "Cache-Control": "no-store" } });
}
