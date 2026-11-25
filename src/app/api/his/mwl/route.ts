import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { fetchMwl } from "@/lib/server/pacs";
import { loadMwlEndpoints, loadPacsConfig } from "@/lib/server/pacsConfig";
import { upsertStudy } from "@/lib/server/studyRepo";
import { filterMwl, mwlFromDicomJson, mwlSummary, mwlToOrder, sortMwl, type MwlItem } from "@/lib/mwl";

export const dynamic = "force-dynamic";

/**
 * Modality Worklist (MWL) — modalite konsolundaki "bugünün işleri" listesi.
 *
 * GET  ?modality=CT&date=2026-01-15&stationAE=BT1&q=YILMAZ&open=1
 *      → `{ items, summary, source }`; kaynak: DICOMweb MWL ya da DIMSE köprüsü.
 * POST { stepId, accession, patientId, studyUid? }
 *      → seçilen ögeyi çalışma kaydına çevirir (idempotent: aynı accession tekrar
 *        geldiğinde yeni çalışma açılmaz, `upsertStudy` günceller).
 *
 * Neden POST ayrı: MWL salt okunur bir listedir; "hasta geldi, çalışmayı aç"
 * eylemi denetime ve veritabanına yazdığı için ayrı ve yetki gerektiren bir adım.
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });
  const extra = await loadMwlEndpoints();

  // Tarih verilmezse bugün (modalite konsolu "bugün"ü bekler); geçersiz tarih yok sayılır.
  const rawDate = (sp.get("date") ?? "").replace(/[^0-9]/g, "");
  const date = /^\d{8}$/.test(rawDate) ? rawDate : sp.get("date") === "all" ? "" : todayDa();
  const modality = (sp.get("modality") ?? "").slice(0, 16);
  const stationAe = (sp.get("stationAE") ?? "").slice(0, 16);

  try {
    const raw = await fetchMwl(cfg, { modality, date, stationAe, limit: Number(sp.get("limit")) || 100 }, extra);
    const items = sortMwl(mwlFromDicomJson(raw));
    const filtered = filterMwl(items, {
      query: sp.get("q") ?? "",
      onlyOpen: sp.get("open") === "1",
    });
    await audit(a.user, "his.mwl_query", "pacs", "", {
      date: date || "tümü",
      modality,
      stationAe,
      fetched: raw.length,
      usable: items.length,
      source: extra.mwlRoot ? "mwlRoot" : extra.dimseUrl ? "dimse" : "dicomweb",
    });
    return NextResponse.json({
      items: filtered,
      summary: mwlSummary(filtered),
      dropped: raw.length - items.length,
      source: extra.mwlRoot ? "mwlRoot" : extra.dimseUrl ? "dimse" : "dicomweb",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as Partial<MwlItem> | null;
  if (!b?.patientId) return NextResponse.json({ error: "patientId gerekli" }, { status: 400 });
  const order = mwlToOrder({
    accession: b.accession ?? "",
    patientId: b.patientId,
    patientName: b.patientName ?? "",
    patientBirthDate: b.patientBirthDate ?? "",
    patientSex: b.patientSex ?? "",
    modality: b.modality ?? "",
    bodyPart: b.bodyPart ?? "",
    description: b.description ?? "",
    scheduledStart: b.scheduledStart ?? "",
    stationAeTitle: "",
    scheduledAeTitle: "",
    status: "ARRIVED",
    stepId: b.stepId ?? "",
    studyInstanceUid: b.studyInstanceUid ?? "",
    priority: "",
  });
  if (!order) return NextResponse.json({ error: "Hasta kimliği ve istek/işlem kimliği gerekli" }, { status: 400 });

  const r = await upsertStudy(
    {
      studyUid: order.studyUid,
      patientName: order.patientName,
      patientId: order.patientId,
      patientAge: order.patientAge,
      patientSex: order.patientSex,
      studyDate: order.studyDate ?? "",
      modality: order.modality,
      bodyPart: order.bodyPart,
      seriesDescription: order.description,
      sliceCount: 0,
      accession: order.accessionNumber,
    },
    "his",
  );
  await audit(a.user, "his.mwl_to_study", "study", r.id, {
    accession: order.accessionNumber,
    modality: order.modality,
    created: r.created,
  });
  return NextResponse.json({ ok: true, ...r, studyUid: order.studyUid });
}

/** Bugünün DICOM DA biçimi (yerel saat). */
function todayDa(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
