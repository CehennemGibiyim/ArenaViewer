/**
 * e-wado-frame: metadata-içi PixelData (BulkDataURI) erişimi testleri.
 * Saf çözümleme/doğrulama + sahte DICOMweb sunucusuna karşı gerçek HTTP.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  extractPixelSource, resolveBulkDataUri, decodeInlineBinary, firstInstance,
} from "../src/lib/bulkdata";
import {
  wadoMetadata, fetchBulkdata, isAllowedBulkdataUri,
} from "../src/lib/server/pacs";

const PIXEL = Buffer.from("PIXEL-BUFFER-0123456789");

function metaJson(bulkUri: string | null) {
  const px = bulkUri === null
    ? { vr: "OB", InlineBinary: PIXEL.toString("base64") }
    : { vr: "OB", BulkDataURI: bulkUri };
  return [{ "0008,0060": { vr: "CS", Value: ["CT"] }, "7FE0,0010": px }];
}

async function main() {
  // ── 1) saf çözümleme ──
  assert.equal(resolveBulkDataUri("http://pacs/x", "http://pacs/meta"), "http://pacs/x", "mutlak URI aynen döner");
  assert.equal(resolveBulkDataUri("/dicom-web/px", "http://pacs:8080/dicom-web/studies/x/metadata"), "http://pacs:8080/dicom-web/px", "kök-göreli URI çözülür");
  assert.equal(resolveBulkDataUri("px", "http://pacs/dicom-web/studies/x/metadata"), "http://pacs/dicom-web/studies/x/px", "göreli URI çözülür");
  assert.throws(() => resolveBulkDataUri("file:///etc/passwd", "http://pacs/"), /http\/https/, "file: reddedilir");
  assert.throws(() => resolveBulkDataUri("http://u:p@pacs/x", "http://pacs/"), /kullanıcı/, "kullanıcı bilgili URI reddedilir");
  assert.throws(() => resolveBulkDataUri("", "http://pacs/"), /Boş/, "boş URI reddedilir");
  console.log("PASS resolveBulkDataUri (mutlak/göreli/file/userinfo/boş)");

  // ── 2) kaynak seçimi ──
  const u = "http://pacs/dicom-web/studies/s/series/x/instances/i/metadata";
  const b = extractPixelSource(metaJson("/dicom-web/px/1"), u);
  assert.equal(b.kind, "bulkdata");
  assert.equal(b.uri, "http://pacs/dicom-web/px/1");
  const inl = extractPixelSource(metaJson(null), u);
  assert.equal(inl.kind, "inline-binary");
  assert.deepEqual([...decodeInlineBinary((inl as { base64: string }).base64)], [...PIXEL]);
  const val = extractPixelSource([{ "7FE0,0010": { vr: "OW", Value: [1, 2] } }], u);
  assert.equal(val.kind, "unsupported");
  const missing = extractPixelSource([{ "0008,0060": { vr: "CS", Value: ["CT"] } }], u);
  assert.equal(missing.kind, "missing");
  assert.throws(() => firstInstance(42), /DICOMweb yanıtı değil/);
  assert.equal(firstInstance({ a: 1 } as unknown).a, 1 as never, "tek nesne de kabul edilir");
  console.log("PASS extractPixelSource (bulkdata/inline/unsupported/missing) + firstInstance");

  // ── 3) SSRF koruması ──
  const cfgOf = (qidoRoot: string, wadoRoot = "") =>
    ({ qidoRoot, wadoRoot, allowSelfSigned: false, auth: { type: "none", username: "", password: "", token: "", headerName: "", headerValue: "" } }) as Parameters<typeof isAllowedBulkdataUri>[1];
  assert.equal(isAllowedBulkdataUri("http://127.0.0.1:5000/dicom-web/px", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, true, "aynı host izinli");
  assert.equal(isAllowedBulkdataUri("http://127.0.0.1:5001/x", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "farklı port reddedilir");
  assert.equal(isAllowedBulkdataUri("http://169.254.169.254/latest/meta-data", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "dahili metadata reddedilir");
  assert.equal(isAllowedBulkdataUri("https://pacs.kurum.local/x", cfgOf("http://pacs.kurum.local/dicom-web")).ok, true, "https aynı host izinli");
  assert.equal(isAllowedBulkdataUri("http://u:p@127.0.0.1:5000/x", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "userinfo reddedilir");
  assert.equal(isAllowedBulkdataUri("http://127.0.0.1:5000/x#frag", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "fragment reddedilir");
  assert.equal(isAllowedBulkdataUri("ftp://127.0.0.1:5000/x", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "http-dışı şema reddedilir");
  assert.equal(isAllowedBulkdataUri("/dicom-web/px", cfgOf("http://127.0.0.1:5000/dicom-web")).ok, false, "göreli URI vekilsiz reddedilir (çözülmüş olmalı)");
  // wadoRoot ayrı host verirse oradaki host da kabul edilir
  assert.equal(isAllowedBulkdataUri("http://wado.local:9999/px", cfgOf("http://qido.local:9998/rs", "http://wado.local:9999/rs")).ok, true, "wadoRoot host'u izinli");
  console.log("PASS isAllowedBulkdataUri (SSRF koruması)");

  // ── 4) sahte DICOMweb sunucusuyla uçtan uca (gerçek HTTP) ──
  const authOk = (h: string | undefined) => (h ?? "") === "Basic " + Buffer.from("atik:atik123").toString("base64");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // Üretimdeki /api/pacs/bulkdata gibi vekil rotası kimlik İSTEMEZ (kullanıcının PACS
    // parolası yoktur); PACS kimliğini kendisi ekler. Diğer PACS rotaları 401 ister.
    if (url.pathname === "/api/pacs/bulkdata") {
      const uri = url.searchParams.get("uri") ?? "";
      const check = isAllowedBulkdataUri(uri, cfg);
      if (!check.ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: check.error })); return; }
      http.get(uri, { headers: { authorization: "Basic " + Buffer.from("atik:atik123").toString("base64") } }, (pxRes) => {
        res.writeHead(pxRes.statusCode ?? 502, { "Content-Type": "application/octet-stream" });
        pxRes.pipe(res);
      }).on("error", () => { res.writeHead(502); res.end(); });
      return;
    }
    if (!authOk(req.headers.authorization)) { res.writeHead(401); res.end("unauthorised"); return; }
    if (url.pathname.endsWith("/metadata")) {
      res.writeHead(200, { "Content-Type": "application/dicom+json" });
      res.end(JSON.stringify(metaJson("/dicom-web/pixeldata/1"))); return;
    }
    if (url.pathname === "/dicom-web/pixeldata/1") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(PIXEL); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("sahte sunucu adresi yok");
  const ROOT = `http://127.0.0.1:${addr.port}/dicom-web`;
  const cfg = {
    kind: "generic", name: "mock", qidoRoot: ROOT, wadoRoot: "",
    auth: { type: "basic", username: "atik", password: "atik123", token: "", headerName: "", headerValue: "" },
    allowSelfSigned: false, limit: 50, includefield: true, notes: "",
  } as unknown as Parameters<typeof wadoMetadata>[0];
  const metaUrl = `${ROOT}/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1/metadata`;
  try {
    // 4a) metadata getir + piksel kaynağını çıkar
    const meta = await wadoMetadata(cfg, "1.2.3", "1.2.3.1", "1.2.3.1.1");
    const src = extractPixelSource(meta, metaUrl);
    assert.equal(src.kind, "bulkdata", "metadata PixelData'yı BulkDataURI olarak veriyor");
    assert.equal(src.uri, `http://127.0.0.1:${addr.port}/dicom-web/pixeldata/1`, "göreli URI metadata tabanına göre çözülüyor");
    // 4b) vekil üzerinden (aynı host denetimi gerçek kodla) piksel baytlarını al
    const proxied = await fetchBulkdata(cfg, src.uri);
    assert.deepEqual([...proxied], [...PIXEL], "BulkDataURI baytları doğru");
    // 4c) vekil harici bir adresi reddeder
    await assert.rejects(() => fetchBulkdata(cfg, "http://127.0.0.1:1/pixeldata/1"), /aynı sunucuda/, "farklı port vekilde reddedilir");
    // 4d) istemci hattı: /api/pacs/bulkdata sözleşmesi (sahte vekil)
    const { fetchPixelData } = await import("../src/lib/wadoClient");
    const px = await fetchPixelData(meta, { metadataUrl: metaUrl, baseUrl: `http://127.0.0.1:${addr.port}` });
    assert.equal(px.source, "bulkdata", "istemci bulkdata kaynağını seçiyor");
    assert.deepEqual([...px.bytes], [...PIXEL], "istemci piksel baytları doğru");
    // 4e) kimlik hatası ayırt edilebilir
    const cfgBad = { ...cfg, auth: { ...cfg.auth, password: "yanlis" } };
    await assert.rejects(() => wadoMetadata(cfgBad, "1.2.3", "1.2.3.1", "1.2.3.1.1"), /401/, "401 mesajı kimlik hatası");
    console.log("PASS sahte DICOMweb: metadata → BulkDataURI → vekil → piksel baytları");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }

  // ── 5) uç + vekil kaynağı bağlantısı ──
  const fs = await import("node:fs");
  const path = await import("node:path");
  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/[action]/route.ts"), "utf8");
  assert.ok(routeSrc.includes('action === "bulkdata"'), "uç bulkdata yolunu ayırıyor");
  assert.ok(routeSrc.includes("isAllowedBulkdataUri"), "vekil SSRF denetimi yapıyor");
  assert.ok(routeSrc.includes("pacs.retrieve_bulkdata"), "bulkdata indirme denetime yazılıyor");
  assert.ok(routeSrc.includes('action === "metadata"'), "uç metadata yolunu ayırıyor");
  console.log("PASS uç sözleşmesi (metadata + bulkdata + denetim)");

  console.log("Tüm bulkdata (metadata-içi piksel erişimi) testleri geçti.");
}
main().catch((e) => { console.error("FAIL", e instanceof Error ? e.message : e); process.exit(1); });
