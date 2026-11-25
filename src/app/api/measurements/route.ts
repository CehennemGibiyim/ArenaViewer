import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { measurementHistory } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

const UNITS = new Set(["mm", "mL", "mm2", "HU", "SUV"]);
const MAX_ROWS = 500;

/**
 * Ölçüm geçmişi (c-measure-history).
 *
 * GET  ?patientId=...        → hastanın son 500 ölçümü (kronolojik artan).
 * POST { rows:[...] }        → aynı hasta+çalışma+seri için kayıtları değiştirir
 *                              (yeniden kaydetme kopya üretmez).
 *
 * Değerler istemciden gelir; sunucu ÖLÇÜM ÜRETMEZ, yalnız saklar. Hasta kimliği
 * zorunludur; birim beyaz listesi ve sonlu/pozitif değer denetlenir.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const patientId = (req.nextUrl.searchParams.get("patientId") ?? "").trim();
  if (!patientId) return NextResponse.json({ error: "patientId gerekli" }, { status: 400 });
  const label = (req.nextUrl.searchParams.get("label") ?? "").trim();

  const where = label
    ? and(eq(measurementHistory.patientId, patientId), eq(measurementHistory.label, label))
    : eq(measurementHistory.patientId, patientId);
  const rows = await db
    .select()
    .from(measurementHistory)
    .where(where)
    .orderBy(desc(measurementHistory.studyDate), desc(measurementHistory.id))
    .limit(MAX_ROWS);

  return NextResponse.json(rows.reverse().map((r) => ({
    id: r.id, patientId: r.patientId, studyUid: r.studyUid, studyDate: r.studyDate,
    seriesKey: r.seriesKey, modality: r.modality, label: r.label, kind: r.kind,
    value: r.value, unit: r.unit, slice: r.slice, createdAt: r.createdAt,
  })));
}

export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as { rows?: unknown[] } | null;
  if (!body || !Array.isArray(body.rows)) return NextResponse.json({ error: "rows dizisi gerekli" }, { status: 400 });
  if (body.rows.length > MAX_ROWS) return NextResponse.json({ error: `En fazla ${MAX_ROWS} satır` }, { status: 413 });

  const clean = [] as { patientId: string; studyUid: string; studyDate: string; seriesKey: string; modality: string; label: string; kind: string; value: number; unit: string; slice: number }[];
  for (const raw of body.rows) {
    const r = raw as Record<string, unknown>;
    const patientId = typeof r.patientId === "string" ? r.patientId.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const unit = typeof r.unit === "string" ? r.unit : "";
    const value = typeof r.value === "number" ? r.value : Number.NaN;
    if (!patientId || !label || !UNITS.has(unit) || !Number.isFinite(value) || value <= 0) {
      return NextResponse.json({ error: "Geçersiz ölçüm satırı (patientId/label/unit/value)" }, { status: 400 });
    }
    clean.push({
      patientId,
      label: label.slice(0, 160),
      unit,
      value,
      studyUid: typeof r.studyUid === "string" ? r.studyUid.slice(0, 128) : "",
      studyDate: typeof r.studyDate === "string" ? r.studyDate.slice(0, 10) : "",
      seriesKey: typeof r.seriesKey === "string" ? r.seriesKey.slice(0, 128) : "",
      modality: typeof r.modality === "string" ? r.modality.slice(0, 16) : "",
      kind: typeof r.kind === "string" ? r.kind.slice(0, 32) : "",
      slice: typeof r.slice === "number" && Number.isFinite(r.slice) ? Math.trunc(r.slice) : 0,
    });
  }
  if (clean.length === 0) return NextResponse.json({ ok: true, saved: 0 });

  const keys = new Set(clean.map((r) => `${r.patientId}|${r.studyUid}|${r.seriesKey}`));
  let saved = 0;
  for (const key of keys) {
    const [patientId, studyUid, seriesKey] = key.split("|");
    const batch = clean.filter((r) => r.patientId === patientId && r.studyUid === studyUid && r.seriesKey === seriesKey);
    await db.delete(measurementHistory).where(and(
      eq(measurementHistory.patientId, patientId),
      eq(measurementHistory.studyUid, studyUid),
      eq(measurementHistory.seriesKey, seriesKey),
    ));
    if (batch.length) {
      await db.insert(measurementHistory).values(batch.map((r) => ({ ...r, recordedBy: a.user.id })));
      saved += batch.length;
    }
  }
  await audit(a.user, "measurement-history-save", "patient", clean[0].patientId, { saved });
  return NextResponse.json({ ok: true, saved });
}
