"""
Inner-record dialect normalization for SleepyPod biometrics modules.

Pod firmware emits two inner-record dialects depending on generation:

  - v1 (Pod 3):  `bedTemp`, `capSense` — flat scalar keys per side
                 (left/right.{out, cen, in}), integer centidegrees for
                 temperatures, integer centipercent for humidity.

  - v2 (Pod 4 / Pod 5):  `bedTemp2`, `capSense2` — nested per-side objects
                 with `temps: [...]` arrays (bedTemp2) or `values: [...]`
                 arrays (capSense2), float values in degrees C / raw units.

The outer CBOR envelope (0xa2 {seq, data}) is identical across all pods —
no envelope-level branching is needed.

Dispatch is content-driven on the inner record's `type` field. Pod_GEN
plumbing isn't required: the type tag IS the version marker (Eight Sleep
deliberately renamed v1 → v2 when the schema changed).

The canonical shape mirrors the SQLite DB row shape: scalar values per
zone (no arrays), centidegrees integers for temperatures (matching the
`bed_temp` table column types). v2 records are reduced to scalars at this
boundary; v1 records map directly.

Unknown record types pass through unchanged with a one-time warning log.
"""

import logging
from typing import Optional

log = logging.getLogger(__name__)

# Float sentinel emitted by v2 firmware when a sensor is absent.
NO_SENSOR_FLOAT = -327.68

# Integer sentinel some v1 readings use (negative absolute zero).
NO_SENSOR_INT = -32768

# Record types any biometrics module knows how to handle (or deliberately
# ignores as another module's concern). Records whose type is outside this set
# are genuinely new firmware output — surfaced once via warn_unknown_type_once
# rather than silently dropped. New Pod 5 firmware adds blanketReadings / log
# (and frzTherm, already consumed by the sleep-detector's pump-state gate),
# which is exactly what this set exists to flag.
KNOWN_RECORD_TYPES = frozenset({
    "capSense", "capSense2", "piezo-dual",
    "bedTemp", "bedTemp2",
    "frzTemp", "frzHealth", "frzTherm",
})

# Track unknown record types seen so we only log each once per process.
_unknown_types_seen: set[str] = set()

# Track distinct non-"good" capSense side statuses seen, so each is logged once.
_capsense_status_seen: set[str] = set()


def _is_sentinel_float(v) -> bool:
    if v is None:
        return True
    if not isinstance(v, (int, float)):
        return True
    return abs(v - NO_SENSOR_FLOAT) < 0.01


def _to_centidegrees(v) -> Optional[int]:
    """Convert a float-degrees value to integer centidegrees, or None on sentinel."""
    if _is_sentinel_float(v):
        return None
    return round(float(v) * 100)


def _passthrough_centi(v) -> Optional[int]:
    """v1 emits integer centidegrees natively — strip sentinels and pass through."""
    if v is None:
        return None
    if not isinstance(v, (int, float)):
        return None
    iv = int(v)
    if iv == NO_SENSOR_INT or abs(iv - NO_SENSOR_INT) < 1:
        return None
    return iv


def normalize_bed_temp(rec: dict) -> Optional[dict]:
    """
    Reduce a `bedTemp` (v1) or `bedTemp2` (v2) record to the canonical
    DB-row shape:

        {
          'ts': int,                                # unix seconds
          'ambient_temp': int | None,               # centidegrees C
          'mcu_temp': int | None,                   # centidegrees C
          'humidity': int | None,                   # centipercent
          'left_outer_temp', 'left_center_temp', 'left_inner_temp',
          'right_outer_temp', 'right_center_temp', 'right_inner_temp':
              int | None,                           # centidegrees C
        }

    Returns None if the record is not a bedTemp variant.
    """
    rtype = rec.get("type")
    ts = int(rec.get("ts", 0))

    if rtype == "bedTemp2":
        # v2: float degrees, nested temps[] arrays
        left = rec.get("left") or {}
        right = rec.get("right") or {}
        ltemps = left.get("temps") or []
        rtemps = right.get("temps") or []

        def _ambient():
            la = left.get("amb") if not _is_sentinel_float(left.get("amb")) else None
            ra = right.get("amb") if not _is_sentinel_float(right.get("amb")) else None
            return la if la is not None else ra

        def _humidity():
            lh = left.get("hu") if not _is_sentinel_float(left.get("hu")) else None
            rh = right.get("hu") if not _is_sentinel_float(right.get("hu")) else None
            return lh if lh is not None else rh

        return {
            "ts": ts,
            "ambient_temp": _to_centidegrees(_ambient()),
            "mcu_temp": _to_centidegrees(rec.get("mcu")),
            "humidity": _to_centidegrees(_humidity()),  # both percent and degrees use x100
            "left_outer_temp": _to_centidegrees(ltemps[0] if len(ltemps) > 0 else None),
            "left_center_temp": _to_centidegrees(ltemps[1] if len(ltemps) > 1 else None),
            "left_inner_temp": _to_centidegrees(ltemps[2] if len(ltemps) > 2 else None),
            "right_outer_temp": _to_centidegrees(rtemps[0] if len(rtemps) > 0 else None),
            "right_center_temp": _to_centidegrees(rtemps[1] if len(rtemps) > 1 else None),
            "right_inner_temp": _to_centidegrees(rtemps[2] if len(rtemps) > 2 else None),
        }

    if rtype == "bedTemp":
        # v1: integer centidegrees natively, flat out/cen/in per side
        left = rec.get("left") or {}
        right = rec.get("right") or {}
        return {
            "ts": ts,
            "ambient_temp": _passthrough_centi(rec.get("amb")),
            "mcu_temp": _passthrough_centi(rec.get("mcu")),
            "humidity": _passthrough_centi(rec.get("hu")),
            "left_outer_temp": _passthrough_centi(left.get("out")),
            "left_center_temp": _passthrough_centi(left.get("cen")),
            "left_inner_temp": _passthrough_centi(left.get("in")),
            "right_outer_temp": _passthrough_centi(right.get("out")),
            "right_center_temp": _passthrough_centi(right.get("cen")),
            "right_inner_temp": _passthrough_centi(right.get("in")),
        }

    return None


def is_bed_temp_record(rec: dict) -> bool:
    return rec.get("type") in ("bedTemp", "bedTemp2")


def warn_unknown_type_once(rec: dict, pod_context: str = "") -> None:
    """Log once per unique record type. Called by ingestion loops on records
    they don't recognize, to surface firmware variance instead of silently
    dropping data."""
    rtype = rec.get("type")
    if rtype is None or rtype in _unknown_types_seen:
        return
    _unknown_types_seen.add(rtype)
    suffix = f" ({pod_context})" if pod_context else ""
    log.warning("Unknown record type %r — passing through without normalization%s", rtype, suffix)


def log_capsense_status_once(rec: dict, pod_context: str = "") -> None:
    """Record (but do not gate on) capSense per-side ``status``.

    New Pod 5 firmware tags each side of a ``capSense`` record with a
    ``status`` ("good" observed; the non-good vocabulary is unknown). Design
    decision (review 2026-07-19): v1 *records but does not gate* — gating on
    unobserved states risks discarding usable data. This logs the first
    occurrence of each distinct non-good status with the channel values
    alongside, so field reports carry the evidence needed to design the future
    per-side suppression gate. It never mutates the record.
    """
    if rec.get("type") != "capSense":
        return
    for side in ("left", "right"):
        data = rec.get(side)
        if not isinstance(data, dict):
            continue
        status = data.get("status")
        if status is None or status == "good" or status in _capsense_status_seen:
            continue
        _capsense_status_seen.add(status)
        suffix = f" ({pod_context})" if pod_context else ""
        log.warning(
            "capSense %s side status=%r (out=%s cen=%s in=%s)%s",
            side, status, data.get("out"), data.get("cen"), data.get("in"), suffix,
        )
