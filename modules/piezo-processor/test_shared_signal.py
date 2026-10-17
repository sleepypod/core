"""Numerical parity and parameter isolation for the extracted signal core."""
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics import signal as core
from common.biometrics.config import resolve_config


def parameters(path, value):
    return core.ProcessingParameters.from_config(resolve_config([{"path": path, "value": value}])["resolved"])


def samples():
    fs = 500
    t = np.arange(fs * 300) / fs
    rng = np.random.default_rng(20261012)
    phase = 2 * np.pi * (1.1 * t + .2 * np.sin(2 * np.pi * t / 40))
    return ((1 + .2 * np.sin(2 * np.pi * .25 * t))
            * (np.sin(phase) + .5 * np.sin(2 * phase) + .25 * np.sin(3 * phase))
            + rng.normal(0, .08, len(t)))


def test_shared_estimator_matches_pre_extraction_golden():
    fixture = json.loads(Path(__file__).with_name("fixtures").joinpath("default-processing-v1.json").read_text())
    data = samples()
    estimate = core.WindowEstimator().estimate(1700000000, data[-15000:], data[-30000:], data)
    assert estimate.timestamp_s == 1700000000
    assert estimate.heart_rate == pytest.approx(fixture["hr"][0], abs=1e-9)
    assert estimate.hr_score == pytest.approx(fixture["hr"][1], abs=1e-9)
    assert estimate.breathing_rate == pytest.approx(fixture["breathing"], abs=1e-9)
    assert estimate.hrv_index == pytest.approx(fixture["hrvIndex"], abs=1e-9)
    assert estimate.rejection_reasons == ()


def test_parameters_are_immutable_and_tracking_is_isolated():
    wider = parameters("heart_rate.trackingToleranceBpm", 30)
    with pytest.raises(FrozenInstanceError):
        wider.tracking_tolerance_bpm = 10
    left, right = core.WindowEstimator(wider), core.WindowEstimator()
    left.hr_tracker.update(60, 1)
    right.hr_tracker.update(60, 1)
    assert left.hr_tracker.update(85, 1) == 85
    assert right.hr_tracker.update(85, 1) == 42.5
    fresh = core.WindowEstimator(wider)
    assert list(fresh.hr_tracker.history) == []
    assert fresh.hr_tracker.update(85, 1) == 85


def test_hrv_harmonic_gate_obeys_explicit_tolerance():
    assert core._harmonic_gate(1100, 1000, tolerance=.05) is None
    assert core._harmonic_gate(1100, 1000, tolerance=.2) == 1100


def test_breathing_interval_rejection_obeys_config(monkeypatch):
    monkeypatch.setattr(core, "find_peaks", lambda *args, **kwargs: (np.array([0, 1000, 2500, 3500]), {}))
    data = samples()[-30000:]
    assert core.compute_breathing_rate(data) == 30
    assert core.compute_breathing_rate(data, parameters=parameters("breathing_rate.intervalUpperRatio", 2)) == pytest.approx(60 / (7 / 3))


def test_explicit_event_time_and_warmup_never_consult_wall_clock():
    estimator = core.WindowEstimator()
    data = samples()
    early = estimator.estimate(0, data[:4999], data[:4999], data[:4999])
    assert early.heart_rate is None
    assert early.rejection_reasons == ("hr_warmup",)
    enough_hr = estimator.estimate(10, data[:5000], data[:5000], data[:5000])
    assert enough_hr.hrv_index is None
    assert "hrv_warmup" in enough_hr.rejection_reasons
    with pytest.raises(ValueError, match="500 Hz"):
        estimator.estimate(20, data, data, data, fs=250)
    with pytest.raises(ValueError, match="finite"):
        estimator.estimate(float("nan"), data, data, data)


def test_minimum_peak_score_abstains_on_weak_windows_only():
    # A heartbeat buried in noise still yields a tallest peak, just a weak one.
    weak = samples()[-15000:] + np.random.default_rng(7).normal(0, 2.5, 15000)
    hr, score = core.subharmonic_summation_hr(weak)
    assert hr is not None and 0.1 < score < 0.8
    assert core.subharmonic_summation_hr(weak, min_score=score - 1e-6)[0] == pytest.approx(hr)
    assert core.subharmonic_summation_hr(weak, min_score=score + 1e-6) == (None, pytest.approx(score))
    strict = core.WindowEstimator(parameters("heart_rate.minimumPeakScore", score + 1e-6))
    estimate = strict.estimate(1700000000, weak, samples()[-30000:], samples())
    assert estimate.heart_rate is None and "no_hr" in estimate.rejection_reasons
    # 0.1 is the previous fixed floor; the shipped default is now 0.4.
    legacy = core.WindowEstimator(parameters("heart_rate.minimumPeakScore", 0.1))
    assert legacy.estimate(1700000000, weak, samples()[-30000:], samples()).heart_rate == pytest.approx(hr)
    assert core.DEFAULT_PARAMETERS.heart_rate_minimum_peak_score == 0.4
    assert core.subharmonic_summation_hr(weak)[0] == (hr if score >= 0.4 else None)


@pytest.mark.parametrize("value", [0.05, 0.85])
def test_minimum_peak_score_range_is_validated(value):
    with pytest.raises(ValueError):
        parameters("heart_rate.minimumPeakScore", value)
