export const HEADER_BYTES = 64;
export const FANOUT = 16;
export const POLYGON_BYTES = 20;
export const BLOCK_BYTES = 16;
export const ARC_BYTES = 16;
export const ARC_BOUNDS_STEP = 10_000;
export const COARSE_SCALE = 100;
export const MICRODEGREES = 1_000_000;
export const MAGIC = 0x42445a54; // TZDB in little endian

export function levelSizes(leaves: number): number[] {
  const sizes = [leaves];
  while (leaves > 1) {
    leaves = Math.ceil(leaves / FANOUT);
    sizes.push(leaves);
  }
  return sizes;
}

export function writeVarUint(target: number[], unsigned: number): void {
  while (unsigned >= 128) {
    target.push((unsigned & 127) | 128);
    unsigned >>>= 7;
  }
  target.push(unsigned);
}

export function writeDelta(target: number[], signed: number): void {
  writeVarUint(target, ((signed << 1) ^ (signed >> 31)) >>> 0);
}

export class Varints {
  private bytes: Uint8Array;
  private cursor: number;
  private end: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    if (start > end || end > bytes.byteLength) throw new Error('Invalid stream length');
    this.bytes = bytes;
    this.cursor = start;
    this.end = end;
  }

  get done(): boolean {
    return this.cursor === this.end;
  }

  read(): number {
    let value = 0;
    for (let shift = 0; shift < 35 && this.cursor < this.end; shift += 7) {
      const byte = this.bytes[this.cursor++];
      if (shift === 28 && byte > 15) break;
      value = (value | ((byte & 127) << shift)) >>> 0;
      if (byte < 128) return value;
    }
    throw new Error('Invalid varint');
  }

  delta(): number {
    const value = this.read();
    return (value >>> 1) ^ -(value & 1);
  }
}
