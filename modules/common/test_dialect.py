"""Tests for the inner-record dialect normalizer."""
import logging

import common.dialect as dialect
from common.dialect import (
    KNOWN_RECORD_TYPES,
    is_bed_temp_record,
    log_capsense_status_once,
    normalize_bed_temp,
)


# Real fixtures captured from the pods (PR #437 RAW for Pod 3, local pod for v2).

POD3_BED_TEMP_V1 = {
    "type": "bedTemp",
    "ts": 1776463233,
    "amb": 2514, "mcu": 3428, "hu": 3956,
    "left": {"side": 2334, "out": 2280, "cen": 2301, "in": 2359},
    "right": {"side": 2417, "out": 2351, "cen": 2420, "in": 2396},
}

POD4_BED_TEMP_V2 = {
    "type": "bedTemp2",
    "ts": 1777349731,
    "version": 1,
    "mcu": 31.51,
    "left": {"amb": 22.43, "hu": 51.99, "board": -327.68,
             "temps": [24.01, 24.69, 23.67, -327.68]},
    "right": {"amb": -327.68, "hu": -327.68, "board": -327.68,
              "temps": [23.51, 27.89, 23.59, 22.94]},
}


class TestBedTempV1:
    """Pod 3 bedTemp passes through as integer centidegrees."""

    def test_top_level_scalars_passthrough(self):
        c = normalize_bed_temp(POD3_BED_TEMP_V1)
        assert c["ambient_temp"] == 2514
        assert c["mcu_temp"] == 3428
        assert c["humidity"] == 3956

    def test_left_zones_from_flat_keys(self):
        c = normalize_bed_temp(POD3_BED_TEMP_V1)
        assert c["left_outer_temp"] == 2280
        assert c["left_center_temp"] == 2301
        assert c["left_inner_temp"] == 2359

    def test_right_zones_from_flat_keys(self):
        c = normalize_bed_temp(POD3_BED_TEMP_V1)
        assert c["right_outer_temp"] == 2351
        assert c["right_center_temp"] == 2420
        assert c["right_inner_temp"] == 2396

    def test_timestamp_preserved(self):
        c = normalize_bed_temp(POD3_BED_TEMP_V1)
        assert c["ts"] == 1776463233

    def test_missing_zone_returns_none(self):
        rec = {**POD3_BED_TEMP_V1, "left": {"out": 2280}}
        c = normalize_bed_temp(rec)
        assert c["left_outer_temp"] == 2280
        assert c["left_center_temp"] is None
        assert c["left_inner_temp"] is None

    def test_int_sentinel_returns_none(self):
        rec = {**POD3_BED_TEMP_V1, "amb": -32768}
        c = normalize_bed_temp(rec)
        assert c["ambient_temp"] is None


class TestBedTempV2:
    """Pod 4/5 bedTemp2 reduces float arrays to integer centidegrees."""

    def test_left_ambient_from_nested(self):
        c = normalize_bed_temp(POD4_BED_TEMP_V2)
        assert c["ambient_temp"] == 2243  # 22.43 °C → 2243 cdC

    def test_right_ambient_falls_back_when_left_sentinel(self):
        rec = {**POD4_BED_TEMP_V2,
               "left": {**POD4_BED_TEMP_V2["left"], "amb": -327.68},
               "right": {**POD4_BED_TEMP_V2["right"], "amb": 22.5}}
        c = normalize_bed_temp(rec)
        assert c["ambient_temp"] == 2250

    def test_temps_array_indexed_into_zones(self):
        c = normalize_bed_temp(POD4_BED_TEMP_V2)
        assert c["left_outer_temp"] == 2401
        assert c["left_center_temp"] == 2469
        assert c["left_inner_temp"] == 2367
        assert c["right_outer_temp"] == 2351
        assert c["right_center_temp"] == 2789
        assert c["right_inner_temp"] == 2359

    def test_mcu_converted_from_float(self):
        c = normalize_bed_temp(POD4_BED_TEMP_V2)
        assert c["mcu_temp"] == 3151

    def test_float_sentinel_returns_none(self):
        # Right side has all -327.68 → no usable readings
        rec = {**POD4_BED_TEMP_V2,
               "left": {**POD4_BED_TEMP_V2["left"], "amb": -327.68}}
        c = normalize_bed_temp(rec)
        # Falls through to right.amb which is also sentinel
        assert c["ambient_temp"] is None

    def test_short_temps_array_returns_none_for_missing_zones(self):
        rec = {**POD4_BED_TEMP_V2,
               "left": {**POD4_BED_TEMP_V2["left"], "temps": [24.01]}}
        c = normalize_bed_temp(rec)
        assert c["left_outer_temp"] == 2401
        assert c["left_center_temp"] is None
        assert c["left_inner_temp"] is None


class TestDispatch:
    def test_unknown_type_returns_none(self):
        assert normalize_bed_temp({"type": "frzTemp"}) is None
        assert normalize_bed_temp({"type": "piezo-dual"}) is None
        assert normalize_bed_temp({"type": "log"}) is None

    def test_is_bed_temp_record(self):
        assert is_bed_temp_record({"type": "bedTemp"}) is True
        assert is_bed_temp_record({"type": "bedTemp2"}) is True
        assert is_bed_temp_record({"type": "frzTemp"}) is False
        assert is_bed_temp_record({}) is False


class TestKnownRecordTypes:
    def test_covers_all_parsed_dialects(self):
        for t in ("capSense", "capSense2", "piezo-dual", "bedTemp", "bedTemp2",
                  "frzTemp", "frzHealth", "frzTherm"):
            assert t in KNOWN_RECORD_TYPES

    def test_excludes_new_unconsumed_types(self):
        # blanketReadings / log are the genuinely-new firmware types that must
        # trigger warn_unknown_type_once, not be silently ignored.
        assert "blanketReadings" not in KNOWN_RECORD_TYPES
        assert "log" not in KNOWN_RECORD_TYPES


# capSense records from the field NATS capture (Pod 3 dialect + new status key).
CAPSENSE_GOOD = {
    "type": "capSense", "ts": 1784482449,
    "left": {"out": 3288, "cen": 3734, "in": 3262, "status": "good"},
    "right": {"out": 1680, "cen": 1891, "in": 2232, "status": "good"},
}


class TestLogCapsenseStatusOnce:
    def setup_method(self):
        dialect._capsense_status_seen.clear()

    def test_all_good_logs_nothing(self, caplog):
        with caplog.at_level(logging.WARNING):
            log_capsense_status_once(CAPSENSE_GOOD)
        assert not [r for r in caplog.records if "status" in r.getMessage()]

    def test_non_good_status_logged_once_with_channels(self, caplog):
        rec = {**CAPSENSE_GOOD,
               "left": {"out": 5, "cen": 6, "in": 7, "status": "saturated"}}
        with caplog.at_level(logging.WARNING):
            log_capsense_status_once(rec, "sleep-detector")
            log_capsense_status_once(rec, "sleep-detector")  # dedup — no 2nd log
        hits = [r for r in caplog.records if "saturated" in r.getMessage()]
        assert len(hits) == 1
        msg = hits[0].getMessage()
        assert "out=5" in msg and "cen=6" in msg and "in=7" in msg

    def test_distinct_statuses_each_log_once(self, caplog):
        with caplog.at_level(logging.WARNING):
            log_capsense_status_once(
                {**CAPSENSE_GOOD, "left": {"out": 0, "cen": 0, "in": 0, "status": "warmup"}})
            log_capsense_status_once(
                {**CAPSENSE_GOOD, "right": {"out": 0, "cen": 0, "in": 0, "status": "error"}})
        assert any("warmup" in r.getMessage() for r in caplog.records)
        assert any("error" in r.getMessage() for r in caplog.records)

    def test_ignores_non_capsense_records(self, caplog):
        with caplog.at_level(logging.WARNING):
            log_capsense_status_once({"type": "capSense2", "left": {"status": "bad"}})
        assert not caplog.records
