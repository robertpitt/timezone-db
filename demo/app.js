import { TimezoneClient } from './TimezoneClient.js';
import { ZoneMap } from './map.js';

const examples = [
  { name: 'London', lon: -0.1278, lat: 51.5074 },
  { name: 'New York', lon: -74.006, lat: 40.7128 },
  { name: 'Mumbai', lon: 72.8777, lat: 19.076 },
  { name: 'Tokyo', lon: 139.6917, lat: 35.6895 },
  { name: 'Sydney', lon: 151.2093, lat: -33.8688 },
  { name: 'São Paulo', lon: -46.6333, lat: -23.5505 },
];
const offsetColors = [
  [-12, [153, 118, 197]], [-7, [98, 123, 211]], [-3, [79, 159, 206]],
  [0, [80, 185, 201]], [4, [85, 184, 155]], [8, [165, 189, 109]], [14, [230, 175, 103]],
];

const get = (id) => document.getElementById(id);
const result = get('timezone-result');
const selectionLabel = get('selection-label');
const otherMatches = get('other-matches');
const localTime = get('local-time');
const localDate = get('local-date');
const offsetText = get('utc-offset');
const lonInput = get('longitude');
const latInput = get('latitude');
const mapStatus = get('map-status');
const statusText = get('map-status-text');
const mapSelection = get('map-selection');
const retry = get('retry');
const zoomIn = get('zoom-in');
const zoomOut = get('zoom-out');
const reset = get('reset-map');
const cityArea = get('city-buttons');

let db;
let map;
let clock;

function offsetFormatter(tzid) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tzid, timeZoneName: 'longOffset' });
}

function readOffset(formatter, date) {
  const label = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
  if (label === 'GMT' || label === 'UTC') return { hours: 0, text: 'UTC+00:00' };
  const fields = /^(?:GMT|UTC)([+\u2212-])(\d{1,2})(?::(\d{2}))?$/.exec(label ?? '');
  if (!fields) return null;
  const [, sign, hours, minutes = '00'] = fields;
  return {
    hours: (Number(hours) + Number(minutes) / 60) * (sign === '+' ? 1 : -1),
    text: 'UTC' + (sign === '+' ? '+' : '−') + hours.padStart(2, '0') + ':' + minutes,
  };
}

function zoneColor(tzid, date) {
  try {
    const offset = readOffset(offsetFormatter(tzid), date);
    if (!offset) return '#6083a9';
    const hours = Math.max(-12, Math.min(14, offset.hours));
    const end = Math.max(1, offsetColors.findIndex(([hour]) => hour >= hours));
    const [startHour, startColor] = offsetColors[end - 1];
    const [endHour, endColor] = offsetColors[end];
    const weight = (hours - startHour) / (endHour - startHour);
    return 'rgb(' + startColor.map((channel, i) => Math.round(channel + weight * (endColor[i] - channel))).join(',') + ')';
  } catch {
    return '#6083a9';
  }
}

function setClock(tzid) {
  clock = null;
  if (tzid) {
    try {
      const timeZone = tzid;
      clock = {
        time: new Intl.DateTimeFormat('en-GB', {
          timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }),
        date: new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full' }),
        offset: offsetFormatter(tzid),
      };
    } catch {
      // The database can contain IDs newer than the browser's timezone rules.
    }
  }
  if (clock) {
    updateClock();
  } else {
    localTime.textContent = '--:--:--';
    localTime.removeAttribute('datetime');
    localDate.textContent = tzid ? 'Local time unavailable in this browser' : 'No local time for this point';
    offsetText.hidden = true;
  }
}

function updateClock() {
  if (!clock) return;
  const now = new Date();
  localTime.dateTime = now.toISOString();
  localTime.textContent = clock.time.format(now);
  localDate.textContent = clock.date.format(now);
  const offset = readOffset(clock.offset, now);
  offsetText.hidden = !offset;
  offsetText.textContent = offset?.text ?? '';
}

function select(lon, lat, example, reveal = true) {
  if (!db) return;
  const choices = db.lookupAll(lon, lat);
  const tzid = choices[0];
  selectionLabel.textContent = example?.name ?? 'Selected timezone';
  result.textContent = tzid ?? 'No timezone match';
  lonInput.value = String(lon);
  latInput.value = String(lat);
  otherMatches.hidden = choices.length < 2;
  otherMatches.textContent = choices.length < 2 ? '' : 'Also matches ' + choices.slice(1).join(', ');
  mapSelection.hidden = false;
  mapSelection.textContent = result.textContent;
  for (const button of cityArea.children) {
    button.setAttribute('aria-pressed', String(button.textContent === example?.name));
  }
  setClock(tzid);
  map.select(lon, lat, tzid, reveal);
}

function syncControls() {
  const limits = map?.zoomLimits();
  zoomIn.disabled = !limits?.canZoomIn;
  zoomOut.disabled = !limits?.canZoomOut;
  reset.disabled = !map;
}

async function load() {
  retry.hidden = true;
  mapStatus.hidden = false;
  statusText.textContent = 'Loading timezone boundaries…';
  try {
    const response = await fetch(new URL('./world.tzdb', import.meta.url));
    if (!response.ok) throw new Error('Database request returned HTTP ' + response.status);
    const binary = await response.arrayBuffer();
    const client = new TimezoneClient(binary, 64);
    const now = new Date();
    map = new ZoneMap(get('world-map'), client.polygonShapes(), (tzid) => zoneColor(tzid, now),
      (lon, lat) => select(lon, lat, undefined, false), syncControls);
    db = client;
    const summary = get('data-summary');
    summary.textContent = [
      db.release, map.paths.size + ' zones', Math.round(binary.byteLength / 1000) + ' KB binary',
    ].join(' · ');
    summary.hidden = false;
    get('lookup-fields').disabled = false;
    for (const button of cityArea.children) button.disabled = false;
    mapStatus.hidden = true;
    syncControls();
    select(examples[0].lon, examples[0].lat, examples[0]);
  } catch (error) {
    console.error(error);
    statusText.textContent = 'Could not load the timezone database.';
    retry.hidden = false;
    result.textContent = 'Map unavailable';
  }
}

for (const city of examples) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = city.name;
  button.disabled = true;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => select(city.lon, city.lat, city));
  cityArea.append(button);
}

get('lookup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  select(lonInput.valueAsNumber, latInput.valueAsNumber);
});
zoomIn.addEventListener('click', () => map?.changeZoom(1.45));
zoomOut.addEventListener('click', () => map?.changeZoom(1 / 1.45));
reset.addEventListener('click', () => map?.reset());
retry.addEventListener('click', load);
setInterval(updateClock, 1000);
load();
