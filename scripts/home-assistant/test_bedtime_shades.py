"""Execute the shade routine with HA's engine, without commanding accessories."""
from datetime import timedelta
from unittest.mock import patch

from homeassistant.components.cover.const import CoverEntityFeature
from homeassistant.core import State
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

import test_blueprints as existing


class BedtimeShades(existing.BlueprintHarness):
    def shade(self, entity='cover.selected', state='open', position=80, **attributes):
        values = {'current_position': position, 'device_class': 'shade',
                  'supported_features': int(CoverEntityFeature.SET_POSITION | CoverEntityFeature.STOP)}
        values.update(attributes)
        self.hass.states.async_set(entity, state, values)

    def entry(self, age=65, before='off', after='on', entity='binary_sensor.test_left'):
        changed = existing.NOW - timedelta(seconds=age)
        current = State(entity, after, last_changed=changed)
        self.hass.states._states[entity] = current
        return {'platform': 'state', 'entity_id': entity,
                'from_state': State(entity, before, last_changed=changed - timedelta(minutes=5)),
                'to_state': current}

    async def run_shades(self, inputs=None, trigger=None):
        values = {'allow_actions': True, 'shades': ['cover.selected']}
        values.update(inputs or {})
        return await self.run_actions('bedtime_shades.yaml', values, trigger)

    async def test_known_entry_sets_only_selected_shades_and_never_opens_lower_ones(self):
        self.shade()
        self.shade('cover.closed', 'closed', 0)
        self.shade('cover.lower', position=10)
        self.shade('cover.at_target', position=20)
        self.shade('cover.unselected')
        calls = await self.run_shades({'position': 20, 'shades': ['cover.selected', 'cover.closed',
            'cover.lower', 'cover.at_target', 'cover.selected']}, self.entry())
        self.assertEqual(calls, [('cover', 'set_cover_position', {'entity_id': ['cover.selected'], 'position': 20})])

    async def test_both_sides_and_all_supported_window_coverings(self):
        for source in ['binary_sensor.test_left', 'binary_sensor.test_right']:
            for device_class in ['blind', 'shade', 'curtain']:
                with self.subTest(source=source, device_class=device_class):
                    self.shade(device_class=device_class)
                    calls = await self.run_shades(trigger=self.entry(entity=source))
                    self.assertEqual(calls[0][2]['position'], 0)

    async def test_manual_run_permissions_and_unrelated_or_mismatched_events_do_not_move(self):
        self.shade()
        self.assertEqual(await self.run_shades(), [])
        self.assertEqual(await self.run_shades(trigger={'platform': 'time'}), [])
        self.assertEqual(await self.run_shades(trigger=self.entry(entity='binary_sensor.other_bed')), [])
        for permission in [False, 1, 'true', 'yes', None]:
            self.assertEqual(await self.run_shades({'allow_actions': permission}, self.entry()), [])
        for field in ['from_state', 'to_state']:
            trigger = self.entry()
            trigger[field] = State('binary_sensor.other_bed', 'off' if field == 'from_state' else 'on')
            self.assertEqual(await self.run_shades(trigger=trigger), [])

    async def test_unknown_recovery_and_occupancy_exit_are_not_entry(self):
        self.shade()
        for before, after in [('unknown', 'on'), ('unavailable', 'on'), ('on', 'on'), ('on', 'off')]:
            with self.subTest(before=before, after=after):
                self.assertEqual(await self.run_shades(trigger=self.entry(before=before, after=after)), [])

    async def test_one_minute_hold_and_dispatch_deadline(self):
        self.shade()
        for age in [-1, 0, 59, 91, 3600]:
            with self.subTest(age=age):
                self.assertEqual(await self.run_shades(trigger=self.entry(age=age)), [])
        for age in [60, 90]:
            self.assertEqual(len(await self.run_shades(trigger=self.entry(age=age))), 1)

    async def test_source_must_still_have_the_same_occupied_interval(self):
        self.shade()
        for state in ['off', 'unknown', 'unavailable', 'on']:
            trigger = self.entry()
            self.hass.states._states[trigger['entity_id']] = State(trigger['entity_id'], state,
                last_changed=existing.NOW - timedelta(seconds=2))
            self.assertEqual(await self.run_shades(trigger=trigger), [])

    async def test_night_window_and_each_pause_helper_are_rechecked(self):
        self.shade()
        for hour, expected in [(21, 0), (22, 1), (0, 1), (4, 1), (5, 0), (12, 0)]:
            now = existing.NOW.astimezone(dt_util.DEFAULT_TIME_ZONE).replace(hour=hour)
            with patch.object(existing, 'NOW', now), patch.object(dt_util, 'now', return_value=now):
                self.assertEqual(len(await self.run_shades(trigger=self.entry())), expected)
        for state, expected in [('on', 0), ('unknown', 0), ('unavailable', 0), ('off', 1)]:
            self.hass.states.async_set('input_boolean.partner_resting', state)
            self.assertEqual(len(await self.run_shades({'pause_entities': ['input_boolean.partner_resting']}, self.entry())), expected)
        self.assertEqual(await self.run_shades({'pause_entities': ['input_boolean.missing']}, self.entry()), [])

    async def test_other_cover_classes_and_groups_cannot_move(self):
        for device_class in ['garage', 'door', 'gate', 'window', 'awning', 'damper', 'shutter', None, 'unknown']:
            with self.subTest(device_class=device_class):
                self.shade(device_class=device_class)
                self.assertEqual(await self.run_shades(trigger=self.entry()), [])
        self.shade(entity_id=['cover.child'])
        self.assertEqual(await self.run_shades(trigger=self.entry()), [])
        self.shade(assumed_state=True)
        self.assertEqual(await self.run_shades(trigger=self.entry()), [])

    async def test_position_and_stop_must_both_be_supported(self):
        for features in [0, 1, 2, 3, 4, 8, 11, -1, 12.0, True, '12', None]:
            with self.subTest(features=features):
                self.shade(supported_features=features)
                self.assertEqual(await self.run_shades(trigger=self.entry()), [])
        self.shade(supported_features=15)
        self.assertEqual(len(await self.run_shades(trigger=self.entry())), 1)

    async def test_moving_and_unavailable_shades_are_not_interrupted(self):
        for state in ['opening', 'closing', 'unknown', 'unavailable', 'closed']:
            with self.subTest(state=state):
                self.shade(state=state)
                self.assertEqual(await self.run_shades(trigger=self.entry()), [])

    async def test_missing_or_invalid_reported_positions_do_not_become_open(self):
        for position in [None, True, '80', -1, 101, float('nan'), float('inf')]:
            with self.subTest(position=position):
                self.shade(position=position)
                self.assertEqual(await self.run_shades(trigger=self.entry()), [])

    async def test_configured_position_is_bounded_and_whole_percent(self):
        self.shade()
        for position in [-1, 51, True, '20', 0.5, float('nan'), float('inf')]:
            with self.subTest(position=position):
                self.assertEqual(await self.run_shades({'position': position}, self.entry()), [])
        for position in [0, 20, 50]:
            calls = await self.run_shades({'position': position}, self.entry())
            self.assertEqual(calls[0][2]['position'], position)

    async def test_configuration_cannot_expand_beyond_reviewed_entity_lists(self):
        self.shade()
        for inputs in [
            {'occupancy_entities': ['binary_sensor.test_left', 'binary_sensor.test_left']},
            {'occupancy_entities': ['binary_sensor.test_left', 'binary_sensor.test_right', 'binary_sensor.other_bed']},
            {'shades': ['cover.selected'] * 21},
            {'pause_entities': ['input_boolean.pause'] * 21},
        ]:
            with self.subTest(inputs=inputs):
                self.assertEqual(await self.run_shades(inputs, self.entry()), [])

    async def test_manual_movement_before_next_shade_prevents_its_request(self):
        self.shade('cover.first')
        self.shade('cover.second')
        async def capture(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            self.shade('cover.second', 'opening', 50)
        self.hass.services.async_register('cover', 'set_cover_position', capture)
        calls = await self.run_shades({'shades': ['cover.first', 'cover.second']}, self.entry())
        self.assertEqual([call[2]['entity_id'] for call in calls], [['cover.first']])

    async def test_new_pause_stale_occupancy_or_deadline_stops_remaining_requests(self):
        self.shade('cover.first')
        self.shade('cover.second')
        for interruption in ['pause', 'occupancy', 'deadline']:
            self.hass.states.async_set('input_boolean.pause', 'off')
            dt_util.now.return_value = existing.NOW.astimezone(dt_util.DEFAULT_TIME_ZONE)
            async def capture(call):
                self.calls.append((call.domain, call.service, dict(call.data)))
                if interruption == 'pause':
                    self.hass.states.async_set('input_boolean.pause', 'on')
                elif interruption == 'occupancy':
                    self.hass.states.async_set('binary_sensor.test_left', 'unavailable')
                else:
                    dt_util.now.return_value = existing.NOW + timedelta(seconds=30)
            self.hass.services.async_register('cover', 'set_cover_position', capture)
            calls = await self.run_shades({'shades': ['cover.first', 'cover.second'],
                'pause_entities': ['input_boolean.pause']}, self.entry())
            self.assertEqual([call[2]['entity_id'] for call in calls], [['cover.first']])

    async def test_service_failure_aborts_without_retry_or_opening(self):
        self.shade('cover.first')
        self.shade('cover.second')
        async def fail(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            raise HomeAssistantError('Synthetic unavailable shade')
        self.hass.services.async_register('cover', 'set_cover_position', fail)
        with self.assertRaises(HomeAssistantError):
            await self.run_shades({'shades': ['cover.first', 'cover.second']}, self.entry())
        self.assertEqual([call[2]['entity_id'] for call in self.calls], [['cover.first']])
