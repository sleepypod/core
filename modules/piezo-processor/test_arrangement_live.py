"""The production loop acknowledges both installed profiles, not just a database intent."""
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import numpy as np
import pytest

import main
from common.test_arrangement_processing import rig  # noqa: F401 - shared real-SQLite fixture
from common.biometrics.config import resolve_config, config_hash
from common.tests_support.mechanical import quiet_snapshot


@pytest.mark.parametrize('project_both', [True, False])
def test_actual_live_loop_waits_for_both_profiles_and_reports_new_routing(rig, tmp_path, monkeypatch, project_both):
    configuration, biometrics, intent, consumer, _, clock = rig
    selected = resolve_config([])
    intent['profiles'] = {side: {'generation': 2, 'hash': selected['hash']} for side in ('left', 'right')}
    configuration.execute('UPDATE household_arrangement_transitions SET processing=?', (json.dumps(intent),))
    configuration.commit()
    biometrics.executescript('''
        CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER,
            heart_rate REAL, hrv REAL, breathing_rate REAL);
        CREATE TABLE vitals_quality (vitals_id INTEGER, side TEXT, timestamp INTEGER,
            quality_score REAL, flags TEXT, hr_raw REAL, created_at INTEGER);
    ''')
    migration = Path(__file__).parents[2] / 'src/db/biometrics-migrations/0020_black_patch.sql'
    biometrics.executescript(migration.read_text())
    for side in (('left', 'right') if project_both else ('left',)):
        payload = dict(schemaVersion=1, side=side, generation=2, revisionId=None,
                       resolved=selected['resolved'], resolvedHash=selected['hash'], manifestHash=selected['manifestHash'], boundary='immediate')
        biometrics.execute('INSERT INTO biometric_runtime_configs VALUES (?, 2, ?, ?, ?, ?)',
                           (side, selected['hash'], json.dumps(payload), 'immediate', int(clock.now * 1000)))
    biometrics.commit()
    target = tmp_path / 'live.db'
    with sqlite3.connect(target) as destination:
        biometrics.backup(destination)
    monkeypatch.setattr(main, 'BIOMETRICS_DB', target)
    monkeypatch.setattr(main, 'SLEEPYPOD_DB', consumer.config_path)
    monkeypatch.setattr(main, 'open_biometrics_db', lambda: sqlite3.connect(target))
    monkeypatch.setattr(main.time, 'time', clock)
    monkeypatch.setattr(main.time, 'monotonic', clock)
    monkeypatch.setattr(main, 'report_health', lambda *args: None)
    monkeypatch.setattr(main, 'KNOWN_RECORD_TYPES', {'piezo-dual'})
    monkeypatch.setattr(main, 'read_snapshot', lambda _, now: quiet_snapshot(now))
    monkeypatch.setattr(main, 'BedPresence', lambda _: SimpleNamespace(occupied=lambda _: False))
    monkeypatch.setattr(main.PumpGate, 'check', lambda *args: False)
    mode = main.SingleSleeperMode(consumer.config_path, clock=clock)
    mode._home, mode._active, mode._last_read = 'left', ('left',), clock.now  # old solo cache
    monkeypatch.setattr(main, 'SingleSleeperMode', lambda _: mode)

    class Follower:
        def read_records(self, on_poll):
            payload = np.zeros(500, dtype='<i4').tobytes()
            for _ in range(4):
                on_poll()
                yield {'type': 'piezo-dual', 'ts': clock.now, 'left1': payload, 'right1': payload}
                clock.now += 1

    monkeypatch.setattr(main, 'create_follower', lambda *args, **kwargs: Follower())
    main.main()
    assert mode.home_side() is None and mode.active_sides() == ('left', 'right')
    with sqlite3.connect(target) as saved:
        receipts = saved.execute('SELECT component, intent_hash FROM household_processing_receipts').fetchall()
        assert receipts == ([('piezo-processor', config_hash(intent))] if project_both else [])
        assert saved.execute('SELECT COUNT(*) FROM vitals').fetchone() == (0,)  # empty bed, no fabricated vitals
