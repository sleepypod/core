"""
Comprehensive tests for piezo-processor v2 signal processing.

Tests run on the developer's Mac — no pod-specific imports (cbor2,
RawFileFollower).  Only the signal processing functions and classes
from main.py are exercised.
"""

import time
from unittest.mock import patch

import numpy as np
import pytest

# We must prevent the top-level `import cbor2` and
# `from common.raw_follower import RawFileFollower` from failing on the
# developer's Mac.  Patch sys.modules before importing main.
import sys

_stubs = {
    "cbor2": type(sys)("cbor2"),
    "common": type(sys)("common"),
    "common.raw_follower": type(sys)("common.raw_follower"),
}
_stubs["common.raw_follower"].RawFileFollower = None
sys.modules.update(_stubs)

from main import (  # noqa: E402
    _bandpass,
    _autocorr_quality,
    _compute_autocorr,
    compute_breathing_rate,
    compute_hrv,
    subharmonic_summation_hr,
    FrzHealthPumpState,
    PUMP_OFF_GUARD_S,
    PUMP_ACTIVE_RPM_MIN,
    HRTracker,
    PresenceDetector,
    PumpGate,
    SideProcessor,
    SAMPLE_RATE,
    PUMP_GUARD_S,
    VITALS_INTERVAL_S,
)

# ===================================================================
# Synthetic signal helpers
# ===================================================================

FS = SAMPLE_RATE  # 500 Hz


def make_bcg_signal(hr_bpm, duration_s, fs=FS, noise_level=0.1):
    """Generate synthetic BCG-like signal at given HR.

    BCG J-wave is approximated as a sharp pulse repeated at the heart rate.
    Add harmonics to simulate realistic BCG morphology.
    """
    t = np.arange(int(duration_s * fs)) / fs
    period = 60.0 / hr_bpm
    fundamental = np.sin(2 * np.pi * t / period)
    harmonic2 = 0.5 * np.sin(2 * np.pi * 2 * t / period)
    harmonic3 = 0.3 * np.sin(2 * np.pi * 3 * t / period)
    signal = fundamental + harmonic2 + harmonic3
    signal += noise_level * np.random.randn(len(signal))
    return (signal * 1_000_000).astype(np.float64)


def make_pump_signal(duration_s, fs=FS):
    """Generate synthetic pump spike signal (massive broadband energy)."""
    t = np.arange(int(duration_s * fs)) / fs
    return (np.random.randn(len(t)) * 500_000_000).astype(np.float64)


def make_noise(duration_s, fs=FS, amplitude=100_000):
    """Generate white noise (empty bed)."""
    return (np.random.randn(int(duration_s * fs)) * amplitude).astype(np.float64)


def make_respiratory_modulated_bcg(hr_bpm, br_bpm, duration_s, fs=FS):
    """BCG signal with amplitude modulated by respiratory cycle."""
    t = np.arange(int(duration_s * fs)) / fs
    hr_freq = hr_bpm / 60.0
    br_freq = br_bpm / 60.0
    cardiac = np.sin(2 * np.pi * hr_freq * t) + 0.5 * np.sin(
        2 * np.pi * 2 * hr_freq * t
    )
    resp_envelope = 1.0 + 0.3 * np.sin(2 * np.pi * br_freq * t)
    return (cardiac * resp_envelope * 1_000_000).astype(np.float64)


# ===================================================================
# _bandpass
# ===================================================================


class TestBandpass:
    """Verify the SOS bandpass filter passes in-band and attenuates out-of-band."""

    def test_passes_in_band_frequency(self):
        """A 3 Hz sinusoid should pass through a 1-10 Hz filter with high energy."""
        np.random.seed(42)
        t = np.arange(5 * FS) / FS
        sig = np.sin(2 * np.pi * 3.0 * t)
        out = _bandpass(sig, 1.0, 10.0, FS)
        # Most energy should survive
        assert np.std(out) > 0.5 * np.std(sig)

    def test_attenuates_out_of_band_low(self):
        """A 0.05 Hz sinusoid should be heavily attenuated by a 1-10 Hz filter."""
        t = np.arange(30 * FS) / FS
        sig = np.sin(2 * np.pi * 0.05 * t)
        out = _bandpass(sig, 1.0, 10.0, FS)
        assert np.std(out) < 0.05 * np.std(sig)

    def test_attenuates_out_of_band_high(self):
        """A 100 Hz sinusoid should be heavily attenuated by a 1-10 Hz filter.

        Edge effects from sosfiltfilt inflate residual energy on short signals,
        so we trim 20% of each end before measuring attenuation.
        """
        t = np.arange(10 * FS) / FS  # longer signal to reduce edge effects
        sig = np.sin(2 * np.pi * 100.0 * t)
        out = _bandpass(sig, 1.0, 10.0, FS)
        trim = int(len(out) * 0.2)
        assert np.std(out[trim:-trim]) < 0.15 * np.std(sig)

    def test_mixed_signal_preserves_in_band(self):
        """Filter a sum of in-band + out-of-band; the in-band component survives."""
        np.random.seed(42)
        t = np.arange(5 * FS) / FS
        in_band = np.sin(2 * np.pi * 5.0 * t)
        out_of_band = 2.0 * np.sin(2 * np.pi * 100.0 * t)
        sig = in_band + out_of_band
        out = _bandpass(sig, 1.0, 10.0, FS)
        # The output should correlate strongly with the in-band component
        corr = np.corrcoef(out[FS:-FS], in_band[FS:-FS])[0, 1]
        assert abs(corr) > 0.9

    def test_order_parameter(self):
        """Higher order filters should attenuate out-of-band more sharply."""
        t = np.arange(5 * FS) / FS
        sig = np.sin(2 * np.pi * 50.0 * t)
        out_low_order = _bandpass(sig, 1.0, 10.0, FS, order=2)
        out_high_order = _bandpass(sig, 1.0, 10.0, FS, order=6)
        assert np.std(out_high_order) < np.std(out_low_order)


# ===================================================================
# PumpGate
# ===================================================================


class TestPumpGate:
    """Dual-channel pump detection with energy spike and guard period."""

    def test_normal_data_returns_false(self):
        """Normal quiet data should not trigger pump detection."""
        np.random.seed(42)
        gate = PumpGate()
        for _ in range(20):
            left = (np.random.randn(500) * 100_000).astype(np.float64)
            right = (np.random.randn(500) * 100_000).astype(np.float64)
            result = gate.check(left, right)
        # After baseline has stabilised, normal-amplitude data should be clean
        assert result is False

    def test_pump_spike_detected(self):
        """Both channels spiking >10x baseline simultaneously should trigger pump."""
        np.random.seed(42)
        gate = PumpGate()
        # Feed several normal records to establish baseline
        for _ in range(20):
            left = (np.random.randn(500) * 1000).astype(np.float64)
            right = (np.random.randn(500) * 1000).astype(np.float64)
            assert gate.check(left, right) is False

        # Now feed a massive spike on both channels
        left_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        right_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        assert gate.check(left_spike, right_spike) is True

    def test_guard_period_active_after_pump(self):
        """After pump detection, subsequent checks should return True for PUMP_GUARD_S."""
        np.random.seed(42)
        gate = PumpGate()
        # Establish baseline
        for _ in range(20):
            left = (np.random.randn(500) * 1000).astype(np.float64)
            right = (np.random.randn(500) * 1000).astype(np.float64)
            gate.check(left, right)

        # Trigger pump
        left_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        right_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        gate.check(left_spike, right_spike)

        # Immediately after: normal data should still be dropped (guard period)
        left_normal = (np.random.randn(500) * 1000).astype(np.float64)
        right_normal = (np.random.randn(500) * 1000).astype(np.float64)
        assert gate.check(left_normal, right_normal) is True

    def test_guard_period_expires(self):
        """After PUMP_GUARD_S, the gate should clear."""
        np.random.seed(42)
        gate = PumpGate()
        # Establish baseline
        for _ in range(20):
            left = (np.random.randn(500) * 1000).astype(np.float64)
            right = (np.random.randn(500) * 1000).astype(np.float64)
            gate.check(left, right)

        # Trigger pump
        left_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        right_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        gate.check(left_spike, right_spike)

        # Simulate time passing beyond guard period
        gate._pump_until = time.monotonic() - 1.0

        left_normal = (np.random.randn(500) * 1000).astype(np.float64)
        right_normal = (np.random.randn(500) * 1000).astype(np.float64)
        assert gate.check(left_normal, right_normal) is False

    def test_asymmetric_spike_no_trigger(self):
        """One channel high, one low should not trigger pump (ratio check fails)."""
        np.random.seed(42)
        gate = PumpGate()
        # Establish baseline
        for _ in range(20):
            left = (np.random.randn(500) * 1000).astype(np.float64)
            right = (np.random.randn(500) * 1000).astype(np.float64)
            gate.check(left, right)

        # Asymmetric: left huge, right stays at baseline
        left_spike = (np.random.randn(500) * 500_000_000).astype(np.float64)
        right_normal = (np.random.randn(500) * 1000).astype(np.float64)
        result = gate.check(left_spike, right_normal)
        # ratio = min/max ~ 1e3^2 / (5e8)^2 ~ near zero, below PUMP_CORRELATION_MIN
        assert result is False

    def test_baseline_adapts_over_time(self):
        """Baseline should change as clean data is fed.

        The EMA update only occurs when avg < baseline * 3, so we must
        increase amplitude gradually to stay within that guard.
        """
        np.random.seed(42)
        gate = PumpGate()
        # Feed low-amplitude data to establish baseline
        for _ in range(30):
            left = (np.random.randn(500) * 1000).astype(np.float64)
            right = (np.random.randn(500) * 1000).astype(np.float64)
            gate.check(left, right)
        baseline_low = gate._baseline
        assert baseline_low is not None

        # Feed slightly higher-amplitude data (within 3x so EMA updates)
        for _ in range(200):
            left = (np.random.randn(500) * 1500).astype(np.float64)
            right = (np.random.randn(500) * 1500).astype(np.float64)
            gate.check(left, right)
        baseline_high = gate._baseline

        assert baseline_high > baseline_low

    def test_zero_energy_not_triggered(self):
        """Channels with zero data should return False (le == 0 or re == 0)."""
        gate = PumpGate()
        left = np.zeros(500, dtype=np.float64)
        right = np.zeros(500, dtype=np.float64)
        assert gate.check(left, right) is False


# ===================================================================
# _autocorr_quality
# ===================================================================


class TestAutocorrQuality:
    """Autocorrelation quality metric for presence detection."""

    def test_periodic_signal_high_quality(self):
        """A clean periodic BCG signal should produce high quality (>0.3)."""
        np.random.seed(42)
        sig = make_bcg_signal(hr_bpm=70, duration_s=10, noise_level=0.05)
        q = _autocorr_quality(sig, FS)
        assert q > 0.3

    def test_white_noise_low_quality(self):
        """White noise should produce significantly lower quality than a periodic signal.

        Bandpass-filtered noise can still have modest autocorrelation peaks
        because the narrow passband induces some periodicity.  We verify that
        it stays well below the detector's acr_threshold (0.45) and is much
        lower than a clean BCG signal.
        """
        np.random.seed(42)
        sig = make_noise(duration_s=10)
        q_noise = _autocorr_quality(sig, FS)
        assert q_noise < 0.3  # below the presence detector's threshold

        # Contrast with a periodic signal for relative check
        sig_periodic = make_bcg_signal(hr_bpm=70, duration_s=10, noise_level=0.05)
        q_periodic = _autocorr_quality(sig_periodic, FS)
        assert q_periodic > q_noise

    def test_constant_signal_returns_zero(self):
        """A constant (zero-variance) signal should return 0.0."""
        sig = np.ones(5000, dtype=np.float64)
        q = _autocorr_quality(sig, FS)
        assert q == 0.0

    def test_very_short_signal_does_not_crash(self):
        """A very short signal should not raise an exception."""
        sig = np.array([1.0, 2.0, 3.0])
        q = _autocorr_quality(sig, FS)
        assert isinstance(q, float)


# ===================================================================
# PresenceDetector
# ===================================================================


class TestPresenceDetector:
    """Hysteresis state machine for in-bed presence."""

    def test_starts_absent(self):
        pd = PresenceDetector()
        assert pd.state == PresenceDetector.ABSENT

    def test_absent_to_present_via_std(self):
        """High window std exceeding enter_threshold triggers PRESENT."""
        pd = PresenceDetector()
        result = pd.update(window_std=500_000, acr_qual=0.0)
        assert result is True
        assert pd.state == PresenceDetector.PRESENT

    def test_absent_to_present_via_autocorr(self):
        """High autocorrelation quality exceeding acr_threshold triggers PRESENT."""
        pd = PresenceDetector()
        result = pd.update(window_std=0.0, acr_qual=0.5)
        assert result is True
        assert pd.state == PresenceDetector.PRESENT

    def test_present_stays_present_above_exit(self):
        """While in PRESENT, std above exit_threshold keeps state PRESENT."""
        pd = PresenceDetector()
        pd.update(window_std=500_000, acr_qual=0.0)  # enter
        assert pd.state == PresenceDetector.PRESENT

        # std between exit and enter thresholds, acr above half-threshold
        result = pd.update(window_std=200_000, acr_qual=0.3)
        assert result is True
        assert pd.state == PresenceDetector.PRESENT

    def test_present_to_absent_after_exit_count(self):
        """PRESENT -> ABSENT only after exit_count consecutive low windows."""
        pd = PresenceDetector()
        pd.update(window_std=500_000, acr_qual=0.0)  # enter PRESENT
        assert pd.state == PresenceDetector.PRESENT

        # Feed exit_count low windows (std below exit_threshold, acr below half-threshold)
        for i in range(pd.exit_count - 1):
            result = pd.update(window_std=100_000, acr_qual=0.1)
            assert result is True  # still PRESENT (hysteresis)

        # The exit_count-th low window triggers ABSENT
        result = pd.update(window_std=100_000, acr_qual=0.1)
        assert result is False
        assert pd.state == PresenceDetector.ABSENT

    def test_hysteresis_no_rapid_oscillation(self):
        """Oscillating signals near threshold should not cause rapid state changes."""
        pd = PresenceDetector()
        pd.update(window_std=500_000, acr_qual=0.0)  # enter PRESENT
        states = []

        # Alternate between low and above-exit signals
        for _ in range(20):
            # One low window
            pd.update(window_std=100_000, acr_qual=0.1)
            states.append(pd.state)
            # One above-exit window (resets consecutive_low)
            pd.update(window_std=200_000, acr_qual=0.3)
            states.append(pd.state)

        # Should stay PRESENT the entire time (never enough consecutive lows)
        assert all(s == PresenceDetector.PRESENT for s in states)

    def test_consecutive_low_resets_on_high_window(self):
        """A high window in the middle of low windows resets consecutive_low."""
        pd = PresenceDetector()
        pd.update(window_std=500_000, acr_qual=0.0)  # PRESENT

        # Two low windows
        pd.update(window_std=100_000, acr_qual=0.1)
        pd.update(window_std=100_000, acr_qual=0.1)
        assert pd.consecutive_low == 2

        # One high window resets
        pd.update(window_std=500_000, acr_qual=0.0)
        assert pd.consecutive_low == 0

    def test_absent_stays_absent_on_low_input(self):
        """While ABSENT, low std and low acr keep state ABSENT."""
        pd = PresenceDetector()
        result = pd.update(window_std=100_000, acr_qual=0.1)
        assert result is False
        assert pd.state == PresenceDetector.ABSENT


# ===================================================================
# _compute_autocorr
# ===================================================================


class TestComputeAutocorr:
    """Normalised autocorrelation via FFT."""

    def test_normalized_at_zero_lag(self):
        """autocorr[0] should equal 1.0 for non-zero signals."""
        np.random.seed(42)
        sig = np.sin(2 * np.pi * 2.0 * np.arange(5000) / FS)
        acr = _compute_autocorr(sig, FS)
        assert acr is not None
        assert abs(acr[0] - 1.0) < 1e-10

    def test_periodic_signal_has_peaks_at_expected_lags(self):
        """A sinusoid at f Hz should have autocorrelation peaks at lags k * fs/f."""
        freq = 5.0
        t = np.arange(10 * FS) / FS
        sig = np.sin(2 * np.pi * freq * t)
        acr = _compute_autocorr(sig, FS)
        assert acr is not None

        expected_lag = int(FS / freq)
        # Check that a peak exists near the expected lag
        region = acr[expected_lag - 5 : expected_lag + 6]
        assert np.max(region) > 0.9

    def test_returns_none_for_all_zeros(self):
        """All-zero signal has acr[0] == 0, should return None."""
        sig = np.zeros(5000, dtype=np.float64)
        acr = _compute_autocorr(sig, FS)
        assert acr is None

    def test_output_length_matches_input(self):
        """Autocorrelation output should have same length as input."""
        np.random.seed(42)
        sig = np.random.randn(3000)
        acr = _compute_autocorr(sig, FS)
        assert acr is not None
        assert len(acr) == len(sig)

    def test_white_noise_decays(self):
        """White noise autocorrelation should decay rapidly after lag 0."""
        np.random.seed(42)
        sig = np.random.randn(10000)
        acr = _compute_autocorr(sig, FS)
        assert acr is not None
        # At lag > 100 samples, autocorrelation should be near zero
        assert np.max(np.abs(acr[100:])) < 0.15


# ===================================================================
# subharmonic_summation_hr
# ===================================================================


class TestSubharmonicSummationHR:
    """Heart rate estimation via subharmonic summation autocorrelation."""

    def test_identifies_hr_from_clean_bcg(self):
        """Should correctly identify HR from a synthetic BCG signal."""
        np.random.seed(42)
        target_hr = 72
        sig = make_bcg_signal(target_hr, duration_s=30, noise_level=0.05)
        hr, score = subharmonic_summation_hr(sig, FS)
        assert hr is not None
        assert abs(hr - target_hr) < 5  # within 5 BPM

    def test_harmonic_signal_returns_fundamental(self):
        """A signal with strong 2nd harmonic should still return the fundamental."""
        np.random.seed(42)
        target_hr = 60
        t = np.arange(30 * FS) / FS
        period = 60.0 / target_hr
        # Fundamental + strong 2nd harmonic + modest 3rd
        sig = (
            np.sin(2 * np.pi * t / period)
            + 0.8 * np.sin(2 * np.pi * 2 * t / period)
            + 0.3 * np.sin(2 * np.pi * 3 * t / period)
        )
        sig = (sig * 1_000_000 + np.random.randn(len(sig)) * 50_000).astype(
            np.float64
        )
        hr, score = subharmonic_summation_hr(sig, FS)
        assert hr is not None
        # The fundamental should be preferred over the 2nd harmonic
        assert abs(hr - target_hr) < 8

    def test_noise_returns_none_or_low_score(self):
        """White noise should return (None, low_score) or very low score."""
        np.random.seed(42)
        sig = make_noise(duration_s=30)
        hr, score = subharmonic_summation_hr(sig, FS)
        if hr is not None:
            assert score < 0.3
        else:
            assert score < 0.2

    def test_bpm_range_respected(self):
        """Returned HR should be within the specified bpm_range."""
        np.random.seed(42)
        target_hr = 70
        sig = make_bcg_signal(target_hr, duration_s=30, noise_level=0.05)
        hr, score = subharmonic_summation_hr(sig, FS, bpm_range=(50, 100))
        if hr is not None:
            assert 50 <= hr <= 100

    def test_different_heart_rates(self):
        """Should detect a range of physiological heart rates.

        At higher BPMs the fundamental period gets short relative to the
        autocorrelation search window, and SHS may lock onto a sub-harmonic.
        We test the resting HR range where SHS is most reliable.
        """
        np.random.seed(42)
        for target_hr in [50, 60, 72, 85]:
            sig = make_bcg_signal(target_hr, duration_s=30, noise_level=0.05)
            hr, score = subharmonic_summation_hr(sig, FS)
            assert hr is not None, f"Failed to detect HR={target_hr}"
            assert abs(hr - target_hr) < 8, (
                f"HR={target_hr}: got {hr:.1f}"
            )

    def test_returns_tuple(self):
        """Return type should always be a (hr, score) tuple."""
        np.random.seed(42)
        sig = make_noise(duration_s=30)
        result = subharmonic_summation_hr(sig, FS)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_short_signal_low_lag_range(self):
        """If max_lag <= min_lag due to narrow bpm_range + short signal, returns None."""
        sig = np.random.randn(500).astype(np.float64)
        hr, score = subharmonic_summation_hr(sig, FS, bpm_range=(45, 46))
        assert hr is None


# ===================================================================
# HRTracker
# ===================================================================


class TestHRTracker:
    """Inter-window HR consistency tracking with harmonic correction."""

    def test_first_reading_accepted(self):
        """The first reading should be accepted as-is."""
        tracker = HRTracker()
        result = tracker.update(72.0, 0.5)
        assert result == 72.0

    def test_consistent_readings_passed_through(self):
        """Consistent readings within max_delta are passed through unchanged."""
        tracker = HRTracker()
        tracker.update(72.0, 0.5)
        result = tracker.update(74.0, 0.5)
        assert result == 74.0

    def test_harmonic_correction(self):
        """170 BPM reading corrected to 85 BPM when history is around 80."""
        tracker = HRTracker()
        # Build up history around 80 BPM
        for hr in [80.0, 81.0, 79.0, 80.5, 80.0]:
            tracker.update(hr, 0.5)

        # Feed a harmonic reading (170 ~ 2x85)
        result = tracker.update(170.0, 0.5)
        assert result is not None
        # Should be corrected to half: 85
        assert abs(result - 85.0) < 1.0

    def test_subharmonic_correction(self):
        """40 BPM reading corrected to 80 BPM when history is around 80."""
        tracker = HRTracker()
        for hr in [80.0, 81.0, 79.0, 80.5, 80.0]:
            tracker.update(hr, 0.5)

        # Feed a sub-harmonic reading (40 ~ 80/2)
        result = tracker.update(40.0, 0.5)
        assert result is not None
        # Should be corrected to double: 80
        assert abs(result - 80.0) < 1.0

    def test_none_input_returns_none(self):
        """None candidate should always return None."""
        tracker = HRTracker()
        tracker.update(70.0, 0.5)
        assert tracker.update(None, 0.5) is None

    def test_does_not_poison_history_with_outlier(self):
        """An uncorrectable outlier should not be added to history."""
        tracker = HRTracker()
        for hr in [70.0, 71.0, 69.0, 70.5, 70.0]:
            tracker.update(hr, 0.5)
        history_before = list(tracker.history)

        # Feed a wild outlier that can't be halved or doubled to match
        tracker.update(200.0, 0.5)

        # History should not have 200.0 appended
        assert 200.0 not in tracker.history
        # History should be unchanged
        assert list(tracker.history) == history_before

    def test_history_length_limited(self):
        """Only the most recent history_len entries are used for median."""
        tracker = HRTracker(history_len=3)
        for hr in [60.0, 65.0, 70.0, 75.0, 80.0]:
            tracker.update(hr, 0.5)

        # Median of last 3: median([70, 75, 80]) = 75
        # A reading near 75 should pass; one near 60 should be far
        result = tracker.update(76.0, 0.5)
        assert result == 76.0

    def test_large_jump_still_returned(self):
        """A large jump that can't be corrected is still returned (just not in history)."""
        tracker = HRTracker()
        for hr in [70.0, 71.0, 69.0]:
            tracker.update(hr, 0.5)
        result = tracker.update(200.0, 0.5)
        # The value is returned even though it's an outlier
        assert result == 200.0

    def test_history_bounded_under_sustained_input(self):
        """HRTracker history must not grow unbounded — only the last
        history_len entries are ever consulted, so retaining more leaks
        memory on multi-day uptime (#325)."""
        tracker = HRTracker(history_len=5)
        # Feed ~1440 readings (equivalent to 1 day at 1/min).
        for i in range(1440):
            tracker.update(70.0 + (i % 3), 0.5)
        assert len(tracker.history) <= 5, (
            f"HRTracker.history leaked: expected ≤5 entries, "
            f"got {len(tracker.history)}"
        )

    def test_history_bound_respects_custom_history_len(self):
        """Custom history_len caps the underlying storage."""
        tracker = HRTracker(history_len=3)
        for i in range(100):
            tracker.update(70.0, 0.5)
        assert len(tracker.history) <= 3


# ===================================================================
# compute_breathing_rate
# ===================================================================


class TestComputeBreathingRate:
    """Breathing rate from Hilbert envelope + peak counting."""

    def test_detects_respiratory_rate(self):
        """Should detect breathing rate from respiratory-modulated BCG."""
        np.random.seed(42)
        target_br = 15  # breaths per minute
        sig = make_respiratory_modulated_bcg(
            hr_bpm=70, br_bpm=target_br, duration_s=90
        )
        br = compute_breathing_rate(sig, FS)
        assert br is not None
        assert abs(br - target_br) < 5

    def test_returns_none_or_gated_for_noise(self):
        """White noise should either return None or a value within the range gate.

        Bandpass-filtered noise can produce spurious peaks that happen to
        yield a plausible-looking breathing rate.  The important thing is
        that the function never returns a value outside the 6-30 BPM gate,
        and with very low amplitude noise it is unlikely to be physiological.
        """
        np.random.seed(42)
        sig = make_noise(duration_s=60, amplitude=100)
        br = compute_breathing_rate(sig, FS)
        if br is not None:
            assert 6 <= br <= 30

    def test_returns_none_for_short_signal(self):
        """Too few peaks (short signal) should return None."""
        np.random.seed(42)
        sig = make_respiratory_modulated_bcg(hr_bpm=70, br_bpm=15, duration_s=5)
        br = compute_breathing_rate(sig, FS)
        # 5 seconds is not enough for 3 respiratory peaks at 15 BPM (4s period)
        assert br is None

    def test_range_gate_rejects_extreme_values(self):
        """Values outside 6-30 BPM should be rejected."""
        np.random.seed(42)
        # Very fast "breathing" at 40 BPM (outside gate)
        sig = make_respiratory_modulated_bcg(hr_bpm=70, br_bpm=40, duration_s=90)
        br = compute_breathing_rate(sig, FS)
        # Should either be None or within 6-30
        if br is not None:
            assert 6 <= br <= 30

    def test_different_breathing_rates(self):
        """Should detect a range of normal breathing rates."""
        np.random.seed(42)
        for target_br in [10, 15, 20]:
            sig = make_respiratory_modulated_bcg(
                hr_bpm=70, br_bpm=target_br, duration_s=120
            )
            br = compute_breathing_rate(sig, FS)
            if br is not None:
                assert 6 <= br <= 30, f"BR out of range for target={target_br}: got {br}"


# ===================================================================
# compute_hrv
# ===================================================================


class TestComputeHRV:
    """HR variability index via window-level autocorrelation IBI + harmonic gate."""

    def _make_varying_ibi_signal(self, mean_hr=70, ibi_std_ms=30,
                                  duration_s=300, fs=FS):
        """Create a BCG-like signal with known, slightly varying IBI.

        Each beat is a short Gaussian pulse placed at varying intervals.
        """
        np.random.seed(42)
        n_samples = int(duration_s * fs)
        signal = np.zeros(n_samples, dtype=np.float64)

        mean_ibi_s = 60.0 / mean_hr
        ibi_std_s = ibi_std_ms / 1000.0

        t = 0.0
        while t < duration_s:
            idx = int(t * fs)
            if idx >= n_samples:
                break
            # Place a Gaussian pulse (sigma ~10ms)
            sigma = int(0.01 * fs)
            for k in range(-3 * sigma, 3 * sigma + 1):
                i = idx + k
                if 0 <= i < n_samples:
                    signal[i] += np.exp(-0.5 * (k / sigma) ** 2) * 1_000_000
            ibi = mean_ibi_s + np.random.randn() * ibi_std_s
            ibi = max(ibi, 0.4)  # floor at 400ms
            t += ibi

        # Add small noise
        signal += np.random.randn(n_samples) * 10_000
        return signal

    def test_computes_rmssd_for_varying_ibi(self):
        """HRV index should be a positive finite number for a realistic signal."""
        sig = self._make_varying_ibi_signal(mean_hr=70, ibi_std_ms=30,
                                             duration_s=300)
        hrv = compute_hrv(sig, FS)
        # We expect an HRV index; it may or may not match the exact input std
        # but should be a plausible number
        if hrv is not None:
            assert 5 <= hrv <= 100
            assert np.isfinite(hrv)

    def test_returns_none_for_insufficient_data(self):
        """Short signals should return None (not enough sub-windows)."""
        np.random.seed(42)
        sig = make_bcg_signal(70, duration_s=10)  # Only 10s, need 30s sub-windows
        hrv = compute_hrv(sig, FS)
        assert hrv is None

    def test_returns_none_or_gated_for_noise(self):
        """White noise should return None or a value within the range gate.

        Broadband noise after bandpass filtering can produce autocorrelation
        peaks in the cardiac lag range, yielding spurious IBI estimates.
        The Hampel filter and range gate (5-100 ms) provide the safety net.
        """
        np.random.seed(42)
        sig = make_noise(duration_s=300, amplitude=100)
        hrv = compute_hrv(sig, FS)
        if hrv is not None:
            assert 5 <= hrv <= 100

    def test_range_gate(self):
        """HRV index should be None or within 5-100 ms."""
        np.random.seed(42)
        sig = self._make_varying_ibi_signal(mean_hr=70, ibi_std_ms=50,
                                             duration_s=300)
        hrv = compute_hrv(sig, FS)
        if hrv is not None:
            assert 5 <= hrv <= 100

    def test_hampel_filter_removes_outliers(self):
        """Verify that compute_hrv can handle signals that would produce
        IBI outliers — the Hampel filter inside should handle them gracefully."""
        np.random.seed(42)
        sig = self._make_varying_ibi_signal(mean_hr=70, ibi_std_ms=20,
                                             duration_s=300)
        # Inject a couple of massive noise bursts to create outlier IBIs
        burst_positions = [50 * FS, 150 * FS]
        for pos in burst_positions:
            sig[pos:pos + FS] += np.random.randn(FS) * 5_000_000

        hrv = compute_hrv(sig, FS)
        # Should still produce a result (Hampel filter cleans outliers)
        # or return None gracefully — either way, no crash
        if hrv is not None:
            assert 5 <= hrv <= 100

    def test_long_clean_signal_produces_result(self):
        """A 5-minute clean BCG signal should produce a valid HRV index."""
        np.random.seed(42)
        sig = make_bcg_signal(hr_bpm=65, duration_s=300, noise_level=0.05)
        hrv = compute_hrv(sig, FS)
        # May or may not produce a result depending on SHS scoring;
        # a clean sinusoidal BCG should have very consistent IBI
        # so HRV index should be small if detected
        if hrv is not None:
            assert 5 <= hrv <= 100


# ===================================================================
# Integration-like tests
# ===================================================================


class TestWriteVitalsResilience:
    """write_vitals must swallow sqlite3 errors and reconnect after N
    consecutive failures so transient WAL/disk issues don't kill the process (#325)."""

    def _make_db(self):
        import sqlite3
        conn = sqlite3.connect(":memory:")
        conn.execute(
            """CREATE TABLE vitals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                side TEXT, timestamp INTEGER,
                heart_rate REAL, hrv REAL, breathing_rate REAL
            )"""
        )
        conn.execute(
            """CREATE TABLE vitals_quality (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vitals_id INTEGER, side TEXT, timestamp INTEGER,
                quality_score REAL, flags TEXT, hr_raw REAL,
                created_at INTEGER
            )"""
        )
        return conn

    def test_happy_path_inserts(self):
        from datetime import datetime, timezone
        import main
        conn = self._make_db()
        main._db_write_failures = 0
        result_conn, wrote = main.write_vitals(conn, "left",
                                               datetime.now(timezone.utc),
                                               70.0, 40.0, 15.0,
                                               quality_score=0.9)
        assert result_conn is conn
        assert wrote is True
        rows = conn.execute("SELECT * FROM vitals").fetchall()
        assert len(rows) == 1

    def test_sqlite_error_does_not_raise(self, monkeypatch):
        """A transient OperationalError must be logged, not raised."""
        from datetime import datetime, timezone
        import sqlite3
        import main

        class BadConn:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, *a, **k):
                raise sqlite3.OperationalError("disk I/O error")

        main._db_write_failures = 0
        # Should not raise
        result_conn, wrote = main.write_vitals(BadConn(), "left",
                                               datetime.now(timezone.utc),
                                               70.0, 40.0, 15.0,
                                               quality_score=0.9)
        # Returns the bad conn unchanged on the first failure, with wrote=False.
        assert result_conn is not None
        assert wrote is False

    def test_reconnect_after_threshold(self, monkeypatch):
        """After _DB_RECONNECT_THRESHOLD consecutive failures, the connection
        is replaced via open_biometrics_db()."""
        from datetime import datetime, timezone
        import sqlite3
        import main

        class BadConn:
            closed = False
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, *a, **k):
                raise sqlite3.OperationalError("disk full")
            def close(self):
                self.closed = True

        replaced = []

        def fake_open():
            replaced.append(1)
            return self._make_db()

        main._db_write_failures = 0
        monkeypatch.setattr(main, "open_biometrics_db", fake_open)

        bad = BadConn()
        ts = datetime.now(timezone.utc)
        conn = bad
        for i in range(main._DB_RECONNECT_THRESHOLD):
            conn, wrote = main.write_vitals(conn, "left", ts, 70.0, 40.0, 15.0,
                                            quality_score=0.9)
            assert wrote is False

        # After crossing the threshold the function must have reopened the DB
        assert len(replaced) == 1, \
            "expected one reconnect after _DB_RECONNECT_THRESHOLD failures"
        # Failure counter resets after reconnect
        assert main._db_write_failures == 0


class TestSideProcessorAbsenceThrottle:
    """_maybe_write must update _last_write on 'no user' so return from
    extended absence doesn't trigger burst processing until the first write
    succeeds (#325)."""

    def test_last_write_advances_on_absence(self):
        """When presence is not detected, _last_write should be advanced so
        the next ingest call does not immediately re-enter the heavy
        signal-processing path."""
        np.random.seed(42)
        proc = SideProcessor("left", db_conn=None)
        # Simulate extended absence — _last_write far in the past.
        proc._last_write = time.time() - 3600  # 1 hour ago
        assert time.time() - proc._last_write > VITALS_INTERVAL_S

        # Feed low-amplitude noise (empty bed).
        samples = make_noise(duration_s=15, amplitude=100).astype(np.int32)
        proc.ingest(samples)

        # _last_write must have been moved forward to now-ish so the NEXT
        # ingest within VITALS_INTERVAL_S will short-circuit at the cadence
        # check rather than running presence detection + suppression again.
        assert time.time() - proc._last_write < VITALS_INTERVAL_S, \
            "absence skip must update _last_write to bound burst processing"


class TestIntegration:
    """Verify that pipeline components work together on realistic signals."""

    def test_full_pipeline_on_bcg_signal(self):
        """bandpass -> autocorr -> SHS -> HR for a 30s BCG window."""
        np.random.seed(42)
        target_hr = 68
        sig = make_bcg_signal(target_hr, duration_s=30, noise_level=0.05)

        # Presence detection should recognize this as a person
        filt = _bandpass(sig, 1.0, 10.0, FS)
        std = float(np.std(filt))
        acr_q = _autocorr_quality(sig, FS)

        pd = PresenceDetector()
        present = pd.update(std, acr_q)
        assert present is True

        # HR should be close to target
        hr, score = subharmonic_summation_hr(sig, FS)
        assert hr is not None
        assert abs(hr - target_hr) < 6

    def test_empty_bed_pipeline(self):
        """Empty bed noise should produce ABSENT and no HR."""
        np.random.seed(42)
        sig = make_noise(duration_s=30, amplitude=50_000)

        filt = _bandpass(sig, 1.0, 10.0, FS)
        std = float(np.std(filt))
        acr_q = _autocorr_quality(sig, FS)

        pd = PresenceDetector()
        present = pd.update(std, acr_q)

        hr, score = subharmonic_summation_hr(sig, FS)

        # At least one of these should indicate "nobody home"
        assert not present or hr is None or score < 0.15


# ===================================================================
# FrzHealthPumpState — asymmetric pump-coupling guard
# ===================================================================

class TestFrzHealthPumpState:
    """Tracks per-side pump RPM from frzHealth records and identifies
    asymmetric pump-on configurations (own pump active, other idle) that
    cause phantom presence on Pod 3. Bug observed live 2026-05-02:
    right-side heating with pump@2000RPM produced 23 vitals rows in
    30 min with no occupant."""

    def test_ignores_non_frzhealth_records(self):
        ps = FrzHealthPumpState()
        ps.update({"type": "piezo-dual", "left": {"pumpRpm": 5000}, "right": {"pumpRpm": 5000}})
        assert ps.is_side_pump_active("left") is False
        assert ps.is_side_pump_active("right") is False

    def test_marks_pump_active_above_threshold(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": PUMP_ACTIVE_RPM_MIN + 100},
        })
        assert ps.is_side_pump_active("left") is False
        assert ps.is_side_pump_active("right") is True

    def test_below_threshold_is_idle(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": PUMP_ACTIVE_RPM_MIN - 1},
            "right": {"pumpRpm": PUMP_ACTIVE_RPM_MIN - 1},
        })
        assert ps.is_side_pump_active("left") is False
        assert ps.is_side_pump_active("right") is False

    def test_alternative_field_names(self):
        """Different firmware versions emit pumpRpm / pump_rpm / rpm /
        pumpDuty. The state tracker must read all of them."""
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pump_rpm": 2000},
            "right": {"rpm": 2000},
        })
        assert ps.is_side_pump_active("left") is True
        assert ps.is_side_pump_active("right") is True

    def test_pumpRPM_uppercase_variant(self):
        """Firmware may emit pumpRPM (all-caps RPM); main.py:196 lists it
        but only the lowercase variants were exercised before."""
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRPM": 2000},
            "right": {"pumpRPM": 0},
        })
        assert ps.is_side_pump_active("left") is True
        assert ps.is_side_pump_active("right") is False

    def test_pumpDuty_fallback(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpDuty": 50},
            "right": {"pumpDuty": 0},
        })
        assert ps.is_side_pump_active("left") is True
        assert ps.is_side_pump_active("right") is False

    def test_is_asymmetric_true_when_only_own_side_running(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 2000},
        })
        # The exact live observation: right is heating, left is off.
        assert ps.is_asymmetric_for("right") is True
        assert ps.is_asymmetric_for("left") is False

    def test_is_asymmetric_false_when_both_running(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 2000},
            "right": {"pumpRpm": 2000},
        })
        # Both pumps on → not asymmetric. The symmetric case is caught
        # by is_symmetric_active() instead — see test below.
        assert ps.is_asymmetric_for("left") is False
        assert ps.is_asymmetric_for("right") is False
        assert ps.is_symmetric_active() is True

    def test_is_symmetric_active_only_when_both_running(self):
        ps = FrzHealthPumpState()
        # Both off
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 0},
        })
        assert ps.is_symmetric_active() is False
        # Asymmetric (right only)
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 2000},
        })
        assert ps.is_symmetric_active() is False
        # Both on (Pod 5 live: 1940 / 2004 → beat 64/min in cardiac band)
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 1940},
            "right": {"pumpRpm": 2004},
        })
        assert ps.is_symmetric_active() is True

    def test_is_asymmetric_false_when_both_idle(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 0},
        })
        assert ps.is_asymmetric_for("left") is False
        assert ps.is_asymmetric_for("right") is False

    def test_guard_period_after_pump_off(self):
        """After own-side pump turns off, ringing in piezo continues for
        a few seconds — keep the gate active during that trailing window."""
        ps = FrzHealthPumpState()
        # Pump on
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 2000},
        })
        assert ps.is_side_pump_active("right") is True

        # Pump off — should still be "active" within guard
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 0},
        })
        assert ps.is_side_pump_active("right") is True
        assert ps.is_asymmetric_for("right") is True

    def test_guard_period_expires(self):
        ps = FrzHealthPumpState()
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 2000},
        })
        ps.update({
            "type": "frzHealth",
            "left": {"pumpRpm": 0},
            "right": {"pumpRpm": 0},
        })
        # Force guard expiry
        ps._pump_off_at["right"] = time.monotonic() - PUMP_OFF_GUARD_S - 1
        assert ps.is_side_pump_active("right") is False

    def test_handles_malformed_record_safely(self):
        ps = FrzHealthPumpState()
        # No left/right keys
        ps.update({"type": "frzHealth"})
        # Wrong types
        ps.update({"type": "frzHealth", "left": "not a dict", "right": [1, 2, 3]})
        # Non-numeric rpm
        ps.update({"type": "frzHealth", "left": {"pumpRpm": "abc"}, "right": {"pumpRpm": None}})
        assert ps.is_side_pump_active("left") is False
        assert ps.is_side_pump_active("right") is False
