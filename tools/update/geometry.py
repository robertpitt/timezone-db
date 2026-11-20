import hashlib
import json
import math
import re
import shutil
import sys
from pathlib import Path
from zipfile import ZipFile

import numpy as np
from shapely import MultiPolygon, Polygon, is_valid_reason


def read_json(path):
    with path.open() as stream:
        return json.load(stream)


def extract(archive, descriptor_path, destination, counts_file):
    descriptor = read_json(descriptor_path)
    with archive.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    if sha != descriptor['source_sha256'] or archive.stat().st_size != descriptor['size']:
        raise ValueError('Downloaded archive does not match the upstream release')
    with ZipFile(archive) as source:
        geodata = [f for f in source.infolist()
                   if not f.is_dir() and Path(f.filename).suffix.lower() in ('.json', '.geojson')]
        if len(geodata) != 1:
            raise ValueError('Expected a single GeoJSON file in the release archive')
        with source.open(geodata[0]) as payload, destination.open('wb') as output:
            shutil.copyfileobj(payload, output)

    data = read_json(destination)
    if data['type'] != 'FeatureCollection':
        raise ValueError('Expected a FeatureCollection')
    counts = {}
    for feature in data['features']:
        name = feature['properties']['tzid']
        geometry = feature['geometry']
        if not isinstance(name, str) or not name or name in counts:
            raise ValueError('Missing or duplicate timezone ID')
        if geometry['type'] == 'Polygon':
            polygons = [geometry['coordinates']]
        elif geometry['type'] == 'MultiPolygon':
            polygons = geometry['coordinates']
        else:
            raise ValueError('Expected timezone polygons')
        counts[name] = [len(polygons), sum(map(len, polygons))]
    if not counts:
        raise ValueError('Source has no timezone polygons')
    counts_file.write_text(json.dumps(counts))


def geometries(topology):
    return [g for layer in topology['objects'].values() for g in layer['geometries']]


def polygons_for(geometry):
    match geometry['type']:
        case 'Polygon':
            return [geometry['arcs']]
        case 'MultiPolygon':
            return geometry['arcs']
        case None:
            return []
        case _:
            raise ValueError('Expected a polygon topology')


def arc_id(ref):
    return ref if ref >= 0 else ~ref


def read_ring(arcs, refs):
    parts = []
    for ref in refs:
        path = arcs[arc_id(ref)]
        if len(path) < 2:
            raise ValueError('Invalid arc')
        if ref < 0:
            path = path[::-1]
        if parts and not np.array_equal(parts[-1][-1], path[0]):
            raise ValueError('Unconnected ring')
        parts.append(path[1:] if parts else path)
    result = np.concatenate(parts)
    if len(result) < 4 or not np.array_equal(result[0], result[-1]):
        raise ValueError('Invalid ring')
    return result


def issues(topology, arcs, expected):
    if 'transform' in topology:
        raise ValueError('Expected unquantized topology')
    actual = set()
    failures = []
    for geometry in geometries(topology):
        name = geometry['properties']['tzid']
        if name in actual or name not in expected:
            raise ValueError('Unexpected or duplicate timezone ID ' + name)
        actual.add(name)
        polygons = polygons_for(geometry)
        if [len(polygons), sum(map(len, polygons))] != expected[name]:
            failures.append({'tzid': name, 'reason': 'Polygon or ring count changed', 'point': None})
            continue
        try:
            paths = [[read_ring(arcs, refs) for refs in rings] for rings in polygons]
            shapes = [Polygon(rings[0], rings[1:]) for rings in paths]
            shape = shapes[0] if len(shapes) == 1 else MultiPolygon(shapes)
            reason = is_valid_reason(shape)
        except ValueError as error:
            reason = str(error)
        if reason == 'Valid Geometry':
            continue
        coordinates = re.search(r'\[([-+.\deE]+)\s+([-+.\deE]+)\]$', reason)
        point = [float(value) for value in coordinates.groups()] if coordinates else None
        failures.append({'tzid': name, 'reason': reason, 'point': point})
    failures.extend({'tzid': name, 'reason': 'Missing timezone', 'point': None}
                    for name in sorted(expected.keys() - actual))
    return failures


def inspect(topology_path, counts_file, output):
    source = read_json(topology_path)
    arcs = [np.asarray(arc, dtype=float) for arc in source['arcs']]
    output.write_text(json.dumps(issues(source, arcs, read_json(counts_file))))


def locks_for_point(arcs, point, metres):
    lon, lat = point
    lat_radius = metres / 111320
    lon_radius = lat_radius / max(0.01, math.cos(math.radians(lat)))
    radius = (lon_radius, lat_radius)
    locked = set()
    for arc in arcs:
        offsets = arc / 1_000_000 - (lon, lat)
        offsets[:, 0] = (offsets[:, 0] + 180) % 360 - 180
        low = np.minimum(offsets[:-1], offsets[1:])
        high = np.maximum(offsets[:-1], offsets[1:])
        close = np.flatnonzero(((low <= radius) & (high >= np.negative(radius))).all(axis=1))
        locked.update(map(tuple, arc[np.r_[close, close + 1]]))
    return locked


def round_safe(topology_path, counts_file, output):
    topology = read_json(topology_path)
    expected = read_json(counts_file)
    original = [np.rint(np.asarray(arc) * 1_000_000).astype(np.int64) for arc in topology['arcs']]
    coarse = [np.sign(arc) * ((np.abs(arc) + 50) // 100) * 100 for arc in original]
    zone_arcs = {
        shape['properties']['tzid']: [arc_id(ref) for p in polygons_for(shape) for ring in p for ref in ring]
        for shape in geometries(topology)
    }
    preserve = set()
    radius = 150
    for _ in range(8):
        candidate = []
        for exact, rounded in zip(original, coarse, strict=True):
            keep = np.fromiter((tuple(point) in preserve for point in exact), dtype=bool, count=len(exact))
            candidate.append(np.where(keep[:, None], exact, rounded) / 1_000_000)
        failures = issues(topology, candidate, expected)
        print(f'Rounding check found {len(failures)} invalid zones with {len(preserve)} exact positions', flush=True)
        if not failures:
            topology['arcs'] = [arc.tolist() for arc in candidate]
            output.write_text(json.dumps(topology, separators=(',', ':')))
            return
        before = len(preserve)
        for failure in failures:
            if failure['point'] is not None:
                preserve.update(locks_for_point(original, failure['point'], radius))
            else:
                for ref in zone_arcs[failure['tzid']]:
                    preserve.update(map(tuple, original[ref]))
        if len(preserve) == before:
            radius *= 2
    raise ValueError('Could not preserve valid zones after rounding')


if __name__ == '__main__':
    action, *args = sys.argv[1:]
    handler = {'extract': extract, 'inspect': inspect, 'round': round_safe}[action]
    handler(*map(Path, args))
