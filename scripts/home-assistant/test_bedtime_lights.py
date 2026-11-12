"""Run the actual bedtime-light blueprint in Home Assistant's script engine."""
from datetime import timedelta
from unittest.mock import patch

from homeassistant.core import State
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

import test_blueprints as existing


class BedtimeLights(existing.BlueprintHarness):
    def light(self, entity='light.selected', state='on', brightness=180, **attributes):
        values = {'brightness': brightness, 'supported_color_modes': ['brightness']}
        values.update(attributes)
        self.hass.states.async_set(entity, state, values)

    def entry(self, age=65, before='off', after='on', entity='binary_sensor.test_left'):
        changed = existing.NOW - timedelta(seconds=age)
        current = State(entity, after, last_changed=changed)
        # Set a source clock independently of the action clock, as an MQTT entity does.
        self.hass.states._states[entity] = current
        return {'platform': 'state', 'entity_id': entity,
                'from_state': State(entity, before, last_changed=changed - timedelta(minutes=5)),
                'to_state': current}

    async def run_lights(self, inputs=None, trigger=None):
        values = {'allow_actions': True, 'lights': ['light.selected']}
        values.update(inputs or {})
        return await self.run_actions('bedtime_lights.yaml', values, trigger)

    async def test_known_bed_entry_dims_only_selected_lights_above_ten_percent(self):
        self.light()
        self.light('light.off', 'off')
        self.light('light.already_dim', brightness=10)
        self.light('light.at_target', brightness=26)
        self.light('light.unselected')
        calls = await self.run_lights({'lights': ['light.selected', 'light.off', 'light.already_dim',
                                                'light.at_target', 'light.selected']}, self.entry())
        self.assertEqual(calls, [('light', 'turn_on', {'entity_id': ['light.selected'], 'brightness': 26})])

    async def test_either_selected_side_can_trigger_without_claiming_person_identity(self):
        self.light()
        calls = await self.run_lights(trigger=self.entry(entity='binary_sensor.test_right'))
        self.assertEqual(len(calls), 1)

    async def test_manual_run_and_wrong_trigger_do_not_dim(self):
        self.light()
        self.assertEqual(await self.run_lights(), [])
        self.assertEqual(await self.run_lights(trigger={'platform': 'time'}), [])
        self.assertEqual(await self.run_lights(trigger=self.entry(entity='binary_sensor.other_bed')), [])
        trigger = self.entry()
        trigger['to_state'] = State('binary_sensor.other_bed', 'on')
        self.assertEqual(await self.run_lights(trigger=trigger), [])

    async def test_permission_must_be_boolean_true(self):
        self.light()
        for allow in [False, 1, 'true', 'yes', None]:
            with self.subTest(allow=allow):
                self.assertEqual(await self.run_lights({'allow_actions': allow}, self.entry()), [])

    async def test_recovery_unknown_and_exit_are_not_bed_entry(self):
        self.light()
        for before, after in [('unknown', 'on'), ('unavailable', 'on'), ('on', 'on'), ('on', 'off')]:
            with self.subTest(before=before, after=after):
                self.assertEqual(await self.run_lights(trigger=self.entry(before=before, after=after)), [])

    async def test_one_minute_hold_and_short_dispatch_deadline(self):
        self.light()
        for age in [-1, 0, 59, 91, 3600]:
            with self.subTest(age=age):
                self.assertEqual(await self.run_lights(trigger=self.entry(age=age)), [])
        for age in [60, 90]:
            self.assertEqual(len(await self.run_lights(trigger=self.entry(age=age))), 1)

    async def test_new_occupancy_generation_or_unavailable_source_withdraws_action(self):
        self.light()
        for current in ['off', 'unknown', 'unavailable', 'on']:
            trigger = self.entry()
            self.hass.states._states[trigger['entity_id']] = State(trigger['entity_id'], current,
                last_changed=existing.NOW - timedelta(seconds=2))
            with self.subTest(current=current):
                self.assertEqual(await self.run_lights(trigger=trigger), [])

    async def test_night_window_crosses_midnight_and_rejects_daytime(self):
        self.light()
        for hour, minute, expected in [(21, 59, 0), (22, 0, 1), (0, 30, 1), (4, 59, 1), (5, 0, 0), (12, 0, 0)]:
            now = existing.NOW.astimezone(dt_util.DEFAULT_TIME_ZONE).replace(hour=hour, minute=minute)
            with self.subTest(hour=hour, minute=minute), patch.object(existing, 'NOW', now), patch.object(dt_util, 'now', return_value=now):
                self.assertEqual(len(await self.run_lights(trigger=self.entry())), expected)

    async def test_selected_pause_helpers_must_all_be_known_off(self):
        self.light()
        for state, expected in [('on', 0), ('unknown', 0), ('unavailable', 0), ('off', 1)]:
            self.hass.states.async_set('input_boolean.partner_resting', state)
            with self.subTest(state=state):
                self.assertEqual(len(await self.run_lights({'pause_entities': ['input_boolean.partner_resting']}, self.entry())), expected)
        self.assertEqual(await self.run_lights({'pause_entities': ['input_boolean.missing']}, self.entry()), [])

    async def test_shared_quiet_must_be_selected_and_known_off_even_without_optional_pauses(self):
        self.light()
        for state, expected in [('on', 0), ('unknown', 0), ('unavailable', 0), ('off', 1)]:
            self.hass.states.async_set('binary_sensor.test_shared_quiet', state)
            self.assertEqual(len(await self.run_lights(trigger=self.entry())), expected)
        for entity in ['', 'binary_sensor.missing', 'input_boolean.other']:
            self.assertEqual(await self.run_lights({'shared_quiet_entity': entity}, self.entry()), [])

    async def test_groups_and_unsupported_or_missing_brightness_are_skipped(self):
        variants = [
            ('on', 180, {'entity_id': ['light.child']}),
            ('on', 180, {'is_hue_group': True}),
            ('on', 180, {'supported_color_modes': ['onoff']}),
            ('on', 180, {'supported_color_modes': ['unknown_future_mode']}),
            ('on', 180, {'supported_color_modes': 'brightness'}),
            ('on', None, {}), ('on', True, {}), ('on', '180', {}),
            ('on', -1, {}), ('on', 256, {}), ('on', float('nan'), {}),
            ('unavailable', 180, {}), ('unknown', 180, {}),
        ]
        for state, brightness, attrs in variants:
            with self.subTest(state=state, brightness=brightness, attributes=attrs):
                self.light(state=state, brightness=brightness, **attrs)
                self.assertEqual(await self.run_lights(trigger=self.entry()), [])

    async def test_configured_brightness_uses_the_same_bounded_contract(self):
        self.light()
        for value in [0, 51, -1, True, '10', float('nan')]:
            with self.subTest(value=value):
                self.assertEqual(await self.run_lights({'brightness_percent': value}, self.entry()), [])
        calls = await self.run_lights({'brightness_percent': 20}, self.entry())
        self.assertEqual(calls[0][2]['brightness'], 51)

    async def test_later_lamp_manual_off_is_rechecked_before_dispatch(self):
        self.light('light.first')
        self.light('light.second')
        async def capture(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            self.hass.states.async_set('light.second', 'off')
        self.hass.services.async_register('light', 'turn_on', capture)
        calls = await self.run_lights({'lights': ['light.first', 'light.second']}, self.entry())
        self.assertEqual([call[2]['entity_id'] for call in calls], [['light.first']])

    async def test_lost_occupancy_or_new_pause_stops_remaining_lamps(self):
        self.light('light.first')
        self.light('light.second')
        for interrupt in ['occupancy', 'pause', 'shared_quiet']:
            self.hass.states.async_set('input_boolean.pause', 'off')
            self.hass.states.async_set('binary_sensor.test_shared_quiet', 'off')
            async def capture(call):
                self.calls.append((call.domain, call.service, dict(call.data)))
                if interrupt == 'occupancy':
                    self.hass.states.async_set('binary_sensor.test_left', 'unavailable')
                elif interrupt == 'pause':
                    self.hass.states.async_set('input_boolean.pause', 'on')
                else:
                    self.hass.states.async_set('binary_sensor.test_shared_quiet', 'on')
            self.hass.services.async_register('light', 'turn_on', capture)
            calls = await self.run_lights({'lights': ['light.first', 'light.second'], 'pause_entities': ['input_boolean.pause']}, self.entry())
            self.assertEqual([call[2]['entity_id'] for call in calls], [['light.first']])

    async def test_failed_service_does_not_retry_or_queue_remaining_lamps(self):
        self.light('light.first')
        self.light('light.second')
        async def fail(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            raise HomeAssistantError('Synthetic unavailable accessory')
        self.hass.services.async_register('light', 'turn_on', fail)
        with self.assertRaises(HomeAssistantError):
            await self.run_lights({'lights': ['light.first', 'light.second']}, self.entry())
        self.assertEqual([call[2]['entity_id'] for call in self.calls], [['light.first']])
