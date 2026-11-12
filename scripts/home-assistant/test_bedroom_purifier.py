"""Exercise particle-response dispatch through HA without contacting appliances."""
from datetime import timedelta
from unittest.mock import patch

from homeassistant.components.fan import FanEntityFeature
from homeassistant.core import State
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

import test_blueprints as existing


class BedroomPurifier(existing.BlueprintHarness):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.occupied()
        self.purifier()
        self.sample()

    def occupied(self, entity='binary_sensor.test_left', state='on', age=600):
        self.hass.states._states[entity] = State(entity, state, {'device_class': 'occupancy'},
            last_changed=existing.NOW - timedelta(seconds=age))

    def purifier(self, state='on', percentage=33, age=600, **attributes):
        values = {'percentage': percentage, 'supported_features': int(FanEntityFeature.SET_SPEED)}
        values.update(attributes)
        timestamp = existing.NOW - timedelta(seconds=age)
        self.hass.states._states['fan.test_purifier'] = State('fan.test_purifier', state, values,
            last_changed=timestamp, last_updated=timestamp)

    def sample(self, value='25', age=5, unit='µg/m³', **attributes):
        values = {'unit_of_measurement': unit, 'device_class': 'pm25',
                  'sampled_at': (existing.NOW - timedelta(seconds=age)).isoformat()}
        values.update(attributes)
        self.hass.states.async_set('sensor.test_room', value, values)

    def crossing(self, age=125, before='10', after='25', **attributes):
        crossed_at = existing.NOW - timedelta(seconds=age)
        values = {'unit_of_measurement': 'µg/m³', 'device_class': 'pm25',
                  'sampled_at': (crossed_at - timedelta(seconds=5)).isoformat()}
        values.update(attributes)
        return {'platform': 'numeric_state', 'entity_id': 'sensor.test_room',
                'from_state': State('sensor.test_room', before, values,
                    last_updated=crossed_at - timedelta(seconds=10)),
                'to_state': State('sensor.test_room', after, values, last_updated=crossed_at)}

    async def run_purifier(self, inputs=None, trigger=None):
        values = {'allow_actions': True}
        values.update(inputs or {})
        return await self.run_actions('bedroom_purifier.yaml', values, trigger)

    async def test_shared_quiet_must_remain_known_off_throughout_decision_window(self):
        for state in ['on', 'unknown', 'unavailable']:
            self.hass.states.async_set('binary_sensor.test_shared_quiet', state)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.hass.states._states['binary_sensor.test_shared_quiet'] = State('binary_sensor.test_shared_quiet', 'off',
            last_changed=existing.NOW - timedelta(seconds=30))
        self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.hass.states._states['binary_sensor.test_shared_quiet'] = State('binary_sensor.test_shared_quiet', 'off',
            last_changed=existing.NOW - timedelta(seconds=600))
        self.assertEqual(len(await self.run_purifier(trigger=self.crossing())), 1)
        self.assertEqual(await self.run_purifier({'shared_quiet_entity': 'binary_sensor.missing'}, self.crossing()), [])

    async def test_fresh_sustained_crossing_requests_only_reviewed_speed(self):
        calls = await self.run_purifier(trigger=self.crossing())
        self.assertEqual(calls, [('fan', 'set_percentage',
            {'entity_id': ['fan.test_purifier'], 'percentage': 66})])
        config = existing.configuration('bedroom_purifier.yaml')
        self.assertEqual(config['triggers'][0]['for'], {'minutes': 2})
        self.assertEqual(config['triggers'][0]['above'], 15)

    async def test_manual_run_and_non_boolean_permission_cannot_control(self):
        self.assertEqual(await self.run_purifier(), [])
        for permission in [False, 'true', 1, None]:
            self.assertEqual(await self.run_purifier({'allow_actions': permission}, self.crossing()), [])
        self.assertEqual(await self.run_purifier(trigger={'platform': 'time'}), [])

    async def test_unknown_recovery_or_already_high_readings_are_not_crossings(self):
        for before, after in [('unknown', '25'), ('unavailable', '25'), ('20', '25'),
                              ('-1', '25'), ('NaN', '25'), ('10', '15'), ('10', '1001')]:
            with self.subTest(before=before, after=after):
                self.assertEqual(await self.run_purifier(trigger=self.crossing(before=before, after=after)), [])

    async def test_unrelated_and_mismatched_source_events_cannot_control(self):
        for field in ['entity_id', 'from_state', 'to_state']:
            trigger = self.crossing()
            trigger[field] = 'sensor.other' if field == 'entity_id' else State('sensor.other', '10')
            self.assertEqual(await self.run_purifier(trigger=trigger), [])

    async def test_two_minute_hold_and_thirty_second_dispatch_deadline(self):
        for age in [-1, 0, 119, 151, 3600]:
            self.assertEqual(await self.run_purifier(trigger=self.crossing(age=age)), [])
        for age in [120, 150]:
            self.assertEqual(len(await self.run_purifier(trigger=self.crossing(age=age))), 1)

    async def test_current_sample_must_be_newer_than_crossing_and_fresh(self):
        for age in [-1, 120, 125, 130, 900]:
            self.sample(age=age)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.sample(age=0)
        self.assertEqual(len(await self.run_purifier(trigger=self.crossing())), 1)

    async def test_invalid_source_clocks_are_not_replaced_by_receipt_time(self):
        for timestamp in [None, 'garbage', True, float('inf'), float('nan'), 0]:
            self.sample(sampled_at=timestamp)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.sample()
        for attribute in ['last_updated', 'last_changed', 'last_reported']:
            self.assertEqual(await self.run_purifier({'timestamp_attribute': attribute}, self.crossing()), [])

    async def test_stale_or_future_crossing_measurement_is_rejected(self):
        for timestamp in ['bad', False, None, (existing.NOW - timedelta(seconds=300)).isoformat(),
                          (existing.NOW - timedelta(seconds=120)).isoformat()]:
            self.assertEqual(await self.run_purifier(trigger=self.crossing(sampled_at=timestamp)), [])

    async def test_numeric_source_clock_formats_require_numbers(self):
        for format_name, factor in [('unix_seconds', 1), ('unix_milliseconds', 1000)]:
            self.sample(sampled_at=(existing.NOW.timestamp() - 5) * factor)
            trigger = self.crossing(sampled_at=(existing.NOW.timestamp() - 130) * factor)
            self.assertEqual(len(await self.run_purifier({'timestamp_format': format_name}, trigger)), 1)
            self.sample(sampled_at=True)
            self.assertEqual(await self.run_purifier({'timestamp_format': format_name}, trigger), [])

    async def test_wrong_units_classes_recovery_and_nonfinite_readings_withhold(self):
        for value, unit in [('unknown', 'µg/m³'), ('unavailable', 'µg/m³'), ('NaN', 'µg/m³'),
                            ('inf', 'µg/m³'), ('1001', 'µg/m³'), ('15', 'µg/m³'), ('25', '%')]:
            self.sample(value, unit=unit)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.sample(device_class='humidity')
        self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.sample()
        self.assertEqual(await self.run_purifier(trigger=self.crossing(unit_of_measurement='%')), [])
        trigger = self.crossing()
        trigger['from_state'] = State('sensor.test_room', '10', {'unit_of_measurement': '%', 'device_class': 'humidity'})
        self.assertEqual(await self.run_purifier(trigger=trigger), [])

    async def test_only_already_running_individual_speed_capable_manual_fans(self):
        for state in ['off', 'unknown', 'unavailable']:
            self.purifier(state=state)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        changes = [{'entity_id': ['fan.other']}, {'assumed_state': True},
                   {'preset_mode': 'auto'}, {'preset_mode': 'sleep'}]
        changes += [{'supported_features': value} for value in [0, 2, -1, True, 1.0, '1', None]]
        for attributes in changes:
            self.purifier(**attributes)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])

    async def test_missing_invalid_or_already_higher_reported_speed_is_not_changed(self):
        for percentage in [0, -1, 66, 99, 101, None, True, '33', float('nan'), float('inf')]:
            self.purifier(percentage=percentage)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])

    async def test_reported_manual_or_other_fan_change_during_hold_wins(self):
        self.purifier(age=124)
        self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.purifier(age=125)
        self.assertEqual(len(await self.run_purifier(trigger=self.crossing())), 1)

    async def test_presence_is_known_occupied_throughout_decision_window(self):
        for state, age in [('off', 600), ('unknown', 600), ('unavailable', 600), ('on', 124)]:
            self.occupied(state=state, age=age)
            self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])
        self.occupied(entity='binary_sensor.test_right')
        self.assertEqual(len(await self.run_purifier(trigger=self.crossing())), 1)

    async def test_wrong_presence_domains_and_classes_cannot_substitute(self):
        self.hass.states._states['input_boolean.fake_presence'] = State('input_boolean.fake_presence', 'on',
            {'device_class': 'occupancy'}, last_changed=existing.NOW - timedelta(seconds=600))
        self.assertEqual(await self.run_purifier({'occupancy_entities': ['input_boolean.fake_presence']}, self.crossing()), [])
        self.hass.states._states['binary_sensor.test_left'] = State('binary_sensor.test_left', 'on',
            {'device_class': 'motion'}, last_changed=existing.NOW - timedelta(seconds=600))
        self.assertEqual(await self.run_purifier(trigger=self.crossing()), [])

    async def test_pause_missing_unknown_on_or_recently_released_withholds(self):
        inputs = {'pause_entities': ['input_boolean.partner_resting']}
        self.assertEqual(await self.run_purifier(inputs, self.crossing()), [])
        for state, age in [('on', 600), ('unknown', 600), ('unavailable', 600), ('off', 124)]:
            self.hass.states._states['input_boolean.partner_resting'] = State('input_boolean.partner_resting', state,
                last_changed=existing.NOW - timedelta(seconds=age))
            self.assertEqual(await self.run_purifier(inputs, self.crossing()), [])
        self.hass.states._states['input_boolean.partner_resting'] = State('input_boolean.partner_resting', 'off',
            last_changed=existing.NOW - timedelta(seconds=600))
        self.assertEqual(len(await self.run_purifier(inputs, self.crossing())), 1)

    async def test_night_window_has_no_daytime_catchup(self):
        for hour, expected in [(21, 0), (22, 1), (0, 1), (4, 1), (5, 0), (12, 0)]:
            now = existing.NOW.astimezone(dt_util.DEFAULT_TIME_ZONE).replace(hour=hour)
            with patch.object(existing, 'NOW', now), patch.object(dt_util, 'now', return_value=now):
                self.occupied()
                self.purifier()
                self.sample()
                self.hass.states._states['binary_sensor.test_shared_quiet'] = State('binary_sensor.test_shared_quiet', 'off',
                    last_changed=now - timedelta(minutes=10))
                self.assertEqual(len(await self.run_purifier(trigger=self.crossing())), expected)

    async def test_configuration_bounds_and_entity_lists_are_enforced_at_dispatch(self):
        changes = [{'percentage': value} for value in [0, 101, 33.5, '66', True]]
        changes += [{'threshold': value} for value in [0, 1001, True]]
        changes += [{'maximum_age': value} for value in [29, 901, True]]
        changes += [{'occupancy_entities': []}, {'occupancy_entities': ['binary_sensor.test_left'] * 2},
                    {'occupancy_entities': ['binary_sensor.test_left'] * 3}, {'purifier': 'switch.diffuser'},
                    {'pause_entities': ['input_boolean.pause'] * 21}]
        for changed in changes:
            with self.subTest(changed=changed):
                self.assertEqual(await self.run_purifier(changed, self.crossing()), [])

    async def test_service_failure_does_not_queue_retry_or_restore_speed(self):
        async def fail(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            raise HomeAssistantError('Synthetic unavailable purifier')
        self.hass.services.async_register('fan', 'set_percentage', fail)
        with self.assertRaises(HomeAssistantError):
            await self.run_purifier(trigger=self.crossing())
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][:2], ('fan', 'set_percentage'))
