"""Writer-side epoch invariants; the same fixture exercises the Node reader."""
import copy
import json
from pathlib import Path

import pytest

from common.calibration_identity import ensure_calibration_epoch

CASES = json.loads((Path(__file__).parent / "biometrics" /
                   "adaptive-calibration-epoch-v1.json").read_text())


def update(previous, case, means=None, **changes):
    return ensure_calibration_epoch(previous, changes.get("format", case["format"]),
                                    means or case["means"],
                                    changes.get("threshold", case["threshold"]),
                                    changes.get("referenceMean", case["referenceMean"]))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["format"])
def test_cumulative_drift_uses_fixed_anchor_across_publications(case):
    epoch = update(None, case)
    restored = json.loads(json.dumps(epoch))
    for means in (case["inside"], case["boundary"], case["inside"]):
        restored = update(restored, case, means)
        assert restored == epoch
    changed = update(restored, case, case["outside"])
    assert changed["id"] != epoch["id"]
    assert changed["means"] == case["outside"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["format"])
def test_recalibration_and_parameter_changes_cannot_reuse_epoch(case):
    epoch = update(None, case)
    assert update(None, case)["id"] != epoch["id"]
    assert update(epoch, case, threshold=case["threshold"] + 1)["id"] != epoch["id"]
    assert update(epoch, case, referenceMean=1.17)["id"] != epoch["id"]
    corrupt = copy.deepcopy(epoch)
    corrupt["version"] = True
    assert update(corrupt, case)["id"] != epoch["id"]
    corrupt["version"] = 2
    assert update(corrupt, case)["id"] != epoch["id"]
    corrupt["version"] = 1
    corrupt["id"] = "invalid"
    assert update(corrupt, case)["id"] != epoch["id"]


@pytest.mark.parametrize("means,threshold,reference", [
    ([1, 2, float("nan")], 300, 1.16),
    ([1, 2, float("inf")], 300, 1.16),
    ([True, 2, 3], 300, 1.16),
    ([1, 2], 300, 1.16),
    ([1, 2, 3], 0, 1.16),
    ([1, 2, 3], True, 1.16),
    ([1, 2, 3], 300, float("nan")),
])
def test_unusable_calibration_cannot_create_epoch(means, threshold, reference):
    with pytest.raises(ValueError):
        ensure_calibration_epoch(None, "capSense", means, threshold, reference)


def test_returned_anchor_does_not_alias_previous_publication():
    epoch = update(None, CASES[0])
    published = update(epoch, CASES[0])
    published["means"][0] += 1
    assert epoch["means"] == CASES[0]["means"]
