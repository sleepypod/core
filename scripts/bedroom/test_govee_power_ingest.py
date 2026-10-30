import json
import unittest
from unittest.mock import patch

from govee_ingest import deliver, qualified_power, qualified_reading


class PowerReadTests(unittest.TestCase):
    def payload(self, model='H712C', power=0):
        return {'version': 1, 'model': model, 'requestIssuedAt': 100000, 'observedAt': 100400,
                'reading': {'power': power}}

    def test_off_and_on_are_device_reads_but_not_measurement_timestamps(self):
        for model in ('H712C', 'H7161'):
            for power in (0, 1):
                self.assertEqual(qualified_power(self.payload(model, power), 101000), (100400, {'power': power}))
        self.assertEqual(qualified_power(self.payload(), 100000)[0], 100000)
        unavailable = {**self.payload(), 'reading': None, 'requestIssuedAt': None}
        self.assertEqual(qualified_power(unavailable, 101000), (100400, {'power': None}))

    def test_receipts_cannot_choose_other_sources_metrics_or_clock_basis(self):
        for extra in ({'model': 'H5106'}, {'model': 'H7126'}, {'sourceId': 'another-source'},
                      {'timeBasis': 'measurement'}, {'action': 'power'}, {'observedAt': True},
                      {'requestIssuedAt': None}, {'requestIssuedAt': 90000}):
            with self.assertRaises(ValueError): qualified_power({**self.payload(), **extra}, 101000)
        for reading in ({'power': True}, {'power': -1}, {'power': 2}, {'power': 0.0}, {'power': '0'},
                        {'power': 0, 'fanSpeed': 66}, {'temperatureC': 22}, {}):
            with self.assertRaises(ValueError): qualified_power({**self.payload(), 'reading': reading}, 101000)
        for now in (99000, 115401):
            with self.assertRaises(ValueError): qualified_power(self.payload(), now)
        with self.assertRaises(ValueError): qualified_reading(self.payload(), 101000)

    def test_receiver_is_limited_to_two_fixed_power_sources_and_verifies_the_live_mapping(self):
        devices = {model: {'deviceId': 'test-' + model, 'sources': {'power': model + '-power'},
                          'externalIds': {'power': model + '/power'}} for model in ('H712C', 'H7161')}
        config = {'environment': '/private/test.env', 'devices': devices}
        status = {'revision': 7, 'config': {'sources': [
            {'id': model + '-power', 'model': model, 'metric': 'power', 'provider': 'homebridge',
             'deviceId': 'test-' + model, 'externalId': model + '/power', 'unit': 'on/off'}
            for model in devices]}}
        requests = []

        class Response:
            def __init__(self, payload): self.payload = payload
            def __enter__(self): return self
            def __exit__(self, *_arguments): return False
            def read(self, _limit): return json.dumps(self.payload).encode()

        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response(status if request.data is None else {'results': [{'accepted': True}]})

        with patch('govee_ingest.time.time', return_value=101), \
                patch('govee_ingest.private_file', return_value='SLEEPYPOD_AUTH_TOKEN=' + 'x' * 40), \
                patch('govee_ingest.urllib.request.build_opener', return_value=Opener()):
            for model in devices:
                requests.clear()
                result = deliver(self.payload(model), config, 'appliance-power')
                self.assertEqual(result, {'accepted': 1, 'submitted': 1, 'deviceReadOnly': True})
                reports = json.loads(requests[-1].data)['reports']
                self.assertEqual(reports, [{'schemaVersion': 1, 'revision': 7, 'sourceId': model + '-power',
                                           'available': True, 'value': 0, 'observedAt': 100400,
                                           'measuredAt': None, 'timeBasis': 'device_read'}])
            for field, value in (('model', 'H5106'), ('metric', 'fanSpeed'), ('provider', 'apple_home'),
                                 ('deviceId', 'other'), ('externalId', 'other/power'), ('unit', '%')):
                original = status['config']['sources'][0][field]
                status['config']['sources'][0][field] = value
                requests.clear()
                with self.assertRaises(ValueError): deliver(self.payload(), config, 'appliance-power')
                self.assertEqual(len(requests), 1)
                status['config']['sources'][0][field] = original
            with self.assertRaises(ValueError): deliver(self.payload(), config)
            with self.assertRaises(ValueError): deliver(self.payload(), {**config, 'devices': {'H712C': devices['H712C']}}, 'appliance-power')


if __name__ == '__main__':
    unittest.main()
