import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { fhirResourcesToOrders } from "@/lib/fhirIn";
import { applyFhirOrders, fetchFhirBundle, fhirQueryUrl, loadFhirConfig, saveFhirConfig } from "@/lib/server/fhirRepo";

export const dynamic = "force-dynamic";

/**
 * FHIR girişi ucu (e-fhir-in).
 *
 * - **POST** — kurum FHIR sunucusunda ServiceRequest/ImagingStudy kaynaklarının
 *  push edildiği durum: ya FHIR Bundle (`Bundle.type=collection`) ya da tek kaynak
 *  (ServiceRequest / ImagingStudy) kabul edilir. Gövde doğrulanıp çalışmalara
 *  tahsis edilir; her kayıt `fhir` kaynaklı bir çalışmaya dönüşür (HL7/MWL/MPPS
 *  ile aynı upsertStudy köprüsü).
 * - **GET** — `?pull=ServiceRequest` (veya `ImagingStudy`) ile kuruluş FHIR kökü
 *  varsa oradan çekim yapar (`app_settings` → `fhir` anahtarı). Kimlik: `x-api-key`.
 */
function authorized(req: NextRequest): boolean {
  const key = process.env.HIS_API_KEY;
  if (!key) return false;
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  const exp = Buffer.from(key);
  return given.length === exp.length && timingSafeEqual(given, exp);
}

export async function POST(req: NextRequest) {
  if (!process.env.HIS_API_KEY) return NextResponse.json({ error: "FHIR alıcısı yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "FHIR JSON nesnesi olmalı" }, { status: 400 });
  const orders = fhirResourcesToOrders(body);
  if (!orders.length) {
    return NextResponse.json(
      { error: "ServiceRequest veya ImagingStudy kaynağı yok (komut PushCache değil)", accepted: 0 },
      { status: 422 }
    );
  }
  const cfg = await loadFhirConfig();
  const out = await applyFhirOrders(orders, cfg ?? { baseUrl: "", token: "", username: "", password: "", timeoutMs: 15000, defaultModality: "" });
  await audit(null, "fhir.ingest", "study", "", {
    accepted: orders.length,
    created: out.created,
    updated: out.updated,
    skipped: out.skipped,
    errors: out.errors.slice(0, 5),
  });
  return NextResponse.json({ ok: true, accepted: orders.length, ...out }, { status: out.errors.length && !out.created && !out.updated ? 422 : 200 });
}

export async function GET(req: NextRequest) {
  if (!process.env.HIS_API_KEY) return NextResponse.json({ error: "FHIR alıcısı yapılandırılmamış (HIS_API_KEY)" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });

  const cfg = await loadFhirConfig();
  if (!cfg) {
    return NextResponse.json({ error: "FHIR kökü yapılandırılmamış (ayarlar → FHIR)", configured: false }, { status: 409 });
  }
  const param = req.nextUrl.searchParams.get("pull");
  const type = param === "ImagingStudy" ? "ImagingStudy" : param === "Patient" ? "Patient" : "ServiceRequest";
  const url = new URL(fhirQueryUrl(cfg.baseUrl, type as "ServiceRequest" | "ImagingStudy" | "Patient"));
  let orders;
  try {
    orders = await fetchFhirBundle(cfg, url.toString());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(null, "fhir.pull", "study", "", { type, error: msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  const out = await applyFhirOrders(orders, cfg);
  await audit(null, "fhir.pull", "study", "", { type, pulled: orders.length, created: out.created, updated: out.updated, skipped: out.skipped, errors: out.errors.slice(0, 5) });
  return NextResponse.json({ ok: true, pulled: orders.length, ...out }, { status: 200 });
}

/** Ayar ayarlama (Bearer token / Basic + timeout + default modality) — `fhir` anahtarı. */
export async function PUT(req: NextRequest) {
  if (!process.env.HIS_API_KEY) return NextResponse.json({ error: "FHIR ayarları için HIS_API_KEY gerekir" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Yetkisiz" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "JSON gerekiyor" }, { status: 400 });
  const baseUrl = String(b.baseUrl ?? "").trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: "FHIR kökü http(s) adresi olmalı" }, { status: 400 });
  }
  try {
    await saveFhirConfig({
      baseUrl,
      token: String(b.token ?? "").trim(),
      username: String(b.username ?? "").trim(),
      password: String(b.password ?? ""),
      timeoutMs: Number(b.timeoutMs ?? 15000) || 15000,
      defaultModality: String(b.defaultModality ?? "").trim(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
  await audit(null, "fhir.config", "settings", "", { fields: ["fhir"] });
  return NextResponse.json({ ok: true });
}
