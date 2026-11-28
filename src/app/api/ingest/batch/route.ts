import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/server/auth";
import { audit } from "@/lib/server/audit";
import { enqueueBatchItems, batchProgress, listBatchItems, publicBatchItems } from "@/lib/server/batchImportRepo";
import { batchErrorReportCsv } from "@/lib/batchImport";

export const dynamic = "force-dynamic";

/**
 * Toplu/arka plan içe aktarma kuyruğu ucu (f-batch).
 *
 * - **POST** `/api/ingest/batch` — body `{ batchId, owner?, items: [{name,size,sha256?,studyUid?,modality?}] }`:
 *   kuyruğa öge ekler (dedupe, sınır); ilerleme durumu döndürür.
 * - **GET** `/api/ingest/batch?batchId=…` — kuyruğun ilerlemesi + hata raporu + öge listesi.
 * - **GET** `/api/ingest/batch?batchId=…&report=csv` — hata raporu CSV.
 *
 * Her kuyruk ögesi `status` ile `pending|processing|done|failed` durumunda;
 * worker (`scripts/batch-worker.ts`) bu durumdan ilerleme/hata raporu üretir.
 * Payload (şifreli baytlar) listelemeden hiçbir ucu döndürür — sızıntı önleme.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;

  const b = (await req.json().catch(() => null)) as
    | { batchId?: string; owner?: string; items?: { name: string; size: number; sha256?: string; studyUid?: string; modality?: string }[] }
    | null;
  if (!b?.batchId || !Array.isArray(b.items)) {
    return NextResponse.json({ error: "batchId ve items (dosya meta verileri) gerekli" }, { status: 400 });
  }
  const owner = (b.owner ?? a.user.username).slice(0, 64);
  const res = await enqueueBatchItems(b.batchId, owner, b.items);
  const prog = await batchProgress(b.batchId);
  await audit(a.user, "batch.enqueue", "batch_queue", "", {
    batch: b.batchId,
    accepted: res.accepted,
    skippedDuplicates: res.skippedDuplicates.length,
  });
  return NextResponse.json({ ok: true, accepted: res.accepted, skippedDuplicates: res.skippedDuplicates, progress: prog.summary });
}

export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const sp = req.nextUrl.searchParams;
  const batchId = (sp.get("batchId") ?? "").trim();
  if (!batchId) return NextResponse.json({ error: "batchId gerekli" }, { status: 400 });

  if (sp.get("report") === "csv") {
    const items = await listBatchItems(batchId);
    return new NextResponse(batchErrorReportCsv(items), { headers: { "content-type": "text/csv; charset=utf-8" } });
  }

  const items = await publicBatchItems(batchId);
  const prog = await batchProgress(batchId);
  return NextResponse.json({ batchId, summary: prog.summary, errors: prog.errors, items });
}
