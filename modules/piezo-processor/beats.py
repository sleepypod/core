"""
Beat-to-beat heartbeat detection from the bed's piezo (ballistocardiogram).

Produces individual heartbeat times — the input HRV analysis and heart-rate-
based sleep staging need — instead of per-minute rate estimates.

Pipeline, per side, on a sliding window (WINDOW_S long, advancing STEP_S; only
beats in the central STEP_S are committed, so every beat is decided with
context on both sides):

1. Band-pass each piezo channel to the cardiac band (HR_BAND, as the rate
   pipeline) and decimate 500 -> 100 Hz. Blank body movement (samples far
   above the heartbeat's own amplitude, plus a margin) so a turn-over can't
   corrupt the rhythm estimate or template of the surrounding windows; no
   beat is taken near, and no interval spans, a blanked stretch.
2. Other-side noise reference: fit a short FIR mapping the other side's
   channels onto this channel (ridge least squares) and subtract it. Vibration
   common to both sides (pump beat frequencies, building, a partner's
   movement) is removed. The other side can also carry THIS sleeper's own
   heartbeat through the mattress, which a blind subtraction would cancel.
   That case is unmistakable: removing your own heartbeat collapses the
   channel's cardiac periodicity (measured ~0.83 -> 0.1-0.26), whereas
   removing common vibration leaves it unchanged or better, and removing a
   partner's coupled heartbeat improves it. So the cleaned channel is used
   unless it loses more than ANC_MAX_QUALITY_DROP of periodicity.
3. Combine the side's two channels: normalise, align the second to the first
   (lag and polarity), weight by periodicity, and keep the combination only
   if it beats the best single channel.
4. Detect beats by template matching: a per-window average heartbeat complex
   (the sleeper's own waveform in their current position) is matched against
   the signal; correlation peaks are beats, refined to sub-sample precision.
   Gaps longer than 1.6 beat periods are searched again at a lower
   threshold. With two good channels, a beat neither channel confirms is
   dropped.
5. Artifact correction (BeatCleaner): intervals outside 20% of the local
   median are rejected (the classic HRV editing criterion, e.g. Kamath &
   Fallen 1995); an extra beat whose two short intervals sum to a normal one
   is removed; a missed beat becomes a break rather than an interpolated
   beat (beat classification after Lipponen & Tarvainen 2019). No interval is
   ever computed across a break.

HRV: RMSSD over the last 5 minutes of clean intervals (Task Force of the ESC
and NASPE, 1996, short-term standard), only when enough of the window is
covered by valid intervals.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import butter, correlate, find_peaks, sosfiltfilt

FS_RAW = 500
DECIMATE = 5
FS = FS_RAW // DECIMATE  # 100 Hz after decimation

# Cardiac band — same as the rate pipeline (HR_BAND in main.py, PMC7582983).
BAND = (0.8, 8.5)

WINDOW_S = 20.0
STEP_S = 5.0
# Committed region of each window, as offsets from the window start: the
# central STEP_S, leaving (WINDOW_S - STEP_S) / 2 of context on each side.
COMMIT_START_S = (WINDOW_S - STEP_S) / 2
COMMIT_END_S = COMMIT_START_S + STEP_S

# Heart-rate range considered: 40-150 bpm.
MIN_PERIOD_S = 0.4
MAX_PERIOD_S = 1.5

# Envelope periodicity below this: no reliable heartbeat in the window.
MIN_QUALITY = 0.35

# Period selection by subharmonic summation: autocorrelation at 1x..3x the
# lag, weights decaying by 0.84 per harmonic (Hermes 1988), each multiple
# searched within +-5% for beat-to-beat variability.
SHS_HARMONICS = 3
SHS_DECAY = 0.84
SHS_TOL = 0.05
# A lag whose double correlates better by more than this is a within-beat
# wave, not the period.
SUB_PERIOD_MARGIN = 0.05
# Likewise a lag whose half or third correlates at least as well is every
# second or third cycle of a faster rhythm (searched down to 200 bpm).
FASTEST_S = 0.3

# Rhythm tracking across windows (as HRTracker does for the vitals, after
# Bruser et al. 2011): a resting heart can't change rate by more than
# TRACK_TOL between 5 s steps, so once a rhythm is established each window's
# period must lie within TRACK_TOL of the recent median. Movement or
# machinery can put a stronger rhythm at another rate on the sensors; those
# windows yield no beats rather than wrong ones. RESEED_WINDOWS consistent
# windows at a new rate (15 s) mean the rate really changed; SEED_WINDOWS
# agreeing windows start tracking. Tracking only starts (or re-seeds) at a
# resting rate, SEED_MIN_PERIOD_S (120 bpm) or slower, so a fast mechanical
# rhythm present when someone lies down can't be taken for the heart; a
# tracked rhythm may still climb past it gradually. A rhythm unseen for
# TRACK_MAX_AGE_S is forgotten.
TRACK_TOL = 0.20
TRACK_HISTORY = 5
SEED_WINDOWS = 2
RESEED_WINDOWS = 3
SEED_MIN_PERIOD_S = 0.5
TRACK_MAX_AGE_S = 60.0
# While following an established rhythm the prior already rules out other
# rates, so a weaker window is still trustworthy: measured against a
# wrist-worn reference this kept heart-rate error unchanged (~1 bpm) while
# adding ~12% more beats.
FOLLOW_MIN_QUALITY = 0.2

# Rate hint: the side's window heart rate (HRTracker, from subharmonic
# summation over 30 s — a different estimator from this one). Envelope
# periodicity can't tell a heartbeat from half of one when each beat has
# two similar waves, which some sleeping positions produce; the window rate
# can (it corrects half/double readings). A fresh hint decides where
# tracking starts, and a tracked rhythm more than TRACK_TOL from it is
# dropped. Hints older than HINT_MAX_AGE_S are ignored.
HINT_MAX_AGE_S = 120.0

# Beat shapes of consecutive windows correlating at least this well are the
# same complex, so the anchor is kept on the same point of it.
ANCHOR_MIN_SIMILARITY = 0.5
# The other-side-cleaned channel is used unless its periodicity drops by more
# than this (self-cancellation of the sleeper's own heartbeat drops it ~0.6).
ANC_MAX_QUALITY_DROP = 0.10
# Below this fraction of variance removed, cancellation isn't worth using.
ANC_MIN_REMOVED = 0.02
# Template-match (normalised cross-correlation) thresholds.
NCC_MIN = 0.4
NCC_SEARCHBACK = 0.25
# Other-side reference FIR: +-50 ms of lags, ridge relative to mean energy.
ANC_LAGS = 5
ANC_RIDGE = 1e-3
# Two channels confirm a beat when both have a beat within this tolerance.
CONFIRM_TOL_S = 0.08
CONFIRM_MIN_QUALITY = 0.4

# Motion blanking: |x| above MOTION_K x the typical heartbeat peak (median of
# per-MAX_PERIOD_S-block maxima: every block holds >= 1 beat at >= 40 bpm, so
# this tracks J-peak height at any heart rate), widened by MOTION_MARGIN_S.
MOTION_K = 3.0
MOTION_MARGIN_S = 0.5
# Beats within this of a blanked stretch are dropped.
MOTION_GUARD_S = 0.3

# Artifact correction.
MEDIAN_WINDOW = 11
MIN_HISTORY = 5
REL_TOL = 0.20
MIN_RRI_S = 0.3
MAX_RRI_S = 2.0
# More than this apart in the incoming stream is a signal gap.
GAP_TOL_S = 2.0

_SOS = butter(4, BAND, btype="band", fs=FS_RAW, output="sos")


# ---------------------------------------------------------------------------
# Signal helpers
# ---------------------------------------------------------------------------

def bandpass_decimate(x_raw: np.ndarray) -> np.ndarray:
    """Zero-phase cardiac band-pass at 500 Hz, then take every 5th sample.
    The band tops out at 8.5 Hz, far below the new 50 Hz Nyquist."""
    x = np.asarray(x_raw, dtype=np.float64)
    if x.size < 64:
        return np.zeros(x.size // DECIMATE)
    return sosfiltfilt(_SOS, x - x.mean())[::DECIMATE]


def motion_mask(x: np.ndarray, fs: int = FS) -> np.ndarray:
    """True where body movement swamps the heartbeat."""
    a = np.abs(x)
    block = int(MAX_PERIOD_S * fs)
    nblk = a.size // block
    if nblk < 3:
        return np.zeros(a.size, dtype=bool)
    ref = float(np.median(a[:nblk * block].reshape(nblk, block).max(axis=1)))
    if ref <= 0:
        return np.zeros(a.size, dtype=bool)
    hit = a > MOTION_K * ref
    if not hit.any():
        return hit
    m = int(MOTION_MARGIN_S * fs)
    return np.convolve(hit.astype(float), np.ones(2 * m + 1), mode="same") > 0


def _motion_starts(mask: np.ndarray) -> np.ndarray:
    """Sample indices where blanked stretches begin."""
    if mask.size == 0:
        return np.zeros(0, dtype=int)
    m = mask.astype(np.int8)
    starts = np.flatnonzero(np.diff(np.concatenate(([0], m))) == 1)
    return starts


def _envelope(x: np.ndarray, fs: int = FS) -> np.ndarray:
    """Beat-rate envelope: rectified signal smoothed over ~100 ms."""
    width = max(1, int(0.1 * fs))
    kernel = np.ones(width) / width
    return np.convolve(np.abs(x), kernel, mode="same")


def _subharmonic_score(ac: np.ndarray, lag: int) -> float:
    """Weighted mean autocorrelation at 1x, 2x and 3x `lag` (each the best
    value within SHS_TOL of the multiple, since beat-to-beat variability
    smears later peaks)."""
    total = weight = 0.0
    for k in range(1, SHS_HARMONICS + 1):
        centre = k * lag
        tol = max(2, int(round(SHS_TOL * centre)))
        lo, hi = centre - tol, min(ac.size, centre + tol + 1)
        if lo >= ac.size:
            break
        w = SHS_DECAY ** (k - 1)
        total += w * float(ac[lo:hi].max())
        weight += w
    return total / weight if weight else 0.0


def periodicity(x: np.ndarray, fs: int = FS, prior: Optional[float] = None,
                min_period: float = MIN_PERIOD_S) -> Tuple[float, float]:
    """(quality, period_s) from the normalised autocorrelation of the beat
    envelope over the 40-150 bpm lag range. Quality 0 = no rhythm, 1 = a
    perfectly repeating envelope.

    The period is the autocorrelation peak with the best subharmonic
    score (Hermes, 1988, J Acoust Soc Am 83:257-264): a true period repeats
    at 2x and 3x its lag too, while the decay of the autocorrelation with
    lag keeps 2x the period (every other beat) from winning over the true
    one. Excluded first: a lag whose double correlates better (a secondary
    wave inside each beat complex, which would double the count) and a lag
    whose half or third correlates at least as well (every other or third
    cycle of a faster rhythm).

    The quality is the chosen peak's own autocorrelation, and (0, 0) means
    no period qualifies. With a `prior` period (the rhythm being tracked, or
    an independent rate estimate), only peaks within TRACK_TOL of it are
    considered, in place of the octave filters above — so a signal can be
    strongly rhythmic at some other rate and still score 0. `min_period`
    narrows the lag range (to rates at which tracking may start)."""
    if x.size < int(2 * MAX_PERIOD_S * fs) or not np.any(x):
        return 0.0, 0.0
    env = _envelope(x, fs)
    env = env - env.mean()
    denom = float(np.dot(env, env))
    if denom <= 0:
        return 0.0, 0.0
    ac = correlate(env, env, mode="full", method="fft")[env.size - 1:] / denom
    lo, hi = int(min_period * fs), int(MAX_PERIOD_S * fs)
    seg = ac[lo:hi + 1]
    peaks, _ = find_peaks(seg)
    if peaks.size == 0:
        return 0.0, 0.0
    best = float(seg[peaks].max())
    if best <= 0:
        return 0.0, 0.0
    lags = lo + peaks

    def sub_period(lag: int) -> bool:
        # A secondary wave inside each beat: the "period" at `lag` correlates
        # worse than twice that lag, which a true rhythm never does (the
        # autocorrelation fades with lag as beat intervals vary).
        tol = max(2, int(round(SHS_TOL * 2 * lag)))
        double = lags[np.abs(lags - 2 * lag) <= tol]
        return double.size > 0 and float(ac[double].max()) > float(ac[lag]) + SUB_PERIOD_MARGIN

    # Every peak of the autocorrelation down to FASTEST_S, for spotting a
    # candidate that is only every other cycle of something faster.
    floor = int(FASTEST_S * fs)
    all_peaks = floor + find_peaks(ac[floor:hi + 1])[0]

    def multiple(lag: int) -> bool:
        tol = max(2, int(round(SHS_TOL * lag)))
        for k in (2, 3):
            part = all_peaks[np.abs(all_peaks - lag / k) <= tol]
            if part.size and float(ac[part].max()) >= float(ac[lag]):
                return True
        return False

    if prior is not None:
        # The prior settles which octave is the heart; the octave filters
        # would reject the true period when each beat has two similar waves
        # (then its half repeats at least as strongly).
        candidates = [p for p in peaks
                      if seg[p] > 0 and abs((lo + p) / fs / prior - 1) <= TRACK_TOL]
    else:
        # A genuine rhythm in range always leaves its own period standing;
        # when nothing does, whatever repeats is outside the range.
        candidates = [p for p, lag in zip(peaks, lags)
                      if seg[p] > 0 and not sub_period(int(lag)) and not multiple(int(lag))]
    if not candidates:
        return 0.0, 0.0
    scores = [_subharmonic_score(ac, lo + int(p)) for p in candidates]
    pick = int(candidates[int(np.argmax(scores))])
    lag = lo + pick + _parabolic(seg, pick)
    return max(0.0, min(1.0, float(seg[pick]))), lag / fs


def _parabolic(y: np.ndarray, i: int) -> float:
    """Sub-sample offset of a local extremum at index i (parabolic fit)."""
    if i <= 0 or i >= y.size - 1:
        return 0.0
    a, b, c = y[i - 1], y[i], y[i + 1]
    d = a - 2 * b + c
    if d == 0:
        return 0.0
    return float(max(-0.5, min(0.5, 0.5 * (a - c) / d)))


def _shift(x: np.ndarray, lag: int) -> np.ndarray:
    """x delayed by `lag` samples (negative = advanced), zero-filled."""
    out = np.zeros_like(x)
    if lag == 0:
        out[:] = x
    elif lag > 0:
        out[lag:] = x[:-lag]
    else:
        out[:lag] = x[-lag:]
    return out


def cancel_common_noise(primary: np.ndarray, references: List[np.ndarray],
                        lags: int = ANC_LAGS, ridge: float = ANC_RIDGE) -> np.ndarray:
    """Subtract the part of `primary` predictable from the other side's
    channels: ridge least-squares FIR over +-`lags` samples of each
    reference. Returns the residual. Callers must verify it helped — see
    the module docstring on self-cancellation."""
    refs = [r for r in references if r is not None and r.size == primary.size and np.any(r)]
    if not refs:
        return primary
    cols = [_shift(r, lag) for r in refs for lag in range(-lags, lags + 1)]
    R = np.stack(cols, axis=1)
    RtR = R.T @ R
    lam = ridge * float(np.trace(RtR)) / RtR.shape[0]
    try:
        w = np.linalg.solve(RtR + lam * np.eye(RtR.shape[0]), R.T @ primary)
    except np.linalg.LinAlgError:
        return primary
    return primary - R @ w


def _best_alignment(a: np.ndarray, b: np.ndarray, max_lag: int) -> Tuple[int, float]:
    """(lag, signed correlation) aligning b to a, |lag| <= max_lag."""
    best_lag, best_c = 0, 0.0
    na = np.linalg.norm(a)
    for lag in range(-max_lag, max_lag + 1):
        bs = _shift(b, lag)
        nb = np.linalg.norm(bs)
        if na == 0 or nb == 0:
            continue
        c = float(np.dot(a, bs) / (na * nb))
        if abs(c) > abs(best_c):
            best_lag, best_c = lag, c
    return best_lag, best_c


@dataclass
class Combined:
    signal: np.ndarray
    period: float
    quality: float
    # Each usable channel, lag- and polarity-aligned to `signal`, with its
    # own periodicity — for per-channel confirmation of beats.
    aligned: List[Tuple[np.ndarray, float]]


def combine_channels(c1: np.ndarray, c2: Optional[np.ndarray], fs: int = FS,
                     prior: Optional[float] = None,
                     min_period: float = MIN_PERIOD_S) -> Combined:
    """Combine a side's two channels: the periodicity-weighted, lag- and
    polarity-aligned sum when that is more periodic than either channel
    alone, else the better channel. Periodicity is judged at `prior` when
    given, over lags from `min_period` (see `periodicity`)."""
    q1, p1 = periodicity(c1, fs, prior, min_period)
    if c2 is None or c2.size != c1.size or not np.any(c2):
        return Combined(c1, p1, q1, [(c1, q1)])
    q2, p2 = periodicity(c2, fs, prior, min_period)
    s1, s2 = np.std(c1), np.std(c2)
    if s1 == 0 or s2 == 0:
        return Combined(c1, p1, q1, [(c1, q1)]) if s1 else Combined(c2, p2, q2, [(c2, q2)])
    z1, z2 = c1 / s1, c2 / s2
    lag, corr = _best_alignment(z1, z2, int(0.1 * fs))
    if abs(corr) < 0.3:
        # The channels don't see the same thing: use the better one alone.
        return Combined(c1, p1, q1, [(c1, q1)]) if q1 >= q2 else Combined(c2, p2, q2, [(c2, q2)])
    z2a = math.copysign(1.0, corr) * _shift(z2, lag)
    aligned = [(z1, q1), (z2a, q2)]
    w1, w2 = q1 ** 2, q2 ** 2
    if w1 + w2 > 0:
        comb = (w1 * z1 + w2 * z2a) / (w1 + w2)
        qc, pc = periodicity(comb, fs, prior, min_period)
        if qc >= max(q1, q2):
            return Combined(comb, pc, qc, aligned)
    return Combined(z1, p1, q1, aligned) if q1 >= q2 else Combined(z2a, p2, q2, aligned)


def _ncc(y: np.ndarray, template: np.ndarray) -> np.ndarray:
    """Normalised cross-correlation of `template` (odd length) centred at
    every sample of `y`; 0 where the template does not fit."""
    L = template.size
    h = L // 2
    t0 = template - template.mean()
    tn = np.linalg.norm(t0)
    out = np.zeros(y.size)
    if tn == 0 or y.size < L:
        return out
    num = correlate(y, t0, mode="same", method="fft")
    c1 = np.concatenate(([0.0], np.cumsum(y)))
    c2 = np.concatenate(([0.0], np.cumsum(y * y)))
    idx = np.arange(h, y.size - h)
    s = c1[idx + h + 1] - c1[idx - h]
    ss = c2[idx + h + 1] - c2[idx - h]
    var = np.maximum(ss - s * s / L, 1e-12)
    out[idx] = num[idx] / (np.sqrt(var) * tn)
    return out


@dataclass
class Template:
    waveform: np.ndarray
    polarity: int


def _pick_polarity(x: np.ndarray, period: float, fs: int,
                   prefer: Optional[int]) -> Tuple[int, np.ndarray]:
    """Choose the sign whose peaks (at >= 0.6 period spacing) are most
    regular and closest to the period; ties keep the previous window's sign
    so the beat anchor doesn't jump between windows."""
    dist = max(1, int(0.6 * period * fs))
    scores = {}
    peaks_by = {}
    for pol in (1, -1):
        pk, props = find_peaks(pol * x, distance=dist, height=0)
        if pk.size >= 3:
            heights = props["peak_heights"]
            pk = pk[heights >= 0.3 * np.median(heights)]
        if pk.size < 3:
            continue
        ibi = np.diff(pk) / fs
        scores[pol] = abs(ibi.mean() - period) / period + ibi.std() / ibi.mean()
        peaks_by[pol] = pk
    if not scores:
        return (prefer or 1), np.array([], dtype=int)
    pol = min(scores, key=scores.get)
    if prefer in scores and scores[prefer] <= scores[pol] + 0.1:
        pol = prefer
    return pol, peaks_by[pol]


def detect_beats(x: np.ndarray, period: float, fs: int = FS,
                 previous: Optional[Template] = None
                 ) -> Tuple[np.ndarray, np.ndarray, Optional[Template]]:
    """Beat positions (fractional samples) and confidences in `x`.

    Builds the window's average beat complex around regular candidate peaks,
    matches it against the signal (normalised cross-correlation), takes
    correlation peaks at >= 0.6 period spacing, searches long gaps again at
    a lower threshold, and refines each beat by parabolic interpolation.

    Anchor continuity: a beat's time is the template centre, which depends
    on the polarity picked (J peak vs K trough ~80 ms apart). Consecutive
    windows may pick differently, and one inconsistent interval per switch
    would inflate RMSSD while passing the 20% artifact rule. So the new
    template is aligned (in the signal's own polarity) to the previous one;
    beat times are shifted by that lag, and the template is stored
    re-centred on the previous anchor.
    """
    empty = (np.array([]), np.array([]), previous)
    if period <= 0:
        return empty
    pol, cand = _pick_polarity(x, period, fs, previous.polarity if previous else None)
    h = int(round(min(max(0.35 * period, 0.2), 0.5) * fs))
    segs = [pol * x[c - h:c + h + 1] for c in cand if c - h >= 0 and c + h < x.size]
    if len(segs) < 3:
        return empty
    template = np.median(np.stack(segs), axis=0)
    y = pol * x
    ncc = _ncc(y, template)
    dist = max(1, int(0.6 * period * fs))
    peaks, _ = find_peaks(ncc, height=NCC_MIN, distance=dist)
    peaks = list(peaks)
    # Search-back: a gap of > 1.6 periods probably hides a weaker beat.
    extra = []
    bounds = [0] + peaks + [x.size - 1]
    for a, b in zip(bounds[:-1], bounds[1:]):
        if (b - a) / fs > 1.6 * period:
            lo, hi = a + dist, b - dist
            if hi > lo:
                i = lo + int(np.argmax(ncc[lo:hi]))
                if ncc[i] >= NCC_SEARCHBACK:
                    extra.append(i)
    peaks = np.array(sorted(set(peaks) | set(extra)), dtype=int)
    pos = np.array([p + _parabolic(ncc, p) for p in peaks], dtype=float)
    conf = ncc[peaks] if peaks.size else np.array([])
    lag = _anchor_lag(previous, Template(template, pol), fs)
    if lag:
        pos = pos - lag
        template = _shift(template, lag)
    return pos, conf, Template(template, pol)


def _shape_match(previous: Template, new: Template, fs: int) -> Tuple[int, float]:
    """(lag, correlation) of the best alignment of `new`'s beat shape to
    `previous`'s, each in its signal's own polarity. Templates are sized
    from the period, so both are cropped to the shorter, centred."""
    n = min(previous.waveform.size, new.waveform.size)

    def centre(w: np.ndarray) -> np.ndarray:
        k = (w.size - n) // 2
        return w[k:k + n]

    a = previous.polarity * centre(previous.waveform)
    b = new.polarity * centre(new.waveform)
    a = a - a.mean()
    b = b - b.mean()
    best_lag, best_c = 0, 0.0
    for lag in range(-int(0.15 * fs), int(0.15 * fs) + 1):
        bs = _shift(b, lag)
        d = np.linalg.norm(a) * np.linalg.norm(bs)
        if d == 0:
            continue
        c = float(np.dot(a, bs) / d)
        if c > best_c:
            best_lag, best_c = lag, c
    return best_lag, best_c


def _anchor_lag(previous: Optional[Template], new: Template, fs: int) -> int:
    """Samples by which `new`'s centre sits later on the beat complex than
    `previous`'s (0 when unrelated or equal)."""
    if previous is None:
        return 0
    lag, similarity = _shape_match(previous, new, fs)
    return lag if similarity >= ANCHOR_MIN_SIMILARITY else 0


def confirmed_by_channels(pos: np.ndarray, template: Template,
                          aligned: List[Tuple[np.ndarray, float]],
                          fs: int = FS) -> np.ndarray:
    """Boolean mask over beat positions: True unless two good channels both
    fail to show the beat. Each aligned channel is matched against the SAME
    template (so the same point of the beat complex is compared), and a
    channel confirms a beat when its correlation reaches NCC_SEARCHBACK
    within CONFIRM_TOL_S. With fewer than two good channels there is nothing
    independent to cross-check, so every beat stands."""
    good = [ch for ch, q in aligned if q >= CONFIRM_MIN_QUALITY]
    if len(good) < 2 or pos.size == 0:
        return np.ones(pos.size, dtype=bool)
    tol = int(round(CONFIRM_TOL_S * fs))
    ok = np.zeros(pos.size, dtype=bool)
    for ch in good:
        ncc = _ncc(template.polarity * ch, template.waveform)
        for i, p in enumerate(np.round(pos).astype(int)):
            lo, hi = max(0, p - tol), min(ncc.size, p + tol + 1)
            if hi > lo and ncc[lo:hi].max() >= NCC_SEARCHBACK:
                ok[i] = True
    return ok


# ---------------------------------------------------------------------------
# Artifact correction
# ---------------------------------------------------------------------------

Beat = Optional[Tuple[float, float]]  # (time_s, confidence); None = break


class BeatCleaner:
    """Streaming RR artifact correction. Feed raw beats (and breaks);
    returns cleaned beats with at most one beat of delay (an apparent extra
    beat is held until the next one decides it).

    - accept an interval within REL_TOL (20%) of the median of the last
      MEDIAN_WINDOW accepted intervals (or within MIN_RRI_S..MAX_RRI_S while
      there is no history yet);
    - a short interval whose sum with the next is a normal interval marks
      an extra beat: the middle beat is dropped;
    - anything else (missed beats, ectopy, noise) is a break: no interval is
      reported across it, and the beat after it starts a new run;
    - three consecutive intervals that agree with each other but not with
      the history mean the rate really changed: the history is reset.
    """

    def __init__(self) -> None:
        self._last: Optional[float] = None
        self._hist: Deque[float] = deque(maxlen=MEDIAN_WINDOW)
        self._held: Optional[Tuple[float, float]] = None
        self._outliers: List[float] = []

    def _median(self) -> Optional[float]:
        return float(np.median(self._hist)) if len(self._hist) >= MIN_HISTORY else None

    def _ok(self, d: float, med: Optional[float]) -> bool:
        if not (MIN_RRI_S <= d <= MAX_RRI_S):
            return False
        return med is None or abs(d / med - 1) <= REL_TOL

    def _start_run(self, beat: Tuple[float, float], out: List[Beat]) -> None:
        if out and out[-1] is not None or (not out and self._last is not None):
            out.append(None)
        self._last = beat[0]
        out.append(beat)

    def push(self, beat: Beat) -> List[Beat]:
        out: List[Beat] = []
        if beat is None:
            if self._held is not None:
                self._held = None
            if self._last is not None:
                out.append(None)
            self._last = None
            self._outliers = []
            return out
        t, _ = beat
        if self._last is None:
            self._last = t
            out.append(beat)
            return out
        med = self._median()
        if self._held is not None:
            # Was the held beat an extra one? Then last -> this beat is normal.
            held, self._held = self._held, None
            if self._ok(t - self._last, med):
                self._accept(t - self._last, beat, out)
                return out
            # Not extra: the held beat broke the rhythm. Restart at it.
            self._reject(held[0] - self._last)
            self._start_run(held, out)
            return out + self.push(beat)
        d = t - self._last
        if self._ok(d, med):
            self._accept(d, beat, out)
            return out
        if med is not None and 0 <= d < med * (1 - REL_TOL):
            self._held = beat  # maybe an extra beat; decided by the next one
            return out
        self._reject(d)
        self._start_run(beat, out)
        return out

    def _reject(self, d: float) -> None:
        """Record a rejected interval. Three that agree with each other (but
        not the history) mean the rate really changed: adopt them."""
        self._outliers.append(d)
        if len(self._outliers) < 3:
            return
        recent = self._outliers[-3:]
        m = float(np.median(recent))
        if not (m > 0 and all(MIN_RRI_S <= r <= MAX_RRI_S and abs(r / m - 1) <= REL_TOL
                              for r in recent)):
            return
        old = self._median()
        # Halving or doubling is a detection artifact (every other beat
        # missed, or extra half-beats), not a physiological rate change.
        if old is not None and (0.4 <= m / old <= 0.6 or 1.7 <= m / old <= 2.3):
            return
        self._hist.clear()
        self._hist.extend(recent)
        self._outliers = []

    def _accept(self, d: float, beat: Tuple[float, float], out: List[Beat]) -> None:
        self._hist.append(d)
        self._outliers = []
        self._last = beat[0]
        out.append(beat)


# ---------------------------------------------------------------------------
# Rolling statistics for vitals
# ---------------------------------------------------------------------------

class BeatHistory:
    """Recent cleaned beats of one side, for heart rate and RMSSD."""

    def __init__(self, keep_s: float = 330.0) -> None:
        self._keep_s = keep_s
        self._items: Deque[Beat] = deque()

    def extend(self, items: List[Beat]) -> None:
        for it in items:
            if it is None and self._items and self._items[-1] is None:
                continue
            self._items.append(it)
        latest = self.latest_time()
        if latest is None:
            return
        while self._items and (self._items[0] is None or self._items[0][0] < latest - self._keep_s):
            self._items.popleft()

    def latest_time(self) -> Optional[float]:
        for it in reversed(self._items):
            if it is not None:
                return it[0]
        return None

    def _intervals(self, since: float) -> List[List[float]]:
        """Runs of consecutive valid intervals whose end beat is >= since."""
        runs: List[List[float]] = [[]]
        prev: Optional[float] = None
        for it in self._items:
            if it is None:
                prev = None
                runs.append([])
                continue
            if prev is not None and it[0] >= since:
                runs[-1].append(it[0] - prev)
            prev = it[0]
        return [r for r in runs if r]

    def heart_rate(self, window_s: float = 60.0, min_coverage: float = 0.5) -> Optional[float]:
        latest = self.latest_time()
        if latest is None:
            return None
        ivs = [d for run in self._intervals(latest - window_s) for d in run]
        if not ivs or sum(ivs) < min_coverage * window_s:
            return None
        return 60.0 / float(np.mean(ivs))

    def rmssd_ms(self, window_s: float = 300.0, min_coverage: float = 0.5,
                 min_diffs: int = 20) -> Optional[float]:
        """RMSSD over successive differences of adjacent intervals within a
        run (never across a break)."""
        latest = self.latest_time()
        if latest is None:
            return None
        runs = self._intervals(latest - window_s)
        diffs = [b - a for run in runs for a, b in zip(run[:-1], run[1:])]
        covered = sum(sum(run) for run in runs)
        if len(diffs) < min_diffs or covered < min_coverage * window_s:
            return None
        return 1000.0 * math.sqrt(float(np.mean(np.square(diffs))))


# ---------------------------------------------------------------------------
# Streaming tracker
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    """One minute of cleaned beats for storage."""
    start: int                     # epoch seconds, minute-aligned
    beats: List[Optional[int]]     # ms offsets from start; None = break
    quality: float                 # mean beat confidence

    @property
    def coverage(self) -> int:
        return sum(1 for b in self.beats if b is not None)


@dataclass
class BeatTracker:
    """Per-side streaming beat detector. Feed every piezo record (own two
    channels plus the other side's two as the noise reference); collect
    finished minute chunks with `take_chunks()`."""
    side: str
    history: BeatHistory = field(default_factory=BeatHistory)
    _raw: Dict[str, np.ndarray] = field(default_factory=dict)
    _start: Optional[float] = None       # time of _raw sample 0
    _next_end: Optional[float] = None    # end of the next window to process
    _template: Optional[Template] = None
    _cleaner: BeatCleaner = field(default_factory=BeatCleaner)
    _chunk_items: List[Tuple[Optional[float], float]] = field(default_factory=list)
    _chunk_start: Optional[int] = None
    _ready: List[Chunk] = field(default_factory=list)
    _last_committed_end: Optional[float] = None
    _rhythm: Deque[float] = field(default_factory=lambda: deque(maxlen=TRACK_HISTORY))
    _rhythm_at: Optional[float] = None
    _candidates: List[float] = field(default_factory=list)
    _hint: Optional[float] = None        # period (s) from the window rate
    _hint_at: Optional[float] = None
    _mask: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=bool))

    KEYS = ("own1", "own2", "ref1", "ref2")

    def set_rate_hint(self, period: float, at: float) -> None:
        """Independent heart period (s) measured at `at`; see HINT_MAX_AGE_S."""
        if period > 0:
            self._hint, self._hint_at = float(period), float(at)

    def gap(self) -> None:
        """Signal discontinuity (dropped records): restart windows."""
        self._emit([None])
        self._raw = {}
        self._mask = np.zeros(0, dtype=bool)
        self._start = None
        self._next_end = None

    def push(self, ts: float, own1: np.ndarray, own2: Optional[np.ndarray],
             ref1: Optional[np.ndarray], ref2: Optional[np.ndarray],
             masked: bool = False) -> None:
        """Add one record. A `masked` record (e.g. pump-gated) keeps the
        windows running but is blanked like movement: no beat in it or
        within MOTION_MARGIN_S of it, and no interval across it — where a
        gap() would cost a whole window of refill."""
        n = own1.size
        if n == 0:
            return
        if self._start is not None:
            expected = self._start + self._raw["own1"].size / FS_RAW
            if abs(ts - expected) > GAP_TOL_S:
                self.gap()
        if self._start is None:
            self._start = float(ts)
            self._raw = {k: np.zeros(0) for k in self.KEYS}
            self._mask = np.zeros(0, dtype=bool)
            self._next_end = self._start + WINDOW_S
        for key, arr in zip(self.KEYS, (own1, own2, ref1, ref2)):
            if arr is None or arr.size != n:
                arr = np.zeros(n)
            self._raw[key] = np.concatenate((self._raw[key], np.asarray(arr, dtype=np.float64)))
        self._mask = np.concatenate((self._mask, np.full(n, masked)))
        end = self._start + self._raw["own1"].size / FS_RAW
        while self._next_end is not None and end >= self._next_end:
            self._process(self._next_end)
            self._next_end += STEP_S
            keep_from = int(round((self._next_end - WINDOW_S - self._start) * FS_RAW))
            if keep_from > 0:
                for k in self.KEYS:
                    self._raw[k] = self._raw[k][keep_from:]
                self._mask = self._mask[keep_from:]
                self._start += keep_from / FS_RAW

    def _process(self, window_end: float) -> None:
        w0 = window_end - WINDOW_S
        i0 = int(round((w0 - self._start) * FS_RAW))
        i1 = i0 + int(WINDOW_S * FS_RAW)
        sig = {k: bandpass_decimate(self._raw[k][i0:i1]) for k in self.KEYS}
        motion = np.zeros(sig["own1"].size, dtype=bool)
        blank = self._mask[i0:i1][::DECIMATE][:motion.size]
        if blank.any():
            # Masked records, widened by the filter's ringing margin.
            pad = int(MOTION_MARGIN_S * FS)
            blank = np.convolve(blank.astype(float), np.ones(2 * pad + 1), mode="same") > 0
            motion |= blank
            for k in self.KEYS:
                sig[k] = np.where(blank, 0.0, sig[k])
        for k in self.KEYS:
            m = motion_mask(sig[k])
            sig[k] = np.where(m, 0.0, sig[k])
            if k.startswith("own"):
                motion |= m
        refs = [sig["ref1"], sig["ref2"]]
        channels = []
        for key in ("own1", "own2"):
            c = sig[key]
            if not np.any(c):
                channels.append(None)
                continue
            channels.append(self._use_reference(c, refs))
        c1, c2 = channels
        if c1 is None:
            c1, c2 = c2, None
        if c1 is None or motion.mean() > 0.5:
            self._commit(w0, [], [], ok=False)
            return
        comb = self._track(window_end, c1, c2)
        if comb is None:
            self._commit(w0, [], [], ok=False)
            return
        pos, conf, template = detect_beats(comb.signal, comb.period, previous=self._template)
        if template is None or pos.size == 0:
            self._commit(w0, [], [], ok=False)
            return
        self._template = template
        keep = confirmed_by_channels(pos, template, comb.aligned)
        if motion.any():
            guard = int(MOTION_GUARD_S * FS)
            near = np.convolve(motion.astype(float), np.ones(2 * guard + 1), mode="same") > 0
            idx = np.clip(np.round(pos).astype(int), 0, motion.size - 1)
            keep &= ~near[idx]
        breaks = _motion_starts(motion) / FS
        self._commit(w0, list(pos[keep] / FS), list(conf[keep]), ok=True, breaks=list(breaks))

    def _track(self, now: float, c1: np.ndarray, c2: Optional[np.ndarray]) -> Optional[Combined]:
        """This window's combined signal if its rhythm continues the tracked
        one (or starts / re-seeds it); None if the window yields no beats."""
        if self._rhythm and self._rhythm_at is not None and now - self._rhythm_at > TRACK_MAX_AGE_S:
            self._rhythm.clear()
            self._candidates = []
        hint = self._hint
        if hint is None or self._hint_at is None or now - self._hint_at > HINT_MAX_AGE_S:
            hint = None
        if self._rhythm and hint is not None and abs(float(np.median(self._rhythm)) / hint - 1) > TRACK_TOL:
            # Tracking some other rhythm than the heart rate says (typically
            # half-beats): drop it and restart at the hinted rate.
            self._rhythm.clear()
            self._candidates = []
        if self._rhythm:
            comb = combine_channels(c1, c2, prior=float(np.median(self._rhythm)))
            if comb.quality >= FOLLOW_MIN_QUALITY:
                self._candidates = []
                return self._follow(now, comb)
        if hint is not None:
            if self._rhythm:
                return None
            comb = combine_channels(c1, c2, prior=hint)
            if comb.quality < MIN_QUALITY:
                return None
            # This window and the independent rate agree: start here.
            self._candidates = []
            return self._follow(now, comb)
        comb = combine_channels(c1, c2, min_period=SEED_MIN_PERIOD_S)
        if comb.quality < MIN_QUALITY:
            if not self._rhythm:
                self._candidates = []
            return None
        # A rhythm other than the tracked one (or none tracked yet): adopt it
        # once enough consecutive windows agree on it.
        self._candidates.append(comb.period)
        need = RESEED_WINDOWS if self._rhythm else SEED_WINDOWS
        recent = self._candidates[-need:]
        if len(recent) < need:
            return None
        m = float(np.median(recent))
        if not all(abs(p / m - 1) <= TRACK_TOL for p in recent):
            return None
        self._rhythm.clear()
        self._rhythm.extend(recent[:-1])
        self._candidates = []
        return self._follow(now, comb)

    def _follow(self, now: float, comb: Combined) -> Combined:
        self._rhythm.append(comb.period)
        self._rhythm_at = now
        return comb

    @staticmethod
    def _use_reference(c: np.ndarray, refs: List[np.ndarray]) -> np.ndarray:
        """`c` with vibration predictable from the other side removed, unless
        that removal was (mostly) this sleeper's own heartbeat."""
        cleaned = cancel_common_noise(c, refs)
        var = float(np.var(c))
        if var <= 0 or float(np.var(c - cleaned)) / var < ANC_MIN_REMOVED:
            return c
        q_raw, _ = periodicity(c)
        q_clean, _ = periodicity(cleaned)
        if q_clean >= MIN_QUALITY and q_clean >= q_raw - ANC_MAX_QUALITY_DROP:
            return cleaned
        return c

    def _commit(self, w0: float, times: List[float], conf: List[float], ok: bool,
                breaks: Optional[List[float]] = None) -> None:
        lo, hi = w0 + COMMIT_START_S, w0 + COMMIT_END_S
        if not ok:
            self._emit([None])
            self._last_committed_end = hi
            return
        events = [(w0 + t, 1, (w0 + t, float(c))) for t, c in zip(times, conf)
                  if lo <= w0 + t < hi]
        # A movement starting in (or just before) the committed region
        # breaks the run there.
        events += [(w0 + b, 0, None) for b in (breaks or [])
                   if lo - MOTION_MARGIN_S <= w0 + b < hi]
        events.sort(key=lambda e: (e[0], e[1]))
        self._emit([e[2] for e in events])
        self._last_committed_end = hi

    def _emit(self, raw_items: List[Beat]) -> None:
        cleaned: List[Beat] = []
        for it in raw_items:
            cleaned.extend(self._cleaner.push(it))
        self.history.extend(cleaned)
        for it in cleaned:
            if it is None:
                if self._chunk_items and self._chunk_items[-1][0] is not None:
                    self._chunk_items.append((None, 0.0))
                continue
            t, c = it
            minute = int(t // 60) * 60
            if self._chunk_start is None:
                self._chunk_start = minute
            if minute != self._chunk_start:
                self._flush()
                self._chunk_start = minute
            self._chunk_items.append((t, c))

    def _flush(self) -> None:
        if self._chunk_start is None:
            return
        items = self._chunk_items
        # A break at the end of a minute belongs to the next one's start.
        carry_break = bool(items) and items[-1][0] is None
        beats: List[Optional[int]] = []
        confs = []
        for t, c in items[:-1] if carry_break else items:
            if t is None:
                # A leading break says "not contiguous with the previous chunk".
                if not beats or beats[-1] is not None:
                    beats.append(None)
            else:
                beats.append(int(round((t - self._chunk_start) * 1000)))
                confs.append(c)
        if confs:
            self._ready.append(Chunk(self._chunk_start, beats, float(np.mean(confs))))
        self._chunk_items = [(None, 0.0)] if carry_break else []

    def take_chunks(self, flush_before: Optional[float] = None) -> List[Chunk]:
        """Finished chunks. The open minute is also flushed once committed
        processing has moved past its end (`flush_before`, default the last
        committed time)."""
        edge = flush_before if flush_before is not None else self._last_committed_end
        # One extra step of margin: the cleaner may still hold the minute's
        # last beat until the next beat decides it.
        if (self._chunk_start is not None and edge is not None
                and edge >= self._chunk_start + 60 + STEP_S):
            self._flush()
            self._chunk_start = None
        out, self._ready = self._ready, []
        return out
