import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { fetchBulkdata, isAllowedBulkdataUri, isUid, qidoInstances, qidoStudies, testConnection, wadoFrames, wadoInstance, wadoMetadata } from "@/lib/server/pacs";
import { loadPacsConfig } from "@/lib/server/pacsConfig";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const a = await authorize(req);
  if ("error" in a) return a.error;
  const { action } = await params;
  const sp = req.nextUrl.searchParams;
  const cfg = await loadPacsConfig();
  if (!cfg) return NextResponse.json({ error: "PACS yapılandırılmamış (Yönetim → Entegrasyon → PACS)" }, { status: 503 });

  try {
    if (action === "studies") {
      const q = (sp.get("q") ?? "").slice(0, 64);
      const list = await qidoStudies(cfg, q);
      await audit(a.user, "pacs.query", "pacs", "", { q, results: list.length, pacs: cfg.name || cfg.kind });
      return NextResponse.json(list);
    }
    if (action === "test") {
      const result = await testConnection(cfg);
      await audit(a.user, "pacs.test", "pacs", "", { ok: result.ok, steps: result.steps.map((s) => `${s.name}:${s.http ?? "ağ"}`) });
      return NextResponse.json(result);
    }
    if (action === "metadata") {
      // OHIF uyumu: örnek metadata'sı (PixelData çoğu sunucuda BulkDataURI olarak gelir).
      const seriesUid = sp.get("seriesUid") ?? "";
      const sopUid = sp.get("sopUid") ?? "";
      const studyUid = sp.get("studyUid") ?? "";
      if (!isUid(studyUid) || !isUid(seriesUid) || !isUid(sopUid)) return NextResponse.json({ error: "Geçersiz UID" }, { status: 400 });
      const meta = await wadoMetadata(cfg, studyUid, seriesUid, sopUid);
      await audit(a.user, "pacs.retrieve_metadata", "pacs", studyUid, { sop: sopUid });
      return NextResponse.json(meta, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "bulkdata") {
      // SSRF koruması: URI yalnız yapılandırılan PACS host'una işaret edebilir.
      const uri = sp.get("uri") ?? "";
      const check = isAllowedBulkdataUri(uri, cfg);
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      const bytes = await fetchBulkdata(cfg, uri);
      await audit(a.user, "pacs.retrieve_bulkdata", "pacs", "", { host: check.url.host, bytes: bytes.length });
      return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
    }
    const studyUid = sp.get("studyUid") ?? "";
    if (!isUid(studyUid)) return NextResponse.json({ error: "Geçersiz StudyInstanceUID" }, { status: 400 });
    if (action === "instances") {
      const list = await qidoInstances(cfg, studyUid);
      await audit(a.user, "pacs.retrieve", "pacs", studyUid, { instances: list.length });
      return NextResponse.json(list);
    }
    if (action === "frames") {
      // Kare düzeyinde getirme: yalnız istenen kareler (büyük çalışmalarda bant genişliği).
      const seriesUid = sp.get("seriesUid") ?? "";
      const sopUid = sp.get("sopUid") ?? "";
      if (!isUid(seriesUid) || !isUid(sopUid)) return NextResponse.json({ error: "Geçersiz UID" }, { status: 400 });
      const framesParam = sp.get("frames") ?? sp.get("frame") ?? "1";
      const frames = framesParam.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n <= 100000);
      if (!frames.length) return NextResponse.json({ error: "Geçersiz kare numarası (1 tabanlı)" }, { status: 400 });
      const accept = sp.get("accept") ?? undefined;
      const parts = await wadoFrames(cfg, { studyUid, seriesUid, sopUid }, frames, accept);
      await audit(a.user, "pacs.retrieve_frames", "pacs", studyUid, { sop: sopUid, frames: frames.length, returned: parts.length });
      // Tek kare: doğrudan ikili yanıt (istemci <img>/Blob ile kullanır).
      if (parts.length === 1 && sp.get("raw") === "1") {
        const type = (sp.get("accept") ?? "").includes("jpeg") ? "image/jpeg" : "application/octet-stream";
        return new NextResponse(new Uint8Array(parts[0]), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
      }
      return NextResponse.json({
        count: parts.length,
        requested: frames,
        frames: parts.map((p) => ({ bytes: p.length, data: Buffer.from(p).toString("base64") })),
      });
    }
    if (action === "instance") {
      const seriesUid = sp.get("seriesUid") ?? "";
      const sopUid = sp.get("sopUid") ?? "";
      if (!isUid(seriesUid) || !isUid(sopUid)) return NextResponse.json({ error: "Geçersiz UID" }, { status: 400 });
      const bytes = await wadoInstance(cfg, studyUid, seriesUid, sopUid);
      return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/dicom", "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });
  } catch (e) {
    // Ağ/sertifika/durum hataları zaten Türkçe ve ayırt edilebilir mesajla geliyor.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
