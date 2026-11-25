import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { studies } from "@/db/schema";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { getSetting } from "@/lib/server/settings";
import {
  bridgeHealth,
  cfind,
  cmove,
  DIMSE_LEVELS,
  TAGS,
  toDicomDate,
  type DimseLevel,
} from "@/lib/dimseBridge";

export const dynamic = "force-dynamic";

/**
 * DIMSE köprüsü (w-pacs): C-FIND / C-MOVE.
 *
 * GET  ?action=health → köprü sağlığı (AE Title, sürüm).
 * POST { action: "cfind", level, patientId?, accession?, studyUid?, date?, limit? }
 *      → çalışma/seri listesi (DICOM JSON → düz satırlar).
 * POST { action: "cmove", studyUid, seriesUid?, destinationAe } → PACS → hedef AE.
 * POST { action: "import", studyUid } → C-MOVE ile **kendi AE'mize** çekip
 *      çalışma kaydını kuyruğa alır (PACS'i kaynak, kendimizi hedef gösteririz).
 *
 * Neden köprü: DIMSE TCP protokolü tarayıcıdan/sunucudan doğrudan konuşulamaz.
 * Köprü adresi `pacs.mwl` ayarındaki `dimseUrl` alanından okunur (mevcut MWL
 * köprüsüyle aynı adres) — ayrı bir sır/anahtar yönetimi gerekmez.
 */
async function bridgeUrl(): Promise<string> {
  try {
    const raw = await getSetting("pacs.mwl", "{}");
    const o = JSON.parse(raw) as { dimseUrl?: string };
    return (o.dimseUrl ?? "").trim();
  } catch {
    return "";
  }
}

/** Kendi AE Title'ımız (C-MOVE hedefi); varsayılan ARENAVIEWER. */
async function ownAeTitle(): Promise<string> {
  return ((await getSetting("pacs.aeTitle", "ARENAVIEWER")) || "ARENAVIEWER").trim();
}

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const url = await bridgeUrl();
  if (!url) return NextResponse.json({ configured: false, ok: false, message: "DIMSE köprüsü adresi tanımlı değil (Yönetim → Entegrasyon)." });
  const health = await bridgeHealth(url);
  return NextResponse.json({ configured: true, ...health, ownAe: await ownAeTitle() });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    level?: string;
    patientId?: string;
    accession?: string;
    studyUid?: string;
    seriesUid?: string;
    date?: string;
    limit?: number;
    destinationAe?: string;
  };
  const url = await bridgeUrl();
  if (!url) return NextResponse.json({ error: "DIMSE köprüsü adresi tanımlı değil — Yönetim → Entegrasyon → MWL köprüsü alanını doldurun." }, { status: 400 });

  if (b.action === "cfind") {
    const level: DimseLevel = DIMSE_LEVELS.includes((b.level ?? "") as DimseLevel) ? (b.level as DimseLevel) : "STUDY";
    const query: Record<string, string> = {};
    if (b.patientId?.trim()) query[TAGS.patientId] = b.patientId.trim();
    if (b.accession?.trim()) query[TAGS.accession] = b.accession.trim();
    if (b.studyUid?.trim()) query[TAGS.studyUid] = b.studyUid.trim();
    if (b.seriesUid?.trim()) query[TAGS.seriesUid] = b.seriesUid.trim();
    const date = toDicomDate(b.date ?? "");
    if (date) query[TAGS.studyDate] = date;
    if (Object.keys(query).length === 0) {
      return NextResponse.json({ error: "En az bir arama ölçütü gerekli (hasta kimliği, erişim no, çalışma UID veya tarih)." }, { status: 400 });
    }
    try {
      const rows = await cfind(url, { level, query, limit: b.limit ?? 100 });
      await audit(a.user, "pacs.cfind", "study", b.studyUid ?? "", { level, hits: rows?.length ?? 0 });
      return NextResponse.json({ ok: true, level, rows: rows ?? [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit(a.user, "pacs.cfind_failed", "study", "", { level, error: msg.slice(0, 200) });
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  if (b.action === "cmove" || b.action === "import") {
    if (!b.studyUid?.trim()) return NextResponse.json({ error: "Çalışma UID gerekli" }, { status: 400 });
    // "import": kendimizi C-MOVE hedefi gösteriyoruz; köprü görüntüyü PACS'ten çeker.
    const destinationAe = b.action === "import" ? await ownAeTitle() : (b.destinationAe ?? "").trim();
    try {
      const res = await cmove(url, { studyUid: b.studyUid.trim(), seriesUid: b.seriesUid?.trim(), destinationAe });
      await audit(a.user, b.action === "import" ? "pacs.cmove_import" : "pacs.cmove", "study", b.studyUid, {
        destinationAe, completed: res?.completed, failed: res?.failed, warnings: res?.warnings,
      });
      if (b.action === "import" && res && res.completed > 0) {
        // Gelen görüntüler PACS alıcısına düşer; çalışma kaydı yoksa "bekliyor"
        // durumunda oluşturulur ki iş listesinde görünsün (görüntü akışı ayrı iş).
        const existing = await db.select({ id: studies.id }).from(studies).where(eqStudy(b.studyUid.trim())).limit(1);
        if (!existing[0]) {
          await db.insert(studies).values({
            studyUid: b.studyUid.trim(),
            modality: "OT",
            bodyPart: "-",
            seriesDescription: "DIMSE C-MOVE ile alındı",
            studyDate: new Date().toISOString().slice(0, 10),
            workStatus: "bekliyor",
            source: "pacs",
          });
        }
      }
      return NextResponse.json({ ok: res?.accepted ?? false, result: res, destinationAe });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit(a.user, "pacs.cmove_failed", "study", b.studyUid, { destinationAe, error: msg.slice(0, 200) });
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Bilinmeyen action" }, { status: 400 });
}

/** Drizzle eşitlik yardımcısı (studies.studyUid). */
import { eq } from "drizzle-orm";
function eqStudy(uid: string) {
  return eq(studies.studyUid, uid);
}
