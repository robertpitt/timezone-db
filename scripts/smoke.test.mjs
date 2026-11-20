import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TimezoneClient } from '@robertpitt/timezone-db';

const bytes = readFileSync(new URL(import.meta.resolve('@robertpitt/timezone-db/world.tzdb')));

test('reads the packaged world database from a byte view', () => {
  assert.ok(bytes.byteLength < 1_000_000);
  const padded = new Uint8Array(bytes.length + 13);
  padded.set(bytes, 13);
  const db = new TimezoneClient(padded.subarray(13));
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
