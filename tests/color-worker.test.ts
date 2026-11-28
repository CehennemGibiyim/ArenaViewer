/**
 * v-perf — renkli çerçeve çözümü: saf çekirdek (`colorDecode.ts`) ↔ worker kaynağı
 * ve `dicom.ts` renkli yolu arasındaki **bit eşdeğerliği**.
 *
 * Neden: worker'a taşınan aritmetik ana iş parçacığındakinden bir bit saparsa
 * renkli görüntü sessizce değişir (klinikte "görüntü bozuk" olarak görünür).
 * Bu test worker kaynağını `node:vm` içinde gerçekten çalıştırır ve ürettiği RGBA
 * tamponunu `decodeColorFrame` çıktısıyla birebir karşılaştırır.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { colorFrameBytes, colorWorkerEligible, decodeColorFrame, deplanar8, deplanar16, type ColorFrameParams } from "../src/lib/colorDecode";
import { COLOR_WORKER_SOURCE } from "../src/lib/colorWorker";
import { colorToRgba, upsampleSubsampled } from "../src/lib/photometric";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const base = (over: Partial<ColorFrameParams> = {}): ColorFrameParams => ({
  rows: 4, cols: 6, samples: 3, bitsAllocated: 8, bitsStored: 8, planar: false,
  photometric: "RGB", convertYbr: true, slope: 1, intercept: 0, ...over,
});

function rgbBytes(rows: number, cols: number): Uint8Array {
  const b = new Uint8Array(rows * cols * 3);
  for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 0xff;
  return b;
}

/** Worker'ı vm'de çalıştırıp tek çerçeve çözer. */
function runWorker(bytes: Uint8Array, offset: number, p: ColorFrameParams) {
  const messages: { id: number; rgba?: ArrayBuffer; gray?: ArrayBuffer; error?: string; rejected?: boolean }[] = [];
  const ctx = { self: { postMessage: (m: unknown) => messages.push(m as never) }, Math, DataView, Uint8Array, Uint16Array, Uint32Array, Float32Array };
  vm.createContext(ctx);
  vm.runInContext(COLOR_WORKER_SOURCE, ctx);
  const onmessage = (ctx.self as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage;
  const copy = new Uint8Array(bytes.subarray(offset, offset + colorFrameBytes(p)));
  onmessage({ data: { id: 7, bytes: copy, offset: 0, params: p } });
  return { msg: messages[0], messages };
}

function sameRgba(a: Uint32Array, b: ArrayBuffer | undefined): boolean {
  if (!b) return false;
  const u = new Uint32Array(b);
  if (u.length !== a.length) return false;
  for (let i = 0; i < a.length; i++) if (u[i] !== a[i]) return false;
  return true;
}

function sameF32(exp: Float32Array, buf: ArrayBuffer | undefined): boolean {
  if (!buf) return false;
  const u = new Float32Array(buf);
  if (u.length !== exp.length) return false;
  for (let i = 0; i < exp.length; i++) {
    if (Number.isNaN(exp[i]) !== Number.isNaN(u[i])) return false;
    if (!Object.is(exp[i], u[i])) return false;
  }
  return true;
}

// ── 1. Kapsam kapısı ve bayt uzunluğu ──
ok(colorWorkerEligible(base()), "RGB 8-bit renkli çerçeve worker'a uygun");
ok(!colorWorkerEligible(base({ samples: 1 })), "gri çerçeve renk yolundan geçmez (kapsam dışı)");
ok(!colorWorkerEligible(base({ photometric: "PALETTE COLOR" })), "palet renkli ayrı yol (kapsam dışı)");
ok(!colorWorkerEligible(base({ bitsAllocated: 12 })), "12 bit desteklenmiyor");
ok(colorFrameBytes(base()) === 4 * 6 * 3, "RGB bayt uzunluğu = piksel × 3");
const p422 = base({ photometric: "YBR_FULL_422" });
ok(colorFrameBytes(p422) === Math.ceil(24 / 2) * 4, "4:2:2 seyreltilmiş bayt uzunluğu");
const p420 = base({ photometric: "YBR_PARTIAL_420" });
ok(colorFrameBytes(p420) === Math.ceil(24 / 4) * 6, "4:2:0 seyreltilmiş bayt uzunluğu");

// ── 2. Worker kaynağı ↔ saf çekirdek: beş senaryo ──
const scenarios: [string, ColorFrameParams][] = [
  ["RGB 8-bit", base()],
  ["YBR_FULL", base({ photometric: "YBR_FULL" })],
  ["YBR_PARTIAL_422", base({ photometric: "YBR_PARTIAL_422" })],
  ["YBR_PARTIAL_420", base({ photometric: "YBR_PARTIAL_420" })],
  ["16-bit RGB (big-endian değil)", base({ photometric: "RGB", bitsAllocated: 16, bitsStored: 12 })],
];
for (const [name, p] of scenarios) {
  const frames = 2;
  const bytes = new Uint8Array(colorFrameBytes(p) * frames + 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 53 + 7) & 0xff;
  const offset = 3; // hizalama dışı başlangıç: ofset hesabı sınanır
  const expected = decodeColorFrame(bytes, offset, p);
  ok(!!expected, `${name}: saf çekirdek çözdü`);
  const { msg } = runWorker(bytes, offset, p);
  ok(sameRgba(expected!.rgba, msg.rgba), `${name}: worker RGBA birebir aynı`);
  ok(sameF32(expected!.gray, msg.gray), `${name}: worker gri (Float32) birebir aynı`);
}

// ── 3. Planar ve YBR dönüşümü kapalı ──
{
  const p = base({ planar: true });
  const bytes = rgbBytes(4, 6);
  const expected = decodeColorFrame(bytes, 0, p)!;
  ok(sameRgba(expected.rgba, runWorker(bytes, 0, p).msg.rgba), "planar (düzlem sıralı) RGBA birebir");
  const d = deplanar8(bytes, 24);
  ok(d[0] === bytes[0] && d[1] === bytes[24] && d[2] === bytes[48], "deplanar8 RRR…GGG…BBB → RGB");
}
{
  const p = base({ photometric: "YBR_FULL", convertYbr: false });
  const bytes = rgbBytes(4, 6);
  const expected = decodeColorFrame(bytes, 0, p)!;
  ok(sameRgba(expected.rgba, runWorker(bytes, 0, p).msg.rgba), "convertYbr=false: YBR→RGB yapılmaz (kodek RGB verdi)");
  const withConv = decodeColorFrame(bytes, 0, { ...p, convertYbr: true })!;
  ok(withConv.rgba[0] !== expected.rgba[0], "dönüşüm açıkken renk gerçekten değişir (test anlamlı)");
}

// ── 4. dicom.ts ile aynı sonuç (eşzamanlı referans) ──
{
  const bytes = rgbBytes(4, 6);
  const p = base({ photometric: "YBR_FULL", slope: 2, intercept: -50 });
  const mine = decodeColorFrame(bytes, 0, p)!;
  // dicom.ts renkli yolu: colorToRgba(raw) + Y/parlaklık × slope + intercept
  const refRgba = colorToRgba(bytes, 24, { photometric: "YBR_FULL", bitsStored: 8, convertYbr: true });
  ok(mine.rgba.every((v, i) => v === refRgba[i]), "RGBA, `colorToRgba` referansıyla birebir");
  const refGray = new Float32Array(24);
  for (let i = 0; i < 24; i++) refGray[i] = bytes[i * 3] * 2 + -50; // YBR: parlaklık = Y
  ok(mine.gray.every((v, i) => Object.is(v, refGray[i])), "gri, dicom.ts kuralıyla (Y × slope + intercept) birebir");
  // RGB'de parlaklık BT.601 ağırlıklı
  const rgbP = base();
  const g = decodeColorFrame(bytes, 0, rgbP)!.gray;
  ok(Math.abs(g[0] - (0.299 * bytes[0] + 0.587 * bytes[1] + 0.114 * bytes[2])) < 1e-4, "RGB'de gri = 0.299R+0.587G+0.114B");
}
{
  // 4:2:2: yukarı örnekleme referansı
  const p = base({ photometric: "YBR_FULL_422" });
  const bytes = new Uint8Array(colorFrameBytes(p));
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29 + 3) & 0xff;
  const up = upsampleSubsampled(bytes, 24, false);
  const mine = decodeColorFrame(bytes, 0, p)!;
  ok(mine.gray[0] === up[0] + 0 * p.intercept, "4:2:2 gri değeri yukarı örneklenmiş Y'den");
}

// ── 5. 16 bit + işaretli sınırlar ve big-endian ──
{
  const p = base({ photometric: "RGB", bitsAllocated: 16, bitsStored: 16, bigEndian: true });
  const n = 24 * 3;
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = (i * 1000 + 3000) & 0xffff;
    bytes[i * 2] = (v >> 8) & 0xff;      // büyük sonlu
    bytes[i * 2 + 1] = v & 0xff;
  }
  const expected = decodeColorFrame(bytes, 0, p)!;
  ok(sameRgba(expected.rgba, runWorker(bytes, 0, p).msg.rgba), "16-bit big-endian RGBA birebir");
  const le = decodeColorFrame(bytes, 0, { ...p, bigEndian: false })!;
  ok(!expected.rgba.every((v, i) => v === le.rgba[i]), "endian farkı gerçekten sonucu değiştirir (test anlamlı)");
}

// ── 6. Sınır/hatalı girişler: asılı kalma ve sessiz yanlış yok ──
{
  const p = base();
  ok(decodeColorFrame(new Uint8Array(10), 0, p) === null, "kısa tampon → null (eşzamanlı yola düşülür)");
  ok(decodeColorFrame(rgbBytes(4, 6), -1, p) === null, "negatif ofset → null");
  ok(decodeColorFrame(rgbBytes(4, 6), 0, base({ samples: 1 })) === null, "tek örnek → null (gri yolu)");
  const { messages } = runWorker(rgbBytes(4, 6), 0, p);
  ok(messages.length === 1 && messages[0].rejected !== true, "worker tek yanıt üretir (asılı istek yok)");
  // Kapsam dışı parametre worker'da da reddedilir
  const bad = runWorker(rgbBytes(4, 6), 0, base({ samples: 1 }));
  ok(!!bad.msg.rejected || !!bad.msg.error, "worker kapsam dışı isteği sessizce geçmez (ret/hata)");
}

console.log(`\ncolor-worker: ${fail === 0 ? "PASS" : "FAIL"} (${pass} geçti, ${fail} kaldı)`);
process.exit(fail === 0 ? 0 : 1);
