"""Real SQLite receipts cannot be inferred from a reset attempt or elapsed time."""
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from common.arrangement_processing import ArrangementProcessing, parse_intent, read_intent
from common.biometrics.config import config_hash


class Clock:
    now = 1800000000.0

    def __call__(self):
        return self.now


@pytest.fixture
def rig(tmp_path):
    clock = Clock()
    intent = dict(version=1, operationId=str(uuid4()), householdId=str(uuid4()), datasetId=str(uuid4()),
                  assignmentRevision=2, committedAt=int(clock.now * 1000) - 1000, mode="two",
                  profiles={side: {"generation": 2, "hash": "a" * 64} for side in ("left", "right")})
    path = tmp_path / "config.db"
    config = sqlite3.connect(path)
    config.executescript("""
        CREATE TABLE households(id TEXT, mode TEXT, assignment_revision INTEGER, effective_at INTEGER);
        CREATE TABLE household_arrangement_transitions(id TEXT, household_id TEXT, state TEXT, committed_at INTEGER, processing TEXT);
        CREATE TABLE device_settings(id INTEGER, bed_mode TEXT);
        CREATE TABLE side_settings(side TEXT, away_mode INTEGER);
        CREATE TABLE biometric_profile_bindings(side TEXT, generation INTEGER, desired_revision_id TEXT);
    """)
    config.execute("INSERT INTO households VALUES (?, 'assigned', 2, ?)", (intent["householdId"], intent["committedAt"]))
    config.execute("INSERT INTO household_arrangement_transitions VALUES (?, ?, 'committed', ?, ?)",
                   (intent["operationId"], intent["householdId"], intent["committedAt"], json.dumps(intent)))
    config.execute("INSERT INTO device_settings VALUES (1, 'two')")
    config.executemany("INSERT INTO side_settings VALUES (?, 0)", [("left",), ("right",)])
    config.executemany("INSERT INTO biometric_profile_bindings VALUES (?, 2, NULL)", [("left",), ("right",)])
    config.commit()
    biometrics = sqlite3.connect(":memory:")
    biometrics.execute("CREATE TABLE biometric_history_identity(id INTEGER, dataset_id TEXT, created_at_ms INTEGER)")
    biometrics.execute("INSERT INTO biometric_history_identity VALUES (1, ?, ?)", (intent["datasetId"], intent["committedAt"] - 1000))
    migrations = Path(__file__).parents[2] / "src/db/biometrics-migrations"
    biometrics.executescript(next(migrations.glob('*_household_processing_receipts.sql')).read_text())
    resets = []
    reset = lambda desired: resets.append(desired) or True
    consumer = ArrangementProcessing(path, lambda: biometrics, "sleep-detector", reset, clock, clock)
    yield config, biometrics, intent, consumer, resets, clock
    config.close()
    biometrics.close()


def test_receipt_only_after_reset_and_actual_fresh_frame(rig):
    _, biometrics, intent, consumer, resets, clock = rig
    sample = int(clock.now * 1000)
    consumer.after_frame(sample)
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchall() == []
    assert consumer.before_frame(sample)
    assert resets == [intent]
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchall() == []
    consumer.after_frame(sample)
    row = biometrics.execute("SELECT * FROM household_processing_receipts").fetchone()
    assert row == (intent["operationId"], "sleep-detector", consumer.process_id, config_hash(intent), sample, sample, sample)
    assert not consumer.before_frame(sample)
    clock.now += 2
    assert consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    assert len(resets) == 1
    row = biometrics.execute("SELECT first_sample_ms, latest_sample_ms FROM household_processing_receipts").fetchone()
    assert row == (sample, sample + 2000)


@pytest.mark.parametrize("offset", [-10001, -2000, 1, float('nan'), float('inf')])
def test_old_future_or_invalid_frames_cannot_adopt(rig, offset):
    _, biometrics, _, consumer, resets, clock = rig
    assert not consumer.before_frame(clock.now * 1000 + offset)
    assert resets == []
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchall() == []


@pytest.mark.parametrize('timestamp', [True, None, '1800000000000', 10 ** 400])
def test_non_numeric_or_unbounded_source_time_is_rejected(rig, timestamp):
    assert not rig[3].before_frame(timestamp)


def test_failed_reset_never_receipted_and_can_retry(rig):
    _, biometrics, _, consumer, resets, clock = rig
    consumer.reset = lambda _: False
    sample = int(clock.now * 1000)
    assert not consumer.before_frame(sample)
    consumer.after_frame(sample)
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchall() == []
    consumer.reset = lambda desired: resets.append(desired) or True
    assert consumer.before_frame(sample)
    consumer.after_frame(sample)
    assert len(resets) == 1


@pytest.mark.parametrize("change", [
    "UPDATE household_arrangement_transitions SET processing=NULL",
    "UPDATE household_arrangement_transitions SET state='held'",
    "UPDATE households SET assignment_revision=3",
    "UPDATE households SET effective_at=1",
    "UPDATE device_settings SET bed_mode='solo-left'",
    "UPDATE side_settings SET away_mode=1 WHERE side='right'",
    "UPDATE biometric_profile_bindings SET generation=3 WHERE side='left'",
    "UPDATE biometric_profile_bindings SET desired_revision_id='old-person' WHERE side='left'",
])
def test_changed_or_missing_configuration_blocks_adoption(rig, change):
    config, biometrics, _, consumer, resets, clock = rig
    config.execute(change)
    config.commit()
    assert not consumer.before_frame(int(clock.now * 1000))
    assert consumer.problem
    assert resets == []
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchall() == []


def test_changed_source_and_disappeared_intent_do_not_reuse_old_acknowledgment(rig):
    config, biometrics, _, consumer, _, clock = rig
    assert consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    original = biometrics.execute("SELECT * FROM household_processing_receipts").fetchone()
    config.execute("DELETE FROM households")
    config.commit()
    clock.now += 2
    assert not consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    assert biometrics.execute("SELECT * FROM household_processing_receipts").fetchone() == original


def test_recording_database_replacement_blocks_receipt(rig):
    _, biometrics, _, consumer, resets, clock = rig
    biometrics.execute("UPDATE biometric_history_identity SET dataset_id=?", (str(uuid4()),))
    assert not consumer.before_frame(int(clock.now * 1000))
    assert resets == []


def test_restart_needs_new_boundary_and_replaces_process_receipt(rig):
    _, biometrics, intent, consumer, resets, clock = rig
    assert consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    restarted = ArrangementProcessing(consumer.config_path, lambda: biometrics, "sleep-detector",
                                     lambda desired: resets.append(desired) or True, clock, clock)
    clock.now += 2
    assert restarted.before_frame(int(clock.now * 1000))
    restarted.after_frame(int(clock.now * 1000))
    assert len(resets) == 2 and restarted.process_id != consumer.process_id
    assert biometrics.execute("SELECT process_id, first_sample_ms FROM household_processing_receipts").fetchone() == (restarted.process_id, int(clock.now * 1000))
    assert read_intent(consumer.config_path) == intent


def test_receipt_failure_blocks_until_storage_rechecks(rig):
    _, biometrics, _, consumer, _, clock = rig
    biometrics.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON household_processing_receipts BEGIN SELECT RAISE(FAIL, 'write failed'); END")
    assert consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    assert consumer.problem
    assert not consumer.before_frame(int(clock.now * 1000) + 1)
    biometrics.execute("DROP TRIGGER fail_receipt")
    clock.now += 2
    assert consumer.before_frame(int(clock.now * 1000))
    consumer.after_frame(int(clock.now * 1000))
    assert len(biometrics.execute("SELECT * FROM household_processing_receipts").fetchall()) == 1


def test_legacy_solo_is_unchanged_and_missing_database_is_not_created(tmp_path):
    path = tmp_path / "solo.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE side_settings(side TEXT)")
    consumer = ArrangementProcessing(path, lambda: None, "sleep-detector", lambda _: pytest.fail('unexpected reset'))
    assert consumer.before_frame(float('nan'))
    assert consumer.intent is None
    path.unlink()
    with pytest.raises(sqlite3.OperationalError):
        read_intent(path)
    assert not path.exists()


@pytest.mark.parametrize("update", [{"version": True}, {"mode": "solo-left"}, {"assignmentRevision": 0},
                                    {"committedAt": True}, {"profiles": {}}, {"operationId": "bad"}, {"extra": 1}])
def test_invalid_intent_cannot_claim_adoption(rig, update):
    intent = {**rig[2], **update}
    with pytest.raises(ValueError):
        parse_intent(json.dumps(intent))


def test_duplicate_and_oversized_intent(rig):
    with pytest.raises(ValueError):
        parse_intent(json.dumps(rig[2])[:-1] + ', "version": 1}')
    with pytest.raises(ValueError):
        parse_intent(' ' * 16385)


def test_swift_uppercase_request_identity_survives_the_live_receipt(rig):
    configuration, biometrics, intent, consumer, _, clock = rig
    intent['operationId'] = intent['operationId'].upper()
    configuration.execute('UPDATE household_arrangement_transitions SET id=?, processing=?',
                          (intent['operationId'], json.dumps(intent)))
    configuration.commit()
    sample = int(clock.now * 1000)
    assert consumer.before_frame(sample)
    consumer.after_frame(sample)
    assert biometrics.execute('SELECT operation_id, intent_hash FROM household_processing_receipts').fetchone() == (
        intent['operationId'], config_hash(intent))


@pytest.mark.parametrize('identifier', ['a' * 32, 'aaaaaaaa-aaaa-9aaa-aaaa-aaaaaaaaaaaa'])
def test_noncanonical_or_unsupported_uuid_is_rejected(rig, identifier):
    with pytest.raises(ValueError):
        parse_intent(json.dumps({**rig[2], 'operationId': identifier}))


def test_fractional_timestamp_cannot_reacknowledge_the_same_millisecond(rig):
    _, biometrics, _, consumer, _, clock = rig
    sample = int(clock.now * 1000) - 1 + 0.5
    assert consumer.before_frame(sample)
    consumer.after_frame(int(sample))
    before = biometrics.execute('SELECT * FROM household_processing_receipts').fetchall()
    assert not consumer.before_frame(sample)
    consumer.after_frame(int(sample))
    assert biometrics.execute('SELECT * FROM household_processing_receipts').fetchall() == before
