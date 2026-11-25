/** DICOM C.7.9.2; invalid segments are rejected, never partially rendered. */
function expand(words: readonly number[], expected: number, bits: 8 | 16, bigEndian: boolean): number[] | null {
  type Segment = { opcode: number; length: number; data: number[] };
  if (!Number.isInteger(expected) || expected < 1 || expected > 65536) return null;
  const segments = new Map<number, Segment>();
  let offset = 0;
  while (offset < words.length) {
    if (bits === 8 && offset === words.length - 1 && words[offset] === 0) break;
    const start = offset;
    if (offset + 2 > words.length) return null;
    const opcode = words[offset++], length = words[offset++];
    if (!Number.isInteger(length) || length <= 0 || !Number.isInteger(opcode) || opcode < 0 || opcode > 2) return null;
    const size = opcode === 0 ? length : opcode === 1 ? 1 : bits === 8 ? 4 : 2;
    if (offset + size > words.length) return null;
    const data = words.slice(offset, offset + size);
    if (data.some(n => !Number.isInteger(n) || n < 0 || n > (bits === 8 ? 255 : 65535))) return null;
    segments.set(start, { opcode, length, data });
    offset += size;
  }
  const out: number[] = [];
  // NumPy/pydicom rounds midpoint values to even, rather than always upwards.
  const roundEven = (value: number) => {
    const floor = Math.floor(value), fraction = value - floor;
    return fraction === 0.5 ? floor + (floor % 2) : Math.round(value);
  };
  const apply = (segment: Segment): boolean => {
    if (segment.opcode === 0) {
      if (out.length + segment.length > expected) return false;
      out.push(...segment.data);
      return true;
    }
    if (segment.opcode === 1) {
      if (!out.length || out.length + segment.length > expected) return false;
      const first = out[out.length - 1], last = segment.data[0];
      for (let i = 1; i <= segment.length; i++) out.push(roundEven(first + (last - first) * i / segment.length));
      return true;
    }
    if (!out.length) return false;
    const byteOffset = bits === 16
      ? segment.data[0] + segment.data[1] * 65536
      : bigEndian
        ? segment.data[1] + segment.data[0] * 256 + segment.data[3] * 65536 + segment.data[2] * 16777216
        : segment.data[0] + segment.data[1] * 256 + segment.data[2] * 65536 + segment.data[3] * 16777216;
    if (bits === 16 && byteOffset % 2) return false;
    let cursor = bits === 16 ? byteOffset / 2 : byteOffset;
    for (let i = 0; i < segment.length; i++) {
      const referenced = segments.get(cursor);
      if (!referenced || referenced.opcode === 2 || !apply(referenced)) return false;
      cursor += 2 + (referenced.opcode === 0 ? referenced.length : 1);
    }
    return true;
  };
  for (const segment of segments.values()) if (!apply(segment)) return null;
  return out.length === expected ? out : null;
}

export function expandSegmentedPalette16(words: readonly number[], expected: number): Uint16Array | null {
  const out = expand(words, expected, 16, false);
  return out && Uint16Array.from(out);
}

export function expandSegmentedPalette8(bytes: readonly number[], expected: number, bigEndian: boolean): Uint8Array | null {
  const out = expand(bytes, expected, 8, bigEndian);
  return out && Uint8Array.from(out);
}
