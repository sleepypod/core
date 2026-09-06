"""Deterministic sensor baseline and validation contracts."""
import struct
from unittest.mock import Mock
import pytest
from common.calibration import CapCalibrator, CapSense2Calibrator, HRValidator, PiezoCalibrator


def cap_records(count):
    return [{"ts": 1000 + i, "left": {"out": 100, "cen": 200, "in": 300}} for i in range(count)]


def cap2_records(count):
    return [{"ts": 1000 + i, "right": {"values": [10, 12, 20, 22, 30, 32]}} for i in range(count)]


@pytest.mark.parametrize("calibrator", [CapCalibrator, CapSense2Calibrator, PiezoCalibrator])
def test_empty_input_rejected(calibrator):
    with pytest.raises(ValueError, match="No .* records"):
        calibrator().calibrate([], "left")


@pytest.mark.parametrize("calibrator,records,side", [
    (CapCalibrator, cap_records(59) + [{"right": {"out": 100}}], "left"),
    (CapSense2Calibrator, cap2_records(59) + [{}, {"right": {"values": [1, 2]}}], "right"),
    (PiezoCalibrator, [{"left1": [-1, 1]}] * 59 + [{}, {"left1": b""}, {"left1": []}, {"left1": "bad"}], "left"),
])
def test_minimum_counts_only_usable_samples_for_selected_side(calibrator, records, side):
    with pytest.raises(ValueError, match="Insufficient .*59"):
        calibrator().calibrate(records, side)


def test_cap_baseline_scans_final_window_and_floors_std():
    records = cap_records(301)
    records[0]["left"] = {"out": 10000, "cen": 10000, "in": 10000}
    result = CapCalibrator().calibrate(records, "left")
    assert (result.window_start, result.window_end, result.samples_used) == (1001, 1300, 300)
    assert result.quality_score == 1
    assert result.params == {"threshold": 6.0, "channels": {
        "out": {"mean": 100, "std": 5}, "cen": {"mean": 200, "std": 5}, "in": {"mean": 300, "std": 5},
    }}


@pytest.mark.parametrize("count", [60, 300])
def test_capsense2_accepts_six_channel_firmware_and_short_quiet_windows(count):
    result = CapSense2Calibrator().calibrate(cap2_records(count), "right")
    assert (result.window_start, result.window_end, result.samples_used) == (1000, 999 + count, count)
    assert result.quality_score == 1
    assert result.params == {"format": "capSense2", "threshold": 6.0, "channels": {
        "A": {"mean": 11, "std": .05}, "B": {"mean": 21, "std": .05}, "C": {"mean": 31, "std": .05},
    }}


def test_capsense2_uses_final_quiet_sensing_window_ignoring_ref_variance():
    records = cap2_records(301)
    records[0]["right"]["values"] = [1000] * 6
    for i in range(1, 301):
        records[i]["right"]["values"] = [10, 12, 20, 22, 30, 32, i, i + 2]
    result = CapSense2Calibrator().calibrate(records, "right")
    assert result.window_start == 1001
    assert result.samples_used == 300
    assert result.quality_score == 1
    assert result.params["ref"] == {"mean": 151.5, "std": pytest.approx(86.6021)}


def test_capsense2_mixed_reference_frames_keep_timestamp_alignment():
    records = cap2_records(60)
    records[-1]["right"]["values"] = [10, 12, 20, 22, 30, 32, 1.1, 1.3]
    result = CapSense2Calibrator().calibrate(records, "right")
    assert result.params["ref"] == {"mean": 1.2, "std": .001}
    assert result.samples_used == 60


@pytest.mark.parametrize("encoding", [list, bytes, bytearray])
@pytest.mark.parametrize("amplitude,threshold,quality", [(100, 50000, .996), (10000, 120000, .833)])
def test_piezo_signed_samples_threshold_floor_and_signal_scaled_quality(encoding, amplitude, threshold, quality):
    samples = [-amplitude, 0, amplitude]
    raw = samples if encoding is list else encoding(struct.pack("<3i", *samples) + b"\xff")
    result = PiezoCalibrator().calibrate([{"ts": 1000 + i, "left1": raw} for i in range(60)], "left")
    assert result.params == {
        "noise_floor_rms": amplitude * 2, "presence_threshold": threshold, "baseline_mean_range": amplitude * 2,
    }
    assert result.quality_score == quality
    assert (result.window_start, result.window_end, result.samples_used) == (1000, 1059, 60)


def test_piezo_scans_last_quiet_window():
    records = [{"ts": 1000 + i, "right1": [-100, 100]} for i in range(301)]
    records[0]["right1"] = [-100000, 100000]
    result = PiezoCalibrator().calibrate(records, "right")
    assert (result.window_start, result.window_end, result.samples_used) == (1001, 1300, 300)
    assert result.params["noise_floor_rms"] == 200


@pytest.mark.parametrize("field,valid,invalid", [
    ("hr", [30, 100], [29.99, 100.01]), ("hrv", [8, 100], [7.99, 100.01]), ("br", [6, 22], [5.99, 22.01]),
])
def test_validator_hard_bounds_are_inclusive_and_reject_without_clamping(field, valid, invalid):
    for value in valid:
        result = HRValidator().validate(**{"hr": None, field: value})
        assert getattr(result, field + "_validated") == value
        assert result.flags == []
    for value in invalid:
        result = HRValidator().validate(**{"hr": None, field: value})
        assert getattr(result, field + "_validated") is None
        assert result.flags == [field + "_out_of_bounds"]
        if field == "hr":
            assert result.hr_raw == value


def test_validator_missing_data_does_not_invent_vitals():
    result = HRValidator().validate(None)
    assert (result.hr_validated, result.hrv_validated, result.br_validated, result.hr_raw) == (None,) * 4
    assert result.flags == []
    assert result.quality_score == .32


def test_validator_dynamic_bounds_flag_but_retain_plausible_stage_transition():
    validator = HRValidator()
    for _ in range(30):
        assert validator.validate(60).flags == []
    assert validator.validate(67.5).flags == []
    result = validator.validate(68)
    assert result.hr_validated == 68
    assert result.flags == ["hr_dynamic_bounds"]
    assert result.quality_score == .47


@pytest.mark.parametrize("age,quality", [(0, 1), (12, 1), (30, .925), (48, .85), (72, .85)])
def test_validator_calibration_freshness_decays_between_12_and_48_hours(age, quality):
    store = Mock()
    store.get_active.return_value = {"parameters": '{"noise_floor_rms":100}'}
    store.get_profile_age_hours.return_value = age
    result = HRValidator(store, "right").validate(60, 40, 12, signal_rms=1000)
    assert result.quality_score == quality
    assert result.flags == []
    store.get_active.assert_called_once_with("right", "piezo")


@pytest.mark.parametrize("rms,flags,quality", [(200, ["low_signal"], .68), (300, [], .72), (2000, [], 1)])
def test_validator_signal_to_noise_threshold_and_saturation(rms, flags, quality):
    store = Mock()
    store.get_active.return_value = {"parameters": {"noise_floor_rms": 100}}
    store.get_profile_age_hours.return_value = 0
    result = HRValidator(store).validate(60, 40, 12, signal_rms=rms)
    assert result.flags == flags
    assert result.quality_score == quality
