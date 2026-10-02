"""
Single-sleeper mode, shared by the sleep-detector and piezo-processor.

Exactly one side in away mode (side_settings.away_mode in sleepypod.db) means
one person sleeps in the bed, on the other ("home") side. A solo sleeper who
rolls over or stretches a leg onto the empty side loads that side's sensors
too — its capSense level rises and its piezo picks up the same heartbeat —
which used to open phantom sessions on the empty side, with a heart rate
matching the sleeper's.
In this mode the away side's readings are merged into the home side instead.

Both sides away, or neither, is ordinary per-side operation.
"""

import logging
import sqlite3
import time
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("side_mode")

SIDES = ("left", "right")
# How often side_settings is re-read (seconds). Away mode is toggled by a
# person or a scheduled away window, so a minute's lag is harmless.
SIDE_MODE_RELOAD_S = 60


def other_side(side: str) -> str:
    return "right" if side == "left" else "left"


def home_side_for(away: dict) -> Optional[str]:
    """The single sleeper's side, or None unless exactly one side is away."""
    left_away = bool(away.get("left"))
    right_away = bool(away.get("right"))
    if left_away == right_away:
        return None
    return "right" if left_away else "left"


class SingleSleeperMode:
    """Periodically reads side_settings.away_mode (read-only) and reports the
    single sleeper's home side. A failed read keeps the last known mode."""

    def __init__(self, db_path: Path, reload_s: float = SIDE_MODE_RELOAD_S,
                 clock: Callable[[], float] = time.monotonic):
        self._db_path = db_path
        self._reload_s = reload_s
        self._clock = clock
        self._last_read: Optional[float] = None
        self._home: Optional[str] = None

    def home_side(self) -> Optional[str]:
        now = self._clock()
        if self._last_read is None or now - self._last_read >= self._reload_s:
            self._last_read = now
            self._refresh()
        return self._home

    def _refresh(self) -> None:
        try:
            conn = sqlite3.connect(f"file:{self._db_path}?mode=ro", uri=True, timeout=2.0)
            try:
                rows = conn.execute("SELECT side, away_mode FROM side_settings").fetchall()
            finally:
                conn.close()
        except sqlite3.Error as e:
            log.warning("Could not read side_settings (keeping %s): %s",
                        self._describe(self._home), e)
            return
        home = home_side_for({side: away for side, away in rows})
        if home != self._home:
            log.info("Bed mode: %s", self._describe(home))
        self._home = home

    @staticmethod
    def _describe(home: Optional[str]) -> str:
        if home is None:
            return "per-side"
        return f"single sleeper on {home} ({other_side(home)} away, merged into {home})"
