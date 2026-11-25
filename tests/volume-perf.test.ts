/**
 * v-perf: büyük çalışma performansı testleri.
 *
 * Saf çekirdek (`volumePerf`) doğruluk + bellek + kademeli pencere açısından,
 * worker istemcisi sahte bir `Worker` ile protokol (aktarım, iptal, hata
 * düşüşü) açısından sınanır. GPU yolu Node'da çalışmadığı için shader/LUT
 * formüllerinin CPU referansıyla **birebir** eşleştiği doğrulanır.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canTransfer,
  ChunkedVolume,
  copyBytes,
  formatBytes,
  planMemory,
  prefetchOrder,
  SliceWindowCache,
  textureSize,
  transcodeSlices,
  volumeBytes,
  type SliceArray,
} from "../src/lib/volumePerf";
import { buildLutTexture, lutIndex, textureFormat, WINDOW_SHADERS } from "../src/lib/webglWindow";
import { windowSync, WindowWorkerClient, kindOf } from "../src/lib/windowWorkerClient";
import { buildWindowLUT, windowToRGBA } from "../src/lib/window";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function volume(n: number, len: number, gen: (i: number) => number, Type: Int16ArrayConstructor | Float32ArrayConstructor = Float32Array): SliceArray[] {
  return Array.from({ length: n }, () => {
    const a = new Type(len);
    for (let i = 0; i < len; i++) a[i] = gen(i);
    return a as SliceArray;
  });
}

async function main() {
  // ── 1) Transcode: kayıpsız küçültme ────────────────────────────────────
  const floatVol = volume(20, 1024, (i) => ((i * 37) % 4096) - 1024);
  assert.equal(volumeBytes(floatVol), 20 * 1024 * 4, "Float32 başlangıç belleği");
  const { slices, stats } = transcodeSlices(floatVol);
  assert.equal(stats.kind, "int16", "tamsayı ±32767 aralığı → Int16");
  assert.equal(stats.afterBytes, 20 * 1024 * 2, "bellek yarıya iner");
  assert.equal(stats.ratio, 0.5, "oran 0.5");
  assert.equal(stats.lossless, true, "kayıpsız");
  for (let k = 0; k < floatVol.length; k++) {
    assert.ok(slices[k] instanceof Int16Array, "çıktı türü Int16Array");
    assert.deepEqual(Array.from(slices[k] as Int16Array), Array.from(floatVol[k] as Float32Array), "değerler birebir korunur");
  }
  // Kesirli değerler → Float32 korunur (kayıp yok).
  const frac = transcodeSlices(volume(3, 16, (i) => i * 0.5));
  assert.equal(frac.stats.kind, "float32", "kesirli değerler Float32'de kalır");
  assert.equal(frac.stats.ratio, 1, "kazanç yok");
  assert.equal(typeof (frac.slices[0] as Float32Array)[1], "number", "dizi kullanılabilir");
  // 0–65535 → Uint16 (Int16 aralığını aşar).
  const big = transcodeSlices(volume(2, 8, (i) => 40000 + i));
  assert.equal(big.stats.kind, "uint16", "40000 → Uint16");
  assert.ok(big.slices[0] instanceof Uint16Array, "Uint16Array");
  assert.deepEqual(Array.from(big.slices[0] as Uint16Array), [40000, 40001, 40002, 40003, 40004, 40005, 40006, 40007], "büyük değerler korunur");
  // Zaten doğru türdeyse yeniden kopyalanmaz (referans aynı).
  const already = volume(2, 4, (i) => i, Int16Array);
  const same = transcodeSlices(already);
  assert.equal(same.slices[0], already[0], "uygun türde kopya yok (zero-copy)");
  // Boş hacim
  const empty = transcodeSlices([]);
  assert.equal(empty.stats.afterBytes, 0, "boş hacim güvenli");
  assert.equal(empty.stats.ratio, 1, "boş hacimde oran 1");
  console.log("PASS kayıpsız transcode (Float32 → Int16/Uint16, %50 bellek)");

  // ── 2) Bellek planı ve okunur boyut ───────────────────────────────────
  assert.equal(formatBytes(0), "1 KB", "çok küçük değer 1 KB");
  assert.equal(formatBytes(1024 ** 2), "1 MB", "MB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1,5 GB", "GB ve Türkçe ondalık");
  const kucuk = planMemory(100, 512 * 512, 2);
  assert.equal(kucuk.fits, true, "100 kesit sığar");
  assert.ok(kucuk.cacheSlices <= 100, "pencere hacimden büyük değil");
  const buyuk = planMemory(2000, 512 * 512, 4, 1024 ** 3);
  assert.equal(buyuk.fits, false, "2000 kesit bütçeyi aşar");
  assert.match(buyuk.advice, /istek üzerine/, "kademeli yükleme önerilir");
  assert.ok(buyuk.cacheSlices >= 3, "en az 3 kesit tutulur");
  assert.equal(planMemory(0, 512, 2).bytes, 0, "boş çalışma 0 bayt");
  console.log("PASS bellek planı (bütçe + pencere önerisi)");

  // ── 3) Kademeli pencere sırası ────────────────────────────────────────
  assert.deepEqual(prefetchOrder(0, 10, 2), [0, 1, 2], "alt sınırda geri yok");
  assert.deepEqual(prefetchOrder(9, 10, 2), [9, 8, 7], "üst sınırda ileri yok");
  assert.deepEqual(prefetchOrder(5, 10, 2), [5, 6, 4, 7, 3], "önce ileri, sonra geri");
  assert.deepEqual(prefetchOrder(5, 10, 0), [5], "yarıçap 0");
  assert.deepEqual(prefetchOrder(3, 0, 2), [], "boş hacim");
  assert.deepEqual(prefetchOrder(50, 10, 1), [9, 8], "sınır dışı istek kırpılır");
  console.log("PASS kademeli pencere sırası (ileri öncelikli)");

  // ── 4) Pencere önbelleği (LRU + trim) ─────────────────────────────────
  const cache = new SliceWindowCache<number>(3);
  cache.set(1, 11); cache.set(2, 22); cache.set(3, 33);
  assert.equal(cache.size, 3, "üç kesit");
  cache.get(1); // tazele
  cache.set(4, 44);
  assert.equal(cache.size, 3, "sınır korunur");
  assert.ok(cache.has(1) && !cache.has(2), "en eski (2) düştü, tazelenen (1) kaldı");
  const removed = cache.trimTo([4]);
  assert.deepEqual(removed.sort(), [1, 3], "pencere dışı atılır");
  assert.equal(cache.size, 1, "yalnız pencere kaldı");
  cache.clear();
  assert.equal(cache.size, 0, "temizleme");
  console.log("PASS kesit penceresi (LRU + pencere dışı atma)");

  // ── 5) Parçalı hacim çözücü ───────────────────────────────────────────
  let decodedSlices = 0;
  const cv = new ChunkedVolume<number>(100, 16, (from, to) => {
    decodedSlices += to - from;
    return Array.from({ length: to - from }, (_, i) => from + i);
  });
  assert.equal(cv.chunkCount, 7, "100 kesit / 16 → 7 parça");
  assert.equal(cv.get(0), 0, "ilk kesit");
  assert.equal(decodedSlices, 16, "yalnız ilk parça çözüldü");
  assert.equal(cv.get(5), 5, "aynı parçadan kesit");
  assert.equal(decodedSlices, 16, "önbellekten geldi (yeniden çözülmedi)");
  assert.equal(cv.get(99), 99, "son kesit");
  assert.equal(decodedSlices, 16 + 4, "son parça 4 kesit (100-96)");
  assert.equal(cv.statistics.resolved, 2, "iki parça çözüldü");
  assert.equal(cv.statistics.hits, 1, "bir önbellek isabeti");
  assert.equal(cv.get(-1), undefined, "negatif indeks");
  assert.equal(cv.get(100), undefined, "sınır dışı indeks");
  // Kademeli ön getirme: 3 parçayı ısıtır, fazlası atılır.
  cv.prefetch(prefetchOrder(48, 100, 2));
  assert.ok(cv.loadedChunks >= 3, "pencere parçaları yüklendi");
  const atilan = cv.trimChunks(2);
  assert.ok(atilan >= 1, "fazla parça atıldı");
  assert.ok(cv.loadedChunks <= 2, "bellek sınırı");
  cv.resetStats();
  assert.equal(cv.statistics.resolved, 0, "istatistik sıfırlanır");
  console.log("PASS parçalı hacim çözücü (kademeli + bellek sınırı)");

  // ── 6) Aktarım ve GPU boyut kuralları ─────────────────────────────────
  assert.equal(canTransfer(new ArrayBuffer(8)), true, "normal tampon aktarılabilir");
  assert.equal(canTransfer(new ArrayBuffer(0)), false, "boş tampon aktarılmaz");
  assert.equal(canTransfer(null), false, "boş değer");
  if (typeof SharedArrayBuffer !== "undefined") {
    assert.equal(canTransfer(new SharedArrayBuffer(8)), false, "paylaşılan tampon aktarılmaz");
    assert.equal(copyBytes(new SharedArrayBuffer(16)), 16, "paylaşılan için kopya maliyeti");
  }
  assert.equal(copyBytes(new ArrayBuffer(16)), 0, "aktarılabilir için kopya yok");
  assert.deepEqual(textureSize(512, 512), { width: 512, height: 512, scaled: false }, "küçük görüntü aynı");
  const scaled = textureSize(20000, 5000, 16384);
  assert.equal(scaled.scaled, true, "sınır aşılınca ölçeklenir");
  assert.equal(Math.max(scaled.width, scaled.height), 16384, "büyük kenar sınıra çekilir");
  assert.deepEqual(textureSize(0, 10), { width: 0, height: 0, scaled: false }, "geçersiz boyut");
  console.log("PASS aktarım ve doku boyutu kuralları");

  // ── 7) GPU yolu: biçim, LUT ve shader ↔ CPU eşleşmesi ─────────────────
  assert.equal(textureFormat("int16").name, "R16I", "Int16 → R16I (tam sayı doku)");
  assert.equal(textureFormat("uint16").name, "R16UI", "Uint16 → R16UI");
  assert.equal(textureFormat("float32").name, "R32F", "Float32 → R32F");
  assert.notEqual(textureFormat("int16").internal, textureFormat("uint16").internal, "işaretli/işaretsiz ayrı biçim");
  const lutTex = buildLutTexture(false);
  assert.equal(lutTex.length, 1024, "256×1 RGBA LUT");
  assert.deepEqual([lutTex[0], lutTex[1], lutTex[2], lutTex[3]], [0, 0, 0, 255], "siyah uç");
  assert.deepEqual([lutTex[255 * 4], lutTex[255 * 4 + 1], lutTex[255 * 4 + 2], lutTex[255 * 4 + 3]], [255, 255, 255, 255], "beyaz uç");
  const inv = buildLutTexture(true);
  assert.equal(inv[0], 255, "ters çevirmede 0 → beyaz");
  assert.equal(inv[255 * 4], 0, "ters çevirmede 255 → siyah");

  // Shader'daki formül `lutIndex` ile aynı olmalı; `lutIndex` de CPU LUT ile
  // aynı gri seviyeyi (±1) vermeli.
  const wl = 40, ww = 400;
  const cpuLut = buildWindowLUT(wl, ww, false);
  for (const v of [-500, -160, 0, 40, 239, 240, 1000, 5000]) {
    const idx = lutIndex(v, wl, ww);
    const cpu = windowToRGBA(Float32Array.of(v), cpuLut.lut, cpuLut.lo)[0] & 0xff;
    assert.ok(Math.abs(idx - cpu) <= 1, `değer ${v}: GPU indeksi ${idx}, CPU ${cpu}`);
  }
  assert.equal(lutIndex(-9999, wl, ww), 0, "alt sınır kenetlenir");
  assert.equal(lutIndex(9999, wl, ww), 255, "üst sınır kenetlenir");
  // Shader kaynakları: tam sayı dokusu için R16I/R16UI'ya uygun `int` okuma.
  assert.match(WINDOW_SHADERS.FRAG_INT, /texelFetch\(u_img/, "shader texelFetch kullanır (yumuşatma yok)");
  assert.match(WINDOW_SHADERS.FRAG_INT, /int v = int\(/, "tam sayı yolu int okur");
  assert.match(WINDOW_SHADERS.FRAG_FLOAT, /float v = texelFetch/, "float yolu float okur");
  for (const frag of [WINDOW_SHADERS.FRAG_INT, WINDOW_SHADERS.FRAG_FLOAT]) {
    assert.match(frag, /u_lo/, "pencere alt sınırı uniform");
    assert.match(frag, /u_span/, "pencere genişliği uniform");
    assert.match(frag, /texelFetch\(u_lut/, "LUT dokusundan renk");
  }
  console.log("PASS GPU yolu (biçim + LUT + shader/CPU eşleşmesi)");

  // ── 8) Worker istemcisi protokolü ─────────────────────────────────────
  assert.equal(kindOf(new Int16Array(1)), "int16", "tür → int16");
  assert.equal(kindOf(new Uint16Array(1)), "uint16", "tür → uint16");
  assert.equal(kindOf(new Float32Array(1)), "float32", "tür → float32");

  const sync = windowSync({ pixels: Int16Array.of(-100, 0, 100), wl: 0, ww: 200, invert: false });
  assert.equal(sync.viaWorker, false, "yedek yol worker kullanmaz");
  assert.equal(sync.pixels.length, 3, "üç piksel");
  assert.equal(sync.pixels[0] & 0xff, 0, "alt değer siyah");
  assert.equal(sync.pixels[2] & 0xff, 255, "üst değer beyaz");
  assert.ok(sync.ms >= 0, "süre ölçülür");

  // Sahte worker: mesajı alır, aktarılan tamponu işler, yanıtı aktarır.
  const sent: { id: number; src: ArrayBuffer; wl: number; ww: number }[] = [];
  const cancelled: number[] = [];
  const fakeWorker = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    postMessage(msg: { type: string; id: number; src?: ArrayBuffer; kind?: string; wl?: number; ww?: number; invert?: boolean }, transfer?: Transferable[]) {
      if (msg.type === "cancel") { cancelled.push(msg.id); return; }
      sent.push({ id: msg.id, src: msg.src!, wl: msg.wl!, ww: msg.ww! });
      assert.equal(transfer?.length, 1, "tampon aktarılır (zero-copy)");
      const out = windowSync({ pixels: new Int16Array(msg.src!), wl: msg.wl!, ww: msg.ww!, invert: !!msg.invert });
      setTimeout(() => this.onmessage?.({ data: { type: "done", id: msg.id, pixels: out.pixels.buffer, ms: 0.5 } } as MessageEvent), 0);
    },
    terminate() { /* test */ },
  };
  (globalThis as unknown as { window: unknown }).window = {};
  const client = new WindowWorkerClient(() => fakeWorker as unknown as Worker);
  const results = await Promise.all([
    client.window({ pixels: Int16Array.of(-100, 0, 100), wl: 0, ww: 200, invert: false }),
    client.window({ pixels: Int16Array.of(50, 60), wl: 0, ww: 200, invert: false }),
  ]);
  assert.equal(results[0].viaWorker, true, "sonuç worker'dan");
  assert.equal(results[0].pixels.length, 3, "piksel sayısı korunur");
  assert.equal(results[0].pixels[2] & 0xff, 255, "worker çıktısı doğru");
  assert.equal(results[1].pixels.length, 2, "ikinci istek de tamamlanır");
  assert.ok(cancelled.length >= 1, "yeni istekte önceki iptal edilir (sürükleme)");
  assert.equal(sent.length, 2, "iki istek gönderildi");
  client.terminate();
  // Worker oluşturulamazsa eşzamanlı yola düşer.
  const broken = new WindowWorkerClient(() => { throw new Error("worker yok"); });
  const fallback = await broken.window({ pixels: Int16Array.of(0, 100), wl: 0, ww: 200, invert: false });
  assert.equal(fallback.viaWorker, false, "worker yoksa eşzamanlı yedek");
  assert.equal(fallback.pixels.length, 2, "yedek yol çalışır");
  delete (globalThis as unknown as { window?: unknown }).window;
  console.log("PASS worker istemcisi (aktarım + iptal + yedek yol)");

  // ── 9) Kaynak sözleşmesi ──────────────────────────────────────────────
  const viewport = read("src/components/Viewport.tsx");
  assert.ok(viewport.includes("WindowWorkerClient"), "Viewport worker'ı kullanır");
  assert.ok(viewport.includes("webglWindowCanvas") && viewport.includes("webglEnabled"), "Viewport GPU yolunu dener");
  assert.ok(viewport.includes("prepared"), "hazır worker tamponu çizime girer");
  assert.ok(viewport.includes("trimBaseCache"), "taban katmanı önbelleği sınırlı");
  const dicom = read("src/lib/dicom.ts");
  assert.ok(dicom.includes("packPixels"), "DICOM okuma tamsayı türlerinde saklar (Int16/Uint16)");
  const worker = read("src/workers/windowWorker.ts");
  assert.ok(worker.includes("postMessage") && worker.includes("[out.buffer]"), "worker sonucu aktarır");
  assert.ok(worker.includes("cancel"), "worker iptal mesajını tanır");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["test:volumeperf"]?.includes("volume-perf"), "test betiği kayıtlı");
  assert.ok(pkg.scripts["bench:volume"]?.includes("volume-bench"), "ölçüm betiği kayıtlı");
  console.log("PASS kaynak sözleşmesi (worker + GPU + tamsayı saklama)");

  console.log("Tüm v-perf (büyük çalışma performansı) testleri geçti.");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
