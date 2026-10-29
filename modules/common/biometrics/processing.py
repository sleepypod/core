"""Stateful per-channel processing shared by live ingestion and replay.

All time, occupancy, routing, provenance and output are caller-owned. The
clock returns Unix seconds, and estimates and candidate timestamps use the
same event time. Retain
left-before-right ingestion: cross-channel rejection intentionally sees the
other side's most recently evaluated features, not a simultaneous recompute.
There are no database, hardware, transport or wall-clock reads here.
"""
from collections import deque
from datetime import datetime, timezone
import logging
from typing import Callable, Optional

import numpy as np

from .signal import (SAMPLE_RATE, _bandpass, _autocorr_quality,
                     ProcessingParameters, DEFAULT_PARAMETERS, WindowEstimator)
from .gates import (FrzHealthPumpState, PresenceDetector,
                    PUMP_COUPLING_STD_FACTOR, PUMP_COUPLING_ACR_THRESHOLD)
from .routing import VITALS_INTERVAL_S

HR_WINDOW_S = 30
BREATHING_WINDOW_S = 60
HRV_WINDOW_S = 300
log = logging.getLogger(__name__)


class StatefulSideProcessor:
    def __init__(self, side: str, *, clock: Callable[[], float],
                 writer: Callable[[object], bool], candidate_factory: Callable,
                 pump_state: Optional[FrzHealthPumpState] = None,
                 parameters: ProcessingParameters = DEFAULT_PARAMETERS,
                 autocorr_quality: Callable = _autocorr_quality):
        self.side = side
        self._clock = clock
        self._writer = writer
        self._candidate_factory = candidate_factory
        self._quality = autocorr_quality
        self._hr_buf: deque = deque(maxlen=HR_WINDOW_S * SAMPLE_RATE)
        self._hrv_buf: deque = deque(maxlen=HRV_WINDOW_S * SAMPLE_RATE)
        self._br_buf: deque = deque(maxlen=BREATHING_WINDOW_S * SAMPLE_RATE)
        self._last_write = 0.0
        self._presence = PresenceDetector()
        self.parameters = parameters
        self.run_context: Optional[object] = None
        self._estimator = WindowEstimator(parameters)
        self._hr_tracker = self._estimator.hr_tracker
        self._other: Optional['StatefulSideProcessor'] = None  # set after both sides created
        self._last_med_std: float = 0.0  # cached for cross-channel comparison
        self._last_acr_qual: float = 0.0
        self._pump_state = pump_state
        # An optional arbitration sink; None uses the caller-provided writer.
        # main() routes both sides through SingleSleeperVitals.submit.
        self.sink: Optional[Callable[[object], bool]] = None
        # The bed's own answer to "is anyone here" (sleep-detector presence):
        # False vetoes piezo presence, None (unknown) leaves it alone.
        self.bed_occupied: Optional[Callable[[], Optional[bool]]] = None
        # Single-sleeper home side (None in per-side mode). The sleep-detector
        # merges both zones into the home side, so only the home side's
        # processor may treat `bed_occupied() is True` as its own evidence.
        self.home_side: Optional[Callable[[], Optional[str]]] = None
        # Receives this side's tracked window heart rate as a period (s);
        # main() points it at the beat tracker so it starts from the right
        # rhythm. It doesn't change any vitals value.
        self.rate_hint: Optional[Callable[[float], None]] = None

    def install_runtime(self, parameters, run_context, reset_side=False):
        if parameters != self.parameters or reset_side:
            self._hr_buf.clear()
            self._hrv_buf.clear()
            self._br_buf.clear()
            self._estimator = WindowEstimator(parameters)
            self._hr_tracker = self._estimator.hr_tracker
            self._last_write = 0.0
            self._last_med_std = self._last_acr_qual = 0.0
            self._presence = PresenceDetector()
        self.parameters = parameters
        self.run_context = run_context

    def ingest(self, samples: np.ndarray) -> None:
        self._hr_buf.extend(samples)
        self._hrv_buf.extend(samples)
        self._br_buf.extend(samples)
        self._maybe_write()

    def _maybe_write(self) -> None:
        now = self._clock()
        if now - self._last_write < VITALS_INTERVAL_S:
            return

        hr_arr = np.array(self._hr_buf)
        if len(hr_arr) < int(10 * SAMPLE_RATE):
            return  # Not enough data yet

        # --- Presence detection (hysteresis + autocorrelation quality) ---
        filt = _bandpass(hr_arr, 1.0, 10.0, SAMPLE_RATE)
        w = int(5 * SAMPLE_RATE)
        stds = [np.std(filt[j:j + w])
                for j in range(0, len(filt) - w + 1, w)]
        med_std = float(np.median(stds)) if stds else 0.0
        acr_qual = self._quality(hr_arr)
        cross_channel_rejected = False

        # Cross-channel rejection: if the other side has stronger or similar
        # signal AND strong autocorrelation (someone is actually there), this
        # side's signal is likely vibration coupling, not a person.
        # A real person produces ~3-5x stronger signal on their side.
        #
        # Note: due to sequential processing in main() (left before right),
        # left sees right's values from the previous cycle (~60s stale).
        # This is acceptable — coupling produces similar energy regardless
        # of which side checks first.
        if self._other is not None and self._other._last_med_std > 0:
            other_std = self._other._last_med_std
            other_acr = self._other._last_acr_qual
            # Only suppress if: other side has real periodicity (someone there),
            # other side's energy is >= ours, and our energy is below threshold
            if (other_acr > 0.3
                    and other_std > med_std * 0.7
                    and med_std < self._presence.enter_threshold):
                acr_qual = 0.0
                cross_channel_rejected = True

        # Cache AFTER suppression so the other side sees post-suppression values
        self._last_med_std = med_std
        self._last_acr_qual = acr_qual

        # The bed's own answer to "is anyone here" (sleep-detector capacitance
        # presence), read once per cycle: True relaxes re-entry below, False
        # vetoes piezo presence, None (unknown) leaves the piezo alone.
        bed = self.bed_occupied() if self.bed_occupied is not None else None
        # Only occupancy measured on this side may relax the piezo. With one
        # side away the reading is merged under the home side, so the away
        # side inherits a True it cannot attribute to its own zone and keeps
        # the strict path. A side whose energy cross-channel rejection has
        # already attributed to the other sleeper keeps it too.
        own_side = self.home_side is None or self.home_side() in (None, self.side)
        relaxed = bed is True and own_side and not cross_channel_rejected

        # Pump-coupling guard. PumpGate handles symmetric spikes (ramps)
        # but misses two steady-state modes: asymmetric (own-pump-on with
        # opposite idle — vibration couples into same-side piezo, no
        # competing signal for cross-channel rejection) and symmetric
        # (both pumps on at mismatched RPMs — beat frequency lands in the
        # cardiac band, both sides look "real"). In both, require elevated
        # energy AND strong autocorrelation to enter PRESENT; coupling
        # rarely produces both, only a real person does.
        #
        # The guard answers "is this vibration a person or the pump". When
        # the capacitance sensor says a person is in bed on this side and
        # the energy is not the other sleeper's, that question is settled;
        # on Pod 5 both pumps run all night, so without this bypass a
        # sleeper who drifted to a weak-signal position stayed ABSENT for
        # an hour at a time (05:57-07:01 on 2026-10-11) until a hard
        # movement cleared the raised bar.
        if (self._pump_state is not None and not relaxed
                and self._presence.state == PresenceDetector.ABSENT):
            symmetric = self._pump_state.is_symmetric_active()
            asymmetric = self._pump_state.is_asymmetric_for(self.side)
            if symmetric or asymmetric:
                std_threshold = self._presence.enter_threshold * PUMP_COUPLING_STD_FACTOR
                if not (med_std > std_threshold and acr_qual > PUMP_COUPLING_ACR_THRESHOLD):
                    log.debug(
                        "%s: pump-coupling guard suppressed presence "
                        "(med_std=%.0f, acr=%.2f, mode=%s)",
                        self.side, med_std, acr_qual,
                        "symmetric" if symmetric else "asymmetric",
                    )
                    return

        if relaxed and self._presence.state == PresenceDetector.ABSENT:
            log.debug("%s: bed reads occupied, relaxed piezo re-entry (med_std=%.0f, acr=%.2f)",
                      self.side, med_std, acr_qual)
        if cross_channel_rejected:
            # The other side owns this energy. Zeroing acr alone cannot end
            # presence (exit needs weak energy too), so count the window as
            # weak and let the normal hysteresis exit instead of latching,
            # and never submit vitals computed from it meanwhile.
            self._presence.update(0.0, 0.0)
            present = False
        else:
            present = self._presence.update(med_std, acr_qual, relaxed=relaxed)
        # Piezo presence is vibration energy and rhythm; a prime or the pump
        # shaking an empty bed passes it. Trust the capacitance-based
        # presence when the sleep-detector says nobody is there.
        if present and bed is False:
            present = False

        if not present:
            # Reset the interval cursor so a return from extended absence
            # doesn't trigger burst processing on every ingest until the
            # first write completes (#325).
            self._last_write = now
            return  # No user detected — skip

        # Shared numerical estimator. Gating and live sinks remain in this adapter.
        estimate = self._estimator.estimate(now, hr_arr, np.array(self._br_buf),
                                             np.array(self._hrv_buf))
        hr, hrv, br = estimate.heart_rate, estimate.hrv_index, estimate.breathing_rate
        hr_raw, hr_score = estimate.hr_raw, estimate.hr_score
        if hr is not None and hr > 0 and self.rate_hint is not None:
            self.rate_hint(60.0 / hr)

        if hr is not None or hrv is not None or br is not None:
            ts = datetime.fromtimestamp(now, timezone.utc)
            snr = max(0.0, min(1.0, acr_qual))
            hr_conf = max(0.0, min(1.0, hr_score)) if hr is not None else 0.0
            quality = round(0.55 * snr + 0.45 * hr_conf, 3)
            flags = []
            if hr is None:
                flags.append("no_hr")
            if hrv is None:
                flags.append("no_hrv")
            if br is None:
                flags.append("no_br")
            if med_std < self._presence.enter_threshold:
                flags.append("low_signal")
            cand = self._candidate_factory(self.side, ts, hr, hrv, br, quality, flags or None, hr_raw, self.run_context)
            wrote = self.sink(cand) if self.sink is not None else self._writer(cand)
            log.info("vitals %s — HR=%.1f HRV=%.1f BR=%.1f q=%.2f", self.side,
                     hr or 0, hrv or 0, br or 0, quality)
            # Only advance the downsample cursor when the write actually
            # committed — otherwise a transient sqlite error would skip
            # VITALS_INTERVAL_S of valid samples.
            if wrote:
                self._last_write = now
        else:
            # No metric to write — advance so we don't recompute on every ingest.
            self._last_write = now

