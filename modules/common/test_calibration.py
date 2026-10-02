"""Tests for the calibrated presence helpers.

Pins the capSense2 presence formula to the Node occupancy sensor's semantics
(src/lib/occupancy.ts readLevelSignal): summed SIGNED raw-unit deviation from
the calibrated per-channel means, reference-compensated when the frame carries
the REF pair, compared against the profile threshold in raw units.

Field regression (trinity, 2026-08): the former z-score check divided by the
quiet-window std (floored at 0.05), so on firmware whose channel values run in
the hundreds a fraction of a raw unit of thermal drift saturated presence 24/7
— every sleep_records row was exactly MAX_SESSION_S, back to back, on both
sides, and recalibrating (quality 0.99+) made the trigger finer, not coarser.
"""
from common.calibration import (
    CAPSENSE2_REF_NOMINAL,
    CAPSENSE_PRESENCE_THRESHOLD,
    capsense_deviation,
    is_present_capsense_calibrated,
    is_present_capsense2_calibrated,
)


PROFILE = {
    "format": "capSense2",
    "threshold": 6.0,
    "channels": {
        "A": {"mean": 500.0, "std": 0.05},
        "B": {"mean": 600.0, "std": 0.05},
        "C": {"mean": 700.0, "std": 0.05},
    },
    "ref": {"mean": 1.16, "std": 0.001},
}


def _record(a, b, c, ref=None):
    values = [a, a, b, b, c, c]
    if ref is not None:
        values += [ref, ref]
    return {"left": {"values": values}}


class TestCapSense2CalibratedPath:
    def test_global_drift_with_ref_pair_reads_absent(self):
        # The trinity bug: every channel (sensing AND ref) drifted +10 raw
        # units with the water loop's thermal state. Ref compensation cancels
        # it; the old z-score read z = 600 >> 6 and stuck present forever.
        rec = _record(510.0, 610.0, 710.0, ref=11.16)
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_occupant_load_reads_present(self):
        # A person loads the sensing channels while the ref stays at nominal.
        rec = _record(520.0, 620.0, 720.0, ref=1.16)
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is True

    def test_signed_deviations_cancel(self):
        # Mirrors Node: the sum is SIGNED, so opposite drifts cancel instead
        # of accumulating like the old absolute z-sum did.
        rec = _record(510.0, 590.0, 702.0, ref=1.16)  # +10 - 10 + 2 = 2 < 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_deviation_exactly_at_threshold_is_absent(self):
        rec = _record(502.0, 602.0, 702.0, ref=1.16)  # 2 + 2 + 2 = 6, not > 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is False

    def test_deviation_just_over_threshold_is_present(self):
        rec = _record(502.0, 602.0, 702.1, ref=1.16)  # 6.1 > 6
        assert is_present_capsense2_calibrated(rec, "left", PROFILE) is True

    def test_six_value_frame_skips_ref_compensation(self):
        # Newer firmware drops the REF pair; deviation is uncompensated.
        assert is_present_capsense2_calibrated(
            _record(500.0, 600.0, 700.0), "left", PROFILE) is False
        assert is_present_capsense2_calibrated(
            _record(505.0, 603.0, 700.0), "left", PROFILE) is True  # 8 > 6

    def test_profile_without_ref_uses_nominal(self):
        profile = {k: v for k, v in PROFILE.items() if k != "ref"}
        rec = _record(500.0, 600.0, 700.0, ref=CAPSENSE2_REF_NOMINAL)
        assert is_present_capsense2_calibrated(rec, "left", profile) is False

    def test_profile_threshold_is_respected(self):
        profile = dict(PROFILE, threshold=50.0)
        rec = _record(510.0, 610.0, 710.0, ref=1.16)  # deviation 30
        assert is_present_capsense2_calibrated(rec, "left", profile) is False
        rec = _record(520.0, 620.0, 720.0, ref=1.16)  # deviation 60
        assert is_present_capsense2_calibrated(rec, "left", profile) is True


class TestCapSense2FallbackPath:
    def test_no_profile_falls_back_to_raw_sum(self):
        assert is_present_capsense2_calibrated(
            _record(30.0, 20.0, 15.0), "left", None) is True   # 65 > 60
        assert is_present_capsense2_calibrated(
            _record(10.0, 10.0, 10.0), "left", None) is False  # 30 < 60

    def test_mismatched_format_falls_back_to_raw_sum(self):
        assert is_present_capsense2_calibrated(
            _record(30.0, 20.0, 15.0), "left", {"format": "capSense"}) is True

    def test_short_or_missing_values_read_absent(self):
        assert is_present_capsense2_calibrated(
            {"left": {"values": [1.0, 2.0, 3.0]}}, "left", PROFILE) is False
        assert is_present_capsense2_calibrated({"left": {}}, "left", PROFILE) is False
        assert is_present_capsense2_calibrated({}, "left", PROFILE) is False


# Pod 3/4 capSense. Channel means are representative Pod 4 empty-bed levels.
# Legacy profiles carried a z-score
# `threshold: 6.0` with std floored at 5 — ~30 raw units of drift read as
# occupied, holding sessions open for 13-16h after the sleeper got up.
CAP_PROFILE = {
    "format": "capSense",
    "threshold": CAPSENSE_PRESENCE_THRESHOLD,
    "channels": {
        "out": {"mean": 1142.0, "std": 5.0},
        "cen": {"mean": 1582.0, "std": 5.0},
        "in": {"mean": 1673.0, "std": 5.0},
    },
}
LEGACY_CAP_PROFILE = {"threshold": 6.0, "channels": CAP_PROFILE["channels"]}


def _cap(out, cen, inner):
    return {"left": {"out": out, "cen": cen, "in": inner, "status": "good"}}


class TestCapSenseRawUnitPath:
    def test_occupant_reads_present(self):
        # Asleep on the left: ~+600/channel over the empty level.
        assert is_present_capsense_calibrated(_cap(1742, 2182, 2273), "left", CAP_PROFILE) is True

    def test_smallest_observed_occupant_reads_present(self):
        # A weak but real occupancy (edge of the bed): +150/channel (+450).
        assert is_present_capsense_calibrated(_cap(1292, 1732, 1823), "left", CAP_PROFILE) is True

    def test_empty_bed_drift_reads_absent(self):
        # The regression: slow empty-bed drift of a few tens of units per
        # channel must not count as a person.
        assert is_present_capsense_calibrated(_cap(1175, 1615, 1706), "left", CAP_PROFILE) is False

    def test_drop_below_baseline_reads_absent(self):
        # A body only adds capacitance. A baseline taken while someone was in
        # bed leaves the empty bed far BELOW it — the old |z| check read that
        # as occupied and stuck present all day.
        assert is_present_capsense_calibrated(_cap(542, 982, 1073), "left", CAP_PROFILE) is False

    def test_threshold_boundary_is_exclusive(self):
        assert is_present_capsense_calibrated(_cap(1242, 1682, 1773), "left", CAP_PROFILE) is False  # 300
        assert is_present_capsense_calibrated(_cap(1242, 1682, 1774), "left", CAP_PROFILE) is True   # 301

    def test_legacy_z_score_threshold_is_not_read_as_raw_units(self):
        # 6.0 was a z-score; as raw units it would flag +3/channel drift.
        assert is_present_capsense_calibrated(_cap(1145, 1585, 1676), "left", LEGACY_CAP_PROFILE) is False
        assert is_present_capsense_calibrated(_cap(1292, 1732, 1823), "left", LEGACY_CAP_PROFILE) is True

    def test_profile_threshold_is_respected(self):
        profile = dict(CAP_PROFILE, threshold=500.0)
        assert is_present_capsense_calibrated(_cap(1292, 1732, 1823), "left", profile) is False
        assert is_present_capsense_calibrated(_cap(1342, 1782, 1873), "left", profile) is True

    def test_deviation_is_signed_sum(self):
        assert capsense_deviation(_cap(1152, 1572, 1675), "left", CAP_PROFILE) == 2.0
        assert capsense_deviation({"right": {}}, "left", CAP_PROFILE) is None

    def test_missing_side_reads_absent(self):
        assert is_present_capsense_calibrated({"right": {"out": 9999}}, "left", CAP_PROFILE) is False

    def test_no_profile_falls_back_to_raw_sum(self):
        assert is_present_capsense_calibrated(_cap(600, 500, 401), "left", None) is True
        assert is_present_capsense_calibrated(_cap(500, 500, 500), "left", None) is False
