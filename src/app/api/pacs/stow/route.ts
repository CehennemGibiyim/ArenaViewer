import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reports, studies, studyState } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { loadPacsConfig } from "@/lib/server/pacsConfig";
import { isUid, qidoInstances, stowInstance } from "@/lib/server/pacs";
import { mapReport } from "@/lib/server/studyRepo";
import { buildKeyObjectSelection, buildPresentationState, buildReportSr } from "@/lib/dicomSr";
import { summarizeAnonResult, validateAnonStowBody } from "@/lib/stowPayload";
import { decryptText } from "@/lib/server/crypto";

export const dynamic = "force-dynamic";

interface StowBody {
  kind?: "sr" | "ko" | "pr" | "anon";
  /** Anonim gönderim: istemcide sıfırdan üretilmiş DICOM baytları (base64). */
  instances?: { name?: string; data?: string }[];
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
  const v = validateAnonStowBody(b);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
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
  await audit(user, sum.ok ? "pacs.send_anon" : "pacs.send_anon_partial", "study", studyUid, { count: v.instances.length, stored: sum.stored, failed: sum.failed, pacs: cfg.name || cfg.kind });
  return NextResponse.json({ ...sum, kind: "anon", pacs: cfg.name || cfg.kind }, { status: sum.ok ? 200 : 207 });
}
