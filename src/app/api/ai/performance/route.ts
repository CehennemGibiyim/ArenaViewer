import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { calibrationBins, expectedCalibrationError, type CalibrationBin } from "@/lib/modelOps";
import type { Finding, FindingApprovalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Row {
  engine: string;
  category: string;
  shown: number;
  approved: number;
  rejected: number;
  edited: number;
  pending: number;
  manualAdded: number;
  ppv: number | null;
}

/** Hekim geri bildiriminden AI performansı: kesinlik (PPV) = onaylanan / (onaylanan + reddedilen). */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const rs = await db.select({ f: reports.findingsJson, ap: reports.findingsApproval, e: reports.engine, st: reports.status }).from(reports);
  const map = new Map<string, Row>();
  for (const r of rs) {
    const findings = (r.f as Finding[]) ?? [];
    const ap = (r.ap as Record<string, FindingApprovalStatus>) ?? {};
    for (const f of findings) {
      if (f.category === "Sistem" || f.category === "ROI") continue;
      const key = `${r.e || "?"}|${f.category}`;
      const row = map.get(key) ?? { engine: r.e || "?", category: f.category, shown: 0, approved: 0, rejected: 0, edited: 0, pending: 0, manualAdded: 0, ppv: null };
      if (f.source === "manual") { row.manualAdded++; map.set(key, row); continue; }
      row.shown++;
      const s = ap[f.id] ?? "bekliyor";
      if (s === "onaylandi") row.approved++;
      else if (s === "reddedildi") row.rejected++;
      else if (s === "duzenlendi") row.edited++;
      else row.pending++;
      map.set(key, row);
    }
  }
  // Güven kalibrasyonu: bulgunun güven puanı ile hekim onayı arasındaki ilişki.
  const calibMap = new Map<string, Array<{ score: number; approved: boolean }>>();
  for (const r of rs) {
    const findings = (r.f as Finding[]) ?? [];
    const ap = (r.ap as Record<string, FindingApprovalStatus>) ?? {};
    for (const f of findings) {
      if (f.category === "Sistem" || f.category === "ROI" || f.source === "manual") continue;
      if (f.confidenceKind === "none" || !Number.isFinite(f.confidence)) continue;
      const st = ap[f.id];
      if (st !== "onaylandi" && st !== "reddedildi") continue;
      const key = `${r.e || "?"}|${f.category}`;
      const arr = calibMap.get(key) ?? [];
      arr.push({ score: f.confidence, approved: st === "onaylandi" });
      calibMap.set(key, arr);
    }
  }
  const calibration = [...calibMap.entries()].map(([key, data]) => {
    const [engine, category] = key.split("|");
    const bins: CalibrationBin[] = calibrationBins(data, 5);
    return { engine: engine ?? "?", category: category ?? "?", n: data.length, bins, ece: expectedCalibrationError(bins) };
  });

  const rows = [...map.values()].map((r) => ({ ...r, ppv: r.approved + r.rejected > 0 ? r.approved / (r.approved + r.rejected) : null }));
  return NextResponse.json({
    rows,
    calibration,
    note: "Kesinlik (PPV) yalnızca hekim kararlarına dayanır. Duyarlılık için 'AI'nın kaçırdığı bulgu' girişleri (manualAdded) gerekir; bu, kontrollü bir klinik doğrulama çalışmasının yerini tutmaz.",
  });
}
