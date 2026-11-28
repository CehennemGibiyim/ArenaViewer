import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { readMppsResponse, type MppsStatus } from "@/lib/mpps";
import { applyMppsEvent } from "@/lib/server/mppsRepo";

export const dynamic = "force-dynamic";

/**
 * MPPS olay alımı (e-hl7-mwl): N-CREATE/N-SET sonucunu köprü sürecinden alır.
 *
 * Gövde (DICOM JSON + örnek UID): `{ mppsUid, tags: { "00400252": {...}, ... } }`
 * Kimlik: `x-api-key = HIS_API_KEY`.
 *
 * Neden DICOM JSON: DIMSE (TCP/PDU) yığını Node içinde değil; köprü (dcm4che
 * `mpps-scu` vb.) DIMSE'yi konuşur ve sonucu bu sözleşmeyle aktarır. Böylece
 * doğrulama/eşleştirme tek yerde ve test edilebilir kalır.
 */
function authorized(req: NextRequest): boolean {
  const key = process.env.HIS_API_KEY;
  if (!key) return false;
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  return given.length === exp.length && timingSafeEqual(given, exp);
}

export async function POST(req: NextRequest) {
  if (!process.env.HIS_API_KEY) return NextResponse.json({ error: "MPPS köprüsü yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { mppsUid?: string; tags?: Record<string, unknown> } | null;
  if (!body?.mppsUid || !body.tags || typeof body.tags !== "object") {
    return NextResponse.json({ error: "mppsUid ve tags (DICOM JSON) gerekli" }, { status: 400 });
  }
  const ev = readMppsResponse(body.tags, body.mppsUid);
  const result = await applyMppsEvent(ev);
  if (ev.warnings.length) {
    await audit(null, "mpps.warning", "study", body.mppsUid, { warnings: ev.warnings.slice(0, 5), status: ev.status as MppsStatus });
  }
  return NextResponse.json({ ok: result.applied, status: ev.status, ...result, warnings: ev.warnings }, { status: result.applied ? 200 : 422 });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  return NextResponse.json({
    contract: {
      mppsUid: "string (MPPS örnek UID)",
      tags: "DICOM JSON — 00400252 durum, 00400251 bitiş saati, 0020000D çalışma UID",
    },
    statuses: ["IN PROGRESS", "COMPLETED", "DISCONTINUED"],
    note: "DIMSE yığını Node içinde değildir; olay JSON sözleşmesiyle köprüden gelir.",
  });
}
