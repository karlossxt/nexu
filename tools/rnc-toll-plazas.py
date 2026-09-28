#!/usr/bin/env python3
"""Build a conservative named toll-plaza catalog from RNC 2025 plaza_cobro.

Usage: python3 tools/rnc-toll-plazas.py rnc2025.gpkg worker/rnc-toll-plazas.json
Grouped lane points farther than 250 m apart are excluded for manual review.
"""
import collections
import json
import math
import re
import sqlite3
import struct
import sys
import unicodedata
from pathlib import Path


def normalized(value):
    value = unicodedata.normalize('NFD', value or '')
    return re.sub(r'\s+', ' ', ''.join(c for c in value if not unicodedata.combining(c)).lower()).strip()


def point(blob):
    if blob[:2] != b'GP':
        raise ValueError('Expected GeoPackage point')
    pos = 8 + (0, 32, 48, 48, 64, 0, 0, 0)[(blob[3] >> 1) & 7]
    endian = '<' if blob[pos] == 1 else '>'
    if struct.unpack_from(endian + 'I', blob, pos + 1)[0] % 1000 != 1:
        raise ValueError('Expected Point geometry')
    return struct.unpack_from(endian + 'dd', blob, pos + 5)


def catalog(rows, max_spread_m=250):
    grouped = collections.defaultdict(list)
    rejected = collections.Counter()
    for ident, name, section, geom in rows:
        a, b = normalized(name), normalized(section)
        if not a or not b or a in ('n/d', 'n/a', 'sin nombre') or b in ('n/d', 'n/a'):
            rejected['unnamed_or_no_section'] += 1
            continue
        lon, lat = point(geom)
        grouped[(a, b)].append((ident, name.strip(), section.strip(), lon, lat))
    selected = []
    for entries in grouped.values():
        lon = sum(e[3] for e in entries) / len(entries)
        lat = sum(e[4] for e in entries) / len(entries)
        spread = max(math.hypot((e[3]-lon)*111195*math.cos(math.radians(lat)),(e[4]-lat)*111195) for e in entries)
        if spread > max_spread_m:
            rejected['spread_over_250m'] += len(entries)
            continue
        selected.append({'name': entries[0][1], 'section': entries[0][2],
                         'lat': round(lat, 8), 'lon': round(lon, 8),
                         'sourceIds': sorted(e[0] for e in entries), 'spreadM': round(spread)})
    selected.sort(key=lambda x: (normalized(x['name']), normalized(x['section'])))
    return selected, dict(rejected)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    db = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
    rows = db.execute('select ID_PLAZA,NOMBRE,SECCION,geom from plaza_cobro')
    selected, rejected = catalog(rows)
    Path(sys.argv[2]).write_text(json.dumps(selected, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'namedPlazas': len(selected), 'excluded': rejected}, ensure_ascii=False))


if __name__ == '__main__':
    main()
