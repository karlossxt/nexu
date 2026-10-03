#!/usr/bin/env python3
"""Audit proposed corridor calibration against conservative RNC review chains.

Usage: python3 tools/rnc-calibration-audit.py calibration.json national-review.json output.json
This offline report NEVER approves or publishes coordinates.
"""
import json
import sys
import unicodedata
from pathlib import Path


def key(value):
    value = unicodedata.normalize('NFD', str(value or '').lower())
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in value
                            if unicodedata.category(c) != 'Mn').split())


def audit(calibration, national, max_gap=3, min_posts=4):
    output = []
    chains = national['chains']
    for corridor in calibration['corredores']:
        name = corridor['nombre']
        matching = [c for c in chains if key(c['name']) == key(name) and c.get('toll') is True]
        proposed = {a['idKm']: a for a in corridor.get('detalleAnclas', [])}
        segments = []
        for chain in matching:
            current = []
            def finish():
                if len(current) >= min_posts:
                    segments.append({'code': chain['code'], 'name': chain['name'],
                                     'fromKm': current[0]['km'], 'toKm': current[-1]['km'],
                                     'posts': [{'id': p['id'], 'km': p['km']} for p in current],
                                     'status': 'review_required'})
            for post in chain['posts']:
                # This also rejects duplicates/ambiguous posts: the national
                # review excludes them from every accepted chain.
                if post['id'] not in proposed or (current and post['km'] - current[-1]['km'] > max_gap):
                    finish()
                    current = []
                if post['id'] in proposed:
                    current.append(post)
            finish()
        output.append({'corridor': name, 'calibrationState': corridor['estado'],
                       'candidateAnchors': len(proposed),
                       'reviewChainNames': sorted({c['name'] for c in matching}),
                       'segments': segments, 'status': 'review_required'})
    return output


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    source, national, target = map(Path, sys.argv[1:])
    result = audit(json.loads(source.read_text()), json.loads(national.read_text()))
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'corridors': len(result),
                      'corridorsWithSegments': sum(bool(x['segments']) for x in result),
                      'segmentsForReview': sum(len(x['segments']) for x in result)}, ensure_ascii=False))
