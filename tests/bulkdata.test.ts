/**
 * e-wado-frame: BulkDataURI ile metadata-içi piksel erişimi + codec kararı.
 *
 * İddialar: bulk adresi PACS dışına çıkamaz (SSRF), kare planı tekilleştirir ve
 * istenmeyen kareleri atlar, sıkıştırılmış aktarımda "tarayıcı çözebilir mi"
 * dürüstçe söylenir (uydurma başarı yok), kare boyutu doğru hesaplanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectBulkUris, expectedFrameBytes, frameFromUri, planFrameFetch, resolveBulkUrl, transferSyntaxHint } from "../src/lib/bulkData";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const PACS = "https://pacs.hastane.local/dicomweb";

function main() {
  // ── 1) Güvenlik kapısı ──────────────────────────────────────────────
  const rel = resolveBulkUrl(PACS, "/dicomweb/studies/1.2.3/series/4.5/instances/6.7/bulk/7FE00010");
  assert.equal(rel.ok, true, "göreli bulk adresi kabul");
  if (rel.ok) assert.equal(rel.url, `${PACS}/studies/1.2.3/series/4.5/instances/6.7/bulk/7FE00010`, "kök origin'ine çözüldü");
  const abs = resolveBulkUrl(PACS, `${PACS}/studies/1/bulk/7FE00010`);
  assert.equal(abs.ok, true, "aynı origin mutlak adres kabul");
  const ssrf = resolveBulkUrl(PACS, "http://169.254.169.254/latest/meta-data/");
  assert.equal(ssrf.ok, false, "başka origin reddedildi");
  assert.match((ssrf as { error: string }).error, /PACS dışına çıkıyor/, "gerekçe SSRF der");
  assert.match((ssrf as { error: string }).error, /169\.254\.169\.254/, "hedef adres gerekçede");
  assert.equal(resolveBulkUrl(PACS, "ftp://pacs/x").ok, false, "http dışı protokol reddedildi");
  assert.equal(resolveBulkUrl(PACS, "").ok, false, "boş adres reddedildi");
  assert.equal(resolveBulkUrl("bozuk", "/x").ok, false, "bozuk kök reddedildi");
  console.log("PASS bulk adresi güvenlik kapısı");

  // ── 2) Metadata'dan bulk referansları ───────────────────────────────
  const metadata = {
    "00280010": { vr: "US", Value: [512] },
    "00280011": { vr: "US", Value: [512] },
    "00280100": { vr: "US", Value: [16] },
    "00280002": { vr: "US", Value: [1] },
    "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.4.90"] },
    "7FE00010": { vr: "OB", BulkDataURI: "https://pacs.hastane.local/dicomweb/studies/1/series/2/instances/3/bulk/7FE00010" },
    "00080018": { vr: "UI", Value: ["1.2.3.4"] },
    "60003000": { vr: "SQ", Value: [{ "7FE00010": { vr: "OW", BulkDataURI: "https://pacs.hastane.local/dicomweb/studies/1/series/2/instances/3/bulk/60003000" } }] },
  };
  const refs = collectBulkUris(metadata, { pixelOnly: true });
  assert.equal(refs.length, 2, "iki piksel bulk referansı (gömülü SQ dahil)");
  // Etiket her zaman bulk veriyi **taşıyan** etikettir (gömülü SQ içinde de 7FE00010).
  assert.deepEqual(refs.map((r) => r.tag).sort(), ["7FE00010", "7FE00010"], "etiketler");
  assert.equal(collectBulkUris({ "00420010": {} }).length, 0, "bulk'sız nesne");
  assert.equal(collectBulkUris(metadata).length, 2, "pixelOnly olmadan da iki");
  assert.equal(collectBulkUris({ "60003000": { vr: "OW", BulkDataURI: "/dicomweb/encapsulated/1" } }, { pixelOnly: true }).length, 0, "gömülü belge piksel sayılmaz");
  const nonPixel = collectBulkUris({ "00420010": { vr: "OB", BulkDataURI: "/dicomweb/encapsulated/1" } }, { pixelOnly: true });
  assert.equal(nonPixel.length, 0, "piksel olmayan bulk atlanır");
  assert.equal(collectBulkUris(null).length, 0, "boş metadata");
  console.log("PASS metadata bulk referansları");

  // ── 3) Kare numarası çıkarma ────────────────────────────────────────
  assert.equal(frameFromUri("https://p/bulk/7FE00010#frame%203"), undefined, "kodlanmış ayırıcı yakalanmaz");
  assert.equal(frameFromUri("https://p/bulk/7FE00010#frame 3"), 3, "#frame 3");
  assert.equal(frameFromUri("https://p/instances/1/frames/7"), 7, "frames/7");
  assert.equal(frameFromUri("https://p/instances/1/frames/1,2"), undefined, "çoklu kare → belirsiz (uydurma yok)");
  assert.equal(frameFromUri("https://p/bulk/7FE00010"), undefined, "kare bilgisi yok");
  console.log("PASS kare numarası");

  // ── 4) Aktarım sözdizimi / codec kararı ─────────────────────────────
  const native = transferSyntaxHint("1.2.840.10008.1.2.1");
  assert.equal(native.compressed, false, "native sıkıştırmasız");
  assert.equal(native.browserDecodable, true, "native tarayıcıda çözülür");
  const j2k = transferSyntaxHint("1.2.840.10008.1.2.4.90");
  assert.equal(j2k.compressed, true, "JPEG 2000 sıkıştırılmış");
  assert.equal(j2k.browserDecodable, false, "JPEG 2000 tarayıcıda çözülmez");
  assert.match(j2k.note, /codec köprüsü gerekir/, "dürüst uyarı");
  const jpeg = transferSyntaxHint("1.2.840.10008.1.2.4.50");
  assert.equal(jpeg.browserDecodable, true, "JPEG baseline tarayıcıda çözülür");
  const rle = transferSyntaxHint("1.2.840.10008.1.2.5");
  assert.equal(rle.browserDecodable, false, "RLE tarayıcıda çözülmez");
  const unknown = transferSyntaxHint("1.2.3.4.5");
  assert.equal(unknown.browserDecodable, false, "bilinmeyen sözdizimi için çözüm denenmez");
  assert.match(unknown.note, /tanınmadı/, "gerekçe");
  assert.match(transferSyntaxHint(undefined).note, /metadata'da yok/, "eksik sözdizimi bildirilir");
  console.log("PASS aktarım sözdizimi / codec");

  // ── 5) Kare boyutu ──────────────────────────────────────────────────
  assert.equal(expectedFrameBytes(512, 512, 1, 16), 524288, "512×512×2 bayt");
  assert.equal(expectedFrameBytes(512, 512, 1, 8), 262144, "8-bit");
  assert.equal(expectedFrameBytes(64, 32, 3, 8), 6144, "RGB");
  assert.equal(expectedFrameBytes(100, 100, 1, 1), 1250, "1-bit");
  assert.equal(expectedFrameBytes(0, 0, 0, 0), 0, "eksik boyut → 0 (uydurma yok)");
  assert.equal(expectedFrameBytes(10, 10, 0, 12), 200, "12-bit → 2 bayt, örnek en az 1");
  console.log("PASS kare boyutu");

  // ── 6) Kare indirme planı ───────────────────────────────────────────
  const plan = planFrameFetch(
    {
      "7FE00010": { vr: "OB", BulkDataURI: "https://pacs.hastane.local/dicomweb/studies/1/bulk/7FE00010#frame 2" },
      // 7FE00009 (Float Pixel Data) piksel sayılır; 60003000 (gömülü belge) sayılmaz.
      "7FE00009": { vr: "OW", BulkDataURI: "https://pacs.hastane.local/dicomweb/studies/1/bulk/7FE00009#frame 9" },
      "00080018": { vr: "UI", Value: ["1.2.3"] },
    },
    PACS,
    { frames: [2, 3], transferSyntaxUid: "1.2.840.10008.1.2.4.90" },
  );
  assert.equal(plan.urls.length, 1, "yalnız istenen kare planda");
  assert.equal(plan.urls[0].frame, 2, "istenen kare 2");
  assert.equal(plan.skipped.length, 1, "kare 9 atlandı");
  assert.match(plan.skipped[0].reason, /kare 9 istenmedi/, "atlama gerekçesi");
  assert.equal(plan.hint.browserDecodable, false, "codec uyarısı planda");
  assert.match(plan.note, /1 bulk adresi planlandı/, "özet");
  assert.equal(plan.mixedSyntax, false, "tek VR");

  const dup = planFrameFetch(
    {
      "7FE00010": { vr: "OW", BulkDataURI: "/dicomweb/studies/1/bulk/7FE00010" },
      "60003000": { vr: "OW", BulkDataURI: "https://pacs.hastane.local/dicomweb/studies/1/bulk/7FE00010" },
    },
    PACS,
  );
  assert.equal(dup.urls.length, 1, "aynı adres tekilleştirildi");

  const mixed = planFrameFetch(
    { "7FE00010": { vr: "OW", BulkDataURI: "/a" }, "7FE00009": { vr: "OB", BulkDataURI: "/b" } },
    PACS,
  );
  assert.equal(mixed.mixedSyntax, true, "farklı VR → mixedSyntax");

  const blocked = planFrameFetch({ "7FE00010": { vr: "OW", BulkDataURI: "http://evil.example/x" } }, PACS);
  assert.equal(blocked.urls.length, 0, "dış adres plana girmez");
  assert.match(blocked.skipped[0].reason, /PACS dışına/, "gerekçe");

  const empty = planFrameFetch({ "00080018": { vr: "UI", Value: ["1"] } }, PACS);
  assert.equal(empty.urls.length, 0, "bulk yok");
  assert.match(empty.note, /bulk piksel adresi yok/, "dürüst mesaj");
  console.log("PASS kare indirme planı");

  // ── 7) Uç ve istemci sözleşmesi ─────────────────────────────────────
  const route = read("src/app/api/pacs/[action]/route.ts");
  assert.ok(route.includes('action === "bulkdata"') && route.includes("fetchBulk"), "bulkdata ucu");
  assert.ok(route.includes('action === "frameplan"') && route.includes("planFrameFetch"), "frameplan ucu");
  assert.ok(route.includes("pacs.retrieve_bulk") && route.includes("pacs.frameplan"), "denetim kayıtları");
  const pacs = read("src/lib/server/pacs.ts");
  assert.ok(pacs.includes("export async function fetchBulk") && pacs.includes("resolveBulkUrl"), "sunucu bulk getirme + SSRF kapısı");
  assert.ok(pacs.includes("export async function wadoMetadata") && pacs.includes("firstTransferSyntax"), "metadata okuyucu");
  const client = read("src/lib/wadoClient.ts");
  assert.ok(client.includes("fetchFramesViaBulk") && client.includes("/api/pacs/frameplan"), "istemci bulk yolu");
  const gap = read("src/lib/gapAnalysis.ts");
  assert.ok(/id: "e-wado-frame"[\s\S]{0,2600}Bu sürümde eklendi/.test(gap), "gap kaydı güncel");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:bulkdata"]?.includes("bulkdata"), "test betiği");
  console.log("PASS uç/istemci sözleşmesi");

  console.log("Tüm e-wado-frame (bulk/kare) testleri geçti.");
}

main();
