import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { fetchMwl } from "@/lib/server/pacs";
import { loadMwlEndpoints, loadPacsConfig } from "@/lib/server/pacsConfig";
import { upsertStudy } from "@/lib/server/studyRepo";
import { filterMwl, mwlFromDicomJson, mwlSummary, mwlToOrder, sortMwl, type MwlItem } from "@/lib/mwl";
import { parseAdt, planAdt } from "@/lib/hl7Adt";
import { db } from "@/db";
import { notifications, studies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encryptText, decryptText } from "@/lib/server/crypto";

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
  // ADT iletimi (e-hl7-mwl): `{ action: "adt", hl7: "MSH|..." }`
  const rawBody = (await req.json().catch(() => null)) as (Partial<MwlItem> & { action?: string; hl7?: string }) | null;
  if (rawBody?.action === "adt") return applyAdt(rawBody.hl7 ?? "", a.user);
  const b = rawBody;
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

/**
 * ADT^A08/A40 uygulaması: hasta demografisi güncellenir veya mükerrer kayıt
 * hedef kimliğe birleştirilir (çalışmalar + açık takip görevleri).
 *
 * Dürüstlük kuralları: hedef kayıt yoksa birleştirme **yapılmaz**; değişmeyen
 * alan yazılmaz; her işlem `his.adt_update` / `his.adt_merge` olarak denetlenir.
 * Hasta kimliği denetim gövdesine olduğu gibi yazılmaz (yalnız eşleşen çalışma
 * sayısı ve alan adları).
 */
async function applyAdt(hl7: string, user: Parameters<typeof audit>[0]) {
  const msg = parseAdt(hl7);
  const parsed = msg ? null : "ADT mesajı ayrıştırılamadı (PID-3 veya MSH eksik).";
  if (!msg) return NextResponse.json({ error: parsed }, { status: 400 });

  if (msg.event === "A40") {
    if (!msg.mergedPatientId) return NextResponse.json({ error: "A40 için MRG-1 (birleşen kimlik) gerekli", warnings: msg.warnings }, { status: 400 });
    const rows = await db.select().from(studies);
    const target = rows.find((r) => decryptText(r.patientId) === msg.patient.patientId);
    const plan = planAdt(msg, target ? { patientName: decryptText(target.patientName) } : null);
    if (!plan.ok) return NextResponse.json({ error: plan.reason, warnings: plan.warnings }, { status: 409 });

    const from = rows.filter((r) => decryptText(r.patientId) === plan.fromPatientId);
    for (const r of from) {
      await db.update(studies).set({ patientId: target!.patientId, updatedAt: new Date() }).where(eq(studies.id, r.id));
    }
    // Açık takip görevleri de hedef kimliğe taşınır (mesaj metni kimlik taşır).
    const fu = await db.select().from(notifications).where(eq(notifications.kind, "followup"));
    let moved = 0;
    for (const n of fu) {
      if (!n.message.includes(plan.fromPatientId!)) continue;
      await db.update(notifications).set({ message: n.message.split(plan.fromPatientId!).join(plan.patientId!) }).where(eq(notifications.id, n.id));
      moved += n.status === "acik" ? 1 : 0;
    }
    await audit(user, "his.adt_merge", "patient", target!.id, { studies: from.length, openFollowups: moved, warnings: plan.warnings.length });
    return NextResponse.json({ ok: true, action: plan.action, studies: from.length, openFollowups: moved, reason: plan.reason, warnings: plan.warnings });
  }

  const plan = planAdt(msg, null);
  if (!plan.ok || plan.action !== "guncelle") {
    await audit(user, "his.adt_ignored", "patient", 0, { event: msg.event, reason: plan.reason.slice(0, 120) });
    return NextResponse.json({ ok: true, action: plan.action, changed: 0, reason: plan.reason, warnings: plan.warnings });
  }
  const rows = await db.select().from(studies);
  const hits = rows.filter((r) => decryptText(r.patientId) === plan.patientId);
  for (const r of hits) {
    await db.update(studies).set({
      ...(plan.changes.patientName ? { patientName: encryptText(plan.changes.patientName) } : {}),
      ...(plan.changes.sex ? { patientSex: plan.changes.sex } : {}),
      updatedAt: new Date(),
    }).where(eq(studies.id, r.id));
  }
  await audit(user, "his.adt_update", "patient", hits[0]?.id ?? 0, { studies: hits.length, fields: Object.keys(plan.changes).join(",") });
  return NextResponse.json({ ok: true, action: plan.action, changed: hits.length, fields: Object.keys(plan.changes), reason: plan.reason, warnings: plan.warnings });
}
