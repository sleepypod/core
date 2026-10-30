from datetime import datetime, timezone
import time
import unittest
import urllib.error
from unittest.mock import patch

import handoff
import maintenance_status


def status():
    return {'apiVersion': 1, 'kind': 'sleepypod-maintenance-status',
            'generatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'controller': {'id': 'sleepypod-core', 'revision': 'abcdef1'},
            'device': {'freshness': 'fresh'}, 'temperatureRuntime': 'ready',
            'thermalIdle': True, 'privacyBoundary': 'personal_required'}


class MaintenanceStatusTests(unittest.TestCase):
    def test_private_status_never_reads_the_legacy_owner_api(self):
        with patch.object(handoff, 'local_json', return_value=status()) as request:
            observation = handoff.core_observation('private-fixture', 'abcdef1' + '0'*33)
            handoff.require_core_thermal_idle('private-fixture', observation)
        request.assert_called_once_with(maintenance_status.PATH, 'private-fixture')
        self.assertEqual(observation['privacyBoundary'], 'personal_required')
        self.assertNotIn('private-fixture', repr(observation))

    def test_only_missing_endpoint_falls_back_for_an_older_release(self):
        legacy = {'controller': {'id': 'sleepypod-core', 'revision': 'abcdef1'},
                  'observations': {'device': {'freshness': 'fresh'}},
                  'features': {'temperatureControl': {'runtime': 'ready'}}}
        error = urllib.error.HTTPError(maintenance_status.PATH, 404, 'missing', {}, None)
        with patch.object(handoff, 'local_json', side_effect=[error, legacy]) as request:
            result = handoff.core_observation('private-fixture', 'abcdef1' + '0'*33)
        self.assertEqual(request.call_count, 2)
        self.assertNotIn('maintenanceProtocol', result)

    def test_auth_storage_redirect_and_network_errors_never_fall_back(self):
        errors = [urllib.error.HTTPError(maintenance_status.PATH, code, 'error', {}, None) for code in (301, 400, 401, 403, 500, 503)]
        errors += [OSError('offline'), ValueError('invalid JSON')]
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(handoff, 'local_json', side_effect=error) as request:
                with self.assertRaises(type(error)):
                    handoff.core_observation('private-fixture', 'abcdef1' + '0'*33)
                self.assertEqual(request.call_count, 1)

    def test_malformed_or_private_payload_never_enters_a_journal_or_falls_back(self):
        cases = [None, [], {}, {**status(), 'privateAccount': 'fixture'},
                 {**status(), 'controller': {'id': 'sleepypod-core', 'revision': 'abcdef1', 'name': 'fixture'}},
                 {**status(), 'device': {'freshness': 'fresh', 'left': 'fixture'}}]
        for field, values in {
            'apiVersion': [True, 2, None], 'kind': ['other'], 'thermalIdle': [1, 0, 'true'],
            'temperatureRuntime': ['unknown', None], 'privacyBoundary': ['unknown', None],
            'generatedAt': [None, 'invalid', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'],
        }.items():
            cases.extend({**status(), field: value} for value in values)
        for value in cases:
            with self.subTest(value=value), patch.object(handoff, 'local_json', return_value=value) as request:
                with self.assertRaises(ValueError):
                    handoff.core_observation('private-fixture', 'abcdef1' + '0'*33)
                self.assertEqual(request.call_count, 1)

    def test_revision_is_bound_to_the_staged_release(self):
        for revision in ('bbbbbbb', 'abcdef', True, 'abcdef1-private', 'A'*40, None):
            value = status()
            value['controller']['revision'] = revision
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                maintenance_status.parse(value, 'abcdef1' + '0'*33)

    def test_stale_or_unavailable_status_cannot_assert_readiness(self):
        for changed in ({'device': {'freshness': 'stale'}}, {'device': {'freshness': 'unavailable'}}, {'privacyBoundary': 'unavailable'}):
            with self.assertRaises(ValueError):
                maintenance_status.parse({**status(), **changed}, 'abcdef1' + '0'*33)
            value = {**status(), **changed, 'thermalIdle': None, 'temperatureRuntime': 'not_ready'}
            observation = maintenance_status.parse(value, 'abcdef1' + '0'*33)
            with self.assertRaises(RuntimeError): maintenance_status.require_idle(observation)

    def test_idle_is_rechecked_and_not_inferred_from_fresh_telemetry(self):
        observation = maintenance_status.parse(status(), 'abcdef1' + '0'*33)
        for field, values in {'thermalIdle': [False, None, 1], 'maintenanceProtocol': [True, 2],
                              'temperatureRuntime': ['not_ready']}.items():
            for value in values:
                with self.subTest(field=field, value=value), patch.object(handoff, 'local_json') as legacy:
                    with self.assertRaises(RuntimeError):
                        handoff.require_core_thermal_idle('key', {**observation, field: value})
                    legacy.assert_not_called()
        with patch.object(maintenance_status.time, 'time', return_value=time.time() + 20):
            with self.assertRaises(ValueError): maintenance_status.require_idle(observation)


if __name__ == '__main__': unittest.main()
