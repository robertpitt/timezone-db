import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const repository = 'evansiroky/timezone-boundary-builder';
const archiveName = 'timezones-with-oceans.geojson.zip';
const [releaseFile, currentFile, destination] = process.argv.slice(2);
const upstream = JSON.parse(readFileSync(releaseFile, 'utf8'));
const current = JSON.parse(readFileSync(currentFile, 'utf8'));
const release = upstream.tag_name;
const asset = upstream.assets?.find(({ name }) => name === archiveName);

if (upstream.draft !== false || upstream.prerelease !== false ||
    !/^\d{4}[a-z]{1,7}$/.test(release) || !asset ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
    !Number.isSafeInteger(asset.id) || asset.id <= 0) {
  throw new Error('The upstream release is missing a verifiable world archive');
}
if (release < current.release) throw new Error('Upstream latest release is older than the committed snapshot');
const descriptor = {
  release,
  source_sha256: asset.digest.slice(7),
  size: asset.size,
  url: 'https://github.com/' + repository + '/releases/download/' + release + '/' + archiveName,
  asset_url: 'https://api.github.com/repos/' + repository + '/releases/assets/' + asset.id + '?download=1',
};
writeFileSync(destination, JSON.stringify(descriptor) + '\n');

const changed = release !== current.release || descriptor.source_sha256 !== current.source_sha256;
const verify = process.env.TZDB_VERIFY_CURRENT === 'true';
const lastCheck = Date.parse(current.checked_at);
if (!Number.isFinite(lastCheck)) throw new Error('Invalid snapshot check date');
const checkpoint = !changed && !verify && Date.now() - lastCheck >= 42 * 86400000;
const outputs = { release, changed, rebuild: changed || verify, checkpoint, url: descriptor.url, asset_url: descriptor.asset_url };
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => key + '=' + value).join('\n') + '\n');
}
console.log({ release, current: current.release, changed, rebuild: outputs.rebuild, checkpoint });
