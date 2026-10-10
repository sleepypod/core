#!/usr/bin/env python3
"""
Repair sleep_records that the sleep-detector force-closed at its 16 h cap.

A stuck presence signal held sessions open on an empty bed until
MAX_SESSION_S (57600 s), so their left_bed_at, duration and intervals run up
to 16 h past the real exit. This rewrites each capped record's end from the
vitals already in biometrics.db, deterministically:

  - Occupancy evidence is the side's vitals rows inside the record. Movement
    rows are not evidence: the detector writes one every minute for as long
    as a session is open, empty bed included, so they run to the cap.
  - The piezo processor writes about one vitals row a minute while someone
    is in bed, and also short low-signal bursts on an empty bed (pod 88:
    a 22-minute run 35 minutes after the bed emptied). So the vitals are
    split into runs at gaps over VITALS_GAP_S, and the occupant left at the
    end of the last run lasting at least MIN_RUN_S.
  - left_bed_at = that end + ABSENCE_TIMEOUT_S (the detector's own exit
    delay), never later than the original. Duration is recomputed, intervals
    are clipped to the new end, and the final exit is counted as the
    detector counts it on a natural close.
  - Records with no qualifying run are left unchanged and listed.

Dry run by default. --apply first writes a consistent copy of the database to
<db>.bak.<epoch> (SQLite backup API, safe alongside the running services),
then updates all repairable records in one transaction. Re-running finds
nothing: repaired records are no longer exactly MAX_SESSION_S long.

Usage:
  scripts/repair-capped-sessions.py [--db PATH]           # dry run
  scripts/repair-capped-sessions.py [--db PATH] --apply
"""

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

# Mirrors modules/sleep-detector/main.py.
MAX_SESSION_S = 16 * 3600
ABSENCE_TIMEOUT_S = 120
MIN_SESSION_S = 300
# Vitals gaps longer than this split runs; runs shorter than MIN_RUN_S are
# empty-bed noise.
VITALS_GAP_S = 5 * 60
MIN_RUN_S = 30 * 60

DEFAULT_DB = os.environ.get(
    "BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db"
).replace("file:", "")


def occupancy_end(vitals_ts):
    """End of the last vitals run lasting at least MIN_RUN_S, or None."""
    end = None
    run_start = prev = None
    for ts in vitals_ts:
        if prev is None or ts - prev > VITALS_GAP_S:
            run_start = ts
        prev = ts
        if ts - run_start >= MIN_RUN_S:
            end = ts
    return end


def clip_intervals(raw, end):
    """Intervals clipped to `end`; ones starting at or after it are dropped."""
    try:
        intervals = json.loads(raw) if raw else []
    except ValueError:
        return raw
    out = []
    for iv in intervals:
        if not isinstance(iv, list) or len(iv) != 2:
            continue
        start, stop = iv
        if start >= end:
            continue
        out.append([start, min(stop, end)])
    return json.dumps(out)


def plan(conn):
    rows = conn.execute(
        """SELECT id, side, entered_bed_at, left_bed_at, times_exited_bed,
                  present_intervals, not_present_intervals
           FROM sleep_records WHERE sleep_duration_seconds = ? ORDER BY id""",
        (MAX_SESSION_S,),
    ).fetchall()
    out = []
    for rid, side, entered, left, exits, present, absent in rows:
        vitals = [r[0] for r in conn.execute(
            "SELECT timestamp FROM vitals WHERE side = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp",
            (side, entered, left),
        )]
        end = occupancy_end(vitals)
        item = {"id": rid, "side": side, "entered": entered, "left": left,
                "vitals": len(vitals), "last_vitals": vitals[-1] if vitals else None}
        if end is None:
            item["action"] = "no-evidence"
        else:
            new_left = min(left, end + ABSENCE_TIMEOUT_S)
            if new_left >= left:
                item["action"] = "keep"
            elif new_left - entered < MIN_SESSION_S:
                item["action"] = "too-short"
                item["new_left"] = new_left
            else:
                item.update(action="repair", new_left=new_left,
                            new_duration=new_left - entered,
                            new_exits=exits + 1,
                            present=clip_intervals(present, new_left),
                            absent=clip_intervals(absent, new_left))
        out.append(item)
    return out


def fmt(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def report(items, verbose):
    by = {}
    for it in items:
        by.setdefault(it["action"], []).append(it)
    repaired = by.get("repair", [])
    removed_h = sum(it["left"] - it["new_left"] for it in repaired) / 3600
    if verbose:
        print(f"{'id':>5} {'side':5} {'entered (UTC)':16}  {'left (UTC)':16}  {'new left':16}  {'vitals':>6}  action")
        for it in items:
            new = fmt(it["new_left"]) if "new_left" in it else "-"
            print(f"{it['id']:>5} {it['side']:5} {fmt(it['entered'])}  {fmt(it['left'])}  {new:16}  "
                  f"{it['vitals']:>6}  {it['action']}")
        print()
    print(f"capped records (sleep_duration_seconds = {MAX_SESSION_S}): {len(items)}")
    print(f"  repair:      {len(repaired)}  ({removed_h:.1f} h of empty-bed padding removed)")
    if repaired:
        hours = sorted((it["new_duration"]) / 3600 for it in repaired)
        print(f"               new durations {hours[0]:.1f}-{hours[-1]:.1f} h, "
              f"median {hours[len(hours) // 2]:.1f} h")
    print(f"  keep:        {len(by.get('keep', []))}  (vitals run to the cap)")
    print(f"  too-short:   {len(by.get('too-short', []))}  (occupancy under {MIN_SESSION_S}s; left unchanged)")
    print(f"  no-evidence: {len(by.get('no-evidence', []))}  (no vitals run of {MIN_RUN_S // 60}+ min; left unchanged)")


def apply(db_path, conn, items):
    repaired = [it for it in items if it["action"] == "repair"]
    if not repaired:
        print("nothing to apply")
        return
    backup_path = f"{db_path}.bak.{int(time.time())}"
    dst = sqlite3.connect(backup_path)
    try:
        conn.backup(dst)
    finally:
        dst.close()
    print(f"backup written: {backup_path}")
    with conn:
        for it in repaired:
            cur = conn.execute(
                """UPDATE sleep_records
                   SET left_bed_at = ?, sleep_duration_seconds = ?, times_exited_bed = ?,
                       present_intervals = ?, not_present_intervals = ?
                   WHERE id = ? AND sleep_duration_seconds = ? AND left_bed_at = ?""",
                (it["new_left"], it["new_duration"], it["new_exits"],
                 it["present"], it["absent"], it["id"], MAX_SESSION_S, it["left"]),
            )
            if cur.rowcount != 1:
                raise RuntimeError(f"record {it['id']} changed underneath the repair; rolled back")
    print(f"applied: {len(repaired)} records updated")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=DEFAULT_DB, help=f"biometrics.db path (default {DEFAULT_DB})")
    ap.add_argument("--apply", action="store_true", help="write a .bak, then update the records")
    ap.add_argument("-v", "--verbose", action="store_true", help="list every capped record")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        sys.exit(f"no database at {args.db}")
    conn = sqlite3.connect(args.db, timeout=10.0)
    conn.execute("PRAGMA busy_timeout=10000")
    try:
        items = plan(conn)
        report(items, args.verbose)
        if args.apply:
            apply(args.db, conn, items)
        else:
            print("\ndry run: nothing written (pass --apply to repair)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
