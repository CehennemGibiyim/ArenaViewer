/**
 * e-wado-frame: kare düzeyinde (frame-level) WADO-RS getirme testleri.
 * Sahte DICOMweb sunucusuna karşı gerçek HTTP ile çalışır.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { parseAllMultipart, wadoFrames, wadoInstance } from "../src/lib/server/pacs";

let ROOT = "";
type Cfg = Parameters<typeof wadoFrames>[0];
const cfg = (over: Partial<Cfg> = {}): Cfg =>
  ({
    kind: "generic",
    name: "mock",
    qidoRoot: ROOT,
    wadoRoot: "",
    auth: { type: "basic", username: "atik", password: "atik123", token: "", headerName: "", headerValue: "" },
    allowSelfSigned: false,
    limit: 50,
    includefield: true,
    notes: "",
    ...over,
  }) as Cfg;

async function waitForReady(child: ChildProcess, ms = 8000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock PACS hazır olmadı")), ms);
    child.stdout?.on("data", (b: Buffer) => {
      const m = /mock-pacs-ready (\d+)/.exec(b.toString());
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(t); reject(new Error("mock PACS erken kapandı")); });
  });
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, "mockPacsServer.cjs"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(b));
  const port = await waitForReady(child);
  ROOT = `http://127.0.0.1:${port}/dicom-web`;

  const ref = { studyUid: "1.2.3.4.5", seriesUid: "1.2.3.4.5.1", sopUid: "1.2.3.4.5.1.1" };

  try {
    // 1) Tek kare
    const one = await wadoFrames(cfg(), ref, [1]);
    assert.equal(one.length, 1, "tek kare beklenir");
    assert.equal(Buffer.from(one[0]).toString("latin1"), "FRAME-1-PAYLOAD", "kare içeriği doğru");
    console.log("PASS tek kare getirme");

    // 2) Çoklu kare sırası korunur
    const three = await wadoFrames(cfg(), ref, [1, 2, 3]);
    assert.deepEqual(three.map((b) => Buffer.from(b).toString("latin1")), ["FRAME-1-PAYLOAD", "FRAME-2-PAYLOAD", "FRAME-3-PAYLOAD"], "kare sırası korunur");
    console.log("PASS çoklu kare (1,2,3) sıralı");

    // 3) Tekrarlanan/geçersiz numaralar temizlenir
    const dedup = await wadoFrames(cfg(), ref, [2, 2, 0, -1, 1.5]);
    assert.equal(dedup.length, 1, "tekilleştirme ve geçersiz ayıklama");
    console.log("PASS tekrarlanan/geçersiz kare numarası ayıklanır");

    // 4) Geçersiz istek
    await assert.rejects(() => wadoFrames(cfg(), ref, []), /Geçersiz kare/, "boş liste reddedilir");
    console.log("PASS boş kare listesi reddedilir");

    // 5) Kimlik hatası ayırt edilebilir
    await assert.rejects(
      () => wadoFrames(cfg({ auth: { type: "none", username: "", password: "", token: "", headerName: "", headerValue: "" } }), ref, [1]),
      /401/,
      "401 mesajı kimlik doğrulamayı işaret eder",
    );
    console.log("PASS 401 → kimlik hatası");

    // 6) Yol hatası
    await assert.rejects(() => wadoFrames(cfg({ qidoRoot: `${new URL(ROOT).origin}/yanlis` }), ref, [1]), /404/, "404 bildirilir");
    console.log("PASS 404 → yol hatası");

    // 7) Instance getirme hâlâ çalışıyor (geriye dönük uyum)
    const inst = await wadoInstance(cfg(), ref.studyUid, ref.seriesUid, ref.sopUid);
    assert.equal(Buffer.from(inst.slice(128, 132)).toString("latin1"), "DICM", "instance DICM imzalı");
    console.log("PASS instance getirme bozulmadı");

    // 8) multipart ayrıştırıcı: tek parça/çok parça/bozuk
    const bnd = "X1";
    const body = Buffer.from(`--${bnd}\r\nContent-Type: a\r\n\r\nAAA\r\n--${bnd}\r\nContent-Type: a\r\n\r\nBBB\r\n--${bnd}--\r\n`, "latin1");
    const parts = parseAllMultipart(new Uint8Array(body), `multipart/related; boundary="${bnd}"`);
    assert.deepEqual(parts.map((p) => Buffer.from(p).toString("latin1")), ["AAA", "BBB"], "multipart tüm parçalar (CRLF ayıklanır)");
    assert.equal(parseAllMultipart(new Uint8Array(body), "application/octet-stream").length, 0, "boundary yoksa boş");
    console.log("PASS multipart ayrıştırma (çok parça + boundary yok)");
  } finally {
    child.kill();
  }

  // 9) İstemci önbelleği ve kademeli getirme (saf fonksiyonlar)
  const { FrameCache, chunkFrames, prefetchWindow, FRAME_CACHE_MAX } = await import("../src/lib/wadoClient");
  const k = { studyUid: "1.2.3", seriesUid: "1.2.3.1", sopUid: "1.2.3.1.1" };
  const cache = new FrameCache(3);
  cache.set(k, 1, new Uint8Array([1]));
  cache.set(k, 2, new Uint8Array([2]));
  assert.ok(cache.has(k, 1) && cache.size === 2, "önbelleğe yazma");
  cache.get(k, 1); // 1'i tazele
  cache.set(k, 3, new Uint8Array([3]));
  cache.set(k, 4, new Uint8Array([4]));
  assert.equal(cache.size, 3, "LRU sınırı korunur");
  assert.ok(cache.has(k, 1) && !cache.has(k, 2), "en eski (2) düşer, tazelenen (1) kalır");
  cache.clear();
  assert.equal(cache.size, 0, "temizleme");
  assert.equal(FRAME_CACHE_MAX, 240, "varsayılan önbellek sınırı");
  assert.deepEqual(chunkFrames([1, 2, 3, 2, 0, -1], 2), [[1, 2], [3]], "grup: tekilleştir + sırala");
  assert.deepEqual(prefetchWindow(1, 5, 2), [1, 2, 3], "pencere alt sınırda kesilir");
  assert.deepEqual(prefetchWindow(5, 5, 2), [3, 4, 5], "pencere üst sınırda kesilir");
  assert.deepEqual(prefetchWindow(3, 10, 1), [2, 3, 4], "pencere ±1");
  console.log("PASS istemci kare önbelleği + kademeli ön getirme");

  // 10) Uç: frames yolu + denetim
  const fsMod = await import("node:fs");
  const routeSrc = fsMod.readFileSync(path.join(__dirname, "..", "src/app/api/pacs/[action]/route.ts"), "utf8");
  assert.ok(routeSrc.includes('action === "frames"'), "uç kare yolunu ayırıyor");
  assert.ok(routeSrc.includes("wadoFrames") && routeSrc.includes("pacs.retrieve_frames"), "kare getirme denetime yazılıyor");
  assert.ok(routeSrc.includes('sp.get("raw")'), "tek kare doğrudan ikili yanıt");
  console.log("PASS uç sözleşmesi (frames + raw + denetim)");

  console.log("Tüm e-wado-frame (kare düzeyinde getirme) testleri geçti.");
}

main().catch((e) => { console.error("FAIL", e instanceof Error ? e.message : e); process.exit(1); });
