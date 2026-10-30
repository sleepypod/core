import unittest
from cache_ingest import readings, strict_json


class CacheBoundaryTests(unittest.TestCase):
    def payload(self, **values):
        return {'version': 1, 'issuedAt': 100000, 'readings': [{'sourceId': 'room-temp', 'value': 21}], **values}

    def test_accepts_only_allowlisted_finite_readings(self):
        self.assertEqual(readings(self.payload(), ['room-temp'], 100001)[0]['value'], 21)
        for item in ({'sourceId': 'other', 'value': 21}, {'sourceId': 'room-temp', 'value': True},
                     {'sourceId': 'room-temp', 'value': float('nan')},
                     {'sourceId': 'room-temp', 'value': 21, 'timeBasis': 'device_read'}):
            with self.assertRaises(ValueError): readings(self.payload(readings=[item]), ['room-temp'], 100001)

    def test_rejects_stale_future_duplicate_and_control_payloads(self):
        cases = [self.payload(issuedAt=1), self.payload(issuedAt=999999),
                 self.payload(readings=self.payload()['readings']*2), self.payload(action='temperature'),
                 self.payload(readings=[]), self.payload(version=True)]
        for payload in cases:
            with self.assertRaises(ValueError): readings(payload, ['room-temp'], 100001)

    def test_explicit_unavailable_is_allowed(self):
        value = readings(self.payload(readings=[{'sourceId': 'room-temp', 'value': None}]), ['room-temp'], 100001)
        self.assertIsNone(value[0]['value'])

    def test_json_rejects_duplicate_keys_and_nonfinite_numbers(self):
        for value in ('{"version":1,"version":2}', '{"value":NaN}', '{"value":Infinity}'):
            with self.assertRaises(ValueError): strict_json(value)


if __name__ == '__main__': unittest.main()
