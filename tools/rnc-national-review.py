#!/usr/bin/env python3
"""Offline, conservative RNC 2025 toll-road post review. Never used at runtime.

Usage: python3 tools/rnc-national-review.py rnc2025.gpkg report.json
The GeoPackage is read-only; the full report remains outside the repository.
"""
import argparse
import collections
import json
import math
import sqlite3
import struct
from pathlib import Path

EARTH_M_PER_DEG = 111_195
MAX_SNAP_M = 120
AMBIGUITY_M = 30
MAX_GAP_KM = 3
MIN_CHAIN_POSTS = 4


def geometry(blob):
    if not blob or blob[:2] != b'GP':
        raise ValueError('Expected GeoPackage geometry')
    flags = blob[3]
    envelope = (0, 32, 48, 48, 64, 0, 0, 0)[(flags >> 1) & 7]
    pos = 8 + envelope
    endian = '<' if blob[pos] == 1 else '>'
    kind = struct.unpack_from(endian + 'I', blob, pos + 1)[0] % 1000
    pos += 5
    if kind == 1:
        return [struct.unpack_from(endian + 'dd', blob, pos)]
    if kind != 2:
        raise ValueError(f'Unexpected geometry type {kind}')
    count = struct.unpack_from(endian + 'I', blob, pos)[0]
    return [struct.unpack_from(endian + 'dd', blob, pos + 4 + i * 16) for i in range(count)]


def closest_on_line(lon, lat, vertices):
    scale = math.cos(math.radians(lat))
    best = (float('inf'), lon, lat)
    for a, b in zip(vertices, vertices[1:]):
        dx = (b[0] - a[0]) * scale
        dy = b[1] - a[1]
        denom = dx * dx + dy * dy
        t = max(0, min(1, (((lon - a[0]) * scale * dx + (lat - a[1]) * dy) / denom) if denom else 0))
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        distance = math.hypot((lon - x) * scale, lat - y) * EARTH_M_PER_DEG
        if distance < best[0]:
            best = (distance, x, y)
    return best


def separation_m(a, b):
    lat = (a['lat'] + b['lat']) / 2
    return math.hypot((a['lon'] - b['lon']) * math.cos(math.radians(lat)), a['lat'] - b['lat']) * EARTH_M_PER_DEG


def pair_ok(a, b):
    gap = b['km'] - a['km']
    if gap <= 0 or gap > MAX_GAP_KM:
        return False
    distance = separation_m(a, b)
    return max(0, gap * 550 - 150) <= distance <= gap * 1080 + 150


def reviewed_chains(assigned):
    """Never pick a winner among repeated km of one code, even across names."""
    by_code_km = collections.Counter((p['code'], p['km']) for p in assigned)
    blocked = {key for key, count in by_code_km.items() if count > 1}
    flagged = [{**p, 'reason': 'duplicate_km_same_code'} for p in assigned if by_code_km[p['code'], p['km']] > 1]
    unique = [p for p in assigned if by_code_km[p['code'], p['km']] == 1]
    groups = collections.defaultdict(list)
    for p in unique:
        groups[(p['code'], p['name'])].append(p)
    chains = []
    for (code, name), posts in sorted(groups.items()):
        posts.sort(key=lambda p: p['km'])
        current = []

        def finish():
            if len(current) >= MIN_CHAIN_POSTS:
                chains.append({'code': code, 'name': name, 'toll': True,
                               'fromKm': current[0]['km'], 'toKm': current[-1]['km'],
                               'posts': current[:]})
            else:
                flagged.extend({**p, 'reason': 'short_or_isolated_chain'} for p in current)

        for p in posts:
            crosses_duplicate = current and any((code, k) in blocked for k in range(current[-1]['km'] + 1, p['km']))
            if current and (crosses_duplicate or not pair_ok(current[-1], p)):
                finish()
                current = []
            current.append(p)
        if current:
            finish()
    return chains, flagged


def validate_anchors(chains, anchors, tolerance_m=500):
    """Independent anchors must name a route code; never choose any nearby code."""
    results = []
    for anchor in anchors:
        code, km = str(anchor['code']), float(anchor['km'])
        possible = []
        for chain in chains:
            if chain['code'] != code or (anchor.get('name') and anchor['name'] != chain['name']):
                continue
            points = chain['posts']
            for a, b in zip(points, points[1:]):
                if a['km'] <= km <= b['km']:
                    factor = (km - a['km']) / (b['km'] - a['km'])
                    possible.append({'lat': a['lat'] + factor * (b['lat'] - a['lat']),
                                     'lon': a['lon'] + factor * (b['lon'] - a['lon'])})
                    break
        if len(possible) != 1:
            results.append({'code': code, 'km': km, 'result': 'ambiguous' if possible else 'not_covered'})
            continue
        error = round(separation_m(anchor, possible[0]))
        results.append({'code': code, 'km': km, 'result': 'ok' if error <= tolerance_m else 'outside_tolerance',
                        'errorM': error})
    errors = sorted(r['errorM'] for r in results if r['result'] == 'ok')
    return {'total': len(anchors), 'coveredExactlyOnce': sum('errorM' in r for r in results),
            'withinTolerance': len(errors), 'medianErrorM': errors[len(errors) // 2] if errors else None,
            'results': results}


def nearby_roads(db, lon, lat, max_snap_m=MAX_SNAP_M):
    # Expand the RTree window a little beyond the metric threshold. The exact
    # projection below makes the final distance decision.
    delta_lat = (max_snap_m + 40) / EARTH_M_PER_DEG
    delta_lon = delta_lat / max(.2, math.cos(math.radians(lat)))
    query = '''select r.ID_RED,r.CODIGO,r.PEAJE,r.NOMBRE,r.geom
               from rtree_red_vial_geom as bbox join red_vial as r on r.fid=bbox.id
               where bbox.minx<=? and bbox.maxx>=? and bbox.miny<=? and bbox.maxy>=?
                 and r.PEAJE in ('Si','No') and r.CODIGO is not null'''
    found = []
    for road_id, code, toll, name, blob in db.execute(query, (lon + delta_lon, lon - delta_lon, lat + delta_lat, lat - delta_lat)):
        code = str(code or '').strip()
        if not code.isdigit() or not 1 <= int(code) <= 999:
            continue
        dist, x, y = closest_on_line(lon, lat, geometry(blob))
        if dist <= max_snap_m:
            found.append({'roadId': road_id, 'code': code, 'toll': toll == 'Si',
                          'name': str(name or '').strip(), 'snapM': round(dist, 1),
                          'snappedLon': x, 'snappedLat': y})
    return sorted(found, key=lambda r: r['snapM'])


def assign_post(post, candidates, ambiguity_m=AMBIGUITY_M):
    toll = [r for r in candidates if r['toll'] and r['name']]
    if not toll:
        return None, 'no_named_toll_road_within_120m'
    best = toll[0]
    for other in candidates:
        if other is best or other['snapM'] > best['snapM'] + ambiguity_m:
            continue
        if not other['toll'] or other['code'] != best['code']:
            return None, 'ambiguous_free_or_other_code'
        if other['name'] and other['name'] != best['name']:
            return None, 'ambiguous_corridor_name'
    return {**post, **best}, None


def build_report(db, limit=0):
    assigned, flagged = [], []
    stats = collections.Counter()
    cursor = db.execute('select ID_KM,KM,geom from poste_de_referencia')
    for ident, km, blob in cursor:
        if limit and stats['totalPosts'] >= limit:
            break
        stats['totalPosts'] += 1
        lon, lat = geometry(blob)[0]
        post = {'id': ident, 'km': km, 'lat': lat, 'lon': lon}
        if km is None or km < 0 or km > 2000:
            flagged.append({**post, 'reason': 'invalid_or_extreme_km'})
            continue
        selected, reason = assign_post(post, nearby_roads(db, lon, lat))
        if selected:
            assigned.append(selected)
        else:
            flagged.append({**post, 'reason': reason})
        if stats['totalPosts'] % 5000 == 0:
            print(f"reviewed {stats['totalPosts']} posts", flush=True)
    chains, chain_flags = reviewed_chains(assigned)
    flagged.extend(chain_flags)
    reasons = collections.Counter(p['reason'] for p in flagged)
    output = {'status': 'review_required', 'source': 'INEGI RNC 2025 GeoPackage',
              'policy': {'tollOnly': True, 'maxSnapM': MAX_SNAP_M, 'ambiguityM': AMBIGUITY_M,
                         'maxGapKm': MAX_GAP_KM, 'minChainPosts': MIN_CHAIN_POSTS,
                         'duplicateKm': 'reject every duplicate within route code',
                         'runtimeUse': 'none'},
              'summary': {'totalPosts': stats['totalPosts'], 'assignedBeforeChainReview': len(assigned),
                          'candidateChains': len(chains), 'candidatePosts': sum(len(c['posts']) for c in chains),
                          'flagged': len(flagged), 'reasons': dict(reasons),
                          'byCode': {code: {'chains': sum(c['code'] == code for c in chains),
                                             'posts': sum(len(c['posts']) for c in chains if c['code'] == code)}
                                     for code in sorted({c['code'] for c in chains}, key=int)}},
              'chains': chains, 'flaggedPosts': flagged}
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('gpkg', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--limit', type=int, default=0, help='Sample first N posts for a smoke run')
    parser.add_argument('--anchors', type=Path, help='Optional trusted anchors JSON: code, km, lat, lon, optional name')
    args = parser.parse_args()
    db = sqlite3.connect(f'file:{args.gpkg}?mode=ro', uri=True)
    report = build_report(db, args.limit)
    if args.anchors:
        report['anchorValidation'] = validate_anchors(report['chains'], json.loads(args.anchors.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report['summary'], ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
