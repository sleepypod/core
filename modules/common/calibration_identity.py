"""Stable calibration epochs for bounded adaptive capacitance drift.

The epoch anchors the baseline rather than its latest published means. Its
L1 drift budget bounds the change in summed deviation to one quarter of the
presence-entry threshold. This is an engineering acceptance bound, not a
claim of occupancy accuracy; live presence checks still apply.
"""

import math
import re
import uuid

DRIFT_FRACTION = 0.25


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def ensure_calibration_epoch(previous, sensor_format, means, threshold,
                             reference_mean):
    """Retain a valid anchor within its cumulative budget; otherwise rotate."""
    if (sensor_format not in ("capSense", "capSense2")
            or len(means) != 3 or not all(_finite(value) for value in means)
            or not _finite(threshold) or threshold <= 0
            or not _finite(reference_mean)):
        raise ValueError("Invalid capacitance calibration identity")
    if isinstance(previous, dict):
        anchors = previous.get("means")
        valid = (type(previous.get("version")) is int
                 and previous["version"] == 1
                 and isinstance(previous.get("id"), str)
                 and re.fullmatch(r"[a-f0-9]{32}", previous["id"]) is not None
                 and previous.get("format") == sensor_format
                 and _finite(previous.get("threshold"))
                 and previous["threshold"] == threshold
                 and _finite(previous.get("referenceMean"))
                 and previous["referenceMean"] == reference_mean
                 and isinstance(anchors, list) and len(anchors) == 3
                 and all(_finite(value) for value in anchors))
        if valid and sum(abs(current - anchor) for current, anchor
                         in zip(means, anchors)) <= threshold * DRIFT_FRACTION:
            return {**previous, "means": list(anchors)}
    return {"version": 1, "id": uuid.uuid4().hex, "format": sensor_format,
            "means": list(means), "threshold": threshold,
            "referenceMean": reference_mean}
