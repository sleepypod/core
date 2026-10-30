"""Run the actual production loop and compare isolated shadow results to SQLite.

Only transport, clocks and external occupancy/mode are fixtures. Numerical
processing, pump gating, runtime binding, routing and DB writes are real.
"""
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import numpy as np
import pytest

import main
from common.biometrics.live_input import FIRMWARE_TIMESTAMP_BASIS
from common.biometrics.replay import RecordedContext
from common.biometrics.shadow import ProspectiveShadow
from test_shadow import START, configs
from common.tests_support.mechanical import quiet_snapshot


def timeline(mechanical_available=True):
    for second in range(540):
        if second in (125, 126):  # Real missing frames, not a pause in processing.
            continue
        source = START / 1000 + second + .375
        delay = 2.25 + (2 if second == 80 else 1 if second == 81 else 0)
        observed = round((source + delay) * 1000)
        context = RecordedContext(('left',) if second < 440 else ('right',), True, True, True,
                                  quiet_snapshot(observed) if mechanical_available else None)
        samples = np.sin((np.arange(500) + second * 500) / 500 * 2 * np.pi * 1.2) * 1_000_000
        left, right = samples.astype('<i4').tobytes(), (samples * .1).astype('<i4').tobytes()
        if second == 150:
            left = b''
        if second == 160:
            source -= 20  # Stale, not new data merely because it just arrived.
        if second == 170:
            source -= 1  # Duplicate previous accepted frame.
        if second == 180:
            source += 3  # Future relative to observed arrival.
        if second == 190:
            source -= 2  # Reversed source clock.
        if second == 200:
            left = right = (samples * 100).astype('<i4').tobytes()
        if second in (300, 305):
            yield observed, {'type': 'frzHealth', 'ts': source,
                'left': {'pumpRpm': 1000 if second == 300 else 0}, 'right': {'pumpRpm': 0}}, context
        yield observed, {'type': 'piezo-dual', 'ts': source, 'left1': left, 'right1': right}, context


@pytest.mark.parametrize('mechanical_available', [True, False])
def test_real_live_loop_and_shadow_match_event_seconds_values_and_gap_recovery(monkeypatch, tmp_path, mechanical_available):
    database = tmp_path / 'biometrics.db'
    connection = sqlite3.connect(database)
    connection.executescript('''
        CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER,
            heart_rate REAL, hrv REAL, breathing_rate REAL);
        CREATE TABLE vitals_quality (vitals_id INTEGER, side TEXT, timestamp INTEGER,
            quality_score REAL, flags TEXT, hr_raw REAL, created_at INTEGER);
    ''')
    migration = Path(__file__).parents[2] / 'src/db/biometrics-migrations/0020_black_patch.sql'
    connection.executescript(migration.read_text())
    mechanical_migration = migration.parent / '0032_mechanical_signal_context.sql'
    connection.executescript(mechanical_migration.read_text())
    state = SimpleNamespace(observed=START, context=RecordedContext(('left',), True, True, True))
    monkeypatch.setattr(main, 'BIOMETRICS_DB', database)
    monkeypatch.setattr(main, 'open_biometrics_db', lambda: connection)
    monkeypatch.setattr(main, 'report_health', lambda *args: None)
    monkeypatch.setattr(main.time, 'time', lambda: state.observed / 1000)
    monkeypatch.setattr(main.time, 'monotonic', lambda: (state.observed - START) / 1000 + 1000)
    mode = SimpleNamespace(home_side=lambda: state.context.active_sides[0], active_sides=lambda: state.context.active_sides)
    monkeypatch.setattr(main, 'SingleSleeperMode', lambda _: mode)
    monkeypatch.setattr(main, 'BedPresence', lambda _: SimpleNamespace(occupied=lambda _: True))

    class Follower:
        def read_records(self, on_poll):
            for observed, record, context in timeline(mechanical_available):
                state.observed, state.context = observed, context
                snapshot = context.mechanical
                if snapshot:
                    connection.execute('INSERT OR REPLACE INTO biometric_mechanical_state VALUES (1,?)', (json.dumps(snapshot['state']),))
                    for span in snapshot['spans']:
                        connection.execute('INSERT OR REPLACE INTO biometric_mechanical_spans VALUES (?,?,?,?)', tuple(span[key] for key in ('id', 'epoch', 'startMs', 'endMs')))
                connection.commit()
                on_poll()
                yield record

    monkeypatch.setattr(main, 'create_follower', lambda *args, **kwargs: Follower())
    main.main()  # Includes real runtime provenance, DB quantization and shutdown flush.
    with sqlite3.connect(database) as saved:
        rows = saved.execute('''SELECT v.side, v.timestamp * 1000, v.heart_rate, v.hrv, v.breathing_rate,
            q.quality_score, q.flags, q.hr_raw, r.input_identity FROM vitals v
            JOIN vitals_quality q ON q.vitals_id = v.id JOIN biometric_processing_runs r ON r.id = v.processing_run_id
            ORDER BY v.timestamp, v.side''').fetchall()
    if mechanical_available:
        assert rows and {row[0] for row in rows} == {'left', 'right'}
    else:
        assert rows == []
    assert all(json.loads(row[-1])['timestampBasis'] == FIRMWARE_TIMESTAMP_BASIS for row in rows)
    # Firmware fractions truncate exactly as in the DB, never to arrival seconds.
    assert all(row[1] % 1000 == 0 for row in rows)
    for side in ('left', 'right'):
        outputs = []
        candidate = ProspectiveShadow(configs(), side=side, start_ms=START, end_ms=START + 550000,
            maximum_records=600, maximum_outputs=50, maximum_cpu_ms=60000, sink=outputs.append)
        for observed, record, context in timeline(mechanical_available):
            candidate.feed(observed, record, context)
        candidate.finish()
        expected = [(row[0], row[1], *row[2:6], tuple(json.loads(row[6])) if row[6] else (), row[7]) for row in rows if row[0] == side]
        actual = [(item.reading.side, item.reading.timestamp_ms, item.reading.candidate.heart_rate,
            item.reading.candidate.hrv, item.reading.candidate.breathing_rate, item.reading.candidate.quality_score,
            tuple(item.reading.candidate.flags or ()), item.reading.candidate.hr_raw) for item in outputs]
        assert actual == expected
        counts = candidate.health()['counts']
        assert counts['timestamp_rejected_frames'] == 4
        if mechanical_available:
            assert counts['empty_channel_frames'] == 1
            assert counts['pump_gated_frames'] >= 5
        else:
            assert counts['mechanical_gated_frames'] > 500
        assert candidate.health()['timestampBasis'] == FIRMWARE_TIMESTAMP_BASIS
        assert 'recorded_arrival_replaces_local_monotonic_clock' in candidate.health()['limitations']
