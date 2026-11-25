import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { getSetting, setSetting } from "@/lib/server/settings";
import { stowInstance } from "@/lib/server/pacs";
import { loadPacsConfig } from "@/lib/server/pacsConfig";
import { buildMeasurementReportSr, type Measurement } from "@/lib/sr1500";
import {
  compareTracked,
  codingAudit,
  documentChecks,
  EMPTY_LEXICON,
  fhirBundle,
  measurementSummary,
  parseLexicon,
  resolveCode,
  SCHEME_LABEL,
  sr1500Text,
  toFhirObservations,
  trackedCsv,
  type Lexicon,
} from "@/lib/sr1500Registry";

export const dynamic = "force-dynamic";

const LEXICON_KEY = "sr1500.lexicon";

async function loadLexicon(): Promise<{ lexicon: Lexicon; rejected: { index: number; reason: string }[] }> {
  const raw = await getSetting(LEXICON_KEY, "");
  if (!raw) return { lexicon: EMPTY_LEXICON, rejected: [] };
  try {
    return parseLexicon(JSON.parse(raw));
  } catch {
    return { lexicon: EMPTY_LEXICON, rejected: [{ index: 0, reason: "Kayıtlı sözlük geçerli JSON değil" }] };
  }
}

/**
 * Ölçüm defteri ucu (c-sr-tid1500).
 *
 * GET  → sözlük durumu + kod denetimi (ölçüm verilirse) ya da uzunlamasına tablo (`?prev=&cur=`).
 * PUT  → kurum kod sözlüğünü yükler (JSON). Bozuk girişler reddedilir ve raporlanır;
 *        geçerli olanlar saklanır. Lisans kurumdadır — bu uç kod **uydurmaz**.
 * POST → ölçümleri TID 1500 belgesine çevirir; `stow: true` ise PACS'e gönderir
 *        (CTN/STOW başarısızsa belge yine indirilebilir olarak döner).
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const { lexicon, rejected } = await loadLexicon();
  const prevUid = sp.get("prev");
  const curUid = sp.get("cur");
  if (prevUid && curUid) {
    // Sunucuda ölçüm tablosu yok: uzunlamasına karşılaştırma PATCH ile istemci
    // ölçümleriyle yapılır. Sessiz boş sonuç yerine açık yönlendirme döneriz.
    void prevUid;
    void curUid;
    return NextResponse.json(
      { error: "Sunucuda saklı ölçüm yok; ölçümleri PATCH ile gönderin (previous/current)." },
      { status: 400 },
    );
  }
  return NextResponse.json({
    lexicon: { version: lexicon.version, license: lexicon.license ?? "", entries: lexicon.entries.length },
    rejected,
    schemes: SCHEME_LABEL,
    fields: ["SCT", "RADLEX", "LN", "DCM", "SRT", "UCUM"],
  });
}

export async function PUT(req: NextRequest) {
  const a = await authorize(req, ["yonetici"]);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body) return NextResponse.json({ error: "JSON gövde gerekli" }, { status: 400 });
  const { lexicon, rejected } = parseLexicon(body);
  if (lexicon.entries.length === 0) {
    return NextResponse.json({ error: "Geçerli sözlük girişi yok; kayıt yapılmadı.", rejected }, { status: 400 });
  }
  await setSetting(LEXICON_KEY, JSON.stringify(lexicon));
  await audit(a.user, "sr1500.lexicon_update", "setting", LEXICON_KEY, { version: lexicon.version, entries: lexicon.entries.length, rejected: rejected.length });
  return NextResponse.json({ ok: true, version: lexicon.version, entries: lexicon.entries.length, rejected });
}

interface PostBody {
  studyUid?: string;
  measurements?: Measurement[];
  /** Kavram → kod çözümü kullanılsın mı (sözlükten) */
  resolveTerms?: { trackingId: string; finding?: string; site?: string }[];
  title?: string;
  /** PACS'e gönder (C-STORE) */
  stow?: boolean;
  /** Döndürülen belge base64 (istemci indirsin) */
  inline?: boolean;
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as PostBody;
  const studyUid = (b.studyUid ?? "").trim();
  if (!studyUid) return NextResponse.json({ error: "Çalışma UID gerekli" }, { status: 400 });
  const { lexicon } = await loadLexicon();

  // Kavram çözümü: sözlükte olmayanlar yerel koda düşer (uydurma standart kod yok).
  const resolutions: { trackingId: string; finding: unknown; site: unknown; reason: string }[] = [];
  let measurements = (b.measurements ?? []).filter((m) => m && typeof m === "object") as Measurement[];
  if (b.resolveTerms?.length) {
    measurements = measurements.map((m) => {
      const t = b.resolveTerms!.find((r) => r.trackingId === m.trackingId);
      if (!t) return m;
      const f = t.finding ? resolveCode(t.finding, lexicon) : null;
      const s = t.site ? resolveCode(t.site, lexicon) : null;
      if (f) resolutions.push({ trackingId: m.trackingId, finding: f.code, site: s?.code ?? null, reason: [f.reason, s?.reason].filter(Boolean).join(" · ") });
      return { ...m, finding: f?.code ?? m.finding, site: s?.code ?? m.site };
    });
  }

  const auditInfo = codingAudit(measurements, lexicon);
  const checks = documentChecks({ studyUid, patientId: "istek", measurements });
  if (measurements.length === 0) return NextResponse.json({ error: "Yazılabilir sayısal ölçüm yok." }, { status: 400 });

  const st = (await db.select().from(studies).where(eq(studies.studyUid, studyUid)).limit(1))[0];
  const bytes = buildMeasurementReportSr({
    patientName: st?.patientName ?? "ANONIM",
    patientId: st?.patientId ?? "",
    patientSex: st?.patientSex ?? "U",
    patientAge: st?.patientAge,
    studyUid,
    studyDate: st?.studyDate ?? new Date().toISOString().slice(0, 10),
    institution: st?.institution ?? "",
    studyModality: st?.modality,
    title: b.title?.slice(0, 120),
    measurements,
  });

  let stowed: { ok: boolean; message: string } | null = null;
  if (b.stow) {
    const cfg = await loadPacsConfig();
    if (!cfg) stowed = { ok: false, message: "PACS yapılandırılmadı; belge yalnızca indirilebilir." };
    else {
      try {
        const r = await stowInstance(cfg, bytes);
        stowed = { ok: r.ok, message: r.message ?? (r.ok ? "PACS'e gönderildi" : "PACS reddetti") };
      } catch (e) {
        stowed = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  await audit(a.user, "sr1500.build", "study", studyUid, {
    count: measurements.length, standard: auditInfo.standard, local: auditInfo.local, stow: stowed?.ok ?? null, problems: checks.problems.length,
  });

  const summary = measurementSummary(measurements);
  return NextResponse.json({
    ok: true,
    count: measurements.length,
    checks,
    coding: auditInfo,
    resolutions,
    summary,
    text: sr1500Text(summary, auditInfo),
    fhir: b.inline ? fhirBundle(toFhirObservations(measurements, { patientId: st?.patientId ?? "", patientName: st?.patientName ?? "" }, studyUid)) : undefined,
    stowed,
    bytes: b.inline ? Buffer.from(bytes).toString("base64") : undefined,
  });
}

/** Uzunlamasına karşılaştırma (istemci ölçümlerini gönderir). */
export async function PATCH(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as { previous?: Measurement[]; current?: Measurement[] };
  if (!Array.isArray(b.previous) || !Array.isArray(b.current)) {
    return NextResponse.json({ error: "previous ve current ölçüm dizileri gerekli" }, { status: 400 });
  }
  const changes = compareTracked(b.previous, b.current);
  return NextResponse.json({ changes, csv: trackedCsv(changes) });
}
