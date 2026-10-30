import json
import unittest
from unittest.mock import patch

from govee_ingest import air_quality, deliver, qualified_reading, strict_json


class QualifiedReadTests(unittest.TestCase):
    def payload(self):
        return {'version': 1, 'requestIssuedAt': 100000, 'observedAt': 100936,
                'reading': {'temperatureC': 21.5, 'humidity': 55.9, 'pm25': 0}}

    def test_successful_device_read_preserves_clock_and_zero(self):
        observed_at, values = qualified_reading(self.payload(), 101000)
        self.assertEqual(observed_at, 100936)
        self.assertEqual(values, {'temperature': 21.5, 'humidity': 55.9, 'pm25': 0, 'airQuality': 1})
        self.assertEqual(qualified_reading(self.payload(), 100000)[0], 100000)

    def test_expired_future_malformed_and_spoofed_clock_basis_are_rejected(self):
        for extra in ({'timeBasis': 'measurement'}, {'sourceId': 'another-device'}, {'action': 'temperature'},
                      {'version': True}, {'requestIssuedAt': None}, {'requestIssuedAt': 100937},
                      {'requestIssuedAt': 90000}, {'observedAt': True}, {'observedAt': 1.5}):
            with self.assertRaises(ValueError): qualified_reading({**self.payload(), **extra}, 101000)
        for now in (90000, 115937):
            with self.assertRaises(ValueError): qualified_reading(self.payload(), now)
        for contents in ('{"version":1,"version":2}', '{"value":NaN}'):
            with self.assertRaises(ValueError): strict_json(contents)

    def test_invalid_values_withdrawals_and_category_boundaries(self):
        for metric, value in (('temperatureC', True), ('humidity', float('nan')), ('temperatureC', -1),
                              ('temperatureC', 61), ('humidity', 101), ('pm25', 2001), ('pm25', '0')):
            payload = self.payload()
            payload['reading'][metric] = value
            with self.assertRaises(ValueError): qualified_reading(payload, 101000)
        unavailable = {'version': 1, 'observedAt': 101000, 'requestIssuedAt': None, 'reading': None}
        self.assertTrue(all(value is None for value in qualified_reading(unavailable, 101000)[1].values()))
        with self.assertRaises(ValueError): qualified_reading({**unavailable, 'requestIssuedAt': 100000}, 101000)
        self.assertEqual([air_quality(value) for value in (0, 12, 13, 35, 36, 75, 76, 115, 116)],
                         [1, 1, 2, 2, 3, 3, 4, 4, 5])

    def test_receiver_owns_mapping_basis_endpoint_and_does_not_return_owner_credentials(self):
        mapping = {metric: 'test-' + metric for metric in ('temperature', 'humidity', 'pm25', 'airQuality')}
        units = {'temperature': '°C', 'humidity': '%', 'pm25': 'µg/m³', 'airQuality': 'category'}
        external_ids = {metric: 'bridge/monitor/' + metric for metric in mapping}
        configuration = {'sources': mapping, 'externalIds': external_ids, 'deviceId': 'test-monitor',
                         'environment': '/private/test.env'}
        status = {'revision': 3, 'config': {'sources': [
            {'id': mapping[metric], 'metric': metric, 'model': 'H5106', 'provider': 'homebridge', 'unit': unit,
             'deviceId': 'test-monitor', 'externalId': external_ids[metric]}
            for metric, unit in units.items()]}}
        requests = []

        class Response:
            def __init__(self, payload): self.payload = payload
            def __enter__(self): return self
            def __exit__(self, *_arguments): return False
            def read(self, _limit): return json.dumps(self.payload).encode()

        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response(status if len(requests) == 1 else {'results': [{'accepted': True}] * 4})

        with patch('govee_ingest.time.time', return_value=101), \
                patch('govee_ingest.private_file', return_value='SLEEPYPOD_AUTH_TOKEN=' + 'x' * 40), \
                patch('govee_ingest.urllib.request.build_opener', return_value=Opener()):
            result = deliver(self.payload(), configuration)
            self.assertEqual(result, {'accepted': 4, 'submitted': 4, 'deviceReadOnly': True})
            self.assertEqual(requests[-1].full_url, 'http://127.0.0.1:3000/api/v1/home/bedroom/reports')
            reports = json.loads(requests[-1].data)['reports']
            self.assertEqual({report['sourceId'] for report in reports}, set(mapping.values()))
            self.assertTrue(all(report['timeBasis'] == 'device_read' and report['measuredAt'] is None
                                and report['observedAt'] == 100936 and report['revision'] == 3 for report in reports))
            requests.clear()
            status['config']['sources'][0]['model'] = 'another-model'
            with self.assertRaises(ValueError): deliver(self.payload(), configuration)
            self.assertEqual(len(requests), 1)


if __name__ == '__main__':
    unittest.main()
