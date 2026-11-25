/**
 * Fotometrik yorum — **uçtan uca DICOM** testleri (`f-pixel`).
 *
 * Testler sentetik DICOM dosyaları üretir (hasta verisi yok), `loadMedicalFiles`
 * ile içe aktarır ve seri düzeyinde doğrular: renkli seride `rgbaSlices`,
 * MONOCHROME1 ters çevirme, çok kareli renkli seri, PALETTE COLOR LUT,
 * 16-bit renk ve native 4:2:2 YBR.
 */
import { loadMedicalFiles } from "../src/lib/dicom";
import { el, pad, uidEl, us } from "../src/lib/dicomWrite";
import type { SeriesData } from "../src/lib/types";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

const enc = new TextEncoder();
const cs = (g: number, e: number, v: string) => el(g, e, "CS", pad(enc.encode(v), 0x20));
const usMulti = (g: number, e: number, vals: number[]) => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => new DataView(b.buffer).setUint16(i * 2, v, true));
  return el(g, e, "US", b);
};
const ow = (g: number, e: number, vals: number[]) => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => new DataView(b.buffer).setUint16(i * 2, v, true));
  return el(g, e, "OW", pad(b, 0));
};
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

async function main() {
  // ── 1. RGB 8-bit, piksel sıralı ──
  const rgb = await importOne("rgb.dcm", buildDicom({
    rows: 2, cols: 2, samples: 3, photo: "RGB", bits: 8, planar: 0,
    pixels: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]),
  }));
  ok(!!rgb && rgb.isColor === true && rgb.photometric === "RGB", "RGB serisi renkli olarak açılır");
  ok(rgb?.rgbaSlices?.[0]?.length === 4, "RGBA tamponu piksel sayısı kadar (4)");
  ok(same(rgba(rgb)[0], 255, 0, 0) && same(rgba(rgb)[1], 0, 255, 0) && same(rgba(rgb)[2], 0, 0, 255), "RGB pikselleri doğru RGBA üretir");
  ok(same(rgba(rgb)[3], 10, 20, 30), "ara tonlar korunur");

  // ── 2. RGB 8-bit, planar configuration = 1 ──
  const planar = await importOne("planar.dcm", buildDicom({
    rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 8, planar: 1,
    pixels: new Uint8Array([255, 255, 0, 0, 0, 0]), // R düzlemi [255,255], G [0,0], B [0,0]
  }));
  ok(!!planar && same(rgba(planar)[0], 255, 0, 0) && same(rgba(planar)[1], 255, 0, 0), "planar RGB doğru çözülür (düzlemler birleştirilir)");

  // ── 3. 16-bit renk ──
  const rgb16 = await importOne("rgb16.dcm", buildDicom({
    rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 16, planar: 0,
    pixels: new Uint16Array([0xff00, 0, 0, 0, 0x8000, 0]),
  }));
  ok(!!rgb16 && same(rgba(rgb16)[0], 255, 0, 0) && same(rgba(rgb16)[1], 0, 128, 0), "16-bit renk 8 bite ölçeklenir");

  // ── 4. YBR_FULL ──
  const ybr = await importOne("ybr.dcm", buildDicom({
    rows: 1, cols: 2, samples: 3, photo: "YBR_FULL", bits: 8, planar: 0,
    pixels: new Uint8Array([255, 128, 128, 76, 85, 255]),
  }));
  ok(!!ybr && same(rgba(ybr)[0], 255, 255, 255), "YBR_FULL beyaz pikseli");
  ok(!!ybr && px(rgba(ybr)[1])[0] > 200 && px(rgba(ybr)[1])[1] < 40, "YBR_FULL kırmızı pikseli RGB'ye çevrilir");

  // ── 5. Native YBR_FULL_422 (4 px = 8 bayt) ──
  const ybr422 = await importOne("ybr422.dcm", buildDicom({
    rows: 1, cols: 4, samples: 3, photo: "YBR_FULL_422", bits: 8, planar: 0,
    pixels: new Uint8Array([255, 128, 0, 128, 128, 128, 128, 128]),
  }));
  ok(!!ybr422 && ybr422.slices.length === 1, "4:2:2 native veri tek kesit olarak çözülür");
  ok(!!ybr422 && rgba(ybr422).length === 4, "4:2:2 → 4 piksel RGBA (seyreltilmiş veri açılır)");
  ok(!!ybr422 && px(rgba(ybr422)[0])[0] > 200 && px(rgba(ybr422)[1])[0] < 40, "4:2:2 parlaklık farkı korunur (beyaz → siyah)");

  // ── 6. PALETTE COLOR ──
  const palette = await importOne("pal.dcm", buildDicom({
    rows: 1, cols: 3, samples: 1, photo: "PALETTE COLOR", bits: 8,
    pixels: new Uint8Array([0, 1, 2]),
    extra: [
      usMulti(0x0028, 0x1101, [3, 0, 8]), usMulti(0x0028, 0x1102, [3, 0, 8]), usMulti(0x0028, 0x1103, [3, 0, 8]),
      ow(0x0028, 0x1201, [255, 0, 0]), ow(0x0028, 0x1202, [0, 255, 0]), ow(0x0028, 0x1203, [0, 0, 255]),
    ],
  }));
  ok(!!palette && palette.isColor === true && palette.photometric === "PALETTE COLOR", "palet serisi renkli açılır");
  ok(!!palette && same(rgba(palette)[0], 255, 0, 0) && same(rgba(palette)[1], 0, 255, 0) && same(rgba(palette)[2], 0, 0, 255), "palet LUT (US tanımlayıcı + OW veri) doğru uygulanır");
  ok(!!palette && palette.paletteLut?.numEntries === 3 && palette.paletteLut?.bits === 8, "palet tanımlayıcısı ikili olarak okunur");

  // ── 7. 16-bit palet (bitsPerEntry = 16) ──
  const pal16 = await importOne("pal16.dcm", buildDicom({
    rows: 1, cols: 2, samples: 1, photo: "PALETTE COLOR", bits: 8,
    pixels: new Uint8Array([10, 11]),
    extra: [
      usMulti(0x0028, 0x1101, [2, 10, 16]), usMulti(0x0028, 0x1102, [2, 10, 16]), usMulti(0x0028, 0x1103, [2, 10, 16]),
      ow(0x0028, 0x1201, [0xffff, 0]), ow(0x0028, 0x1202, [0, 0xffff]), ow(0x0028, 0x1203, [0, 0]),
    ],
  }));
  ok(!!pal16 && pal16.paletteLut?.bits === 16, "16-bit palet tanınır");
  ok(!!pal16 && same(rgba(pal16)[0], 255, 0, 0) && same(rgba(pal16)[1], 0, 255, 0), "16-bit palet + firstMapped ofseti doğru");

  // ── 8. MONOCHROME1 / MONOCHROME2 ──
  const mono1 = await importOne("mono1.dcm", buildDicom({
    rows: 1, cols: 3, samples: 1, photo: "MONOCHROME1", bits: 16,
    pixels: new Uint16Array([0, 500, 1000]),
  }));
  ok(!!mono1 && mono1.photometric === "MONOCHROME1", "MONOCHROME1 serisi açılır");
  ok(!!mono1 && mono1.slices[0][0] === 1000 && mono1.slices[0][2] === 0, "MONOCHROME1 ters çevrilir (max+min kuralı)");
  ok(!!mono1 && mono1.isColor === false, "MONOCHROME1 gri seri olarak kalır");
  const mono2 = await importOne("mono2.dcm", buildDicom({
    rows: 1, cols: 3, samples: 1, photo: "MONOCHROME2", bits: 16,
    pixels: new Uint16Array([0, 500, 1000]),
  }));
  ok(!!mono2 && mono2.slices[0][0] === 0 && mono2.slices[0][2] === 1000, "MONOCHROME2 değiştirilmez");

  // ── 9. Çok kareli renkli seri ──
  const multi = await importOne("multi.dcm", buildDicom({
    rows: 1, cols: 2, samples: 3, photo: "RGB", bits: 8, frames: 3, planar: 0,
    pixels: new Uint8Array([
      255, 0, 0, 0, 0, 0,
      0, 255, 0, 0, 0, 0,
      0, 0, 255, 0, 0, 0,
    ]),
  }));
  ok(!!multi && multi.slices.length === 3, "çok kareli renkli dosya 3 kesit üretir");
  ok(!!multi && multi.rgbaSlices?.length === 3, "her kare için RGBA tamponu var");
  ok(!!multi && same(rgba(multi, 0)[0], 255, 0, 0) && same(rgba(multi, 1)[0], 0, 255, 0) && same(rgba(multi, 2)[0], 0, 0, 255), "kareler sırayla doğru renkleri taşır");
  ok(!!multi && multi.isColor === true, "çok kareli renkli seri renkli işaretlenir");

  if (failed) { console.error(`${failed} fotometri uçtan uca testi başarısız`); process.exit(1); }
  console.log("Tüm fotometri uçtan uca testleri geçti.");
}

main().catch((e) => {
  console.error("Fotometri e2e testi çöktü:", e);
  process.exit(1);
});
