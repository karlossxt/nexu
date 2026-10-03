#!/usr/bin/env python3
"""Rank unlocated road+km alerts against RNC candidate chains; never publish pins.

Usage: python3 tools/rnc-batch-review.py alerts.json rnc-national-review.json output.json [traffic.json]
The alerts input is an array exported from Supabase with road, kilometer, event_at,
latitude, longitude, location_status, state and optionally id/title.
"""
import collections
import json
import re
import sys
import unicodedata
from pathlib import Path


def tokens(value):
    value = unicodedata.normalize('NFD', str(value or '').lower())
    value = ''.join(c for c in value if unicodedata.category(c) != 'Mn')
    return [x for x in re.findall(r'[a-z0-9]+', value)
            if x not in {'autopista', 'carretera', 'de', 'del', 'la', 'el', 'cuota', 'federal', 'km'}]


def name_matches(alert_road, chain_name):
    a, b = tokens(alert_road), tokens(chain_name)
    return len(a) >= 2 and a == b


def review(alerts, report, traffic=()):
    groups = collections.defaultdict(list)
    for alert in alerts:
        if alert.get('latitude') is not None or alert.get('longitude') is not None:
            continue
        road, km = alert.get('road'), alert.get('kilometer')
        if not road or km is None:
            continue
        try:
            km = float(km)
        except (ValueError, TypeError):
            continue
        groups[(road, km)].append(alert)

    output = []
    for (road, km), rows in groups.items():
        candidates = []
        for chain in report['chains']:
            if not name_matches(road, chain['name']) or not chain['fromKm'] <= km <= chain['toKm']:
                continue
            exact = [p for p in chain['posts'] if p['km'] == km]
            candidates.append({'code': chain['code'], 'name': chain['name'],
                               'range': [chain['fromKm'], chain['toKm']],
                               'postIds': [p['id'] for p in exact],
                               'exactPost': len(exact) == 1})
        reason = ('no_matching_chain' if not candidates else
                  'ambiguous_chains' if len(candidates) > 1 else
                  'exact_post_needs_review' if candidates[0]['exactPost'] else
                  'gap_needs_review')
        samples = [s for s in traffic if name_matches(road, s.get('road'))]
        sample = max(samples, key=lambda s: s['tdpa']) if samples else None
        output.append({'road': road, 'kilometer': km, 'alerts': len(rows),
                       'states': sorted({a['state'] for a in rows if a.get('state')}),
                       'latestEventAt': max((a.get('event_at') or '' for a in rows)),
                       'alertIds': [a['id'] for a in rows if a.get('id')],
                       'trafficSample': sample,
                       'reason': reason, 'candidates': candidates,
                       'status': 'review_required'})
    if traffic:
        # A station is a sample, not a road-wide or national ranking. Missing
        # samples remain visible below the measured corridors.
        return sorted(output, key=lambda x: (-int(bool(x['trafficSample'])),
                    -(x['trafficSample']['tdpa'] if x['trafficSample'] else 0),
                    -x['alerts'], x['road'], x['kilometer']))
    return sorted(output, key=lambda x: (-x['alerts'], -bool(x['candidates']), x['road'], x['kilometer']))


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5):
        raise SystemExit(__doc__)
    alerts, source, target = map(Path, sys.argv[1:4])
    traffic = json.loads(Path(sys.argv[4]).read_text()) if len(sys.argv) == 5 else []
    result = review(json.loads(alerts.read_text()), json.loads(source.read_text()), traffic)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'groups': len(result), 'alerts': sum(r['alerts'] for r in result),
                      'exactCandidates': sum(r['reason'] == 'exact_post_needs_review' for r in result)},
                     ensure_ascii=False))
