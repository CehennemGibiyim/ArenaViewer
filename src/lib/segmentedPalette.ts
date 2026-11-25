/** DICOM C.7.9.2: 16-bit segmented LUT. Invalid data is rejected, never partially rendered. */
export function expandSegmentedPalette16(words: readonly number[], expected: number): Uint16Array | null {
  type Segment = { opcode: number; length: number; data: number[] };
  if (!Number.isInteger(expected) || expected < 1 || expected > 65536) return null;
  const segments = new Map<number, Segment>();
  let offset = 0;
  while (offset < words.length) {
    const start = offset;
    if (offset + 2 > words.length) return null;
    const opcode = words[offset++], length = words[offset++];
    if (!Number.isInteger(length) || length <= 0 || opcode < 0 || opcode > 2) return null;
    const size = opcode === 0 ? length : opcode === 1 ? 1 : 2;
    if (offset + size > words.length) return null;
    const data = words.slice(offset, offset + size);
    if (data.some(n => !Number.isInteger(n) || n < 0 || n > 65535)) return null;
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
    const byteOffset = segment.data[0] + segment.data[1] * 65536;
    if (byteOffset % 2) return false;
    let cursor = byteOffset / 2;
    for (let i = 0; i < segment.length; i++) {
      const referenced = segments.get(cursor);
      if (!referenced || referenced.opcode === 2 || !apply(referenced)) return false;
      cursor += 2 + (referenced.opcode === 0 ? referenced.length : 1);
    }
    return true;
  };
  for (const segment of segments.values()) if (!apply(segment)) return null;
  return out.length === expected ? Uint16Array.from(out) : null;
}
