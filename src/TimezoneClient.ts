import decompress from 'brotli/decompress.js';
import { orient2d } from 'robust-predicates';
import {
  HEADER_BYTES, FANOUT, POLYGON_BYTES, BLOCK_BYTES, MAGIC, COARSE_SCALE,
  MICRODEGREES, ARC_BYTES, ARC_BOUNDS_STEP, levelSizes, Varints,
} from './format.ts';

type Block = { positions: Int32Array; offsets: Uint32Array };
export type TimezonePolygon = {
  tzid: string;
  /** Closed rings of interleaved longitude and latitude in degrees, exterior first. */
  rings: Float64Array[];
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class TimezoneClient {
  readonly release: string;
  private bytes: Uint8Array;
  private view: DataView;
  private zones: number;
  private polygons: number;
  private rings: number;
  private arcs: number;
  private blocks: number;
  private sections: number[];
  private arcIndex: number;
  private levels: number[];
  private levelOffsets: number[];
  private cacheSize: number;
  private cache = new Map<number, Block>();
  private decoded = 0;
  private names = new Map<number, string>();

  constructor(binary: ArrayBuffer | Uint8Array, cacheBlocks = 8) {
    this.bytes = ArrayBuffer.isView(binary)
      ? new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
      : new Uint8Array(binary);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (this.view.byteLength < HEADER_BYTES || this.u32(0) !== MAGIC || this.u16(4) !== 1 ||
        this.bytes[6] !== FANOUT || this.bytes[7] !== 1 || this.u16(20) !== COARSE_SCALE ||
        this.u32(48) !== this.bytes.byteLength) {
      throw new Error('Invalid or unsupported TZDB file');
    }
    if (!Number.isInteger(cacheBlocks) || cacheBlocks < 1) throw new RangeError('Invalid cache size');
    this.cacheSize = cacheBlocks;
    this.zones = this.u16(8);
    this.polygons = this.u16(10);
    this.rings = this.u16(12);
    const arcRefs = this.u16(14);
    this.arcs = this.u16(16);
    this.blocks = this.u16(18);
    this.sections = Array.from({ length: 6 }, (_, i) => this.u32(24 + i * 4));
    this.levels = levelSizes(this.polygons);
    this.levelOffsets = [0];
    let nodeCount = 0;
    for (const size of this.levels.slice(1)) {
      this.levelOffsets.push(nodeCount * 16);
      nodeCount += size;
    }
    const [labels, polygonTable, tree, ringTable, references, blocks] = this.sections;
    this.arcIndex = references + arcRefs * 2;
    let payload = blocks + this.blocks * BLOCK_BYTES;
    if (!this.polygons || !this.zones || !this.rings || !arcRefs || !this.arcs || !this.blocks ||
        labels !== HEADER_BYTES || polygonTable < labels + (this.zones + 1) * 2 ||
        tree !== polygonTable + this.polygons * POLYGON_BYTES ||
        ringTable !== tree + nodeCount * 16 || references !== ringTable + (this.rings + 1) * 2 ||
        blocks !== this.arcIndex + this.arcs * ARC_BYTES || payload > this.view.byteLength) {
      throw new Error('Invalid TZDB section layout');
    }
    let nextArc = 0;
    for (let i = 0; i < this.blocks; i++) {
      const record = blocks + i * BLOCK_BYTES;
      const packed = this.u32(record + 4), raw = this.u32(record + 8);
      const count = this.u16(record + 14);
      if (this.u32(record) !== payload || this.u16(record + 12) !== nextArc ||
          !count || !packed || raw < 16 || raw > 262144) {
        throw new Error('Invalid TZDB block directory');
      }
      payload += packed;
      nextArc += count;
    }
    if (payload !== this.bytes.byteLength || nextArc !== this.arcs || this.bytes[52] > 11) {
      throw new Error('Invalid TZDB block limits');
    }
    this.release = utf8.decode(this.bytes.subarray(53, 53 + this.bytes[52]));
  }

  lookup(lon: number, lat: number): string | null {
    return this.lookupAll(lon, lat)[0] ?? null;
  }

  lookupAll(lon: number, lat: number): string[] {
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      throw new RangeError('Longitude or latitude is outside its valid range');
    }
    const ids = new Set<number>();
    this.visit(this.levels.length - 1, 0, lon * MICRODEGREES, lat * MICRODEGREES, ids);
    if (Math.abs(lon) === 180) {
      this.visit(this.levels.length - 1, 0, -lon * MICRODEGREES, lat * MICRODEGREES, ids);
    }
    return Array.from(ids).sort((a, b) => a - b).map(zone => this.zoneName(zone));
  }

  getStats() {
    return { bytes: this.bytes.length, blocks: this.blocks, cachedBlocks: this.cache.size, decodedBlocks: this.decoded };
  }

  *polygonShapes(): IterableIterator<TimezonePolygon> {
    for (let part = 0; part < this.polygons; part++) {
      const offset = this.sections[1] + part * POLYGON_BYTES;
      const [first, end] = this.polygonRings(part);
      const rings: Float64Array[] = [];
      for (let ring = first; ring < end; ring++) {
        const [start, stop] = this.ringReferences(ring);
        const positions: number[] = [];
        for (let i = start; i < stop; i++) {
          const ref = this.view.getInt16(this.sections[4] + i * 2, true);
          const reversed = ref < 0;
          const id = reversed ? ~ref : ref;
          const { chart, first: begin, last } = this.arc(id);
          const step = reversed ? -2 : 2;
          const origin = reversed ? last - 2 : begin;
          const limit = reversed ? begin - 2 : last;
          // Consecutive arcs share one endpoint.
          for (let at = i === start ? origin : origin + step; at !== limit; at += step) {
            positions.push(chart[at] / MICRODEGREES, chart[at + 1] / MICRODEGREES);
          }
        }
        rings.push(Float64Array.from(positions));
      }
      yield { tzid: this.zoneName(this.u16(offset + 16)), rings };
    }
  }

  private u16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  private zoneName(zone: number): string {
    const cached = this.names.get(zone);
    if (cached !== undefined) return cached;
    if (zone >= this.zones) throw new Error('Invalid timezone ID');
    const labels = this.sections[0];
    const start = labels + (this.zones + 1) * 2;
    const from = start + this.u16(labels + 2 * zone);
    const to = start + this.u16(labels + 2 * (zone + 1));
    if (to <= from || to > this.sections[1]) throw new Error('Invalid timezone name');
    const value = utf8.decode(this.bytes.subarray(from, to));
    this.names.set(zone, value);
    return value;
  }

  private visit(level: number, id: number, x: number, y: number, matches: Set<number>): void {
    const offset = level === 0
      ? this.sections[1] + id * POLYGON_BYTES
      : this.sections[2] + this.levelOffsets[level] + id * 16;
    const read = (index: number) => this.view.getInt32(offset + index * 4, true);
    if (x < read(0) || y < read(1) || x > read(2) || y > read(3)) return;
    if (level > 0) {
      const end = Math.min((id + 1) * FANOUT, this.levels[level - 1]);
      for (let child = id * FANOUT; child < end; child++) this.visit(level - 1, child, x, y, matches);
      return;
    }
    const zone = this.u16(offset + 16);
    if (matches.has(zone)) return;
    const [first, end] = this.polygonRings(id);
    const exterior = this.ring(first, x, y);
    if (exterior === 0) return;
    for (let i = first + 1; i < end; i++) {
      if (this.ring(i, x, y) === 1) return;
    }
    matches.add(zone);
  }

  private polygonRings(id: number): [number, number] {
    const offset = this.sections[1] + id * POLYGON_BYTES;
    const start = this.u16(offset + 18);
    const end = id + 1 === this.polygons ? this.rings : this.u16(offset + POLYGON_BYTES + 18);
    if (start >= end || end > this.rings) throw new Error('Invalid polygon rings');
    return [start, end];
  }

  private ringReferences(index: number): [number, number] {
    const start = this.u16(this.sections[3] + index * 2);
    const end = this.u16(this.sections[3] + (index + 1) * 2);
    if (start >= end || this.sections[4] + end * 2 > this.arcIndex) throw new Error('Invalid ring references');
    return [start, end];
  }

  private ring(index: number, x: number, y: number): 0 | 1 | 2 {
    const [start, end] = this.ringReferences(index);
    let inside = false;
    for (let i = start; i < end; i++) {
      const ref = this.view.getInt16(this.sections[4] + i * 2, true);
      const id = ref < 0 ? ~ref : ref;
      if (id >= this.arcs) throw new Error('Invalid arc reference');
      const offset = this.arcIndex + id * ARC_BYTES;
      const bounds = (j: number) => this.view.getInt16(offset + 2 * j, true) * ARC_BOUNDS_STEP;
      if (y < bounds(1) || y > bounds(3) || x > bounds(2)) continue;
      if (x < bounds(0)) {
        // For an arc wholly east of the query, intermediate crossings cancel in pairs.
        const firstAbove = this.view.getInt32(offset + 8, true) > y;
        const lastAbove = this.view.getInt32(offset + 12, true) > y;
        if (firstAbove !== lastAbove) inside = !inside;
        continue;
      }
      const { chart, first, last } = this.arc(id);
      // Crossing parity and edge membership are independent of traversal direction.
      for (let a = first; a + 2 < last; a += 2) {
        const ax = chart[a], ay = chart[a + 1], bx = chart[a + 2], by = chart[a + 3];
        if (y < Math.min(ay, by) || y > Math.max(ay, by) || x > Math.max(ax, bx)) continue;
        const crosses = (ay > y) !== (by > y);
        if (x < Math.min(ax, bx)) {
          if (crosses) inside = !inside;
          continue;
        }
        const sign = orient2d(ax, ay, bx, by, x, y);
        if (sign === 0) return 2;
        if (crosses && (by > ay ? sign < 0 : sign > 0)) inside = !inside;
      }
    }
    return inside ? 1 : 0;
  }

  private arc(id: number) {
    if (id >= this.arcs) throw new Error('Invalid arc reference');
    let low = 0, high = this.blocks;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.u16(this.sections[5] + middle * BLOCK_BYTES + 12) <= id) low = middle;
      else high = middle;
    }
    const record = this.sections[5] + low * BLOCK_BYTES;
    let block = this.cache.get(low);
    if (block) this.cache.delete(low);
    else block = this.decode(record);
    this.cache.set(low, block);
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    const local = id - this.u16(record + 12);
    return { chart: block.positions, first: block.offsets[local], last: block.offsets[local + 1] };
  }

  private decode(record: number): Block {
    const start = this.u32(record);
    const raw: Uint8Array = decompress(this.bytes.subarray(start, start + this.u32(record + 4)), this.u32(record + 8));
    if (raw.length !== this.u32(record + 8)) throw new Error('Invalid Brotli block length');
    const header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const pointCount = header.getUint32(0, true);
    if (!pointCount || pointCount > raw.length) throw new Error('Invalid block position count');
    const xStart = 16 + header.getUint32(4, true);
    const yStart = xStart + header.getUint32(8, true);
    const detailStart = yStart + header.getUint32(12, true);
    const sizes = new Varints(raw, 16, xStart);
    const x = new Varints(raw, xStart, yStart), y = new Varints(raw, yStart, detailStart);
    const details = new Varints(raw, detailStart, raw.length);
    const offsets = new Uint32Array(this.u16(record + 14) + 1);
    const positions = new Int32Array(pointCount * 2);
    let cursor = 0;
    for (let arc = 0; arc + 1 < offsets.length; arc++) {
      offsets[arc] = cursor;
      const length = sizes.read();
      if (length < 2 || cursor + length * 2 > positions.length) throw new Error('Invalid arc length');
      let gx = 0, gy = 0;
      for (let j = 0; j < length; j++) {
        gx += x.delta();
        gy += y.delta();
        positions[cursor++] = gx * COARSE_SCALE;
        positions[cursor++] = gy * COARSE_SCALE;
      }
    }
    offsets[offsets.length - 1] = cursor;
    if (cursor !== positions.length || !sizes.done || !x.done || !y.done) throw new Error('Invalid coordinate streams');
    let index = 0;
    while (!details.done) {
      index += details.read();
      if (index >= pointCount) throw new Error('Invalid coordinate correction');
      positions[index * 2] += details.delta();
      positions[index * 2 + 1] += details.delta();
    }
    this.decoded++;
    return { offsets, positions };
  }
}
