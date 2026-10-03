"""Focused checks for conservative RNC chain review."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('rnc_national_review', Path(__file__).with_name('rnc-national-review.py'))
rnc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rnc)


def post(km, lon, ident=None, code='150', name='Acatzingo - Ciudad Mendoza'):
    return {'id': ident or km, 'km': km, 'lat': 19.0, 'lon': lon, 'code': code,
            'name': name, 'roadId': 1, 'snapM': 0, 'toll': True}


class ReviewTests(unittest.TestCase):
    def test_rejects_parallel_free_and_other_code(self):
        p = post(104, -103.4)
        toll = {'code': '54', 'name': 'Acatlán', 'toll': True, 'snapM': 10}
        free = {'code': '54', 'name': 'Acatlán', 'toll': False, 'snapM': 12}
        other = {'code': '80', 'name': 'Otra vía', 'toll': True, 'snapM': 15}
        self.assertEqual(rnc.assign_post(p, [toll, free])[1], 'ambiguous_free_or_other_code')
        self.assertEqual(rnc.assign_post(p, [toll, other])[1], 'ambiguous_free_or_other_code')
        self.assertIsNotNone(rnc.assign_post(p, [toll, {**free, 'snapM': 70}])[0])

    def test_duplicate_km_is_never_chosen_by_closeness(self):
        points = [post(k, -97.50 + (k-220)*.009) for k in (220,221,222,224,225)]
        points += [post(223,-97.473,2231),post(223,-97.40,2232)]
        chains, flagged = rnc.reviewed_chains(points)
        self.assertEqual(sum(p['km']==223 for p in flagged if p['reason']=='duplicate_km_same_code'),2)
        self.assertFalse(any(p['km']==223 for c in chains for p in c['posts']))

    def test_chain_requires_coherence_and_multiple_posts(self):
        points = [post(k,-97.50+(k-197)*.009) for k in range(197,201)]
        points.append(post(201,-98.00))
        chains, flagged = rnc.reviewed_chains(points)
        self.assertEqual([(c['fromKm'],c['toKm']) for c in chains],[(197,200)])
        self.assertEqual(flagged[0]['km'],201)

    def test_anchors_must_match_route_identity_uniquely(self):
        a = [post(k,-97.50+(k-197)*.009) for k in range(197,201)]
        chains, _ = rnc.reviewed_chains(a)
        anchor = {'code':'150','name':'Acatzingo - Ciudad Mendoza','km':198,'lat':19,'lon':a[1]['lon']}
        self.assertEqual(rnc.validate_anchors(chains,[anchor])['withinTolerance'],1)
        self.assertEqual(rnc.validate_anchors(chains,[{**anchor,'code':'54'}])['withinTolerance'],0)
        self.assertEqual(rnc.validate_anchors(chains,[{**anchor,'name':'otro'}])['results'][0]['result'],'not_covered')


if __name__ == '__main__':
    unittest.main()
