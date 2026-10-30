"""Real SQLite, estimator and routing checks for live profile adoption."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

import numpy as np
import pytest

import main
from common.biometrics.config import resolve_config
from runtime_adapter import RuntimeCoordinator, restore_applied
from common.biometrics.live_input import FIRMWARE_TIMESTAMP_BASIS


class Clock:
    value = 0
    def __call__(self):
        return self.value


@pytest.fixture
def rig():
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER,
                             heart_rate REAL, hrv REAL, breathing_rate REAL);
        CREATE TABLE vitals_quality (vitals_id INTEGER, side TEXT, timestamp INTEGER,
                                     quality_score REAL, flags TEXT, hr_raw REAL, created_at INTEGER);
    """)
    migration = Path(__file__).parents[2] / "src/db/biometrics-migrations/0020_black_patch.sql"
    conn.executescript(migration.read_text())
    holder = main.DBHolder(conn)
    processors = {side: main.SideProcessor(side, holder) for side in ("left", "right")}
    clock = Clock()
    coordinator = RuntimeCoordinator(holder, processors, clock=clock)
    return conn, holder, processors, clock, coordinator


def project(conn, generation=1, side="left", boundary="immediate", overrides=None):
    config = resolve_config(overrides or [{"path": "heart_rate.trackingToleranceBpm", "value": 20}])
    payload = dict(schemaVersion=1, side=side, generation=generation, revisionId=None,
                   resolved=config["resolved"], resolvedHash=config["hash"],
                   manifestHash=config["manifestHash"], boundary=boundary)
    with conn:
        conn.execute("INSERT INTO biometric_runtime_configs VALUES (?, ?, ?, ?, ?, ?)",
                     (side, generation, config["hash"], json.dumps(payload), boundary, 0))
    return config


def test_firmware_time_provenance_survives_delayed_candidate_write(rig):
    conn, holder, processors, clock, _ = rig
    runtime = RuntimeCoordinator(holder, processors, clock=clock,
                                 timestamp_basis=FIRMWARE_TIMESTAMP_BASIS)
    runtime.before_frame(None, lambda _: True, 5000)
    context = processors["left"].run_context
    candidate = main.VitalsCandidate("left", datetime.fromtimestamp(5, timezone.utc),
                                     70, 30, 12, .8, None, 70, context)
    assert candidate.write(holder)
    assert conn.execute("SELECT timestamp FROM vitals").fetchone() == (5,)
    identity = json.loads(conn.execute("SELECT input_identity FROM biometric_processing_runs").fetchone()[0])
    assert identity["timestampBasis"] == FIRMWARE_TIMESTAMP_BASIS


def test_actual_parameters_reset_before_samples_and_ack_after(rig):
    conn, _, processors, _, runtime = rig
    project(conn)
    left = processors["left"]
    left._hr_buf.extend([123] * 20)
    runtime.before_frame(None, lambda _: True, 1000)
    assert left.parameters.tracking_tolerance_bpm == 20
    assert len(left._hr_buf) == 0
    assert processors["right"].parameters.tracking_tolerance_bpm == 15
    assert conn.execute("SELECT * FROM biometric_runtime_receipts").fetchall() == []
    left.ingest(np.array([1, 2]))
    runtime.after_frame(1000)
    receipts = conn.execute("SELECT component, generation, effective_sample_time_ms, state FROM biometric_runtime_receipts").fetchall()
    assert len(receipts) == 3
    assert {r[0] for r in receipts} == {"heart_rate", "breathing_rate", "hrv_index"}
    assert all(r[1:] == (1, 1000, "applied") for r in receipts)


def test_pending_next_session_and_restart_restore(rig):
    conn, holder, processors, clock, runtime = rig
    project(conn, boundary="next_session")
    runtime.before_frame(None, lambda _: None, 1000)
    runtime.after_frame(1000)
    assert processors["left"].parameters.tracking_tolerance_bpm == 15
    assert restore_applied(conn, "left") is None
    runtime.before_frame(None, lambda _: False, 2000)
    runtime.after_frame(2000)
    assert restore_applied(conn, "left").generation == 1
    restarted = RuntimeCoordinator(holder, {s: main.SideProcessor(s, holder) for s in processors}, clock=clock)
    restarted.before_frame(None, lambda _: True, 3000)
    assert restarted.processors["left"].parameters.tracking_tolerance_bpm == 20
    assert restarted.processors["left"].run_context.id != processors["left"].run_context.id


def test_single_sleeper_uses_home_profile_on_both_channels_and_retains_source(rig):
    conn, holder, processors, _, runtime = rig
    config = project(conn)
    runtime.before_frame("left", lambda _: True, 1000)
    assert processors["right"].parameters.tracking_tolerance_bpm == 20
    context = processors["right"].run_context
    candidate = main.VitalsCandidate("right", datetime.fromtimestamp(5, timezone.utc),
                                     70, 30, 12, .8, None, 70, context)
    # A delayed retry after a mode change must preserve its original destination.
    assert candidate.write(holder, side="right")
    row = conn.execute("SELECT side, processing_run_id FROM vitals").fetchone()
    assert row == ("left", context.id)
    run = conn.execute("SELECT side, config_hash, input_identity FROM biometric_processing_runs").fetchone()
    assert run[:2] == ("left", config["hash"])
    assert json.loads(run[2])["sourceSide"] == "right"
    runtime.before_frame(None, lambda _: True, 2000)
    assert processors["right"].parameters.tracking_tolerance_bpm == 15
    assert processors["right"].run_context.side == "right"


def test_stage_only_change_preserves_numerical_state(rig):
    conn, _, processors, clock, runtime = rig
    project(conn)
    runtime.before_frame(None, lambda _: True, 1000)
    left = processors["left"]
    left._hr_buf.extend([7, 8])
    estimator = left._estimator
    project(conn, 2, overrides=[{"path": "heart_rate.trackingToleranceBpm", "value": 20},
                               {"path": "sleep_stages.ruleset.smoothIsolatedEpochs", "value": False}])
    clock.value = 5
    runtime.before_frame(None, lambda _: True, 2000)
    assert left._estimator is estimator
    assert list(left._hr_buf) == [7, 8]
    assert json.loads(left.run_context.bundle_json)["generation"] == 2


def test_invalid_new_projection_retains_actual_profile_and_reports_error(rig):
    conn, _, processors, clock, runtime = rig
    project(conn)
    runtime.before_frame(None, lambda _: True, 1000)
    runtime.after_frame(1000)
    project(conn, 2)
    conn.execute("UPDATE biometric_runtime_configs SET payload='{}' WHERE generation=2")
    clock.value = 5
    runtime.before_frame(None, lambda _: True, 2000)
    runtime.after_frame(2000)
    assert processors["left"].parameters.tracking_tolerance_bpm == 20
    assert runtime.problem is not None
    assert conn.execute("SELECT DISTINCT generation FROM biometric_runtime_receipts").fetchall() == [(1,)]


def test_observation_and_provenance_rollback_together_then_recover(rig):
    conn, holder, processors, _, runtime = rig
    runtime.before_frame(None, lambda _: True, 1000)
    context = processors["left"].run_context
    conn.execute("CREATE TRIGGER reject_quality BEFORE INSERT ON vitals_quality BEGIN SELECT RAISE(ABORT, 'full'); END")
    candidate = main.VitalsCandidate("left", datetime.fromtimestamp(5, timezone.utc), 70, 30, 12, .8, None, 70, context)
    assert not candidate.write(holder)
    assert conn.execute("SELECT * FROM vitals").fetchall() == []
    assert conn.execute("SELECT * FROM biometric_processing_runs").fetchall() == []
    conn.execute("DROP TRIGGER reject_quality")
    assert candidate.write(holder)
    assert conn.execute("SELECT processing_run_id FROM vitals").fetchone()[0] == context.id
    # History reset: a retained context can recreate its exact bundle.
    conn.execute("DELETE FROM vitals")
    conn.execute("DELETE FROM biometric_processing_runs")
    conn.commit()
    assert candidate.write(holder)
    assert conn.execute("SELECT id FROM biometric_processing_runs").fetchone()[0] == context.id


def test_receipt_transaction_failure_retries_without_false_applied_state(rig):
    conn, _, _, _, runtime = rig
    project(conn)
    runtime.before_frame(None, lambda _: True, 1000)
    conn.execute("CREATE TRIGGER reject_receipt BEFORE INSERT ON biometric_runtime_receipts WHEN NEW.component='hrv_index' BEGIN SELECT RAISE(ABORT, 'full'); END")
    runtime.after_frame(1000)
    assert conn.execute("SELECT * FROM biometric_runtime_receipts").fetchall() == []
    assert runtime.problem is not None
    conn.execute("DROP TRIGGER reject_receipt")
    runtime.after_frame(2000)
    assert restore_applied(conn, "left").generation == 1


def test_old_schema_cannot_enable_custom_processing(rig):
    conn, _, processors, _, runtime = rig
    project(conn)
    conn.execute("DROP TABLE biometric_runtime_receipts")
    runtime.before_frame(None, lambda _: True, 1000)
    assert not runtime.enabled
    assert processors["left"].parameters.tracking_tolerance_bpm == 15
    assert runtime.problem is not None


def test_restore_rejects_corrupt_projection_envelope(rig):
    conn, _, _, _, runtime = rig
    project(conn)
    runtime.before_frame(None, lambda _: True, 1000)
    runtime.after_frame(1000)
    conn.execute("UPDATE biometric_runtime_configs SET resolved_hash='corrupt'")
    with pytest.raises(ValueError, match="envelope mismatch"):
        restore_applied(conn, "left")


def test_heartbeat_is_bounded_and_repairs_missing_receipts(rig):
    conn, _, _, clock, runtime = rig
    project(conn)
    runtime.before_frame(None, lambda _: True, 1000)
    runtime.after_frame(1000)
    runtime.after_frame(2000)
    assert conn.execute("SELECT DISTINCT heartbeat_at_ms FROM biometric_runtime_receipts").fetchall() == [(1000,)]
    conn.execute("DELETE FROM biometric_runtime_receipts")
    conn.commit()
    clock.value = 30
    runtime.before_frame(None, lambda _: True, 31000)
    runtime.after_frame(31000)
    assert restore_applied(conn, "left").generation == 1
    assert conn.execute("SELECT DISTINCT heartbeat_at_ms FROM biometric_runtime_receipts").fetchall() == [(31000,)]
