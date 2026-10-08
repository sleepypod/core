"""Active sleepers, independent of physical temperature zones.

Permanent solo setup and temporary away status share sensor attribution.
Keep active_sides_for aligned with src/lib/singleSleeper.ts.
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


def active_sides_for(away: dict, bed_mode: str = "two") -> tuple:
    configured = ("left",) if bed_mode == "solo-left" else ("right",) if bed_mode == "solo-right" else SIDES
    return tuple(side for side in configured if not away.get(side))


def home_side_for(away: dict, bed_mode: str = "two") -> Optional[str]:
    active = active_sides_for(away, bed_mode)
    return active[0] if len(active) == 1 else None


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
        self._active = SIDES

    def home_side(self) -> Optional[str]:
        now = self._clock()
        if self._last_read is None or now - self._last_read >= self._reload_s:
            self._last_read = now
            self._refresh()
        return self._home

    def active_sides(self) -> tuple:
        self.home_side()
        return self._active

    def _refresh(self) -> None:
        try:
            conn = sqlite3.connect(f"file:{self._db_path}?mode=ro", uri=True, timeout=2.0)
            try:
                rows = conn.execute("SELECT side, away_mode FROM side_settings").fetchall()
                # Older core versions do not have bed_mode yet. Only schema absence
                # falls back; lock/I/O failures keep the last complete mode.
                tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='device_settings'").fetchall()
                columns = conn.execute("PRAGMA table_info(device_settings)").fetchall() if tables else []
                bed_mode = "two"
                if any(column[1] == "bed_mode" for column in columns):
                    config = conn.execute("SELECT bed_mode FROM device_settings WHERE id=1").fetchone()
                    if config:
                        bed_mode = config[0]
            finally:
                conn.close()
        except sqlite3.Error as e:
            log.warning("Could not read side_settings (keeping %s): %s",
                        self._describe(self._home), e)
            return
        away = dict(rows)
        self._active = active_sides_for(away, bed_mode)
        home = home_side_for(away, bed_mode)
        if home != self._home:
            log.info("Bed mode: %s", self._describe(home))
        self._home = home

    @staticmethod
    def _describe(home: Optional[str]) -> str:
        if home is None:
            return "per-side"
        return f"single sleeper on {home} (both sensor zones merged into {home})"
