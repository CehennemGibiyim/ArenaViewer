import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { adtPlan, routeAet, parseAetRoutes } from "@/lib/hl7Adt";
import { applyMerge, applyPatientUpdate, legacyIds } from "@/lib/server/adtRepo";
import { parseHl7 } from "@/lib/hl7";

export const dynamic = "force-dynamic";

/**
 * HL7 v2 **ADT** alımı (e-hl7-mwl): hasta güncelleme (A08/A31), birleştirme
 * (A40/A41) ve çoklu AET yönlendirme.
 *
 * Neden ayrı uç: sipariş ucu (`/api/his/orders`) çalışma **oluşturur**; ADT ise
 * var olan hastayı günceller/taşır. İkisini aynı uçta birleştirmek, mesaj tipine
 * göre farklı yan etkileri tek bir kapının arkasına saklardı.
 *
 * Kimlik: `x-api-key = HIS_API_KEY` (sabit zamanlı karşılaştırma). Gövde ya
 * `{ hl7: "<ham MLLP/HL7 metni>" }` ya da doğrudan metin olabilir.
 */
export async function POST(req: NextRequest) {
  const key = process.env.HIS_API_KEY;
  if (!key) return NextResponse.json({ error: "HBYS entegrasyonu yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  if (given.length !== exp.length || !timingSafeEqual(given, exp)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const rawText = (await req.text().catch(() => "")).trim();
  let hl7 = rawText;
  if (rawText.startsWith("{")) {
    const b = JSON.parse(rawText) as { hl7?: string };
    hl7 = b.hl7 ?? "";
  }
  if (!hl7) return NextResponse.json({ error: "HL7 gövdesi boş (hl7 alanı ya da ham metin beklenir)" }, { status: 400 });

  const msg = parseHl7(hl7);
  if (!msg) return NextResponse.json({ error: "HL7 ayrıştırılamadı (MSH ile başlamalı)" }, { status: 400 });

  const plan = adtPlan(msg);
  if (!plan.ok) {
    // Reddedilen ADT de denetlenir: sessiz yutma yok.
    await audit(null, "adt.reject", "patient", plan.patient?.patientId ?? "", { event: plan.event, reason: plan.reason });
    return NextResponse.json({ ok: false, event: plan.event, reason: plan.reason, warnings: plan.patient?.warnings ?? [] }, { status: 422 });
  }
  if (plan.patient) {
    const r = await applyPatientUpdate(plan.patient);
    return NextResponse.json({ ok: true, event: plan.event, applied: r, warnings: plan.patient.warnings });
  }
  const r = await applyMerge(plan.merge!);
  return NextResponse.json({ ok: true, event: plan.event, applied: r, note: plan.reason });
}

/** Emekli kimlikler + AET yönlendirme tablosu (yönetici paneli okur). */
export async function GET(req: NextRequest) {
  const key = process.env.HIS_API_KEY;
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const authorized = !!key && given.length === Buffer.byteLength(key) && timingSafeEqual(given, Buffer.from(key));
  if (!authorized) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const routes = parseAetRoutes(process.env.PACS_AET_ROUTES);
  const sample = routeAet(req.nextUrl.searchParams.get("aet") ?? undefined, req.nextUrl.searchParams.get("modality") ?? undefined, routes);
  return NextResponse.json({ legacyIds: await legacyIds(), aetRoutes: routes, sample, note: sample.reason });
}
