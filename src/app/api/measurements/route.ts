import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { measurementHistory } from "@/db/schema";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 500;
/** Çakışmada yeni değeri koru: `excluded.<kolon>`. */
const sqlExcluded = (column: string): SQL => sql.raw(`excluded.${column}`);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ölçüm geçmişi (c-measure-history).
 *
 * GET  /api/measurements?patientId=…&label=…  → hastanın yapılandırılmış ölçümleri
 * POST /api/measurements { entries: [{ patientId, studyDate, label, longMm, … }] }
 *
 * Aynı hasta + tarih + lezyon üçlüsü tekildir; yeniden gönderim satırı günceller
 * (mükerrer nokta üretmez). Kayıtlar denetim izine yazılır.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const patientId = (sp.get("patientId") ?? "").trim();
  if (!patientId) return NextResponse.json({ error: "patientId gerekli" }, { status: 400 });
  if (patientId.length > 128) return NextResponse.json({ error: "patientId çok uzun" }, { status: 400 });
  const label = (sp.get("label") ?? "").trim();
  const where = label
    ? and(eq(measurementHistory.patientId, patientId), eq(measurementHistory.label, label))
    : eq(measurementHistory.patientId, patientId);
  const rows = await db
    .select()
    .from(measurementHistory)
    .where(where)
    .orderBy(asc(measurementHistory.studyDate))
    .limit(2000);
  const measurements = rows.map((r) => ({
    patientId: r.patientId,
    patientName: r.patientName,
    studyDate: r.studyDate,
    label: r.label,
    anatomy: r.anatomy,
    kind: r.kind,
    longMm: r.longMm,
    hu: r.hu,
    suv: r.suv,
  }));
  return NextResponse.json({ measurements });
}

interface Entry {
  patientId?: unknown; patientName?: unknown; studyDate?: unknown; label?: unknown;
  anatomy?: unknown; kind?: unknown; longMm?: unknown; hu?: unknown; suv?: unknown;
}

const str = (v: unknown, max = 128) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const numOrNull = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as { entries?: Entry[] } | null;
  if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
    return NextResponse.json({ error: "Eksik veri" }, { status: 400 });
  }
  if (body.entries.length > MAX_ENTRIES) return NextResponse.json({ error: "Çok fazla ölçüm" }, { status: 413 });

  const rejected: number[] = [];
  const values = body.entries.flatMap((e, i) => {
    const patientId = str(e.patientId);
    const studyDate = str(e.studyDate, 10);
    const label = str(e.label);
    const longMm = numOrNull(e.longMm);
    if (!patientId || !isoDate.test(studyDate) || !label || longMm === null || longMm <= 0 || longMm > 500) {
      rejected.push(i);
      return [];
    }
    const hu = numOrNull(e.hu);
    const suv = numOrNull(e.suv);
    return [{
      patientId,
      patientName: str(e.patientName, 200),
      studyDate,
      label,
      anatomy: str(e.anatomy, 200),
      kind: str(e.kind, 40),
      longMm,
      hu: hu === null ? null : hu,
      suv: suv === null ? null : suv,
      createdBy: a.user.id,
    }];
  });
  if (values.length === 0) return NextResponse.json({ error: "Geçerli ölçüm yok", rejected }, { status: 400 });

  await db
    .insert(measurementHistory)
    .values(values)
    .onConflictDoUpdate({
      target: [measurementHistory.patientId, measurementHistory.studyDate, measurementHistory.label],
      set: {
        longMm: sqlExcluded("long_mm"),
        hu: sqlExcluded("hu"),
        suv: sqlExcluded("suv"),
        anatomy: sqlExcluded("anatomy"),
        kind: sqlExcluded("kind"),
        patientName: sqlExcluded("patient_name"),
        createdBy: sqlExcluded("created_by"),
      },
    });
  await audit(a.user, "measurement.save", "patient", values[0].patientId, {
    count: values.length,
    studyDate: values[0].studyDate,
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, saved: values.length, rejected });
}
