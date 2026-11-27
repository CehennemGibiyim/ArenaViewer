import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies, studyState } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { loadPacsConfig } from "@/lib/server/pacsConfig";
import { isUid, qidoInstances, stowInstance } from "@/lib/server/pacs";
import { mapReport } from "@/lib/server/studyRepo";
import { validateMeasurementSrBytes } from "@/lib/measureSr";
import { validateDerivedDicomBytes, type DerivedKind } from "@/lib/derivedStow";
import { buildKeyObjectSelection, buildPresentationState, buildReportSr } from "@/lib/dicomSr";
import { parseAnonSelection, selectionInstanceCountError, summarizeAnonResult, validateAnonStowBody } from "@/lib/stowPayload";
import { decryptText } from "@/lib/server/crypto";

export const dynamic = "force-dynamic";

interface StowBody {
  kind?: "sr" | "ko" | "pr" | "anon" | "sr1500" | "seg" | "rtstruct";
  /** Anonim gönderim: istemcide sıfırdan üretilmiş DICOM baytları (base64). */
  instances?: { name?: string; data?: string }[];
  /** Anonim gönderimde istenen kesit aralığı (1 tabanlı kapalı); varsa örnek sayısıyla bire bir uyuşmak zorunda. */
  selection?: { from?: number; to?: number; total?: number } | null;
  reportId?: number;
  studyUid?: string;
  seriesKey?: string;
  /** KO/PR için istemcinin açtığı seri (UID'ler PACS'te doğrulanır). */
  seriesUid?: string;
  sopClassUid?: string;
  sopUids?: string[];
}

/**
 * DICOM nesnesini PACS'e STOW-RS ile gönderir.
 * - SR: yalnızca onaylanmış rapor (taslak reddedilir).
 * - KO/PR: çalışmanın kayıtlı seri durumundan (anahtar kesitler, pencere) üretilir.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const body = ((await req.json().catch(() => ({}))) ?? {}) as StowBody;
  if (body.kind === "anon") return stowAnon(body, a.user);
  if (body.kind === "sr1500") return stowMeasurementSr(body, a.user);
  if (body.kind === "seg" || body.kind === "rtstruct") return stowDerived(body, a.user);
  if (body.kind === "ko" || body.kind === "pr") return stowFromSeries(body, a.user);
  const id = Number(body.reportId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Geçersiz rapor kimliği" }, { status: 400 });

  const rr = (await db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id)).where(eq(reports.id, id)).limit(1))[0];
  if (!rr) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  const rep = mapReport(rr.r, rr.s);
  if (rep.status !== "onaylandi") return NextResponse.json({ error: "Yalnızca onaylanmış rapor PACS'e gönderilebilir" }, { status: 409 });

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  const sr = buildReportSr({
    patientName: rep.patientName, patientId: rep.patientId, patientSex: rep.patientSex, patientAge: rep.patientAge,
    studyUid: rep.studyUid, studyDate: rep.studyDate, institution: rep.institution, studyModality: rep.modality,
    clinicalInfo: rep.clinicalInfo, technique: rep.technique, findings: rep.findingsText, impression: rep.impression,
    recommendation: rep.recommendation, measurements: "", approvedBy: rep.approvedBy, doctorTitle: rep.doctorTitle,
    approvedAt: rep.approvedAt,
  });

  try {
    const out = await stowInstance(cfg, sr);
    await audit(a.user, "pacs.send_sr", "report", String(id), { pacs: cfg.name || cfg.kind, stored: out.stored, failed: out.failed.length });
    return NextResponse.json({ ...out, pacs: cfg.name || cfg.kind });
  } catch (e) {
    await audit(a.user, "pacs.send_sr_failed", "report", String(id), { pacs: cfg.name || cfg.kind });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/**
 * İstemcide üretilmiş TID 1500 ölçüm SR'ını onaylı rapor kimliğiyle STOW-RS gönderir.
 * İstemci ölçümleri sunucuya göndermez; sunucu yalnız SOP sınıfı Comprehensive SR
 * olduğunu doğrular, nesneyi PACS'e iletir ve audit'e yazar. Ölçüm içeriği doğrulanmaz.
 */
async function stowMeasurementSr(b: StowBody, user: Parameters<typeof audit>[0]) {
  const reportId = Number(b.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) return NextResponse.json({ error: "Geçersiz rapor kimliği" }, { status: 400 });

  const rr = (await db.select({ r: reports, s: studies }).from(reports).innerJoin(studies, eq(reports.studyId, studies.id)).where(eq(reports.id, reportId)).limit(1))[0];
  if (!rr) return NextResponse.json({ error: "Rapor bulunamadı" }, { status: 404 });
  const rep = mapReport(rr.r, rr.s);
  if (rep.status !== "onaylandi") return NextResponse.json({ error: "Yalnızca onaylanmış raporun ölçüm SR'ı PACS'e gönderilebilir" }, { status: 409 });

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  const instances = Array.isArray(b.instances) ? b.instances.slice(0, 4) : [];
  if (!instances.length) return NextResponse.json({ error: "Gönderilecek SR nesnesi yok" }, { status: 400 });
  const parts: Uint8Array[] = [];
  for (const inst of instances) {
    const data = typeof inst?.data === "string" ? inst.data : "";
    if (!data || data.length > 40_000_000) return NextResponse.json({ error: "SR nesnesi eksik ya da çok büyük (>30 MB)" }, { status: 413 });
    const buf = Buffer.from(data, "base64");
    const check = validateMeasurementSrBytes(buf);
    if (!check.ok) return NextResponse.json({ error: check.error ?? "Geçersiz SR nesnesi" }, { status: 400 });
    parts.push(new Uint8Array(buf));
  }

  let stored = 0, failed = 0;
  const errors: string[] = [];
  for (const p of parts) {
    try {
      const out = await stowInstance(cfg, p);
      stored += out.stored;
      failed += out.failed.length;
      for (const f of out.failed) errors.push(typeof f === "string" ? f : String(f));
    } catch (e) {
      failed += 1;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  await audit(user, "pacs.send_sr1500", "report", String(reportId), { pacs: cfg.name || cfg.kind, stored, failed });
  if (failed && stored === 0) return NextResponse.json({ error: `Gönderim başarısız: ${errors[0] ?? "PACS reddetti"}`, stored, failed, pacs: cfg.name || cfg.kind }, { status: 502 });
  return NextResponse.json({ stored, failed, pacs: cfg.name || cfg.kind });
}

/**
 * İstemcide üretilmiş SEG / RTSTRUCT nesnesini STOW-RS ile PACS'e yazar (geri yazma).
 * İstemci segmenti/konturu kendisi üretir; sunucu yalnız "istenen türde, bildirilen
 * çalışmaya ait bir nesne" olduğunu doğrular (DICM + SOP Class + Study UID), nesneyi
 * PACS'e iletir ve audit'e yazar. Segment içeriği istemciye aittir; doğrulanmaz.
 * Rapor onayı gerekmez (KO/PR ile aynı sınıf); araştırma/triyaj çıktısıdır.
 */
async function stowDerived(b: StowBody, user: Parameters<typeof audit>[0]) {
  const kind = b.kind as DerivedKind;
  const studyUid = (b.studyUid ?? "").trim();
  if (!isUid(studyUid)) return NextResponse.json({ error: "Geçersiz StudyInstanceUID" }, { status: 400 });

  const row = (await db.select({ s: studies }).from(studies).where(eq(studies.studyUid, studyUid)).limit(1))[0];
  if (!row) return NextResponse.json({ error: "Çalışma kayıtlı değil" }, { status: 404 });

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  const instances = Array.isArray(b.instances) ? b.instances.slice(0, 4) : [];
  if (!instances.length) return NextResponse.json({ error: `Gönderilecek ${kind === "seg" ? "SEG" : "RTSTRUCT"} nesnesi yok` }, { status: 400 });
  const parts: Uint8Array[] = [];
  for (const inst of instances) {
    const data = typeof inst?.data === "string" ? inst.data : "";
    if (!data || data.length > 40_000_000) return NextResponse.json({ error: "Nesne eksik ya da çok büyük (>30 MB)" }, { status: 413 });
    const buf = Buffer.from(data, "base64");
    const check = validateDerivedDicomBytes(buf, kind, studyUid);
    if (!check.ok) return NextResponse.json({ error: check.error ?? "Geçersiz nesne" }, { status: 400 });
    parts.push(new Uint8Array(buf));
  }

  let stored = 0, failed = 0;
  const errors: string[] = [];
  for (const p of parts) {
    try {
      const out = await stowInstance(cfg, p);
      stored += out.stored;
      failed += out.failed.length;
      for (const f of out.failed) errors.push(typeof f === "string" ? f : String(f));
    } catch (e) {
      failed += 1;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  await audit(user, kind === "seg" ? "pacs.send_seg" : "pacs.send_rtstruct", "study", studyUid, { pacs: cfg.name || cfg.kind, stored, failed });
  if (failed && stored === 0) return NextResponse.json({ error: `Gönderim başarısız: ${errors[0] ?? "PACS reddetti"}`, stored, failed, kind, pacs: cfg.name || cfg.kind }, { status: 502 });
  return NextResponse.json({ stored, failed, kind, pacs: cfg.name || cfg.kind });
}

/** Seri durumundaki anahtar kesitler + pencere → KO/PR nesnesi → STOW. */
async function stowFromSeries(b: StowBody, user: Parameters<typeof audit>[0]) {
  const studyUid = (b.studyUid ?? "").trim();
  const seriesKey = (b.seriesKey ?? "").trim();
  if (!studyUid || !seriesKey) return NextResponse.json({ error: "Eksik veri (studyUid, seriesKey)" }, { status: 400 });

  const row = (await db.select({ s: studies }).from(studies).where(eq(studies.studyUid, studyUid)).limit(1))[0];
  if (!row) return NextResponse.json({ error: "Çalışma kayıtlı değil" }, { status: 404 });
  const st = (await db.select().from(studyState).where(and(eq(studyState.studyUid, studyUid), eq(studyState.seriesKey, seriesKey))).limit(1))[0];
  if (!st) return NextResponse.json({ error: "Bu seri için kayıtlı anahtar kesit/görünüm yok" }, { status: 404 });

  const parse = <T,>(raw: string, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
  const keyImages = parse<{ slice: number; note?: string }[]>(decryptText(st.keyImages), []);
  const annotations = parse<{ windowLevel?: number; windowWidth?: number; rotation?: number; flipH?: boolean; flipV?: boolean; invert?: boolean }[]>(st.annotations, []);
  const view = annotations.find((x) => typeof x.windowLevel === "number" && typeof x.windowWidth === "number");

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  if (!keyImages.length) return NextResponse.json({ error: "Bu seride anahtar kesit (★) yok" }, { status: 409 });
  if (b.kind === "pr" && !view) return NextResponse.json({ error: "Bu seride kayıtlı pencere (WL/WW) yok" }, { status: 409 });

  const s = row.s;
  const patient = {
    patientName: s.patientName, patientId: s.patientId, patientSex: s.patientSex,
    studyUid, studyDate: s.studyDate, institution: s.institution,
  };
  // Seri UID'leri istemciden gelir (kesit sırası yalnız istemcide bilinir) ama
  // PACS'teki gerçek örneklerle doğrulanır: uydurma UID ile gönderim yapılamaz.
  const seriesUid = (b.seriesUid ?? "").trim();
  const sopClassUid = (b.sopClassUid ?? "").trim();
  const sopUids = Array.isArray(b.sopUids) ? b.sopUids.slice(0, 5000) : [];
  if (!isUid(seriesUid) || !isUid(sopClassUid) || !sopUids.length || !sopUids.every(isUid)) {
    return NextResponse.json({ error: "Seri UID'leri eksik/geçersiz; KO/PR yalnızca gerçek DICOM serileri için üretilir" }, { status: 400 });
  }
  let known: Set<string>;
  try {
    known = new Set((await qidoInstances(cfg, studyUid)).filter((i) => i.seriesUid === seriesUid).map((i) => i.sopUid));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!known.size) return NextResponse.json({ error: "Seri PACS'te bulunamadı (önce görüntüleri PACS'e gönderin)" }, { status: 409 });
  if (!sopUids.some((u) => known.has(u))) return NextResponse.json({ error: "Kesit UID'leri PACS'teki seriyle eşleşmiyor" }, { status: 409 });

  const mapped = keyImages
    .map((k) => ({ sopUid: sopUids[k.slice], note: k.note }))
    .filter((x) => !!x.sopUid && known.has(x.sopUid));
  if (!mapped.length) return NextResponse.json({ error: "Anahtar kesitlerin SOP UID eşlemesi bulunamadı" }, { status: 409 });

  const bytes = b.kind === "ko"
    ? buildKeyObjectSelection({ ...patient, seriesUid, sopClassUid, title: "Anahtar kesitler", items: mapped })
    : buildPresentationState({
        ...patient, seriesUid, sopClassUid, sopUids,
        wl: view!.windowLevel!, ww: view!.windowWidth!,
        rotation: (view!.rotation ?? 0) as 0 | 90 | 180 | 270,
        flipH: view!.flipH, flipV: view!.flipV, invert: view!.invert,
      });

  try {
    const out = await stowInstance(cfg, bytes);
    await audit(user, b.kind === "ko" ? "pacs.send_ko" : "pacs.send_pr", "study", studyUid, { series: seriesKey, stored: out.stored });
    return NextResponse.json({ ...out, kind: b.kind, pacs: cfg.name || cfg.kind });
  } catch (e) {
    await audit(user, "pacs.send_key_failed", "study", studyUid, { series: seriesKey, kind: b.kind });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/**
 * Anonim seri gönderimi (e-stow): istemci baytları bellekte sıfırdan üretir
 * (özel etiket/UID/kimlik taşımaz); sunucu yalnız STOW-RS'e iletir.
 * Boyut/örnek sayısı sunucuda yeniden doğrulanır; her gönderim denetime yazılır.
 */
async function stowAnon(b: StowBody, user: Parameters<typeof audit>[0]) {
  const sel = parseAnonSelection(b.selection);
  if (!sel.ok) return NextResponse.json({ error: sel.error }, { status: 400 });
  const v = validateAnonStowBody(b);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  // Seçim bütünlüğü: bildirilen aralığın kesit sayısı gelen örneklere eşit olmalı;
  // eşit değilse istemci seçim dışı/eksik örnek gönderiyordur — PACS'e iletilmez.
  if (sel.value) {
    const countErr = selectionInstanceCountError(sel.value, v.instances.length);
    if (countErr) return NextResponse.json({ error: countErr }, { status: 400 });
  }
  const studyUid = (b.studyUid ?? "").trim();
  if (!isUid(studyUid)) return NextResponse.json({ error: "Geçersiz StudyInstanceUID" }, { status: 400 });

  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  const results: { stored: number; failed: string[]; message?: string }[] = [];
  for (const it of v.instances) {
    const bytes = new Uint8Array(Buffer.from(it.data, "base64"));
    // İlk 128 bayt önek + "DICM" imzası: bozuk/yanlış içerik PACS'e gitmesin.
    const sig = Buffer.from(bytes.slice(128, 132)).toString("latin1");
    if (sig !== "DICM") {
      results.push({ stored: 0, failed: [it.name], message: `${it.name}: DICOM imzası yok` });
      continue;
    }
    try {
      const out = await stowInstance(cfg, bytes);
      results.push(out);
    } catch (e) {
      results.push({ stored: 0, failed: [it.name], message: e instanceof Error ? e.message : String(e) });
    }
  }
  const sum = summarizeAnonResult(results);
  await audit(user, sum.ok ? "pacs.send_anon" : "pacs.send_anon_partial", "study", studyUid, { count: v.instances.length, stored: sum.stored, failed: sum.failed, pacs: cfg.name || cfg.kind, ...(sel.value ? { selection: sel.value } : {}) });
  return NextResponse.json({ ...sum, kind: "anon", pacs: cfg.name || cfg.kind }, { status: sum.ok ? 200 : 207 });
}
