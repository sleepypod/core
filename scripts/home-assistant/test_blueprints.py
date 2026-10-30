"""Validate real HA blueprints and execute actions against isolated stub services."""
from datetime import datetime, timedelta, timezone
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

BLUEPRINTS = Path(__file__).resolve().parents[2] / 'integrations/home-assistant/blueprints'
NOW = datetime(2026, 10, 26, 6, 30, tzinfo=timezone.utc)


def configuration(filename, supplied=None):
    """Use HA's own loader/substitution/schema; no parallel YAML interpreter."""
    blueprint = Blueprint(yaml_util.load_yaml(str(BLUEPRINTS / filename)),
                          expected_domain='automation', schema=AUTOMATION_BLUEPRINT_SCHEMA)
    if blueprint.validate():
        raise AssertionError(blueprint.validate())
    examples = {
        'scene': 'scene.test_bedroom', 'occupancy': 'binary_sensor.test_left',
        'left_occupancy': 'binary_sensor.test_left', 'right_occupancy': 'binary_sensor.test_right',
        'sensor': 'sensor.test_room', 'timestamp_attribute': 'sampled_at',
    }
    inputs = {key: value for key, value in examples.items() if key in blueprint.inputs}
    inputs.update(supplied or {})
    config = BlueprintInputs(blueprint, {'id': filename, 'alias': filename,
        'use_blueprint': {'path': filename, 'input': inputs}})
    config.validate()
    return PLATFORM_SCHEMA(config.async_substitute())


class Blueprints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)
        loader.async_setup(self.hass)
        await trigger_helper.async_setup(self.hass)
        await self.hass.config.async_set_time_zone('America/Los_Angeles')
        self.calls = []
        async def capture(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
        for domain, service in [('scene', 'turn_on'), ('persistent_notification', 'create'),
                                ('persistent_notification', 'dismiss')]:
            self.hass.services.async_register(domain, service, capture)
        self.hass.states.async_set('scene.test_bedroom', 'unknown')
        self.hass.states.async_set('binary_sensor.test_left', 'off')
        self.hass.states.async_set('binary_sensor.test_right', 'off')
        self.clock = patch.object(dt_util, 'now', return_value=NOW.astimezone(dt_util.get_time_zone('America/Los_Angeles')))
        self.clock.start()

    async def asyncTearDown(self):
        await self.hass.async_stop()
        self.clock.stop()
        self.directory.cleanup()

    async def run_actions(self, filename, inputs=None, trigger=None):
        """Run actions directly as HA's Run actions does, including internal guards."""
        self.calls.clear()
        config = configuration(filename, inputs)
        script = Script(self.hass, config['actions'], filename, 'automation',
                        variables=config.get('variables'))
        variables = {'this': State('automation.test_room', 'on')}
        if trigger is not None:
            variables['trigger'] = trigger
        await script.async_run(variables, Context())
        await self.hass.async_block_till_done()
        return self.calls

    def exit_trigger(self, before='on', after='off'):
        return {'platform': 'state', 'entity_id': 'binary_sensor.test_left',
                'from_state': State('binary_sensor.test_left', before),
                'to_state': State('binary_sensor.test_left', after)}

    def room(self, value='20', unit='%', sampled_at=None):
        self.hass.states.async_set('sensor.test_room', value, {
            'unit_of_measurement': unit,
            'sampled_at': sampled_at if sampled_at is not None else (NOW - timedelta(seconds=5)).isoformat(),
        })

    async def test_every_blueprint_has_valid_ha_schema_and_starts_disabled(self):
        for filename in BLUEPRINTS.glob('*.yaml'):
            with self.subTest(filename=filename.name):
                config = configuration(filename.name)
                self.assertIs(config['initial_state'], False)
                self.assertEqual(config['mode'], 'single')
                self.assertEqual(config['variables'].variables['allow_actions'], False)
                await async_validate_trigger_config(self.hass, config['triggers'])

    async def test_all_actions_are_inert_with_default_permission_even_manual_run(self):
        self.room()
        for filename in BLUEPRINTS.glob('*.yaml'):
            with self.subTest(filename=filename.name):
                calls = await self.run_actions(filename.name, trigger=self.exit_trigger())
                self.assertEqual(calls, [])

    async def test_wind_down_requires_real_time_trigger(self):
        self.assertEqual(await self.run_actions('wind_down.yaml', {'allow_actions': True}), [])
        calls = await self.run_actions('wind_down.yaml', {'allow_actions': True}, {'platform': 'time'})
        self.assertEqual(calls, [('scene', 'turn_on', {'entity_id': ['scene.test_bedroom']})])

    async def test_scene_manual_runs_and_non_boolean_permissions_cannot_bypass_guards(self):
        for filename in ['wind_down.yaml', 'night_path.yaml', 'morning_scene.yaml', 'empty_bed.yaml']:
            with self.subTest(filename=filename):
                self.assertEqual(await self.run_actions(filename, {'allow_actions': True}), [])
        for permission in [1, 'true', 'yes']:
            self.assertEqual(await self.run_actions('wind_down.yaml', {'allow_actions': permission},
                                                   {'platform': 'time'}), [])

    async def test_night_path_known_exit_sends_only_selected_scene(self):
        calls = await self.run_actions('night_path.yaml', {'allow_actions': True}, self.exit_trigger())
        self.assertEqual(calls, [('scene', 'turn_on', {'entity_id': ['scene.test_bedroom']})])

    async def test_unknown_unavailable_and_restored_state_do_not_trigger_path(self):
        for previous in ['unknown', 'unavailable', 'off']:
            with self.subTest(previous=previous):
                self.assertEqual(await self.run_actions('night_path.yaml', {'allow_actions': True},
                                                       self.exit_trigger(previous)), [])
        for current in ['unknown', 'unavailable', 'on']:
            self.hass.states.async_set('binary_sensor.test_left', current)
            self.assertEqual(await self.run_actions('night_path.yaml', {'allow_actions': True}, self.exit_trigger()), [])

    async def test_morning_scene_does_not_run_in_night_window(self):
        self.assertEqual(await self.run_actions('morning_scene.yaml', {'allow_actions': True}, self.exit_trigger()), [])
        with patch.object(dt_util, 'now', return_value=NOW.astimezone(dt_util.DEFAULT_TIME_ZONE).replace(hour=8)):
            calls = await self.run_actions('morning_scene.yaml', {'allow_actions': True}, self.exit_trigger())
        self.assertEqual(calls[0][:2], ('scene', 'turn_on'))

    async def test_empty_bed_requires_both_known_empty_and_distinct_entities(self):
        for state in ['on', 'unknown', 'unavailable']:
            self.hass.states.async_set('binary_sensor.test_right', state)
            self.assertEqual(await self.run_actions('empty_bed.yaml', {'allow_actions': True}, self.exit_trigger()), [])
        self.hass.states.async_set('binary_sensor.test_right', 'off')
        self.assertEqual(await self.run_actions('empty_bed.yaml', {
            'allow_actions': True, 'right_occupancy': 'binary_sensor.test_left'}, self.exit_trigger()), [])
        self.assertEqual(await self.run_actions('empty_bed.yaml', {'allow_actions': True}, self.exit_trigger()), [])
        # The condition clock advances, not the source data. Both known-off spans must pass.
        latest = max(self.hass.states.get(entity).last_changed for entity in
                     ['binary_sensor.test_left', 'binary_sensor.test_right'])
        with patch.object(dt_util, 'utcnow', return_value=latest + timedelta(minutes=6)):
            calls = await self.run_actions('empty_bed.yaml', {'allow_actions': True}, self.exit_trigger())
        self.assertEqual(calls[0][:2], ('scene', 'turn_on'))

    async def test_room_notice_uses_original_source_clock_and_stable_id(self):
        self.room()
        calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][:2], ('persistent_notification', 'create'))
        self.assertIn('20.0 %', calls[0][2]['message'])
        self.assertIn('No appliance or Pod command was sent.', calls[0][2]['message'])
        self.assertEqual(calls[0][2]['notification_id'], 'sleepypod_room_automation.test_room')

    async def test_stale_future_and_missing_clocks_withdraw_notification(self):
        for timestamp in [(NOW - timedelta(seconds=120)).isoformat(),
                          (NOW + timedelta(seconds=1)).isoformat(), 'garbage', False, 0]:
            with self.subTest(timestamp=timestamp):
                self.room(sampled_at=timestamp)
                calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
                self.assertEqual(calls[0][:2], ('persistent_notification', 'dismiss'))

    async def test_cached_value_cannot_be_rejuvenated_by_republishing(self):
        self.room(sampled_at=(NOW - timedelta(seconds=119)).isoformat())
        calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][1], 'create')
        with patch.object(dt_util, 'now', return_value=NOW + timedelta(seconds=2)):
            calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][1], 'dismiss')

    async def test_wrong_units_nonfinite_and_unavailable_values_are_not_zero(self):
        for value, unit in [('unknown', '%'), ('unavailable', '%'), ('NaN', '%'), ('inf', '%'),
                            ('-1', '%'), ('101', '%'), ('20', '°C')]:
            with self.subTest(value=value, unit=unit):
                self.room(value, unit)
                calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
                self.assertEqual(calls[0][1], 'dismiss')

    async def test_ha_receipt_clocks_and_reversed_thresholds_are_rejected(self):
        self.room()
        for overrides in [{'timestamp_attribute': name} for name in ['last_updated', 'last_reported', 'last_changed']] + [{'lower': 60, 'upper': 30}]:
            calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True, **overrides})
            self.assertEqual(calls[0][1], 'dismiss')

    async def test_missing_clock_age_limits_and_clock_type_mismatches_withdraw(self):
        self.hass.states.async_set('sensor.test_room', '20', {'unit_of_measurement': '%'})
        calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][1], 'dismiss')
        self.room()
        for changed in [{'maximum_age': 29}, {'maximum_age': 901}, {'timestamp_format': 'unix_seconds'}]:
            calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True, **changed})
            self.assertEqual(calls[0][1], 'dismiss')
        self.room(sampled_at=True)
        calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True, 'timestamp_format': 'unix_seconds'})
        self.assertEqual(calls[0][1], 'dismiss')

    async def test_numeric_source_time_formats(self):
        for format_name, factor in [('unix_seconds', 1), ('unix_milliseconds', 1000)]:
            self.room(sampled_at=(NOW.timestamp() - 5) * factor)
            calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True, 'timestamp_format': format_name})
            self.assertEqual(calls[0][1], 'create')

    async def test_recovered_reading_withdraws_and_pm25_never_controls_a_fan(self):
        self.room('45')
        calls = await self.run_actions('humidity_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][1], 'dismiss')
        self.room('25', 'µg/m³')
        calls = await self.run_actions('air_quality_review.yaml', {'allow_actions': True})
        self.assertEqual(calls[0][:2], ('persistent_notification', 'create'))


if __name__ == '__main__':
    unittest.main()
