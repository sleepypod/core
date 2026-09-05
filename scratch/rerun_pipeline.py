import sys
import os
from pathlib import Path
import numpy as np
import cbor2
import struct
import pandas as pd
from datetime import datetime, timezone

# Add the project root to path for imports
PROJECT_ROOT = Path("/Users/onemec/Documents/GitHub/core")
sys.path.insert(0, str(PROJECT_ROOT / "modules" / "piezo-processor"))

import main
from main import (
    SideProcessor, FrzHealthPumpState, SAMPLE_RATE
)

RAW_FILE = PROJECT_ROOT / "sample_data/raw_data/00381528.RAW"

_simulated_now = 0.0

# Mock the database write
def mock_write_vitals(conn, side, ts, hr, hrv, br, quality_score, flags=None, hr_raw=None):
    hr_str = f"{hr:5.1f}" if hr is not None else "  N/A"
    br_str = f"{br:5.1f}" if br is not None else "  N/A"
    rel_time = f"{_simulated_now/60:5.2f}m"
    print(f"[{rel_time}] {side:5} | VITALS | HR: {hr_str} | RR: {br_str} | Qual: {quality_score:.2f}")
    return conn, True

# Patch the write_vitals function in the main module
main.write_vitals = mock_write_vitals

# Patch time.time in main module
def mock_time():
    return _simulated_now
main.time.time = mock_time
main.VITALS_INTERVAL_S = 1

def read_raw_record(f):
    b = f.read(1)
    if not b: raise EOFError
    if b[0] != 0xa2: raise ValueError('Expected 0xa2')
    f.read(4) # seq key
    hdr = f.read(1)
    ai = hdr[0] & 0x1f
    if ai == 24: f.read(1)
    elif ai == 25: f.read(2)
    elif ai == 26: f.read(4)
    elif ai == 27: f.read(8)
    f.read(5) # data key
    bs = f.read(1)
    ai = bs[0] & 0x1f
    if ai <= 23: length = ai
    elif ai == 24: length = f.read(1)[0]
    elif ai == 25: length = struct.unpack('>H', f.read(2))[0]
    elif ai == 26: length = struct.unpack('>I', f.read(4))[0]
    elif ai == 27: length = struct.unpack('>Q', f.read(8))[0]
    data = f.read(length)
    return data

def rerun():
    global _simulated_now
    print(f"Re-running pipeline for {RAW_FILE}...")
    print("Rel Time | Side  | Event  | Heart Rate | Resp Rate | Quality")
    print("-" * 70)

    pump_state = FrzHealthPumpState()
    left = SideProcessor("left", None, pump_state=pump_state)
    right = SideProcessor("right", None, pump_state=pump_state)
    left._other = right
    right._other = left

    _orig_presence_update = main.PresenceDetector.update
    def make_patched_update(side):
        def patched_update(self, window_std, acr_qual):
            old_state = self.state
            res = _orig_presence_update(self, window_std, acr_qual)
            # Log every window for the side we care about
            if side == "right" and window_std > 50000:
                rel_time = f"{_simulated_now/60:5.2f}m"
                state_str = "PRESENT" if self.state == 1 else "ABSENT"
                print(f"[{rel_time}] {side:5} | Window | {state_str} (STD: {window_std/1000:3.0f}k, ACR: {acr_qual:.2f})")
            elif self.state != old_state:
                rel_time = f"{_simulated_now/60:5.2f}m"
                state_str = "PRESENT" if self.state == 1 else "ABSENT"
                print(f"[{rel_time}] {side:5} | STATE  | {state_str} (STD: {window_std/1000:3.0f}k, ACR: {acr_qual:.2f})")
            return res
        return patched_update

    left._presence.update = make_patched_update("left").__get__(left._presence, main.PresenceDetector)
    right._presence.update = make_patched_update("right").__get__(right._presence, main.PresenceDetector)

    record_count = 0
    with open(RAW_FILE, 'rb') as f:
        try:
            while True:
                data_bytes = read_raw_record(f)
                if not data_bytes: continue
                record_count += 1
                record = cbor2.loads(data_bytes)
                rtype = record.get('type')
                
                if record_count % 500 == 0:
                    print(f"Processed {record_count} records... (type: {rtype})")
                
                if rtype == 'frzHealth':
                    pump_state.update(record)
                elif rtype == 'piezo-dual':
                    l_samples = np.frombuffer(record.get('left1', b""), dtype=np.int32)
                    r_samples = np.frombuffer(record.get('right1', b""), dtype=np.int32)
                    
                    if l_samples.size > 0:
                        _simulated_now += len(l_samples) / SAMPLE_RATE
                        left.ingest(l_samples)
                        right.ingest(r_samples)
        except EOFError:
            pass

if __name__ == "__main__":
    rerun()
