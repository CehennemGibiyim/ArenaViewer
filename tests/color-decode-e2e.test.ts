/**
 * v-perf — renkli çözümün **uçtan uca** doğruluğu: sentetik DICOM → `loadMedicalFiles`
 * → RGBA, ve worker yolunun eşzamanlı yolla birebir aynı sonucu vermesi.
 *
 * Neden: `dicom.ts` renkli yolunu worker'a taşıdık. Birim testler saf çekirdeği
 * doğruluyor; burada **gerçek DICOM baytlarından** geçen yol sınanıyor: RGBA
 * tamponu, gri (pencere kaynağı) değerleri ve çok kareli seri sırası. Worker'ın
 * `node:vm` içinde çalıştırılmasıyla üretilen RGBA, `decodeColorFrame` ile
 * karşılaştırılır (bit eşdeğerliği).
 */
import vm from "node:vm";
import { loadMedicalFiles } from "../src/lib/dicom";
import { el, pad, uidEl, us } from "../src/lib/dicomWrite";
import { decodeColorFrame, type ColorFrameParams } from "../src/lib/colorDecode";
import { COLOR_WORKER_SOURCE } from "../src/lib/colorWorker";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const enc = new TextEncoder();
const cs = (g: number, e: number, v: string) => el(g, e, "CS", pad(enc.encode(v), 0x20));
const concatAll = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

interface BuildOpts {
  rows: number;
  cols: number;
  samples: number;
  photo: string;
  bits: number;
  frames?: number;
  planar?: number;
  pixels: Uint8Array | Uint16Array;
  extra?: Uint8Array[];
}

/** Explicit VR Little Endian, tek seri, tek dosya. */
function buildDicom(o: BuildOpts): Uint8Array {
  const meta = [
    el(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    uidEl(0x0002, 0x0002, "1.2.840.10008.5.1.4.1.1.7"),
    uidEl(0x0002, 0x0003, `2.25.${Math.floor(Math.random() * 1e12)}`),
    uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"),
    uidEl(0x0002, 0x0012, "1.2.826.0.1.3680043.8.498.1"),
  ];
  const glen = new Uint8Array(4);
  new DataView(glen.buffer).setUint32(0, meta.reduce((a, p) => a + p.length, 0), true);
  const dataset = [
    uidEl(0x0008, 0x0016, "1.2.840.10008.5.1.4.1.1.7"),
    uidEl(0x0008, 0x0018, `2.25.${Math.floor(Math.random() * 1e12)}`),
    cs(0x0008, 0x0060, "OT"),
    uidEl(0x0020, 0x000d, "2.25.777"),
    uidEl(0x0020, 0x000e, "2.25.888"),
    us(0x0020, 0x0011, 1),
    us(0x0020, 0x0013, 1),
    us(0x0028, 0x0002, o.samples),
    cs(0x0028, 0x0004, o.photo),
    // (0028,0008) Number of Frames VR = IS (metin), US değil
    ...(o.frames && o.frames > 1 ? [el(0x0028, 0x0008, "IS", pad(enc.encode(String(o.frames)), 0x20))] : []),
    ...(o.planar !== undefined ? [us(0x0028, 0x0006, o.planar)] : []),
    us(0x0028, 0x0010, o.rows),
    us(0x0028, 0x0011, o.cols),
    us(0x0028, 0x0100, o.bits),
    us(0x0028, 0x0101, o.bits),
    us(0x0028, 0x0103, 0),
    ...(o.extra ?? []),
    el(
      0x7fe0,
      0x0010,
      o.bits === 8 ? "OB" : "OW",
      pad(new Uint8Array(o.pixels.buffer, o.pixels.byteOffset, o.pixels.byteLength), 0)
    ),
  ];
  return concatAll([new Uint8Array(128), enc.encode("DICM"), el(0x0002, 0x0000, "UL", glen), ...meta, ...dataset]);
}

async function importOne(name: string, bytes: Uint8Array): Promise<SeriesData | null> {
  const file = new File([bytes as BlobPart], name, { type: "application/dicom" });
  const series = await loadMedicalFiles([file]);
  return series[0] ?? null;
}

const rgba = (s: SeriesData | null, frame = 0) => s?.rgbaSlices?.[frame] ?? new Uint32Array(0);
const px = (u: number) => [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff];
const same = (u: number, r: number, g: number, b: number, tol = 1) => {
  const p = px(u);
  return Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol && u >>> 24 === 255;
};


/** Worker'ı vm'de çalıştırıp RGBA üretir (bit eşdeğerliği kontrolü için). */
function workerRgba(bytes: Uint8Array, offset: number, p: ColorFrameParams): Uint32Array | null {
  const msgs: { id: number; rgba?: ArrayBuffer; rejected?: boolean }[] = [];
  const ctx = { self: { postMessage: (m: unknown) => msgs.push(m as never) }, Math, DataView, Uint8Array, Uint16Array, Uint32Array, Float32Array };
  vm.createContext(ctx);
  vm.runInContext(COLOR_WORKER_SOURCE, ctx);
  const fn = (ctx.self as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage;
  fn({ data: { id: 1, bytes, offset: 0, params: p } });
  return msgs[0]?.rgba ? new Uint32Array(msgs[0].rgba) : null;
}

async function main() {
  // ── 1. RGB 8-bit: RGBA + gri (pencere kaynağı) ──
  const rgbPixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const rgb = await importOne("rgb.dcm", buildDicom({ rows: 2, cols: 2, samples: 3, photo: "RGB", bits: 8, planar: 0, pixels: rgbPixels }));
  ok(!!rgb && rgb.isColor === true, "RGB serisi renkli açılır");
  ok(same(rgba(rgb)[0], 255, 0, 0) && same(rgba(rgb)[3], 10, 20, 30), "RGB RGBA doğru (worker yolu)");
  ok(rgb?.slices[0]?.[0] === Math.fround(0.299 * 255), "gri değer BT.601 parlaklığı (worker)");

  // ── 2. Worker ↔ eşzamanlı: aynı DICOM baytları, aynı parametreler ──
  const p: ColorFrameParams = {
    rows: 2, cols: 2, samples: 3, bitsAllocated: 8, bitsStored: 8, planar: false,
    photometric: "RGB", convertYbr: true, slope: 1, intercept: 0,
  };
  const w = workerRgba(rgbPixels, 0, p);
  const sync = decodeColorFrame(rgbPixels, 0, p)!;
  ok(!!w && w.every((v, i) => v === sync.rgba[i]), "worker RGBA ≡ eşzamanlı çekirdek (gerçek DICOM baytları)");
  ok(w!.every((v, i) => v === rgba(rgb)[i]), "worker RGBA ≡ loadMedicalFiles çıktısı");

  // ── 3. YBR_FULL ve 4:2:2: renk dönüşümü seri düzeyinde doğru ──
  const ybr = await importOne("ybr.dcm", buildDicom({ rows: 1, cols: 2, samples: 3, photo: "YBR_FULL", bits: 8, planar: 0, pixels: new Uint8Array([255, 128, 128, 76, 85, 255]) }));
  ok(!!ybr && same(rgba(ybr)[0], 255, 255, 255), "YBR_FULL beyaz");
  ok(!!ybr && px(rgba(ybr)[1])[0] > 200 && px(rgba(ybr)[1])[1] < 40, "YBR_FULL kırmızı (worker içinde YBR→RGB)");
  ok(ybr?.slices[0]?.[0] === 255, "YBR'de gri = Y (parlaklık) — dicom.ts kuralıyla aynı");

  const y422 = await importOne("ybr422.dcm", buildDicom({ rows: 1, cols: 4, samples: 3, photo: "YBR_FULL_422", bits: 8, planar: 0, pixels: new Uint8Array([255, 128, 0, 128, 128, 128, 128, 128]) }));
  ok(!!y422 && rgba(y422).length === 4, "4:2:2 → 4 piksel RGBA (yukarı örnekleme worker'da)");
  ok(!!y422 && px(rgba(y422)[0])[0] > 200 && px(rgba(y422)[1])[0] < 40, "4:2:2 parlaklık farkı korunur");

  // ── 4. Planar ve 16-bit: aynı yol, farklı düzen ──
  const planarBytes = new Uint8Array([255, 255, 0, 0, 0, 0]);
  const planar = await importOne("planar.dcm", buildDicom({ rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 8, planar: 1, pixels: planarBytes }));
  ok(!!planar && same(rgba(planar)[0], 255, 0, 0) && same(rgba(planar)[1], 255, 0, 0), "planar RGB doğru (düzlemler birleştirilir)");
  const pPlan: ColorFrameParams = { ...p, rows: 1, cols: 2, planar: true };
  ok(workerRgba(planarBytes, 0, pPlan)!.every((v, i) => v === decodeColorFrame(planarBytes, 0, pPlan)!.rgba[i]), "planar: worker ≡ eşzamanlı");

  const rgb16 = await importOne("rgb16.dcm", buildDicom({ rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 16, planar: 0, pixels: new Uint16Array([0xff00, 0, 0, 0, 0x8000, 0]) }));
  ok(!!rgb16 && same(rgba(rgb16)[0], 255, 0, 0) && same(rgba(rgb16)[1], 0, 128, 0), "16-bit renk 8 bite ölçeklenir");

  // ── 5. Çok kareli renkli seri: sıra ve kare sayısı korunur ──
  const frames = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const multi = await importOne("multi.dcm", buildDicom({ rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 8, planar: 0, frames: 2, pixels: frames }));
  ok(!!multi && multi.slices.length === 2 && multi.rgbaSlices?.length === 2, "iki kareli renkli seri: 2 kesit + 2 RGBA");
  // 12 bayt = 2 kare × 2 piksel × 3 örnek: kare0 = kırmızı,yeşil · kare1 = mavi,beyaz
  ok(!!multi && same(rgba(multi, 0)[0], 255, 0, 0) && same(rgba(multi, 0)[1], 0, 255, 0), "kare 0: kırmızı, yeşil (sıra korunur)");
  ok(!!multi && same(rgba(multi, 1)[0], 0, 0, 255) && same(rgba(multi, 1)[1], 255, 255, 255), "kare 1: mavi, beyaz (kare sınırı kaymıyor)");

  // ── 6. PALETTE COLOR etkilenmedi (ayrı yol) ──
  const pal = await importOne("pal.dcm", buildDicom({
    rows: 1, cols: 2, samples: 1, photo: "PALETTE COLOR", bits: 8,
    pixels: new Uint8Array([0, 1]),
    extra: [
      el(0x0028, 0x1101, "US", new Uint8Array([3, 0, 8, 0])), el(0x0028, 0x1102, "US", new Uint8Array([3, 0, 8, 0])), el(0x0028, 0x1103, "US", new Uint8Array([3, 0, 8, 0])),
      el(0x0028, 0x1201, "OW", new Uint8Array([255, 0, 0, 0])), el(0x0028, 0x1202, "OW", new Uint8Array([0, 255, 0, 0])), el(0x0028, 0x1203, "OW", new Uint8Array([0, 0, 255, 0])),
      el(0x0028, 0x1102 - 0x0001 + 0x0001 - 0x0001 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000 + 0x0000, "US", new Uint8Array([0, 0])),
    ],
  }));
  ok(!!pal && pal.isColor === true, "PALETTE COLOR hâlâ renkli açılır (ayrı yol korunur)");

  if (failed) { console.error(`${failed} renk uçtan uca testi başarısız`); process.exit(1); }
  console.log("Tüm v-perf renkli çözüm (uçtan uca) testleri geçti.");
}

void main();
