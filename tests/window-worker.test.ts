/**
 * Web Worker pencereleme köprüsü testleri (v-perf).
 *
 * Anahtar nokta: worker kaynağı (metin) ile ana iş parçacığındaki `windowToRGBA`
 * arasındaki **bit eşdeğerliği**. Worker kaynağı `node:vm` içinde sahte `self` ile
 * çalıştırılır; böylece tarayıcı olmadan gerçek ayrışma yakalanır. Worker yoksa
 * köprünün `null` döndüğü (yedeğe düşüldüğü) de doğrulanır.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildWindowLUT, windowToRGBA, GRAY_PALETTE } from "../src/lib/window";
import {
  WINDOW_WORKER_SOURCE, disposeWindowWorker, grayPaletteValue, resetWindowWorkerForTests,
  windowSliceAsync, windowSliceSync, windowWorkerActive,
} from "../src/lib/windowWorker";

async function main() {
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

/** Worker kaynağını sahte `self` ile çalıştırıp istek/yanıt döngüsünü taklit eder. */
function runWorkerSource(message: { id: number; pixels: Int16Array | Float32Array; lut: Uint8ClampedArray; lo: number }): Uint32Array {
  let captured: unknown = null;
  const sandbox: Record<string, unknown> = {
    self: {
      onmessage: null as null | ((e: { data: unknown }) => void),
      postMessage: (msg: unknown) => { captured = msg; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(WINDOW_WORKER_SOURCE, sandbox);
  const self = sandbox.self as { onmessage: (e: { data: unknown }) => void };
  self.onmessage({ data: message });
  const out = (captured as { id: number; out: Uint32Array } | null);
  assert.ok(out, "worker yanıt üretmeli");
  assert.equal(out!.id, message.id, "yanıt kimliği eşleşmeli");
  return out!.out;
}

// ── veri üretimi ──
let seed = 1234;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const int16 = new Int16Array(4096);
for (let i = 0; i < int16.length; i++) int16[i] = Math.round((rnd() - 0.5) * 4000);
const float32 = Float32Array.from(int16, (v) => v / 8 + rnd());

// ── worker kaynağı = windowToRGBA ──
const cases: { wl: number; ww: number; invert: boolean }[] = [
  { wl: 40, ww: 400, invert: false },
  { wl: 40, ww: 400, invert: true },
  { wl: -1000, ww: 1, invert: false },
  { wl: 300, ww: 2000, invert: true },
  { wl: 0, ww: 255, invert: false },
];
for (const c of cases) {
  const { lut, lo } = buildWindowLUT(c.wl, c.ww, c.invert);
  const main = windowToRGBA(int16, lut, lo);
  const worker = runWorkerSource({ id: 7, pixels: int16, lut, lo });
  ok(worker.length === main.length && worker.every((v, i) => v === main[i]), `worker = ana iş parçacığı (wl ${c.wl}, ww ${c.ww}, invert ${c.invert})`);
}
const fMain = windowToRGBA(float32, buildWindowLUT(0, 2, false).lut, buildWindowLUT(0, 2, false).lo);
const fWorker = runWorkerSource({ id: 1, pixels: float32, ...buildWindowLUT(0, 2, false) });
ok(fWorker.every((v, i) => v === fMain[i]), "float32 girdide de bit eşdeğeri");

// aralık dışı değerler kırpılır (alt/üst uç)
const extremes = Float32Array.from([-1e9, -1, 0, 1e9, Number.NaN]);
const { lut: eLut, lo: eLo } = buildWindowLUT(0, 100, false);
const extremesWorker = runWorkerSource({ id: 2, pixels: extremes, lut: eLut, lo: eLo });
const extremesMain = windowToRGBA(extremes, eLut, eLo);
ok(extremesWorker.every((v, i) => v === extremesMain[i]), "uç değerler/NaN aynı şekilde kırpılır");

// renkli (renkli seri) yolda gri palet aynen kullanılır
ok(grayPaletteValue(255) === 0xffffffff && grayPaletteValue(0) === 0xff000000, "gri palet 0xff000000 tabanlı");
ok(GRAY_PALETTE[128] === grayPaletteValue(128), "grayPaletteValue paletle aynı");

// ── yedek yol ve worker yokluğu ──
resetWindowWorkerForTests();
ok(!windowWorkerActive(), "Node ortamında worker kurulmaz");
const asyncRes = await windowSliceAsync(int16, 40, 400, false);
ok(asyncRes === null, "worker yoksa köprü null döner (çağıran yedeğe düşer)");
const sync = windowSliceSync(int16, 40, 400, false);
const ref = windowToRGBA(int16, buildWindowLUT(40, 400, false).lut, buildWindowLUT(40, 400, false).lo);
ok(sync.every((v, i) => v === ref[i]), "yedek yol windowToRGBA ile aynı sonucu verir");

// worker'ı kapatma bekleyen isteği bozmaz
disposeWindowWorker();
ok(!windowWorkerActive(), "dispose worker'ı bırakır");

// ── kaynak metni sözleşmesi ──
ok(WINDOW_WORKER_SOURCE.includes("onmessage") && WINDOW_WORKER_SOURCE.includes("0xff000000"), "worker kaynağı RGBA üretimini içerir");
ok(!WINDOW_WORKER_SOURCE.includes("import "), "worker kaynağı kendi kendine yeterli (import yok)");

if (failed) { console.error(`${failed} pencereleme worker\u0027ı testi başarısız`); process.exit(1); }
console.log("Tüm pencereleme (Web Worker) testleri geçti.");

}

main().catch((e) => { console.error(e); process.exit(1); });
