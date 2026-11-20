import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync, constants } from 'node:zlib';
import mapshaper from 'mapshaper';

const [descriptorFile, archive, output] = process.argv.slice(2);
const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8'));
const destination = resolve(output);
const root = resolve(import.meta.dirname, '../..');
const python = process.env.TZDB_PYTHON ?? 'python3';
const { internal, geom } = mapshaper;
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function geometryTask(action, ...files) {
  const script = resolve(import.meta.dirname, 'geometry.py');
  const result = spawnSync(python, [script, action, ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Geometry ' + action + ' failed');
}

function restoreNear(arcs, regions) {
  const { xx, yy, zz } = arcs.getVertexData();
  const interval = arcs.getRetainedInterval();
  for (const { point: [lon, lat], metres } of regions.values()) {
    const yRadius = metres / 111320;
    const xRadius = yRadius / Math.max(0.01, Math.cos(lat * Math.PI / 180));
    for (let i = 0; i < xx.length; ++i) {
      const dx = Math.abs(xx[i] - lon);
      if (zz[i] < interval && Math.abs(yy[i] - lat) <= yRadius && Math.min(dx, 360 - dx) <= xRadius) {
        zz[i] = Infinity;
      }
    }
  }
}

function simplify(source, counts, candidate, issueFile) {
  mapshaper.enableLogging();
  const dataset = internal.importFile(source, {});
  const arcs = dataset.arcs;
  const rings = [];
  const zoneArcs = new Map();
  for (const layer of dataset.layers) {
    const records = layer.data.getRecords();
    for (const [index, shape] of layer.shapes.entries()) {
      if (!shape) continue;
      const ids = new Set();
      for (const ring of shape) {
        rings.push(geom.getPlanarPathArea(ring, arcs) >= 0 ? ring : ring.toReversed().map((ref) => ~ref));
        for (const ref of ring) ids.add(ref < 0 ? ~ref : ref);
      }
      zoneArcs.set(records[index].tzid, ids);
    }
  }

  const options = internal.getStandardSimplifyOpts(dataset, { method: 'dp', interval: '150m' });
  internal.simplifyPaths(arcs, options);
  arcs.setRetainedInterval(internal.convertSimplifyInterval(options.interval, dataset, options));
  const { zz, ii, nn } = arcs.getVertexData();
  const base = zz.slice();
  const regions = new Map();
  const fullArcs = new Set();
  for (let attempt = 0; attempt < 6; ++attempt) {
    zz.set(base);
    for (const ring of rings) internal.protectShape(arcs, [ring]);
    restoreNear(arcs, regions);
    for (const id of fullArcs) zz.fill(Infinity, ii[id], ii[id] + nn[id]);
    internal.finalizeSimplification(dataset, options);
    const [{ content }] = internal.exportTopoJSON(dataset, { no_quantization: true, final: false });
    writeFileSync(candidate, content);
    geometryTask('inspect', candidate, counts, issueFile);
    const issues = readJSON(issueFile);
    console.log('Simplification check found ' + issues.length + ' invalid zones');
    if (!issues.length) return;
    for (const issue of issues) {
      console.log(issue.tzid + ' — ' + issue.reason);
      if (issue.point && issue.point.every(Number.isFinite)) {
        const key = issue.point.join(',');
        const metres = (regions.get(key)?.metres ?? 1000) * 2;
        regions.set(key, { point: issue.point, metres });
      } else {
        for (const id of zoneArcs.get(issue.tzid) ?? []) fullArcs.add(id);
      }
    }
  }
  throw new Error('Could not simplify while preserving all valid zones and rings');
}

function buildBinary(topology, outputFile, release) {
  for (const points of [8192, 16384, 32768]) {
    const builder = resolve(root, 'scripts', 'build.ts');
    const result = spawnSync(process.execPath, [builder, topology, outputFile, release, String(points)], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 0) {
      console.log(result.stdout.trim());
      return points;
    }
    if (!result.stderr.includes('1 MB budget exceeded')) throw new Error(result.stderr);
    console.log('Trying a larger compression block to preserve the geometry under 1 MB');
  }
  throw new Error('The updated database exceeds the 1 MB budget');
}

mkdirSync(destination, { recursive: true });
const temp = mkdtempSync(join(destination, 'prepare-'));
try {
  const source = join(temp, 'world.geojson');
  const counts = join(temp, 'counts.json');
  const simplified = join(temp, 'simplified.json');
  const rounded = join(temp, 'rounded.json');
  const binaryPath = join(destination, 'world.tzdb');
  geometryTask('extract', archive, descriptorFile, source, counts);
  simplify(source, counts, simplified, join(temp, 'issues.json'));
  geometryTask('round', simplified, counts, rounded);

  const pointsPerBlock = buildBinary(rounded, binaryPath, descriptor.release);
  const topology = brotliCompressSync(readFileSync(rounded), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const binary = readFileSync(binaryPath);
  const shapes = Object.values(readJSON(counts));
  const manifest = {
    release: descriptor.release,
    source_sha256: descriptor.source_sha256,
    prepared_sha256: sha256(topology),
    binary_sha256: sha256(binary),
    checked_at: new Date().toISOString().slice(0, 10),
    zones: shapes.length,
    polygons: shapes.reduce((count, [parts]) => count + parts, 0),
    rings: shapes.reduce((count, [, rings]) => count + rings, 0),
    points_per_block: pointsPerBlock,
  };
  writeFileSync(join(destination, 'world.topo.json.br'), topology);
  writeFileSync(join(destination, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(manifest);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
