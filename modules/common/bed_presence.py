"""
Who is in bed, according to the sleep-detector.

The sleep-detector commits each side's presence from the capacitance sensors
(debounced, against a self-adjusting empty-bed baseline) and saves it to its
state file. Other modules read it here rather than guessing from their own
signal: the piezo-processor's presence check looks at vibration energy and
rhythm only, so bed vibration with nobody there (a prime, the pump) reads as
a person and produced vitals for an empty bed.

With one side away (single sleeper) the sleep-detector merges both sides'
presence into the home side, so callers ask about the side the reading is
stored under.
"""

import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("bed_presence")

STATE_VERSION = 1
# How often the state file is re-read (seconds).
BED_PRESENCE_RELOAD_S = 5.0
# The detector rewrites the file on every presence change and at least once a
# minute; a file older than this means it has stopped, and presence is unknown.
BED_PRESENCE_STALE_S = 300.0


class BedPresence:
    """Committed per-side presence from the sleep-detector's state file."""

    def __init__(self, path: Path, reload_s: float = BED_PRESENCE_RELOAD_S,
                 stale_s: float = BED_PRESENCE_STALE_S,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time):
        self._path = path
        self._reload_s = reload_s
        self._stale_s = stale_s
        self._clock = clock
        self._wall = wall
        self._state: Optional[dict] = None
        self._loaded_at: Optional[float] = None
        self._last_problem: Optional[str] = None

    def occupied(self, side: str) -> Optional[bool]:
        """True/False per the sleep-detector, or None when unknown (no state
        file, unreadable, or stale) — callers fall back to their own signal."""
        self._maybe_reload()
        entry = self._state.get(side) if self._state is not None else None
        if not isinstance(entry, dict):
            return None
        occupied = entry.get("vitals_presence")
        evidence_ts = entry.get("vitals_evidence_ts")
        if type(occupied) is not bool or type(evidence_ts) not in (int, float):
            return None
        age = self._wall() - evidence_ts
        if not math.isfinite(age) or age < 0 or age > self._stale_s:
            return None
        return occupied

    def _maybe_reload(self) -> None:
        now = self._clock()
        if self._loaded_at is not None and now - self._loaded_at < self._reload_s:
            return
        self._loaded_at = now
        try:
            age = self._wall() - os.stat(self._path).st_mtime
            if age > self._stale_s:
                self._set(None, f"state file is {age:.0f}s old")
                return
            with open(self._path, encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError) as e:
            self._set(None, f"state file unreadable: {e}")
            return
        if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
            self._set(None, "state file has an unexpected shape")
            return
        self._set(state, None)

    def _set(self, state: Optional[dict], problem: Optional[str]) -> None:
        self._state = state
        if problem != self._last_problem:
            if problem:
                log.info("Bed presence unknown (%s); using piezo presence alone", problem)
            elif self._last_problem:
                log.info("Bed presence available again")
            self._last_problem = problem
