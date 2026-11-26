/**
 * Piksel çözme Web Worker'ı testleri (v-perf).
 *
 * Worker kaynağı `node:vm` içinde sahte `self` ile çalıştırılır ve TS referansı
 * (`decodeGrayNative`) ile **bit eşdeğerliği** karşılaştırılır. Ayrıca bağımsız
 * üçüncü bir referans uygulama (test içinde yazılmış düz hesap) kullanılarak
 * ortak sistemik hataya karşı koruma sağlanır: endian, Bits Stored maskesi,
 * işaret, slope/intercept ve paketleme kuralları.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { decodeGrayNative, packFloatLike, type GrayNativeParams } from "../src/lib/pixelDecode";
import {
  PIXEL_WORKER_SOURCE, decodeGrayNativeAsync, disposePixelWorker, pixelWorkerActive,
  resetPixelWorkerForTests,
} from "../src/lib/pixelWorker";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

interface WorkerOut { id: number; kind?: "i16" | "u16" | "f32"; buffer?: ArrayBuffer; outOfRange?: boolean; error?: string }

/** Worker kaynağını sahte `self` ile çalıştırır (senkron istek/yanıt). */
function runWorker(bytes: Uint8Array, offset: number, params: GrayNativeParams): WorkerOut {
  let captured: unknown = null;
  const sandbox: Record<string, unknown> = {
    self: {
      onmessage: null as null | ((e: { data: unknown }) => void),
      postMessage: (msg: unknown) => { captured = msg; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PIXEL_WORKER_SOURCE, sandbox);
  const self = sandbox.self as { onmessage: (e: { data: unknown }) => void };
  self.onmessage({ data: { id: 42, bytes, offset, params } });
  assert.ok(captured, "worker yanıt üretmeli");
  return captured as WorkerOut;
}

const wrap = (out: WorkerOut) => {
  // Not: sahte worker'da transfer kopyalama yapılmaz; tampon doğrudan okunur.
  if (out.kind === "i16") return new Int16Array(out.buffer!);
  if (out.kind === "u16") return new Uint16Array(out.buffer!);
  return new Float32Array(out.buffer!);
};

async function main() {
// ─────────── veri üretimi ───────────
let seed = 20260101;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function makeBytes(n: number, big: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * big);
  return b;
}

const base = { rows: 8, cols: 8, bitsAllocated: 16, bitsStored: 16, pixelRep: 1, bigEndian: false, slope: 1, intercept: 0 };
const cases: { name: string; params: GrayNativeParams; bytes: Uint8Array; offset: number }[] = [
  { name: "16 bit işaretli (slope 1, intercept 0)", params: { ...base }, bytes: makeBytes(256, 256), offset: 0 },
  { name: "16 bit işaretsiz, Bits Stored 12", params: { ...base, bitsStored: 12, pixelRep: 0, intercept: -1024 }, bytes: makeBytes(256, 256), offset: 0 },
  { name: "16 bit işaretli, Bits Stored 12 (maske+işaret)", params: { ...base, bitsStored: 12 }, bytes: makeBytes(256, 256), offset: 0 },
  { name: "big endian 16 bit", params: { ...base, bigEndian: true }, bytes: makeBytes(256, 256), offset: 0 },
  { name: "kesirli slope → Float32 çıkış", params: { ...base, slope: 1.5, intercept: -37.25, pixelRep: 0 }, bytes: makeBytes(256, 256), offset: 0 },
  { name: "8 bit gri", params: { ...base, bitsAllocated: 8, bitsStored: 8, pixelRep: 0, slope: 2, intercept: 5 }, bytes: makeBytes(64, 256), offset: 0 },
];

for (const c of cases) {
  const ref = decodeGrayNative(c.bytes, c.offset, c.params);
  const out = runWorker(c.bytes, c.offset, c.params);
  ok(!!ref && out.kind === ref.kind, `${c.name}: tip eşleşti (${out.kind})`);
  if (ref && out.kind) {
    const w = wrap(out);
    ok(w.length === ref.pixels.length && w.every((v, i) => Object.is(v, ref.pixels[i])),
      `${c.name}: ${ref.pixels.length} örnekte bit eşdeğeri`);
  }
}

// offset ile okuma (çerçeve ortasından) aynı sonucu vermeli
{
  const big = makeBytes(1024, 256);
  const params: GrayNativeParams = { ...base, bitsStored: 12, pixelRep: 0 };
  const off = 128;
  const ref = decodeGrayNative(big, off, params)!;
  const out = runWorker(big, off, params);
  const w = wrap(out);
  ok(w.every((v, i) => v === ref.pixels[i]), "offset'li okuma aynı sonucu veriyor");
}

// aralık dışı çerçeve → outOfRange (sessiz bozulma yok)
{
  const out = runWorker(new Uint8Array(32), 0, { ...base, rows: 8, cols: 8 });
  ok(out.outOfRange === true, "aralık dışı çerçeve outOfRange ile reddedilir");
}

// hatalı Bits Allocated → reddedilir
{
  const out = runWorker(new Uint8Array(256), 0, { ...base, bitsAllocated: 12 });
  ok(out.outOfRange === true, "12 bit piksel bu yolda reddedilir (desteklenmiyor)");
}

// ─────────── bağımsız üçüncü referans ───────────
{
  const rows = 4, cols = 5, n = rows * cols;
  const raw = new Int16Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.round((rnd() - 0.5) * 3000);
  const bytes = new Uint8Array(raw.buffer.slice(0));
  const slope = 2, intercept = -1000;
  const expected = new Float32Array(n);
  for (let i = 0; i < n; i++) expected[i] = raw[i] * slope + intercept;
  const got = decodeGrayNative(bytes, 0, { rows, cols, bitsAllocated: 16, bitsStored: 16, pixelRep: 1, bigEndian: false, slope, intercept })!;
  ok(got.pixels.every((v, i) => v === expected[i]), "düz hesap referansıyla aynı (slope 2, intercept −1000)");
  // Paketleme kuralı: Int16 aralığında Int16 kalır
  ok(got.kind === "i16", `Int16 aralığında tip Int16 (${got.kind})`);
}

// paketleme kuralları tek başına
{
  const over = new Float32Array([40000, 50000]);
  ok(packFloatLike(over).kind === "u16", "0…65535 aralığında Uint16");
  const neg = new Float32Array([-40000, 0]);
  ok(packFloatLike(neg).kind === "f32", "Int16 altına inen değer Float32'ye düşer");
  const frac = new Float32Array([1.5, 2]);
  ok(packFloatLike(frac).kind === "f32", "kesirli değer Float32'ye düşer");
}

// ─────────── yedek yol (Node: Worker yok) ───────────
resetPixelWorkerForTests();
ok(!pixelWorkerActive(), "Node ortamında worker kurulmaz");
{
  const bytes = makeBytes(64, 256);
  const params: GrayNativeParams = { ...base, bitsAllocated: 8, bitsStored: 8, pixelRep: 0 };
  const res = await decodeGrayNativeAsync(bytes, 0, params);
  ok(res === null, "worker yoksa async köprü null döner (eşzamanlı yola düşülür)");
  const sync = decodeGrayNative(bytes, 0, params)!;
  ok(sync.pixels.length === 64, "eşzamanlı yol çalışıyor");
}
disposePixelWorker();
ok(!pixelWorkerActive(), "dispose worker'ı bırakır");

// kaynak sözleşmesi
ok(PIXEL_WORKER_SOURCE.includes("onmessage") && PIXEL_WORKER_SOURCE.includes("Float32Array"), "worker kaynağı çözme mantığını içerir");
ok(!PIXEL_WORKER_SOURCE.includes("import "), "worker kaynağı kendi kendine yeterli");



}

main().then(() => {
  if (failed) { console.error(`${failed} piksel worker testi başarısız`); process.exit(1); }
  console.log("Tüm piksel çözme (Web Worker) testleri geçti.");
}).catch((e) => { console.error(e); process.exit(1); });
