"""Arrival time must not turn replayed or discontinuous input into fresh vitals."""
from types import SimpleNamespace

import numpy as np
import pytest

from common.biometrics.live_input import LiveFrameClock, FIRMWARE_TIMESTAMP_BASIS
from common.tests_support.mechanical import quiet_snapshot


@pytest.fixture
def timeline():
    clock = SimpleNamespace(wall=1_792_962_000.0, monotonic=1000.0)
    return clock, LiveFrameClock(lambda: clock.wall, lambda: clock.monotonic)


@pytest.mark.parametrize("timestamp", [None, True, "1792962000", -1, 0,
                                       float("nan"), float("inf"), 10 ** 400])
def test_rejects_missing_or_malformed_firmware_time(timeline, timestamp):
    _, frames = timeline
    assert not frames.admit(timestamp)
    assert frames.problem
    with pytest.raises(RuntimeError, match="No accepted"):
        frames()


def test_retains_event_time_instead_of_arrival_and_bounds_latency(timeline):
    clock, frames = timeline
    assert frames.admit(clock.wall - 10)
    assert frames() == clock.wall - 10
    assert frames.discontinuous
    clock.wall += 1
    clock.monotonic += 1
    assert frames.admit(clock.wall - 10)
    assert not frames.discontinuous
    assert not frames.admit(clock.wall - 10.001)
    assert "too old" in frames.problem
    assert not frames.admit(clock.wall + .001)
    assert "ahead" in frames.problem


def test_duplicate_and_reversed_frames_cannot_reset_the_watermark(timeline):
    clock, frames = timeline
    assert frames.admit(clock.wall)
    assert not frames.admit(clock.wall)
    assert not frames.admit(clock.wall - 1)
    assert not frames.admit(clock.wall)
    clock.wall += 1
    clock.monotonic += 1
    assert frames.admit(clock.wall)
    assert frames.discontinuous
    clock.wall += 1
    clock.monotonic += 1
    assert frames.admit(clock.wall)
    assert not frames.discontinuous


@pytest.mark.parametrize("event_gap,arrival_gap", [(2, 1), (1, -1)])
def test_source_gaps_and_arrival_clock_discontinuities_reset_windows(timeline, event_gap, arrival_gap):
    clock, frames = timeline
    assert frames.admit(clock.wall)
    clock.wall += event_gap
    clock.monotonic += arrival_gap
    assert frames.admit(clock.wall)
    assert frames.discontinuous


def test_slow_processing_preserves_complete_consecutive_source_frames(timeline):
    clock, frames = timeline
    assert frames.admit(clock.wall)
    clock.wall += 3
    clock.monotonic += 3
    # Three seconds of processing did not lose either of the queued frames.
    assert frames.admit(clock.wall - 2)
    assert not frames.discontinuous
    assert frames.admit(clock.wall - 1)
    assert not frames.discontinuous


def test_dropped_or_pump_gated_frame_requires_a_new_window(timeline):
    clock, frames = timeline
    assert frames.admit(clock.wall)
    frames.break_continuity()
    clock.wall += 1
    clock.monotonic += 1
    assert frames.admit(clock.wall)
    assert frames.discontinuous


def test_estimate_keeps_firmware_time_and_reset_clears_all_unfinished_buffers(timeline):
    import main
    clock, frames = timeline
    assert frames.admit(clock.wall - 7)
    processor = main.SideProcessor("left", main.DBHolder(None), clock=frames)
    processor._presence.update = lambda *args, **kwargs: True
    processor._quality = lambda samples: 1.0
    processor._estimator.estimate = lambda *args: SimpleNamespace(
        heart_rate=60.0, hrv_index=30.0, breathing_rate=12.0, hr_raw=60.0, hr_score=1.0)
    candidates = []
    processor.sink = lambda candidate: candidates.append(candidate) or True
    processor.ingest(np.ones(main.SAMPLE_RATE * 10))
    assert candidates[0].ts.timestamp() == clock.wall - 7
    tracker = processor._hr_tracker
    main.reset_live_buffers((processor,))
    assert len(processor._hr_buf) == len(processor._br_buf) == len(processor._hrv_buf) == 0
    assert processor._hr_tracker is not tracker
    assert processor._last_med_std == processor._last_acr_qual == 0
    processor.ingest(np.ones(main.SAMPLE_RATE))
    assert len(candidates) == 1  # no old samples can complete the new estimate


def test_main_rejects_backlog_and_resets_before_accepting_recovery(monkeypatch, tmp_path):
    import main
    clock = SimpleNamespace(wall=1_792_962_000.0, monotonic=1000.0)
    monkeypatch.setattr(main.time, "time", lambda: clock.wall)
    monkeypatch.setattr(main.time, "monotonic", lambda: clock.monotonic)
    monkeypatch.setattr(main, "BIOMETRICS_DB", tmp_path / "biometrics.db")
    monkeypatch.setattr(main, "open_biometrics_db", lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(main, "report_health", lambda *args: None)
    monkeypatch.setattr(main, "read_snapshot", lambda _, now: quiet_snapshot(now))
    monkeypatch.setattr(main, "KNOWN_RECORD_TYPES", {"piezo-dual"})
    processors = []

    class Processor:
        def __init__(self, side, holder, **kwargs):
            self.side, self.clock = side, kwargs["clock"]
            self.parameters, self.run_context = None, None
            self.buffer, self.seen = [], []
            processors.append(self)

        def install_runtime(self, parameters, context, reset_side):
            assert reset_side
            self.buffer.clear()

        def ingest(self, samples):
            self.buffer.append(self.clock())
            self.seen.append(list(self.buffer))

    def coordinator(holder, selected, **kwargs):
        assert kwargs["timestamp_basis"] == FIRMWARE_TIMESTAMP_BASIS
        return SimpleNamespace(problem=None, before_frame=lambda *args: None, after_frame=lambda *args: None)

    monkeypatch.setattr(main, "SideProcessor", Processor)
    monkeypatch.setattr(main, "RuntimeCoordinator", coordinator)
    monkeypatch.setattr(main, "SingleSleeperVitals", lambda *args, **kwargs: SimpleNamespace(submit=lambda *args: True, tick=lambda: None, flush=lambda: True))
    monkeypatch.setattr(main.PumpGate, "check", lambda *args: clock.monotonic == 1003)

    class Follower:
        def read_records(self, on_poll):
            payload = np.zeros(500, dtype="<i4").tobytes()
            for offset in (0, 1, 2, 3, 4, 5):
                clock.wall, clock.monotonic = 1_792_962_000.0 + offset, 1000.0 + offset
                yield {"type": "piezo-dual", "ts": clock.wall - (20 if offset == 2 else 0),
                       "left1": payload, "right1": payload}

    monkeypatch.setattr(main, "create_follower", lambda *args, **kwargs: Follower())
    main.main()
    for processor in processors:
        assert processor.seen == [[1_792_962_000.0], [1_792_962_000.0, 1_792_962_001.0],
                                  [1_792_962_004.0], [1_792_962_004.0, 1_792_962_005.0]]
