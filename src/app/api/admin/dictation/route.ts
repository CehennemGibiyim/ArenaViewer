import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { getSetting, setSetting } from "@/lib/server/settings";
import {
  AUTO_APPLY_AT,
  MAX_CORRECTIONS,
  recordCorrection,
  type LearnedCorrection,
} from "@/lib/dictationAssist";

export const dynamic = "force-dynamic";

const KEY = "dictation.corrections";

/**
 * Kurum dikte sözlüğü (r-dictate) — öğrenilen düzeltmeler.
 *
 * GET  → `{ corrections[], autoApplyAt }` (otomatik uygulananlar `accepts ≥ 2`).
 * POST { action: "accept", from, to } → kabul: sayaç artar, 2. kabulde otomatik.
 * POST { action: "reject", from }     → ret: sayaç düşer, 0'da öneri silinir.
 * POST { action: "remove", from }     → hekim sözlükten tamamen çıkarır.
 *
 * Sözlük **sunucuda** tutulur (app_settings) ki aynı kurumdaki tüm hekimler
 * faydalansın; kayıtlar denetlenir (`report.dictation_lexicon`). Düzeltmeler
 * hasta verisi içermez: yalnız yanlış/dogru kelime çiftleri saklanır.
 */
function parse(raw: string): LearnedCorrection[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((c): c is LearnedCorrection =>
        !!c && typeof c === "object" &&
        typeof (c as LearnedCorrection).from === "string" &&
        typeof (c as LearnedCorrection).to === "string" &&
        Number.isFinite((c as LearnedCorrection).accepts))
      .map((c) => ({ from: c.from, to: c.to, accepts: Number(c.accepts), rejects: Number(c.rejects) || 0, lastAccepted: String(c.lastAccepted ?? "") }));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const list = parse(await getSetting(KEY, ""));
  return NextResponse.json({
    corrections: list,
    autoApplyAt: AUTO_APPLY_AT,
    autoApplied: list.filter((c) => c.accepts >= AUTO_APPLY_AT).map((c) => c.from),
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as { action?: string; from?: string; to?: string } | null;
  const action = b?.action;
  const from = (b?.from ?? "").trim();
  if (!action || !from) return NextResponse.json({ error: "action ve from gerekli" }, { status: 400 });

  const list = parse(await getSetting(KEY, ""));
  let next: LearnedCorrection[];
  switch (action) {
    case "accept": {
      const to = (b?.to ?? "").trim();
      if (!to) return NextResponse.json({ error: "to gerekli" }, { status: 400 });
      next = recordCorrection(list, from, to, true);
      break;
    }
    case "reject":
      next = recordCorrection(list, from, "", false);
      break;
    case "remove":
      next = list.filter((c) => c.from !== from.toLocaleLowerCase("tr-TR").trim());
      break;
    default:
      return NextResponse.json({ error: "Bilinmeyen action" }, { status: 400 });
  }
  next = next.slice(0, MAX_CORRECTIONS);
  await setSetting(KEY, JSON.stringify(next));
  await audit(a.user, "report.dictation_lexicon", "dictation", from.slice(0, 60), {
    action,
    count: next.length,
    autoApplied: next.filter((c) => c.accepts >= AUTO_APPLY_AT).length,
  });
  return NextResponse.json({ corrections: next, autoApplyAt: AUTO_APPLY_AT });
}
