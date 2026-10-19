"""Shared logging preferences. Reload at most once a second; never write on reads."""
import json
import logging
import os
import time
from pathlib import Path

_cache = None
_cache_path = None
_read_at = -float("inf")


def logging_mode():
    global _cache, _cache_path, _read_at
    now = time.monotonic()
    database = os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").removeprefix("file:")
    path = os.environ.get("SP_RECORDING_POLICY_FILE", str(Path(database).parent / "recording-policy.json"))
    if path != _cache_path or now - _read_at >= 1:
        try:
            policy = json.loads(Path(path).read_text())
            if not isinstance(policy, dict) or policy.get("loggingMode", "quiet") not in ("quiet", "off"):
                raise ValueError("Invalid logging mode")
            expiry = policy.get("debugUntil")
            if expiry is not None and (type(expiry) not in (int, float) or expiry < 0):
                raise ValueError("Invalid debug expiry")
            _cache = policy
        except FileNotFoundError:
            _cache = {}
        except (OSError, ValueError, TypeError):
            # If preferences are damaged, keep warning/error output available.
            _cache = {}
        _cache_path, _read_at = path, now
    until = _cache.get("debugUntil")
    if until is not None and until > time.time() * 1000:
        return "debug"
    return _cache.get("loggingMode", "quiet")


class RecordingFilter(logging.Filter):
    def filter(self, record):
        mode = logging_mode()
        return mode == "debug" or (mode == "quiet" and record.levelno >= logging.WARNING)


def install_logging_policy():
    """Install after basicConfig; discard records before handler formatting/I/O."""
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    for handler in root.handlers:
        if not any(isinstance(f, RecordingFilter) for f in handler.filters):
            handler.addFilter(RecordingFilter())
