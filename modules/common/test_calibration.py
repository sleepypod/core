"""Focused regression tests for shared calibration primitives."""

import json
import sqlite3

import pytest

from common.calibration import CalibrationStore, CapCalibrator


def cap_records(count, value=lambda i: 1000):
    return [
        {
            "type": "capSense",
            "ts": 1_700_000_000 + i,
            "left": {
                "out": value(i),
                "cen": value(i) + 100,
                "in": value(i) + 200,
            },
        }
        for i in range(count)
    ]


def create_store(tmp_path):
    db_path = tmp_path / "biometrics.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE calibration_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          side TEXT NOT NULL,
          sensor_type TEXT NOT NULL,
          status TEXT NOT NULL,
          parameters TEXT NOT NULL,
          quality_score REAL,
          source_window_start INTEGER,
          source_window_end INTEGER,
          samples_used INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER
        );
        CREATE UNIQUE INDEX uq_cal_side_type_active
          ON calibration_profiles (side, sensor_type);
        """
    )
    conn.close()
    return CalibrationStore(db_path)


def test_named_capsense_waits_for_a_complete_candidate_window():
    with pytest.raises(ValueError, match=r"299 samples.*need ≥300"):
        CapCalibrator().calibrate(cap_records(299), "left")


def test_named_capsense_exact_window_is_finite_and_high_quality():
    result = CapCalibrator().calibrate(cap_records(300), "left")

    assert result.samples_used == 300
    assert result.quality_score == 1.0
    assert result.params["channels"]["out"] == {"mean": 1000.0, "std": 5.0}


def test_named_capsense_selects_a_quiet_complete_window():
    records = cap_records(
        600,
        value=lambda i: (0 if i % 2 else 1000) if i < 300 else 2000,
    )

    result = CapCalibrator().calibrate(records, "left")

    assert result.window_start == records[300]["ts"]
    assert result.window_end == records[599]["ts"]
    assert result.quality_score == 1.0


def test_named_capsense_rejects_a_window_at_the_quality_floor():
    records = cap_records(300, value=lambda i: 0 if i % 2 else 1000)

    with pytest.raises(ValueError, match="No stable capSense calibration window"):
        CapCalibrator().calibrate(records, "left")


def test_named_capsense_rejects_quality_that_rounds_to_zero():
    calibrator = CapCalibrator()
    records = cap_records(300, value=lambda i: 0 if i % 2 else 100)
    # Three channels each contribute variance 2,500. Set the scale just above
    # that total so the raw score is positive but would persist as 0.000.
    calibrator.VARIANCE_QUALITY_SCALE = 7500.5

    with pytest.raises(ValueError, match="No stable capSense calibration window"):
        calibrator.calibrate(records, "left")


def test_zero_quality_profile_is_not_active(tmp_path):
    store = create_store(tmp_path)
    try:
        # Simulate a profile written by a pre-fix build, bypassing the current
        # store guard so the backwards-compatibility read path is exercised.
        with store._get_conn() as conn:
            conn.execute(
                """INSERT INTO calibration_profiles
                   (side, sensor_type, status, parameters, quality_score, created_at)
                   VALUES ('left', 'capacitance', 'completed', '{}', 0.0, 1)"""
            )

        assert store.get_active("left", "capacitance") is None
    finally:
        store.close()


def test_store_refuses_to_activate_zero_quality_from_any_calibrator(tmp_path):
    store = create_store(tmp_path)
    try:
        with pytest.raises(ValueError, match="Refusing unusable left/capacitance"):
            store.upsert_profile(
                "left", "capacitance", {"channels": {}}, 0.0, 1, 300, 300
            )

        row = store._get_conn().execute(
            "SELECT COUNT(*) FROM calibration_profiles"
        ).fetchone()
        assert row[0] == 0
    finally:
        store.close()


def test_failed_replacement_keeps_completed_profile_active(tmp_path):
    store = create_store(tmp_path)
    try:
        params = {"channels": {"out": {"mean": 1, "std": 5}}}
        store.upsert_profile("left", "capacitance", params, 1.0, 1, 300, 300)

        store.mark_running("left", "capacitance")
        store.mark_failed("left", "capacitance", "new window was noisy")

        active = store.get_active("left", "capacitance")
        assert active is not None
        assert active["status"] == "completed"
        assert json.loads(active["parameters"]) == params
        assert active["quality_score"] == 1.0
        assert active["error_message"] is None
    finally:
        store.close()


def test_first_failed_calibration_remains_retryable(tmp_path):
    store = create_store(tmp_path)
    try:
        store.mark_running("right", "capacitance")
        store.mark_failed("right", "capacitance", "buffer still warming")

        assert store.get_active("right", "capacitance") is None
        row = store._get_conn().execute(
            "SELECT status, error_message FROM calibration_profiles "
            "WHERE side='right' AND sensor_type='capacitance'"
        ).fetchone()
        assert tuple(row) == ("failed", "buffer still warming")
    finally:
        store.close()
