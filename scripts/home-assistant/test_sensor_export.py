"""Exercise the exporter with Home Assistant's real schema and action engine."""
from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from homeassistant import loader
from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA, PLATFORM_SCHEMA
from homeassistant.components.blueprint.models import Blueprint, BlueprintInputs
from homeassistant.core import Context, HomeAssistant, State
from homeassistant.helpers import trigger as trigger_helper
from homeassistant.helpers.script import Script
from homeassistant.helpers.trigger import async_validate_trigger_config
from homeassistant.util import dt as dt_util, yaml as yaml_util

ROOT = Path(__file__).resolve().parents[2] / 'integrations/home-assistant/blueprints/sensor-export'
NOW = datetime(2026, 10, 27, 4, 0, tzinfo=timezone.utc)
TOPIC = 'sleepypod/fixture/bedroom/report'


def configuration(filename, supplied=None):
    blueprint = Blueprint(yaml_util.load_yaml(str(ROOT / filename)),
                          expected_domain='automation', schema=AUTOMATION_BLUEPRINT_SCHEMA)
    if blueprint.validate():
        raise AssertionError(blueprint.validate())
    examples = {'webhook_id': 'synthetic-test-only-webhook-1234567890', 'report_topic': TOPIC,
                'configuration_revision': 2, 'temperature_source': 'fixture-temperature',
                'humidity_source': 'fixture-humidity', 'request_helper': 'input_boolean.fixture_sample'}
    inputs = {key: value for key, value in examples.items() if key in blueprint.inputs}
    inputs.update(supplied or {})
    result = BlueprintInputs(blueprint, {'id': filename, 'alias': filename,
        'use_blueprint': {'path': filename, 'input': inputs}})
    result.validate()
    return PLATFORM_SCHEMA(result.async_substitute())


class SensorExport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)
        loader.async_setup(self.hass)
        await trigger_helper.async_setup(self.hass)
        self.calls = []
        async def capture(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
        for domain, service in [('mqtt', 'publish'), ('input_boolean', 'turn_on'), ('input_boolean', 'turn_off')]:
            self.hass.services.async_register(domain, service, capture)
        self.hass.states.async_set('input_boolean.fixture_sample', 'off')
        self.clock = patch.object(dt_util, 'now', return_value=NOW)
        self.clock.start()

    async def asyncTearDown(self):
        await self.hass.async_stop()
        self.clock.stop()
        self.directory.cleanup()

    async def run_actions(self, inputs=None, payload=None, trigger=None, filename='apple_home_cache.yaml'):
        self.calls.clear()
        config = configuration(filename, inputs)
        script = Script(self.hass, config['actions'], filename, 'automation', variables=config['variables'])
        variables = {'this': State('automation.fixture_export', 'on')}
        if payload is not None:
            variables['trigger'] = {'platform': 'webhook', 'json': payload}
        elif trigger is not None:
            variables['trigger'] = trigger
        await script.async_run(variables, Context())
        await self.hass.async_block_till_done()
        return self.calls

    def payload(self, **updates):
        return {'schemaVersion': 1, 'temperature': 68, 'temperatureUnit': '°F', 'humidity': 50, **updates}

    async def test_real_schemas_and_trigger_configuration(self):
        for filename in ROOT.glob('*.yaml'):
            config = configuration(filename.name)
            self.assertFalse(config['variables'].variables['allow_actions'])
            self.assertNotIn('initial_state', config)  # HA preserves the owner's enabled state across restarts.
            self.assertEqual(config['mode'], 'single')
            await async_validate_trigger_config(self.hass, config['triggers'])
        receiver = configuration('apple_home_cache.yaml')
        self.assertEqual(receiver['triggers'][0]['allowed_methods'], ['POST'])
        self.assertIs(receiver['triggers'][0]['local_only'], True)
        self.assertEqual(receiver['trace']['stored_traces'], 0)

    async def test_disabled_manual_and_wrong_trigger_requests_are_inert(self):
        self.assertEqual(await self.run_actions(payload=self.payload()), [])
        self.assertEqual(await self.run_actions({'allow_actions': True}), [])
        self.assertEqual(await self.run_actions({'allow_actions': True}, trigger={'platform': 'time'}), [])
        for permission in [1, 'true']:
            self.assertEqual(await self.run_actions({'allow_actions': permission}, self.payload()), [])

    async def test_real_publication_converts_units_and_preserves_zero(self):
        calls = await self.run_actions({'allow_actions': True}, self.payload(humidity=0))
        self.assertEqual(len(calls), 2)
        for domain, service, data in calls:
            self.assertEqual((domain, service), ('mqtt', 'publish'))
            self.assertEqual(data['topic'], TOPIC)
            self.assertEqual(data['qos'], 0)
            self.assertIs(data['retain'], False)
        reports = [json.loads(call[2]['payload']) for call in calls]
        self.assertEqual([report['sourceId'] for report in reports], ['fixture-temperature', 'fixture-humidity'])
        self.assertEqual([report['value'] for report in reports], [20, 0])
        for report in reports:
            self.assertEqual(report, {'schemaVersion': 1, 'revision': 2, 'sourceId': report['sourceId'],
                'available': True, 'value': report['value'], 'observedAt': int(NOW.timestamp() * 1000),
                'measuredAt': None, 'timeBasis': 'cached'})

    async def test_configured_fahrenheit_source_is_converted_explicitly(self):
        calls = await self.run_actions({'allow_actions': True, 'temperature_unit': '°F'},
                                       self.payload(temperature=20, temperatureUnit='°C'))
        self.assertEqual(json.loads(calls[0][2]['payload'])['value'], 68)

    async def test_invalid_values_withdraw_instead_of_becoming_zero(self):
        for temperature, humidity in [(None, None), (True, False), ('20', '50'), (float('nan'), float('inf')), (201, -1)]:
            with self.subTest(temperature=temperature, humidity=humidity):
                calls = await self.run_actions({'allow_actions': True}, self.payload(temperature=temperature, humidity=humidity))
                self.assertEqual(len(calls), 2)
                for call in calls:
                    report = json.loads(call[2]['payload'])
                    self.assertIsNone(report['value'])
                    self.assertIs(report['available'], False)

    async def test_webhook_cannot_supply_a_clock_revision_source_or_action(self):
        for extra in [{'observedAt': 9999999999999}, {'revision': 7}, {'sourceId': 'other'}, {'action': 'heat'}]:
            self.assertEqual(await self.run_actions({'allow_actions': True}, self.payload(**extra)), [])
        for changed in [{'schemaVersion': True}, {'schemaVersion': 2}, {'temperatureUnit': 'unknown'}]:
            self.assertEqual(await self.run_actions({'allow_actions': True}, self.payload(**changed)), [])
        self.assertEqual(await self.run_actions({'allow_actions': True}, {'schemaVersion': 1}), [])

    async def test_invalid_configuration_does_not_publish(self):
        for changed in [{'report_topic': 'sleepypod/fixture/command'}, {'report_topic': 'sleepypod/+/bedroom/report'},
                        {'webhook_id': 'short'}, {'configuration_revision': 2.5},
                        {'humidity_source': 'fixture-temperature'}, {'temperature_source': '../other'}]:
            self.assertEqual(await self.run_actions({'allow_actions': True, **changed}, self.payload()), [])

    async def test_polling_touches_only_the_virtual_helper_and_requires_a_timer(self):
        self.assertEqual(await self.run_actions(filename='apple_home_poll.yaml', trigger={'platform': 'time_pattern'}), [])
        self.assertEqual(await self.run_actions({'allow_actions': True}, filename='apple_home_poll.yaml'), [])
        calls = await self.run_actions({'allow_actions': True}, filename='apple_home_poll.yaml', trigger={'platform': 'time_pattern'})
        self.assertEqual([call[:2] for call in calls], [('input_boolean', 'turn_off'), ('input_boolean', 'turn_on'), ('input_boolean', 'turn_off')])
        self.assertTrue(all(call[2]['entity_id'] == ['input_boolean.fixture_sample'] for call in calls))


if __name__ == '__main__':
    unittest.main()
