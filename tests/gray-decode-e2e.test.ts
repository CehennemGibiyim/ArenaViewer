/**
 * Sıkıştırılmamış **gri** piksel çözme — uçtan uca (v-perf).
 *
 * `decodePixels` artık native gri çerçeveleri `src/lib/pixelDecode.ts` (worker
 * varsa `pixelWorker.ts`) üzerinden çözüyor. Bu test, sentetik DICOM dosyalarını
 * `loadMedicalFiles` ile içe aktarıp **seri düzeyinde** doğrular: Rescale
 * Slope/Intercept, Bits Stored maskesi, işaretli/işaretsiz, çok kareli sıra.
 *
 * Not: Node'da `Worker` yok → köprü eşzamanlı yola düşer; worker'ın bit eşdeğerliği
 * `tests/pixel-worker.test.ts` içinde ayrıca sabitlenmiştir.
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
const ds = (g: number, e: number, v: string) => el(g, e, "DS", pad(enc.encode(v), 0x20));
const concatAll = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

interface GrayOpts {
  rows: number;
  cols: number;
  bitsAllocated: 8 | 16;
  bitsStored: number;
  pixelRep: 0 | 1;
  slope?: string;
  intercept?: string;
  frames?: number;
  /** Ham örnekler (piksel verisi olarak yazılır). */
  samples: number[];
}

/** Explicit VR Little Endian, MONOCHROME2, tek seri. */
function buildGray(o: GrayOpts): Uint8Array {
  const meta = [
    el(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    uidEl(0x0002, 0x0002, "1.2.840.10008.5.1.4.1.1.7"),
    uidEl(0x0002, 0x0003, `2.25.${Math.floor(Math.random() * 1e12)}`),
    uidEl(0x0002, 0x0010, "1.2.840.10008.1.2.1"),
    uidEl(0x0002, 0x0012, "1.2.826.0.1.3680043.8.498.1"),
  ];
  const glen = new Uint8Array(4);
  new DataView(glen.buffer).setUint32(0, meta.reduce((a, p) => a + p.length, 0), true);

  const bytesPer = o.bitsAllocated >> 3;
  const pixBytes = new Uint8Array(o.samples.length * bytesPer);
  o.samples.forEach((v, i) => {
    if (bytesPer === 1) pixBytes[i] = v & 0xff;
    else new DataView(pixBytes.buffer).setUint16(i * 2, v & 0xffff, true);
  });

  const dataset = [
    uidEl(0x0008, 0x0016, "1.2.840.10008.5.1.4.1.1.7"),
    uidEl(0x0008, 0x0018, `2.25.${Math.floor(Math.random() * 1e12)}`),
    cs(0x0008, 0x0060, "CT"),
    uidEl(0x0020, 0x000d, "2.25.777"),
    uidEl(0x0020, 0x000e, "2.25.888"),
    us(0x0020, 0x0011, 1),
    us(0x0020, 0x0013, 1),
    us(0x0028, 0x0002, 1),
    cs(0x0028, 0x0004, "MONOCHROME2"),
    ...(o.frames && o.frames > 1 ? [el(0x0028, 0x0008, "IS", pad(enc.encode(String(o.frames)), 0x20))] : []),
    us(0x0028, 0x0010, o.rows),
    us(0x0028, 0x0011, o.cols),
    us(0x0028, 0x0100, o.bitsAllocated),
    us(0x0028, 0x0101, o.bitsStored),
    ...(o.pixelRep ? [us(0x0028, 0x0103, 1)] : [us(0x0028, 0x0103, 0)]),
    ...(o.slope ? [ds(0x0028, 0x1053, o.slope)] : []),
    ...(o.intercept ? [ds(0x0028, 0x1052, o.intercept)] : []),
    el(0x7fe0, 0x0010, o.bitsAllocated === 8 ? "OB" : "OW", pad(pixBytes, 0)),
  ];
  return concatAll([new Uint8Array(128), enc.encode("DICM"), el(0x0002, 0x0000, "UL", glen), ...meta, ...dataset]);
}

async function importOne(name: string, bytes: Uint8Array): Promise<SeriesData | null> {
  const file = new File([bytes as BlobPart], name, { type: "application/dicom" });
  const series = await loadMedicalFiles([file]);
  return series[0] ?? null;
}

async function main() {
  // ── 1. 16 bit işaretsiz, slope/intercept yok → ham değerler ──
  const raw = [0, 1, 1024, 65535];
  const s1 = await importOne("gray-u16.dcm", buildGray({ rows: 2, cols: 2, bitsAllocated: 16, bitsStored: 16, pixelRep: 0, samples: raw }));
  ok(!!s1 && s1.slices.length === 1, "16 bit gri seri tek kesitle açıldı");
  ok(!!s1 && s1.width === 2 && s1.height === 2, "boyutlar korunuyor (2×2)");
  const p1 = s1?.slices[0] ?? new Int16Array(0);
  ok([...p1].join(",") === raw.join(","), `ham değerler korunuyor (${[...p1].join(",")})`);
  ok(p1 instanceof Uint16Array, `işaretsiz 16 bit → Uint16 (${p1.constructor.name})`);

  // ── 2. 16 bit işaretli, negatif değerler ──
  const signed = [0, 1, 65535 /* -1 */, 65534 /* -2 */];
  const s2 = await importOne("gray-i16.dcm", buildGray({ rows: 2, cols: 2, bitsAllocated: 16, bitsStored: 16, pixelRep: 1, samples: signed }));
  const p2 = s2?.slices[0] ?? new Int16Array(0);
  ok([...p2].join(",") === "0,1,-1,-2", `işaretli çözümleme doğru (${[...p2].join(",")})`);

  // ── 3. Rescale Slope/Intercept → kesirli çıkış Float32 ──
  const s3 = await importOne("gray-slope.dcm", buildGray({
    rows: 1, cols: 2, bitsAllocated: 16, bitsStored: 16, pixelRep: 0,
    slope: "1.5", intercept: "-37.25", samples: [100, 200],
  }));
  const p3 = s3?.slices[0] ?? new Float32Array(0);
  ok(Math.abs(p3[0] - (100 * 1.5 - 37.25)) < 1e-4, `slope/intercept uygulandı (${p3[0]} → 112.75)`);
  ok(Math.abs(p3[1] - (200 * 1.5 - 37.25)) < 1e-4, `ikinci örnek doğru (${p3[1]} → 262.75)`);
  ok(p3 instanceof Float32Array, `kesirli değer Float32 olarak saklanır (${p3.constructor.name})`);

  // ── 4. Bits Stored 12: üst bite yazılmış dolgu bitleri maskelenir ──
  //    0xF001 → maske 0x001 = 1 ; 0xFFFF → 0xFFF = 4095
  const s4 = await importOne("gray-bits12.dcm", buildGray({
    rows: 1, cols: 2, bitsAllocated: 16, bitsStored: 12, pixelRep: 0, samples: [0xf001, 0xffff],
  }));
  const p4 = s4?.slices[0] ?? new Int16Array(0);
  ok([...p4].join(",") === "1,4095", `Bits Stored 12 maskesi uygulandı (${[...p4].join(",")})`);

  // ── 5. 8 bit gri ──
  const s5 = await importOne("gray-8.dcm", buildGray({ rows: 1, cols: 3, bitsAllocated: 8, bitsStored: 8, pixelRep: 0, samples: [0, 128, 255] }));
  const p5 = s5?.slices[0] ?? new Int16Array(0);
  ok([...p5].join(",") === "0,128,255", `8 bit değerler korunuyor (${[...p5].join(",")})`);

  // ── 6. Çok kareli: kare sırası korunur ──
  const s6 = await importOne("gray-multi.dcm", buildGray({
    rows: 1, cols: 2, bitsAllocated: 16, bitsStored: 16, pixelRep: 0, frames: 3,
    samples: [10, 20, 30, 40, 50, 60],
  }));
  ok(!!s6 && s6.slices.length === 3, `3 kare → 3 kesit (${s6?.slices.length ?? 0})`);
  ok(!!s6 && [s6.slices[0][0], s6.slices[1][0], s6.slices[2][0]].join(",") === "10,30,50",
    `kare sırası korunuyor (${s6 ? [s6.slices[0][0], s6.slices[1][0], s6.slices[2][0]].join(",") : "-"})`);

  if (failed) { console.error(`${failed} uçtan uca gri çözme testi başarısız`); process.exit(1); }
  console.log("Tüm uçtan uca gri çözme testleri geçti.");
}

main().catch((e) => { console.error(e); process.exit(1); });
