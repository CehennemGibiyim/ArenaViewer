import assert from "node:assert/strict";
import { analyzeSlicePositions } from "../src/lib/seriesGeometryQuality";
import { volumeGeometry } from "../src/lib/mpr";
import { loadMedicalFiles } from "../src/lib/dicom";

assert.deepEqual(analyzeSlicePositions([4, 0, 2, 1]), { comparable: true, spacing: 1, samePlane: 0, irregular: 1 });
assert.deepEqual(analyzeSlicePositions([0, 1, 1.005, 2]), { comparable: true, spacing: 1, samePlane: 1, irregular: 0 });
assert.equal(analyzeSlicePositions([0, 1, 3]).irregular, 0, "iki aralıktan eksik kesit çıkarsanmaz");
assert.equal(analyzeSlicePositions([0, 0]).samePlane, 1);
assert.equal(analyzeSlicePositions([0, 0]).spacing, null);
assert.equal(analyzeSlicePositions([0, Infinity]).comparable, false);
assert.equal(analyzeSlicePositions(undefined).comparable, false);

function element(group: number, tag: number, vr: string, input: Buffer): Buffer {
  const value = input.length % 2 ? Buffer.concat([input, Buffer.from([vr === "UI" ? 0 : 32])]) : input;
  const long = ["OB", "OW", "OF", "SQ", "UC", "UR", "UT", "UN"].includes(vr);
  const h = Buffer.alloc(long ? 12 : 8);
  h.writeUInt16LE(group, 0); h.writeUInt16LE(tag, 2); h.write(vr, 4, "ascii");
  if (long) h.writeUInt32LE(value.length, 8); else h.writeUInt16LE(value.length, 6);
  return Buffer.concat([h, value]);
}
const str = (group: number, tag: number, vr: string, value: string) => element(group, tag, vr, Buffer.from(value, "ascii"));
const us = (group: number, tag: number, n: number) => { const v = Buffer.alloc(2); v.writeUInt16LE(n); return element(group, tag, "US", v); };
function file(position: number | null, instance: number, orientation = "1\\0\\0\\0\\1\\0", frames = 1): File {
  const sop = `1.2.826.0.1.3680043.10.999.${instance}`;
  const cls = "1.2.840.10008.5.1.4.1.1.2";
  const meta = Buffer.concat([
    element(2, 1, "OB", Buffer.from([0, 1])), str(2, 2, "UI", cls), str(2, 3, "UI", sop),
    str(2, 0x10, "UI", "1.2.840.10008.1.2.1"), str(2, 0x12, "UI", "1.2.3.4")
  ]);
  const length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const parts = [Buffer.alloc(128), Buffer.from("DICM"), element(2, 0, "UL", length), meta,
    str(8, 0x16, "UI", cls), str(8, 0x18, "UI", sop), str(8, 0x60, "CS", "CT"),
    str(0x20, 0xd, "UI", "1.2.3.1"), str(0x20, 0xe, "UI", "1.2.3.2"),
    str(0x20, 0x13, "IS", String(instance)),
    ...(position === null ? [] : [str(0x20, 0x32, "DS", `0\\0\\${position}`)]),
    str(0x20, 0x37, "DS", orientation),
    us(0x28, 2, 1), str(0x28, 4, "CS", "MONOCHROME2"),
    ...(frames > 1 ? [str(0x28, 8, "IS", String(frames))] : []),
    us(0x28, 0x10, 4), us(0x28, 0x11, 4), us(0x28, 0x100, 16), us(0x28, 0x101, 16),
    us(0x28, 0x102, 15), us(0x28, 0x103, 0), element(0x7fe0, 0x10, "OW", Buffer.alloc(32 * frames))];
  return new File([Buffer.concat(parts)], `slice-${instance}.dcm`);
}
async function run() {
  const warnings: string[] = [];
  const rows = await loadMedicalFiles([file(4, 4), file(1, 2), file(1, 3), file(0, 1), file(2, 5)], undefined, w => warnings.push(w));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].slicePositions, [0, 1, 1, 2, 4]);
  assert.equal(rows[0].sliceSpacing, 1);
  assert.ok(warnings.some(w => w.includes("aynı veya çok yakın")));
  assert.ok(warnings.some(w => w.includes("%25'ten fazla")));
  const fallbackWarnings: string[] = [];
  const fallback = await loadMedicalFiles([file(null, 2), file(0, 1)], undefined, w => fallbackWarnings.push(w));
  assert.equal(fallback[0].slicePositions, undefined);
  assert.ok(fallbackWarnings.some(w => w.includes("geometriden doğrulanamadı")));
  const varied: string[] = [];
  const differing = await loadMedicalFiles([file(0, 1), file(1, 2, "0\\1\\0\\-1\\0\\0")], undefined, w => varied.push(w));
  assert.equal(differing[0].slicePositions, undefined);
  assert.ok(varied.some(w => w.includes("tutarsız")));
  const multi: string[] = [];
  const multiSeries = await loadMedicalFiles([file(0, 1, "1\\0\\0\\0\\1\\0", 3)], undefined, w => multi.push(w));
  assert.equal(multiSeries[0].unverifiedMultiFrameGeometry, true);
  assert.equal(volumeGeometry(multiSeries[0]), null);
  assert.ok(multi.some(w => w.includes("MPR ve 3B hacim")));
  assert.ok(!multi.some(w => w.includes("geometriden doğrulanamadı")), "çok kareli ciné geometrisi yanlış uyarılmamalı");
  const normal: string[] = [];
  await loadMedicalFiles([file(0, 1), file(1, 2), file(2, 3), file(3, 4)], undefined, w => normal.push(w));
  assert.deepEqual(normal, []);
  console.log("PASS DICOM seri geometri kontrolü, sıralama, uyarılar ve çok kareli istisna");
}
run().catch(e => { console.error(e); process.exitCode = 1; });
