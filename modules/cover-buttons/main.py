#!/usr/bin/env python3
"""
SleepyPod cover-buttons module.

Tails /persistent/*.RAW for `buttonEvent` CBOR records emitted by the TTC
cover (top/middle/bottom buttons on each side) and logs each press to the
systemd journal. Pure observability — no DB writes, no action dispatch.

Wire schema (sparse — only sides/buttons that fired are present):

    { "type": "buttonEvent", "ts": 1777357840,
      "left":  { "top": 1, "bottom": 1 },
      "right": { "top": 1 } }
"""

import os
import sys
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.raw_follower import RawFileFollower

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))

VALID_SIDES = ("left", "right")
VALID_BUTTONS = ("top", "middle", "bottom")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [cover-buttons] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown handling
# ---------------------------------------------------------------------------

_shutdown = threading.Event()

def _on_signal(signum, frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()

signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def report_health(status: str, message: str) -> None:
    """Write module health to sleepypod.db system_health table."""
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('cover-buttons', ?, ?, ?)
                       ON CONFLICT(component) DO UPDATE SET
                         status=excluded.status,
                         message=excluded.message,
                         last_checked=excluded.last_checked""",
                    (status, message, int(time.time())),
                )
        finally:
            conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Press extraction
# ---------------------------------------------------------------------------

def iter_presses(record):
    """Yield (side, button, count, ts) tuples from a buttonEvent record.

    Skips malformed records (non-dict side payloads, unknown button keys)
    without raising. Non-buttonEvent records yield nothing.
    """
    if record.get("type") != "buttonEvent":
        return
    ts = record.get("ts")
    for side in VALID_SIDES:
        side_payload = record.get(side)
        if side_payload is None:
            continue
        if not isinstance(side_payload, dict):
            log.debug("schema mismatch: %s payload is %s, not dict",
                      side, type(side_payload).__name__)
            continue
        for button, count in side_payload.items():
            if button not in VALID_BUTTONS:
                log.debug("schema mismatch: unknown button key %r on %s",
                          button, side)
                continue
            try:
                count_int = int(count)
            except (TypeError, ValueError):
                log.debug("schema mismatch: non-integer count %r for %s.%s",
                          count, side, button)
                continue
            if count_int <= 0:
                continue
            yield side, button, count_int, ts

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    log.info("Starting cover-buttons (raw_dir=%s)", RAW_DATA_DIR)

    follower = RawFileFollower(RAW_DATA_DIR, _shutdown, poll_interval=0.1)

    report_health("healthy", "cover-buttons started")

    try:
        for record in follower.read_records():
            if record.get("type") != "buttonEvent":
                continue
            for side, button, count, ts in iter_presses(record):
                for _ in range(count):
                    log.info("press: side=%s button=%s count=1 ts=%s",
                             side, button, ts)

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        log.info("Shutdown complete")

    report_health("down", "cover-buttons stopped")


if __name__ == "__main__":
    main()
