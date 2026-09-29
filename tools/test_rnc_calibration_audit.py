import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('rnc-calibration-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTest(unittest.TestCase):
    def test_ignores_duplicate_post_and_splits_large_gap(self):
        proposed = {'corredores': [{'nombre': 'Cuernavaca–Acapulco', 'estado': 'calibrable',
                                    'detalleAnclas': [{'idKm': i} for i in range(1, 10)]}]}
        chain = {'code': '95', 'name': 'Cuernavaca - Acapulco', 'toll': True,
                 'posts': [{'id': i, 'km': km} for i, km in
                           [(1, 1), (2, 2), (3, 3), (4, 4),
                            (6, 12), (7, 13), (8, 14), (9, 15)]]}
        result = audit.audit(proposed, {'chains': [chain]})[0]
        self.assertEqual([(x['fromKm'], x['toKm']) for x in result['segments']], [(1, 4), (12, 15)])
        self.assertTrue(all(x['status'] == 'review_required' for x in result['segments']))

    def test_free_road_and_different_name_are_excluded(self):
        proposed = {'corredores': [{'nombre': 'Zacapalco–Rancho Viejo', 'estado': 'calibrable',
                                    'detalleAnclas': [{'idKm': i} for i in range(4)]}]}
        chains = [{'code': '92', 'name': 'Zacapalco - Taxco', 'toll': True, 'posts': []},
                  {'code': '92', 'name': 'Zacapalco - Rancho Viejo', 'toll': False, 'posts': []}]
        self.assertEqual(audit.audit(proposed, {'chains': chains})[0]['segments'], [])


if __name__ == '__main__':
    unittest.main()
