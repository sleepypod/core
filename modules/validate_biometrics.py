#!/usr/bin/env python3
"""
SleepyPod Biometrics Validator & Audit Tool.

Uses the core logic from piezo-processor, sleep-detector, and environment-monitor
to process a directory of RAW files and generate a comprehensive sleep summary.

Usage:
    uv run validate_biometrics.py <raw_data_dir>
"""

# /// script
# dependencies = [
#   "cbor2",
#   "numpy",
#   "scipy",
# ]
# ///

import os
import sys
import time
import json
import logging
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from collections import deque, defaultdict
import cbor2
import numpy as np

# Set logging level BEFORE loading modules (which might call basicConfig)
logging.basicConfig(
    level=logging.DEBUG, 
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    force=True
)
log = logging.getLogger("validator")

# Add modules dir to path so common is findable
sys.path.insert(0, str(Path(__file__).resolve().parent))

from common.cbor_raw import read_raw_record
from common.calibration import CalibrationStore, CalibrationCache, is_present_capsense_calibrated

import importlib.util

def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# Import module logic
pp = load_module("pp", Path(__file__).resolve().parent / "piezo-processor" / "main.py")
sd = load_module("sd", Path(__file__).resolve().parent / "sleep-detector" / "main.py")
em = load_module("em", Path(__file__).resolve().parent / "environment-monitor" / "main.py")

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
log = logging.getLogger("validator")

class BiometricsAuditor:
    def __init__(self, raw_dir: Path):
        self.raw_dir = raw_dir
        # Create an in-memory database for this audit
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init_db()
        
        # Initialize processors
        self.cal_store = CalibrationStore(Path("dummy.db")) 
        self.cal_cache = CalibrationCache(self.cal_store)
        
        # Lower thresholds for audit purposes
        pp.VITALS_INTERVAL_S = 10
        sd.MIN_SESSION_S = 30
        
        # Mock the CalibrationStore to return empty profiles
        self.cal_store.get_active = lambda side, type: None
        
        self.pp_left = pp.SideProcessor("left", self.db, self.cal_cache)
        self.pp_right = pp.SideProcessor("right", self.db, self.cal_cache)
        self.pp_left._other = self.pp_right
        self.pp_right._other = self.pp_left
        self.pp_pump = pp.PumpGate()
        
        self.sd_gate = sd.PumpGateCapSense()
        self.sd_left = sd.SessionTracker("left", self.db, self.cal_cache, self.sd_gate)
        self.sd_right = sd.SessionTracker("right", self.db, self.cal_cache, self.sd_gate)

        # Baseline trackers for adaptive presence in the absence of a real DB calibration
        self._baselines = {"left": None, "right": None}
        self._bs_samples = {"left": 0, "right": 0}
        
        # Diagnostic trackers
        self.flow_samples = []
        self.humidity_samples = []
        self._presence_state = {"left": {"p": False, "count": 0}, "right": {"p": False, "count": 0}}
        self.record_stats = defaultdict(lambda: {"count": 0, "keys": set(), "vals": defaultdict(list)})

    def _init_db(self):
        # Create the tables needed for the audit
        self.db.executescript("""
            CREATE TABLE vitals (
                vitals_id INTEGER PRIMARY KEY,
                side TEXT,
                timestamp INTEGER,
                heart_rate REAL,
                hrv REAL,
                breathing_rate REAL
            );
            CREATE TABLE sleep_records (
                id INTEGER PRIMARY KEY,
                side TEXT,
                entered_bed_at INTEGER,
                left_bed_at INTEGER,
                sleep_duration_seconds INTEGER,
                times_exited_bed INTEGER,
                present_intervals TEXT,
                not_present_intervals TEXT,
                created_at INTEGER
            );
            CREATE TABLE movement (
                id INTEGER PRIMARY KEY,
                side TEXT,
                timestamp INTEGER,
                total_movement INTEGER
            );
            CREATE TABLE bed_temp (
                id INTEGER PRIMARY KEY,
                timestamp INTEGER,
                ambient_temp INTEGER,
                mcu_temp INTEGER,
                humidity INTEGER,
                left_outer_temp INTEGER,
                left_center_temp INTEGER,
                left_inner_temp INTEGER,
                right_outer_temp INTEGER,
                right_center_temp INTEGER,
                right_inner_temp INTEGER
            );
            CREATE TABLE freezer_temp (
                id INTEGER PRIMARY KEY,
                timestamp INTEGER,
                ambient_temp INTEGER,
                heatsink_temp INTEGER,
                left_water_temp INTEGER,
                right_water_temp INTEGER
            );
        """)

    def run(self):
        raw_files = sorted(self.raw_dir.glob("*.RAW"))
        if not raw_files:
            log.error(f"No .RAW files found in {self.raw_dir}")
            return

        log.info(f"Auditing {len(raw_files)} files...")
        
        total_records = 0
        for raw_path in raw_files:
            with open(raw_path, "rb") as f:
                while True:
                    try:
                        data = read_raw_record(f)
                        if data is None: break
                        record = cbor2.loads(data)
                        self._process_record(record)
                        total_records += 1
                    except EOFError: break
                    except Exception as e:
                        log.debug(f"Skip corrupt record: {e}")
                        continue
        
        # Close any open sessions
        now = time.time()
        self.sd_left._close_session(now)
        self.sd_right._close_session(now)
        
        log.info(f"Processed {total_records} records.")
        self.print_summary()

    def _get_presence(self, side: str, record: dict) -> bool:
        """Adaptive presence detection for audit purposes with hysteresis."""
        data = record.get(side, {})
        if not data: return False
        
        val = sum(int(data.get(ch, 0)) for ch in ("out", "cen", "in"))
        
        # Update baseline if we are in the first 100 samples
        if self._bs_samples[side] < 100:
            if self._baselines[side] is None:
                self._baselines[side] = float(val)
            else:
                self._baselines[side] = 0.9 * self._baselines[side] + 0.1 * float(val)
            self._bs_samples[side] += 1
            return False 
        
        # If value is > baseline + 200, we see potential presence
        # Use simple hysteresis: 5 consecutive samples to change state
        is_high = val > (self._baselines[side] + 200)
        state = self._presence_state[side]
        
        if is_high != state["p"]:
            state["count"] += 1
            if state["count"] >= 5:
                state["p"] = is_high
                state["count"] = 0
        else:
            state["count"] = 0
            
        return state["p"]

    def _audit_record(self, data: dict):
        """Track statistics for a record."""
        rtype = data.get("type", "unknown")
        r = self.record_stats[rtype]
        r["count"] += 1
        for k, v in data.items():
            r["keys"].add(k)
            if isinstance(v, (int, float)): r["vals"][k].append(v)
            elif isinstance(v, dict):
                for sk, sv in v.items():
                    r["keys"].add(f"{k}.{sk}")
                    if isinstance(sv, (int, float)): r["vals"][f"{k}.{sk}"].append(sv)

    def _process_record(self, record: dict):
        rtype = record.get("type")
        ts = float(record.get("ts", 0))
        self._audit_record(record)
        
        # 1. Environment
        if rtype in ("bedTemp", "bedTemp2"):
            em.write_bed_temp(self.db, ts, record)
            # Sample humidity (V1: hu, V2: left.hu)
            hu = record.get("hu") or record.get("left", {}).get("hu")
            if hu and hu != em.NO_SENSOR:
                self.humidity_samples.append(hu)
        
        # 2. Sleep/Movement
        elif rtype in ("capSense", "capSense2"):
            # Update local presence tracker
            is_present = self._get_presence("left", record) or self._get_presence("right", record)
            
            # Use lower thresholds for audit sessions
            self.sd_left.process(ts, record)
            self.sd_right.process(ts, record)
            
            # Feed to piezo for presence gating
            self.pp_left._last_cap_record = record
            self.pp_right._last_cap_record = record
            
            # Force the trackers to see presence if our adaptive test passes
            if self._get_presence("left", record):
                self.sd_left._update(ts, True, 0.0)
                self.pp_left._presence.state = pp.PresenceDetector.PRESENT
            else:
                self.pp_left._presence.state = pp.PresenceDetector.ABSENT
                
            if self._get_presence("right", record):
                self.sd_right._update(ts, True, 0.0)
                self.pp_right._presence.state = pp.PresenceDetector.PRESENT
            else:
                self.pp_right._presence.state = pp.PresenceDetector.ABSENT
            
        elif rtype in ("frzHealth", "frzTherm", "frzTemp"):
            self.sd_gate.update_pump_state(record)
            if rtype == "frzHealth":
                rpm = record.get("rpm", 0)
                self.flow_samples.append(rpm)
            elif rtype in ("frzTherm", "frzTemp"):
                em.write_freezer_temp(self.db, ts, record)
            
        # 3. Vitals
        elif rtype == "piezo-dual":
            l_buf = record.get("left1", b"")
            r_buf = record.get("right1", b"")
            l_samples = np.frombuffer(l_buf, dtype="<i4")
            r_samples = np.frombuffer(r_buf, dtype="<i4")
            
            if not self.pp_pump.check(ts, l_samples, r_samples):
                self.pp_left.ingest(ts, l_samples)
                self.pp_right.ingest(ts, r_samples)

    def print_summary(self):
        log.info("\n" + "="*60)
        log.info(" RAW DATA SCHEMA AUDIT (GitHub Debug Info)")
        log.info("="*60)
        for rtype, r in sorted(self.record_stats.items()):
            log.info(f"\n[{rtype}] Count: {r['count']}")
            log.info(f"  Keys: {', '.join(sorted(r['keys']))}")
            # Show stats for numerical keys
            for k, vals in sorted(r["vals"].items()):
                if vals:
                    avg = sum(vals)/len(vals)
                    log.info(f"  - {k:15}: Min: {min(vals):8.1f} | Max: {max(vals):8.1f} | Avg: {avg:8.1f}")

        log.info("\n" + "="*60)
        log.info(" BIOMETRICS & SYSTEM DIAGNOSTICS")
        log.info("="*60 + "\n")

        # 1. Sleep & Presence Timeline
        sessions = self.db.execute("SELECT * FROM sleep_records ORDER BY entered_bed_at").fetchall()
        log.info(f"### [ Bed Presence Timeline ]")
        if not sessions:
            log.info("  No presence detected.")
        for s in sessions:
            start = datetime.fromtimestamp(s['entered_bed_at'], tz=timezone.utc).strftime('%H:%M:%S')
            end = datetime.fromtimestamp(s['left_bed_at'], tz=timezone.utc).strftime('%H:%M:%S')
            duration_m = s['sleep_duration_seconds'] // 60
            side_label = "LEFT " if s['side'] == 'left' else "RIGHT"
            log.info(f"  {side_label} | {start} → {end} | {duration_m:3} min | Exits: {s['times_exited_bed']}")

        # 2. Biometrics
        log.info(f"\n### [ Biometrics ]")
        for side in ("left", "right"):
            stats = self.db.execute(f"""
                SELECT AVG(heart_rate) as hr, AVG(hrv) as hrv, AVG(breathing_rate) as br
                FROM vitals WHERE side = ? AND heart_rate IS NOT NULL AND heart_rate > 0
            """, (side,)).fetchone()
            
            if stats and stats['hr']:
                log.info(f"  {side.upper():5} | HR: {stats['hr']:5.1f} bpm | HRV: {stats['hrv']:5.1f} ms | BR: {stats['br']:4.1f} br/min")
            else:
                log.info(f"  {side.upper():5} | No vitals recorded.")

        # 3. Environment & Temperature Trends
        log.info(f"\n### [ Environmental Trends ]")
        env_stats = self.db.execute("""
            SELECT 
                AVG(ambient_temp)/100.0 as avg_amb, MAX(ambient_temp)/100.0 as max_amb,
                AVG(mcu_temp)/100.0 as avg_mcu, MAX(mcu_temp)/100.0 as max_mcu
            FROM bed_temp
        """).fetchone()
        
        frz_stats = self.db.execute("""
            SELECT 
                AVG(left_water_temp)/100.0 as lw, AVG(right_water_temp)/100.0 as rw,
                AVG(heatsink_temp)/100.0 as hs
            FROM freezer_temp
        """).fetchone()

        avg_hu = np.mean(self.humidity_samples) / 100.0 if self.humidity_samples else 0.0
        avg_rpm = np.mean(self.flow_samples) if self.flow_samples else 0.0
        flow_status = "ACTIVE" if avg_rpm > 500 else "IDLE"

        if env_stats and env_stats['avg_amb']:
            hs_val = frz_stats['hs'] if (frz_stats and frz_stats['hs'] is not None) else 0.0
            lw_val = frz_stats['lw'] if (frz_stats and frz_stats['lw'] is not None) else 0.0
            rw_val = frz_stats['rw'] if (frz_stats and frz_stats['rw'] is not None) else 0.0
            
            log.info(f"  Ambient: {env_stats['avg_amb']:.1f}°C (Peak: {env_stats['max_amb']:.1f}°C) | Humidity: {avg_hu:.1f}%")
            log.info(f"  System:  MCU {env_stats['avg_mcu']:.1f}°C | Heatsink {hs_val:.1f}°C")
            log.info(f"  Water:   Left {lw_val:.1f}°C | Right {rw_val:.1f}°C")
            log.info(f"  Flow:    {flow_status} (Pump RPM: {avg_rpm:.0f})")

        # 4. Sensor Matrix (2x3 Bed Surface)
        log.info(f"\n### [ Bed Sensor Matrix ]")
        m = self.db.execute("""
            SELECT 
                AVG(left_outer_temp)/100.0 as lo, AVG(left_center_temp)/100.0 as lc, AVG(left_inner_temp)/100.0 as li,
                AVG(right_outer_temp)/100.0 as ro, AVG(right_center_temp)/100.0 as rc, AVG(right_inner_temp)/100.0 as ri
            FROM bed_temp
        """).fetchone()
        
        if m and m['lo']:
            log.info("      [ OUTER ]   [ CENTER ]   [ INNER ]")
            log.info(f"  L:   {m['lo']:5.1f}°C     {m['lc']:5.1f}°C     {m['li']:5.1f}°C")
            log.info(f"  R:   {m['ro']:5.1f}°C     {m['rc']:5.1f}°C     {m['ri']:5.1f}°C")
        else:
            log.info("  No matrix data available.")

        log.info("\n" + "="*50)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: uv run validate_biometrics.py <raw_data_dir>")
        sys.exit(1)
    
    # Simple hack to allow imports - redirect module files to act as packages
    # We rename the main files temporarily in memory or just import them
    # But since they are named 'main.py' in different folders, we handle it carefully.
    
    # Create the auditor and run
    path = Path(sys.argv[1])
    auditor = BiometricsAuditor(path)
    auditor.run()
