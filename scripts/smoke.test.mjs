import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TimezoneClient } from '@robertpitt/timezone-db';

const bytes = readFileSync(new URL(import.meta.resolve('@robertpitt/timezone-db/world.tzdb')));
const manifest = JSON.parse(readFileSync(new URL('../data/release.json', import.meta.url), 'utf8'));

test('reads the packaged world database from a byte view', () => {
  assert.ok(bytes.byteLength < 1_000_000);
  const padded = new Uint8Array(bytes.length + 13);
  padded.set(bytes, 13);
  const db = new TimezoneClient(padded.subarray(13));
  assert.equal(db.release, manifest.release);
  assert.equal(db.getStats().decodedBlocks, 0);
  assert.equal(db.lookup(-0.1278, 51.5074), 'Europe/London');
  assert.equal(db.lookup(77.209, 28.6139), 'Asia/Kolkata');
  assert.equal(db.lookup(-140, 0), 'Etc/GMT+9');
  const dateline = db.lookupAll(180, 0);
  assert.ok(dateline.length > 1);
  assert.deepEqual(dateline, db.lookupAll(-180, 0));
});

test('rejects a truncated binary', () => {
  assert.throws(() => new TimezoneClient(bytes.subarray(0, -1)), /Invalid/);
});

test('reconstructs the closed polygon rings for the map', () => {
  const db = new TimezoneClient(bytes, 64);
  const zones = new Set();
  let parts = 0;
  let rings = 0;
  for (const { tzid, rings: polygonRings } of db.polygonShapes()) {
    zones.add(tzid);
    parts++;
    for (const ring of polygonRings) {
      assert.ok(ring.length >= 8);
      assert.equal(ring[0], ring[ring.length - 2]);
      assert.equal(ring[1], ring[ring.length - 1]);
      rings++;
    }
  }
  assert.equal(zones.size, manifest.zones);
  assert.equal(parts, manifest.polygons);
  assert.equal(rings, manifest.rings);
});
