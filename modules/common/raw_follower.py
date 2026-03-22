"""
Shared RAW file follower for SleepyPod biometrics modules.

Tails the newest .RAW file in a directory, yielding decoded CBOR records
as they are appended by the hardware daemon.
"""

import time
import logging
from pathlib import Path
from typing import Optional

import cbor2

from common.cbor_raw import read_raw_record

log = logging.getLogger(__name__)

MAX_CONSECUTIVE_FAILURES = 5


def _safe_mtime(p: Path) -> float:
    """Return mtime, or 0.0 if the file was deleted between glob and stat."""
    try:
        return p.stat().st_mtime
    except FileNotFoundError:
        return 0.0


class RawFileFollower:
    """Follow the newest .RAW file, yielding decoded CBOR records.

    Args:
        data_dir: Directory containing .RAW files.
        shutdown_event: A threading.Event that signals shutdown.
        poll_interval: Seconds to sleep when no new data is available.
    """

    def __init__(self, data_dir: Path, shutdown_event, poll_interval: float = 0.01):
        self.data_dir = data_dir
        self._shutdown = shutdown_event
        self._poll_interval = poll_interval
        self._file = None
        self._path = None
        self._last_pos = 0
        self._consecutive_failures = 0

    def _find_latest(self) -> Optional[Path]:
        candidates = [p for p in self.data_dir.glob("*.RAW")
                      if p.name != "SEQNO.RAW" and _safe_mtime(p) > 0]
        candidates.sort(key=_safe_mtime, reverse=True)
        return candidates[0] if candidates else None

    def read_records(self):
        """Yield decoded CBOR records as they arrive, sleeping between poll attempts."""
        while not self._shutdown.is_set():
            latest = self._find_latest()
            if latest is None:
                time.sleep(1)
                continue

            if latest != self._path:
                log.info("Switched to RAW file: %s", latest.name)
                if self._file:
                    self._file.close()
                self._file = open(latest, "rb")
                self._path = latest
                self._last_pos = 0
                self._consecutive_failures = 0

            try:
                data_bytes = read_raw_record(self._file)
                if data_bytes is None:
                    self._last_pos = self._file.tell()
                    self._consecutive_failures = 0
                    continue  # empty placeholder record
                inner = cbor2.loads(data_bytes)
                self._last_pos = self._file.tell()
                self._consecutive_failures = 0
                yield inner
            except (ValueError, cbor2.CBORDecodeError, OSError) as e:
                self._consecutive_failures += 1
                if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    log.warning("Skipping past corrupt data at offset %d after %d failures: %s",
                                self._last_pos, self._consecutive_failures, e)
                    self._last_pos += 1
                    self._consecutive_failures = 0
                else:
                    log.debug("Error reading RAW record (attempt %d): %s",
                              self._consecutive_failures, e)
                self._file.seek(self._last_pos)
                time.sleep(0.1)
            except EOFError:
                self._file.seek(self._last_pos)
                self._consecutive_failures = 0
                time.sleep(self._poll_interval)

        # Clean up file handle on shutdown
        if self._file:
            self._file.close()
            self._file = None
