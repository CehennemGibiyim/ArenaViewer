import assert from "node:assert/strict";
import { loadMedicalFiles } from "../src/lib/dicom";
import { parseDicom } from "dicom-parser";
import { expandSegmentedPalette16 } from "../src/lib/segmentedPalette";
import { parsePaletteColorLUT } from "../src/lib/dicomSpecial";

type Options = { be?: boolean; bits?: 8 | 16; words?: boolean; signed?: boolean; mismatch?: boolean; segmented?: boolean; truncated?: boolean };
function fixture(o: Options = {}): File {
  const be = !!o.be, bits = o.bits ?? 16;
  const word = (n: number, big = be) => { const b = Buffer.alloc(2); big ? b.writeUInt16BE(n & 65535) : b.writeUInt16LE(n & 65535); return b; };
  const el = (group: number, tag: number, vr: string, input: Buffer, big = be) => {
    const value = input.length % 2 ? Buffer.concat([input, Buffer.from([vr === "UI" ? 0 : 32])]) : input;
    const long = ["OB", "OW"].includes(vr); const h = Buffer.alloc(long ? 12 : 8);
    big ? (h.writeUInt16BE(group, 0), h.writeUInt16BE(tag, 2)) : (h.writeUInt16LE(group, 0), h.writeUInt16LE(tag, 2)); h.write(vr, 4);
    if (long) big ? h.writeUInt32BE(value.length, 8) : h.writeUInt32LE(value.length, 8);
    else big ? h.writeUInt16BE(value.length, 6) : h.writeUInt16LE(value.length, 6);
    return Buffer.concat([h, value]);
  };
  const text = (g: number, t: number, vr: string, v: string, big = be) => el(g, t, vr, Buffer.from(v), big);
  const us = (g: number, t: number, n: number) => el(g, t, "US", word(n));
  const cls = "1.2.840.10008.5.1.4.1.1.7", uid = "1.2.3.4.5";
  const meta = Buffer.concat([text(2, 2, "UI", cls, false), text(2, 3, "UI", uid, false), text(2, 0x10, "UI", be ? "1.2.840.10008.1.2.2" : "1.2.840.10008.1.2.1", false)]);
  const size = Buffer.alloc(4); size.writeUInt32LE(meta.length);
  const first = o.signed ? -1 : 0;
  const descriptor = (channel: number) => el(0x28, 0x1100 + channel, o.signed ? "SS" : "US", Buffer.concat([word(3), word(first + (channel === 2 && o.mismatch ? 1 : 0)), word(bits)]));
  const colors = [[0, 128, 255], [255, 64, 0], [10, 20, 30]];
  const channel = (i: number) => {
    const values = colors[i];
    const data = o.segmented && bits === 16 ? Buffer.concat([word(0), word(1), word(values[0] * 257), word(1), word(2), word(values[2] * 257)]) : bits === 16 ? Buffer.concat(values.map(v => word(v * 257))) : o.words ? Buffer.concat(values.map(v => word(v))) : Buffer.concat([word(values[0] | values[1] << 8), word(values[2])]);
    return el(0x28, (o.segmented ? 0x1221 : 0x1201) + i, "OW", o.truncated && i === 0 ? data.subarray(0, 2) : data);
  };
  const pixels = [first - 1, first, first + 1, first + 2, first + 3];
  const parts = [Buffer.alloc(128), Buffer.from("DICM"), el(2, 0, "UL", size, false), meta,
    text(8, 0x16, "UI", cls), text(8, 0x18, "UI", uid), text(8, 0x60, "CS", "OT"), text(0x20, 0xe, "UI", "1.2.3"),
    us(0x28, 2, 1), text(0x28, 4, "CS", "PALETTE COLOR"), us(0x28, 0x10, 1), us(0x28, 0x11, 5),
    us(0x28, 0x100, 16), us(0x28, 0x101, 16), us(0x28, 0x102, 15), us(0x28, 0x103, o.signed ? 1 : 0),
    descriptor(1), descriptor(2), descriptor(3), channel(0), channel(1), channel(2), el(0x7fe0, 0x10, "OW", Buffer.concat(pixels.map(v => word(v))))];
  return new File([Buffer.concat(parts)], "palette.dcm");
}
async function run() {
  for (const options of [{ signed: true }, { be: true, signed: true }, { bits: 8 as const, words: true, signed: true }, { bits: 8 as const, be: true, signed: true }, { bits: 8 as const, signed: true }]) {
    const f = fixture(options); const ds = parseDicom(new Uint8Array(await f.arrayBuffer()));
    const lut = parsePaletteColorLUT(ds); assert.ok(lut); assert.equal(lut.firstMapped, -1);
    assert.deepEqual(Array.from(lut.r), options.bits === 8 ? [0, 128, 255] : [0, 32896, 65535]);
    const warnings: string[] = []; const rows = await loadMedicalFiles([f], undefined, w => warnings.push(w));
    assert.deepEqual(Array.from(rows[0].rgbaSlices![0]), [0xff0aff00, 0xff0aff00, 0xff144080, 0xff1e00ff, 0xff1e00ff]);
    assert.deepEqual(warnings, []);
  }
  for (const be of [false, true]) {
    const f = fixture({ segmented: true, signed: true, be });
    const rows = await loadMedicalFiles([f]);
    assert.deepEqual(Array.from(rows[0].rgbaSlices![0]), [0xff0aff00, 0xff0aff00, 0xff148080, 0xff1e00ff, 0xff1e00ff]);
  }
  assert.deepEqual(Array.from(expandSegmentedPalette16([0, 2, 0, 10, 1, 2, 20, 2, 1, 0, 0], 6)!), [0, 10, 15, 20, 0, 10]);
  assert.deepEqual(Array.from(expandSegmentedPalette16([0, 1, 0, 1, 2, 5], 3)!), [0, 2, 5]);
  for (const bad of [[1, 1, 3], [0, 1], [0, 1, 1, 2, 1, 1, 0], [0, 1, 1, 2, 1, 6, 0], [0, 1, 1, 3, 1], [0, 1, 1, 2, 1, 0, 0]]) {
    assert.equal(expandSegmentedPalette16(bad, 1), null);
  }
  for (const opts of [{ mismatch: true }, { segmented: true, bits: 8 as const }, { truncated: true }]) {
    const warnings: string[] = []; const rows = await loadMedicalFiles([fixture(opts)], undefined, w => warnings.push(w));
    assert.equal(rows.length, 0); assert.ok(warnings.some(w => w.includes("PALETTE COLOR") && w.includes("Atlandı")));
  }
  console.log("PASS PALETTE COLOR binary descriptor, endian, signed, 8/16-bit ve güvenli red");
}
run().catch(e => { console.error(e); process.exitCode = 1; });
