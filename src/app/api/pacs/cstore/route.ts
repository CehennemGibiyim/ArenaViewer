import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { sendCStore } from "@/lib/server/cstore";
import { bridgeUrl, clampRetries, prepareItems, validateTarget, type CStoreBody } from "@/lib/cstoreBridge";

export const dynamic = "force-dynamic";

/**
 * DIMSE C-STORE gönderimi (e-stow) — DICOMweb STOW-RS'in kardeşi.
 *
 * `POST /api/pacs/stow` STOW-RS kullanır (SR/KO/PR/anonim seri).
 * `POST /api/pacs/cstore` **elde hazır DICOM nesnelerini** DIMSE ile gönderir
 * (köprü süreci gerekir). Gövde sınırları: 20 nesne, nesne başına 12 MB,
 * yalnız Part 10 (DICM) baytları. Her gönderim `pacs.cstore` olarak denetime
 * yazılır; başarısız/reddedilen nesneler tek tek raporlanır.
 *
 * `GET` → köprü yapılandırması ve sınırlar (ön kontrol için).
 */
export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici", "teknisyen"]);
  if ("error" in a) return a.error;
  const raw = process.env.CSTORE_BRIDGE_URL || "";
  const b = bridgeUrl(raw);
  return NextResponse.json({
    configured: b.ok,
    bridge: b.ok ? b.url : null,
    limits: { maxItems: 20, maxItemMb: 12, retries: 4 },
  });
}

export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const body = ((await req.json().catch(() => ({}))) ?? {}) as CStoreBody;

  const t = validateTarget(body.target);
  if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
  const prep = prepareItems(body.items);
  if (!prep.ok) return NextResponse.json({ error: prep.error, index: prep.index }, { status: 400 });

  const out = await sendCStore(body);

  await audit(a.user, out.ok ? "pacs.cstore" : "pacs.cstore_failed", "pacs", 0, {
    host: t.target.host,
    port: t.target.port,
    calledAe: t.target.calledAe,
    objects: prep.prepared.length,
    bytes: prep.prepared.reduce((s, p) => s + p.bytes, 0),
    sent: out.outcome?.sent ?? 0,
    failed: out.outcome?.failed ?? prep.prepared.length,
    retries: clampRetries(body.retries),
    error: out.error?.slice(0, 120),
  });

  if (!out.ok) {
    return NextResponse.json({ error: out.error ?? "C-STORE başarısız", outcome: out.outcome }, { status: out.status });
  }
  return NextResponse.json({ ok: true, outcome: out.outcome });
}
