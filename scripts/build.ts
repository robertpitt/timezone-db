import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import {
  HEADER_BYTES, FANOUT, POLYGON_BYTES, BLOCK_BYTES, MAGIC, COARSE_SCALE,
  MICRODEGREES, ARC_BYTES, ARC_BOUNDS_STEP, writeDelta, writeVarUint,
} from '../src/format.ts';

type Point = [number, number];
type Box = [number, number, number, number];
type Polygon = number[][];
type Shape = { properties: { tzid: string } } & (
  { type: 'Polygon'; arcs: Polygon } | { type: 'MultiPolygon'; arcs: Polygon[] }
);
type Topology = { arcs: Point[][]; objects: Record<string, { geometries: Shape[] }> };
type Part = { bounds: Box; zone: number; rings: Polygon };

const REGION_BYTES = 16;

function bbox(arc: Point[]): Box {
  const bounds: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of arc) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

function merge(boxes: Box[]): Box {
  return [
    Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3])),
  ];
}

function sortParts(parts: Part[]): Part[] {
  const middle = (part: Part, axis: number) => part.bounds[axis] + part.bounds[axis + 2];
  const width = Math.ceil(Math.sqrt(parts.length / FANOUT)) * FANOUT;
  parts.sort((a, b) => middle(a, 0) - middle(b, 0));
  const ordered = [];
  for (let i = 0; i < parts.length; i += width) {
    ordered.push(...parts.slice(i, i + width).sort((a, b) => middle(a, 1) - middle(b, 1)));
  }
  return ordered;
}

function parentBoxes(children: Box[]): Box[] {
  const parents = [];
  for (let i = 0; i < children.length; i += FANOUT) {
    parents.push(merge(children.slice(i, i + FANOUT)));
  }
  return parents;
}

function zoneTable(names: string[]): Buffer {
  const offsets = Buffer.alloc((names.length + 1) * 2);
  const labels = names.map(name => Buffer.from(name, 'utf8'));
  let start = 0;
  for (let i = 0; i < labels.length; i++) {
    offsets.writeUInt16LE(start, i * 2);
    start += labels[i].length;
  }
  offsets.writeUInt16LE(start, labels.length * 2);
  return Buffer.concat([offsets, ...labels]);
}

function blockPayload(arcs: Point[][]): Buffer {
  const sizes: number[] = [], east: number[] = [], north: number[] = [], details: number[] = [];
  let index = 0, previousDetail = 0;
  for (const arc of arcs) {
    writeVarUint(sizes, arc.length);
    let previousX = 0, previousY = 0;
    for (const [x, y] of arc) {
      const gx = Math.sign(x) * Math.floor((Math.abs(x) + COARSE_SCALE / 2) / COARSE_SCALE);
      const gy = Math.sign(y) * Math.floor((Math.abs(y) + COARSE_SCALE / 2) / COARSE_SCALE);
      writeDelta(east, gx - previousX);
      writeDelta(north, gy - previousY);
      previousX = gx;
      previousY = gy;
      const rx = x - gx * COARSE_SCALE, ry = y - gy * COARSE_SCALE;
      if (rx !== 0 || ry !== 0) {
        writeVarUint(details, index - previousDetail);
        writeDelta(details, rx);
        writeDelta(details, ry);
        previousDetail = index;
      }
      index++;
    }
  }
  const header = Buffer.alloc(16);
  [index, sizes.length, east.length, north.length].forEach((n, i) => header.writeUInt32LE(n, i * 4));
  return Buffer.concat([header, ...[sizes, east, north, details].map(s => Buffer.from(s))]);
}

function build(input: Topology, release: string, pointTarget: number): Buffer {
  const shapes = Object.values(input.objects).flatMap(layer => layer.geometries);
  const labels = shapes.map(shape => shape.properties.tzid);
  if (new Set(labels).size !== labels.length) throw new Error('Duplicate timezone ID');
  const coords = input.arcs.map(arc => {
    if (arc.length < 2) throw new Error('Arc is too short');
    return arc.map(([lon, lat]): Point => {
      const x = Math.round(lon * MICRODEGREES), y = Math.round(lat * MICRODEGREES);
      if (!Number.isFinite(x + y) || Math.abs(x) > 180 * MICRODEGREES || Math.abs(y) > 90 * MICRODEGREES ||
          x / MICRODEGREES !== lon || y / MICRODEGREES !== lat) {
        throw new Error('Coordinate is outside the input precision or range');
      }
      return [x, y];
    });
  });
  const bounds = coords.map(bbox);
  const parts = sortParts(shapes.flatMap((shape, zone) => {
    const polygons = shape.type === 'Polygon' ? [shape.arcs] : shape.arcs;
    return polygons.map(rings => ({
      rings, zone, bounds: merge(rings[0].map(id => bounds[id >= 0 ? id : ~id])),
    }));
  }));
  if (!parts.length) throw new Error('No polygons');
  const allRings = parts.flatMap(part => part.rings);
  const allRefs = allRings.flat();
  if (coords.length > 32768 || Math.max(...[labels.length, parts.length, allRings.length, allRefs.length]) > 65535) {
    throw new Error('Dataset exceeds layout limits');
  }
  const table = Buffer.alloc(parts.length * POLYGON_BYTES);
  let ringIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const offset = i * POLYGON_BYTES;
    const part = parts[i];
    part.bounds.forEach((n, j) => table.writeInt32LE(n, offset + j * 4));
    table.writeUInt16LE(part.zone, offset + 16);
    table.writeUInt16LE(ringIndex, offset + 18);
    ringIndex += part.rings.length;
  }
  let children = parts.map(part => part.bounds);
  const nodes: Box[] = [];
  while (children.length > 1) {
    children = parentBoxes(children);
    nodes.push(...children);
  }
  const tree = Buffer.alloc(nodes.length * REGION_BYTES);
  nodes.forEach((node, i) => node.forEach((n, j) => tree.writeInt32LE(n, i * REGION_BYTES + j * 4)));

  const rings = Buffer.alloc((allRings.length + 1) * 2);
  let first = 0;
  for (let i = 0; i < allRings.length; i++) {
    rings.writeUInt16LE(first, i * 2);
    first += allRings[i].length;
  }
  rings.writeUInt16LE(first, allRings.length * 2);
  const refs = Buffer.alloc(allRefs.length * 2);
  allRefs.forEach((ref, i) => refs.writeInt16LE(ref, i * 2));
  const arcIndex = Buffer.alloc(coords.length * ARC_BYTES);
  for (let i = 0; i < coords.length; i++) {
    const offset = i * ARC_BYTES;
    const [west, south, east, north] = bounds[i];
    arcIndex.writeInt16LE(Math.floor(west / ARC_BOUNDS_STEP), offset);
    arcIndex.writeInt16LE(Math.floor(south / ARC_BOUNDS_STEP), offset + 2);
    arcIndex.writeInt16LE(Math.ceil(east / ARC_BOUNDS_STEP), offset + 4);
    arcIndex.writeInt16LE(Math.ceil(north / ARC_BOUNDS_STEP), offset + 6);
    arcIndex.writeInt32LE(coords[i][0][1], offset + 8);
    arcIndex.writeInt32LE(coords[i][coords[i].length - 1][1], offset + 12);
  }

  const blocks: { first: number; arcCount: number; rawLength: number; data: Buffer }[] = [];
  function append(start: number, end: number) {
    const raw = blockPayload(coords.slice(start, end));
    const data = brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 17 },
    });
    blocks.push({ first: start, arcCount: end - start, rawLength: raw.length, data });
  }
  let start = 0, points = 0;
  for (let i = 0; i < coords.length; i++) {
    if (start < i && points + coords[i].length > pointTarget) {
      append(start, i);
      start = i;
      points = 0;
    }
    points += coords[i].length;
  }
  append(start, coords.length);

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt16LE(1, 4);
  header[6] = FANOUT;
  header[7] = 1; // Brotli
  [labels.length, parts.length, allRings.length, allRefs.length, coords.length, blocks.length, COARSE_SCALE]
    .forEach((n, i) => header.writeUInt16LE(n, 8 + i * 2));
  const section = [zoneTable(labels), table, tree, rings, Buffer.concat([refs, arcIndex]), Buffer.alloc(blocks.length * BLOCK_BYTES)];
  let cursor = HEADER_BYTES;
  section.forEach((bytes, i) => {
    header.writeUInt32LE(cursor, 24 + i * 4);
    cursor += bytes.length;
  });
  const directory = section[5];
  blocks.forEach((block, i) => {
    const offset = i * BLOCK_BYTES;
    directory.writeUInt32LE(cursor, offset);
    directory.writeUInt32LE(block.data.length, offset + 4);
    directory.writeUInt32LE(block.rawLength, offset + 8);
    directory.writeUInt16LE(block.first, offset + 12);
    directory.writeUInt16LE(block.arcCount, offset + 14);
    cursor += block.data.length;
  });
  header.writeUInt32LE(cursor, 48);
  if (!/^[a-z0-9.-]{1,11}$/i.test(release)) throw new Error('Invalid release ID');
  header[52] = release.length;
  header.write(release, 53, 'ascii');
  return Buffer.concat([header, ...section, ...blocks.map(block => block.data)]);
}

const root = resolve(import.meta.dirname, '..');
const dataPath = resolve(root, 'data');
const snapshot = process.argv.length === 2;
const manifest = JSON.parse(readFileSync(resolve(dataPath, 'release.json'), 'utf8'));
const [
  source = resolve(dataPath, 'world.topo.json.br'),
  output = resolve(root, 'dist', 'world.tzdb'),
  release = manifest.release,
  perBlock = String(manifest.points_per_block),
] = process.argv.slice(2);
const pointTarget = Number(perBlock);
if (!source || !output || !Number.isInteger(pointTarget) || pointTarget < 64) {
  throw new Error('Usage: build.ts INPUT_TOPOJSON OUTPUT_TZDB [RELEASE] [POINTS_PER_BLOCK]');
}
const contents = readFileSync(source);
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
if (snapshot && checksum(contents) !== manifest.prepared_sha256) throw new Error('Prepared topology checksum mismatch');
const input = JSON.parse((source.endsWith('.br') ? brotliDecompressSync(contents) : contents).toString('utf8')) as Topology;
const bytes = build(input, release, pointTarget);
if (bytes.length >= 1_000_000) throw new Error('1 MB budget exceeded: ' + bytes.length);
if (snapshot && (checksum(bytes) !== manifest.binary_sha256 || !bytes.equals(readFileSync(resolve(dataPath, 'world.tzdb'))))) {
  throw new Error('Rebuilt binary differs from the committed snapshot');
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, bytes);
console.log({ bytes: bytes.length, payloadOffset: bytes.readUInt32LE(bytes.readUInt32LE(44)), blocks: bytes.readUInt16LE(18) });
