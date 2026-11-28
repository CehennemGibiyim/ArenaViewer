import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import {
  applyCstoreReportToQueue,
  cstoreProgress,
  enqueueCstore,
} from "@/lib/server/cstoreRepo";
import { cstoreStatusLabel, CSTORE_STATUS } from "@/lib/cstore";

export const dynamic = "force-dynamic";

/**
 * C-STORE (DIMSE) kuyruğu ucu (e-stow).
 *
 * Node içinde DIMSE TCP/PDU yığını yoktur; **sözleşme + köprü süreci** yaklaşımı:
 * - **POST** — C-STORE isteği (`{ batchId, target: {aet,...}, instances: [...] }`)
 *   doğrulanır, payload şifrelenerek kuyruğa yazılır (dedupe).
 * - **POST** `{ batchId, report: [{sopUid, status}] }` — köprü sürecinin (dcm4che
 *   `cstore-scu`) DIMSE sonuç raporu işler; durum kodları sınıflandırılır,
 *   ilerleme/hata raporu güncellenir.
 * - **GET** `?batchId=…` — kuyruk özeti + öge listesi (payload sızmaz).
 *
 * Kimlik: radyolog/yönetici. Her değişim denetime yazılır.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;

  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON gerekli" }, { status: 400 });
  const b = body as { batchId?: string; report?: unknown[] };

  // Köprüden sonuç raporu işlenir.
  if (Array.isArray(b.report) && b.batchId) {
    try {
      const out = await applyCstoreReportToQueue(b.batchId, b.report as { sopUid: string; status: number; message?: string }[], a.user.username);
      return NextResponse.json({ ok: true, updated: out.updated, summary: out.summary });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  const res = await enqueueCstore(body, a.user.username);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  await audit(a.user, "cstore.enqueue", "cstore_queue", "", {
    batch: res.batchId,
    accepted: res.accepted,
    skipped: res.skipped.length,
    aet: (body as { target?: { aet?: string } }).target?.aet ?? "",
  });
  return NextResponse.json({ ok: true, accepted: res.accepted, skipped: res.skipped, batchId: res.batchId });
}

export async function GET(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const batchId = (req.nextUrl.searchParams.get("batchId") ?? "").trim();
  if (!batchId) return NextResponse.json({ error: "batchId gerekli" }, { status: 400 });
  try {
    return NextResponse.json(await cstoreProgress(batchId));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** Sözleşme bilgisi (köprü/CLI için). */
export function contractInfo() {
  return {
    endpoint: "/api/pacs/cstore",
    enqueue: {
      batchId: "string",
      target: { aet: "string (DIMSE AET)", host: "string (opsiyonel)", port: "number (opsiyonel)" },
      instances: "[{ name, data? (base64 DICOM), sopClassUid?, sopUid?, studyUid, seriesUid?, size?, sha256? }]",
    },
    report: "{ batchId, report: [{ sopUid, status (DIMSE kodu), message? }] }",
    statuses: Object.entries(CSTORE_STATUS).map(([k, v]) => ({ name: k, code: v, label: cstoreStatusLabel(v as number) })),
    note: "DIMSE TCP/PDU Node içinde değildir; köprü (dcm4che cstore-scu) gerçek C-STORE'i konuşur.",
  };
}
