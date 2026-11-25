import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { fetchBulk, firstTransferSyntax, isUid, qidoInstances, qidoStudies, testConnection, wadoFrames, wadoInstance, wadoMetadata } from "@/lib/server/pacs";
import { planFrameFetch } from "@/lib/bulkData";
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
    if (action === "bulkdata") {
      // BulkDataURI yoluyla kare çekme (e-wado-frame): metadata'da verilen adres
      // PACS köküne sabitlenir (SSRF koruması) ve her getirme denetime yazılır.
      const bulk = sp.get("uri") ?? "";
      if (!bulk) return NextResponse.json({ error: "uri parametresi gerekli (metadata BulkDataURI)" }, { status: 400 });
      const parts = await fetchBulk(cfg, bulk, sp.get("accept") ?? undefined);
      await audit(a.user, "pacs.retrieve_bulk", "pacs", studyUid, { parts: parts.length, bytes: parts.reduce((n, p) => n + p.length, 0) });
      if (parts.length === 1 && sp.get("raw") === "1") {
        return new NextResponse(new Uint8Array(parts[0]), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ count: parts.length, frames: parts.map((p) => ({ bytes: p.length, data: Buffer.from(p).toString("base64") })) });
    }
    if (action === "frameplan") {
      // İstemciye "hangi bulk adreslerinden kaç kare çekilecek" planı ve codec
      // uyarısı: PACS metadata'sı sunucuda çözülür, tarayıcı politika bilmez.
      const seriesUid = sp.get("seriesUid") ?? "";
      const sopUid = sp.get("sopUid") ?? "";
      if (!isUid(seriesUid) || !isUid(sopUid)) return NextResponse.json({ error: "Geçersiz UID" }, { status: 400 });
      const meta = await wadoMetadata(cfg, { studyUid, seriesUid, sopUid });
      const frames = (sp.get("frames") ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
      const tsUid = firstTransferSyntax(meta);
      const plan = planFrameFetch(meta, cfg.wadoRoot || cfg.qidoRoot || "", { frames, transferSyntaxUid: tsUid });
      await audit(a.user, "pacs.frameplan", "pacs", studyUid, { bulk: plan.urls.length, skipped: plan.skipped.length, compressed: plan.hint.compressed, decodable: plan.hint.browserDecodable });
      return NextResponse.json(plan);
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
