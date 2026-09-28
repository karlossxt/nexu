import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('batch', Path(__file__).with_name('rnc-batch-review.py'))
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class BatchReviewTest(unittest.TestCase):
    def test_exact_road_and_km_are_candidates_only(self):
        report = {'chains': [{'code': '95', 'name': 'Cuernavaca - Acapulco',
                              'fromKm': 140, 'toKm': 145,
                              'posts': [{'km': 142, 'id': 1510}]}]}
        alerts = [{'id': 'a', 'road': 'Autopista Cuernavaca - Acapulco',
                   'kilometer': 142, 'latitude': None, 'longitude': None},
                  {'id': 'b', 'road': 'Autopista Cuernavaca - Acapulco',
                   'kilometer': 142, 'latitude': None, 'longitude': None},
                  {'id': 'c', 'road': 'Autopista Cuernavaca - Acapulco',
                   'kilometer': 142, 'latitude': 18.5, 'longitude': -99.2},
                  {'id': 'd', 'road': 'Autopista Cuernavaca - Iguala',
                   'kilometer': 142, 'latitude': None, 'longitude': None}]
        result = batch.review(alerts, report)
        self.assertEqual(result[0]['alerts'], 2)
        self.assertEqual(result[0]['reason'], 'exact_post_needs_review')
        self.assertEqual(result[0]['status'], 'review_required')
        self.assertEqual(result[1]['reason'], 'no_matching_chain')

    def test_shared_place_name_does_not_equate_distinct_corridors(self):
        self.assertFalse(batch.name_matches('Zacapalco - Rancho Viejo', 'Zacapalco - Taxco'))


if __name__ == '__main__':
    unittest.main()
