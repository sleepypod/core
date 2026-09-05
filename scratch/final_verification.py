import sys
import os
from pathlib import Path
import numpy as np
import cbor2
import struct
import pandas as pd
import matplotlib.pyplot as plt
from datetime import datetime, timezone, timedelta

# Add the project root to path for imports
PROJECT_ROOT = Path("/Users/onemec/Documents/GitHub/core")
sys.path.insert(0, str(PROJECT_ROOT / "modules" / "piezo-processor"))

import main
from main import SideProcessor, FrzHealthPumpState, SAMPLE_RATE

RAW_FILE = PROJECT_ROOT / "sample_data/raw_data/00381528.RAW"
AW_FILE = PROJECT_ROOT / "sample_data/apple_watch_april_17/heart_rate.csv"

# Global state for simulation
_simulated_now = 0.0
vitals_output = []

def mock_write_vitals(conn, side, ts, hr, hrv, br, quality_score, flags=None, hr_raw=None):
    if hr is not None:
        vitals_output.append({
            'side': side,
            'timestamp': ts,
            'heart_rate': hr,
            'quality': quality_score
        })
    return conn, True

main.write_vitals = mock_write_vitals
main.time.time = lambda: _simulated_now
main.VITALS_INTERVAL_S = 1 # High resolution for comparison

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

def run_verification():
    global _simulated_now
    print("Step 1: Running revised pipeline on RAW data...")
    
    # We need the start timestamp from the first record to ground the simulation
    start_ts_utc = None
    with open(RAW_FILE, 'rb') as f:
        try:
            while start_ts_utc is None:
                data_bytes = read_raw_record(f)
                record = cbor2.loads(data_bytes)
                if 'ts' in record:
                    start_ts_utc = record['ts']
                elif isinstance(record, dict):
                    for v in record.values():
                        if isinstance(v, dict) and 'ts' in v:
                            start_ts_utc = v['ts']
                            break
        except EOFError:
            pass
    
    if start_ts_utc is None:
        print("Error: Could not find start timestamp in RAW file.")
        return

    print(f"RAW File Start: {datetime.fromtimestamp(start_ts_utc, timezone.utc)}")
    _simulated_now = 0.0 # internal clock starts at 0

    pump_state = FrzHealthPumpState()
    left = SideProcessor("left", None, pump_state=pump_state)
    right = SideProcessor("right", None, pump_state=pump_state)
    left._other = right
    right._other = left

    with open(RAW_FILE, 'rb') as f:
        try:
            while True:
                try:
                    data_bytes = read_raw_record(f)
                    record = cbor2.loads(data_bytes)
                except (EOFError, cbor2.CBORDecodeError, cbor2.CBORDecodeEOF):
                    break
                
                rtype = record.get('type')
                if rtype == 'piezo-dual':
                    l_samples = np.frombuffer(record.get('left1', b""), dtype=np.int32)
                    r_samples = np.frombuffer(record.get('right1', b""), dtype=np.int32)
                    if l_samples.size > 0:
                        # Patch datetime.now inside _maybe_write to use simulated UTC
                        current_dt_utc = datetime.fromtimestamp(start_ts_utc + _simulated_now, timezone.utc)
                        main.datetime = type('MockDateTime', (datetime,), {
                            'now': lambda tz: current_dt_utc
                        })
                        
                        _simulated_now += len(l_samples) / SAMPLE_RATE
                        left.ingest(l_samples)
                        right.ingest(r_samples)
        except EOFError:
            pass

    if not vitals_output:
        print("Error: No vitals produced by the pipeline.")
        return

    es_df = pd.DataFrame(vitals_output)
    es_df['timestamp'] = pd.to_datetime(es_df['timestamp'])
    
    print(f"\nStep 2: Loading Apple Watch data from {AW_FILE}...")
    aw_df = pd.read_csv(AW_FILE)
    aw_df['timestamp'] = pd.to_datetime(aw_df['startDate'], utc=True)
    
    # Filter AW data to the RAW file window
    file_end_ts = datetime.fromtimestamp(start_ts_utc + _simulated_now, timezone.utc)
    aw_window = aw_df[(aw_df['timestamp'] >= datetime.fromtimestamp(start_ts_utc, timezone.utc) - timedelta(minutes=5)) & 
                      (aw_df['timestamp'] <= file_end_ts + timedelta(minutes=5))]
    
    print(f"Found {len(aw_window)} Apple Watch records in the window.")
    
    # Step 3: Alignment and Plotting
    plt.figure(figsize=(12, 6))
    
    # Filter Eight Sleep to Right side (where user was)
    right_es = es_df[es_df['side'] == 'right']
    
    plt.plot(right_es['timestamp'], right_es['heart_rate'], 'o-', label='Eight Sleep (Revised)', color='blue', alpha=0.7)
    plt.plot(aw_window['timestamp'], aw_window['value'], 'x-', label='Apple Watch (Truth)', color='red', markersize=10)
    
    plt.title("Eight Sleep (Revised) vs Apple Watch Ground Truth (April 17)")
    plt.xlabel("Time (UTC)")
    plt.ylabel("Heart Rate (bpm)")
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    # Calculate MAE
    # Align by nearest timestamp
    merged = pd.merge_asof(
        right_es.sort_values('timestamp'),
        aw_window.sort_values('timestamp'),
        on='timestamp',
        direction='nearest',
        tolerance=pd.Timedelta('2min')
    )
    merged = merged.dropna(subset=['value'])
    if not merged.empty:
        mae = np.mean(np.abs(merged['heart_rate'] - merged['value']))
        print(f"\nAlignment Success!")
        print(f"Mean Absolute Error (MAE): {mae:.1f} bpm")
        plt.text(0.05, 0.95, f"MAE: {mae:.1f} bpm", transform=plt.gca().transAxes, 
                 bbox=dict(facecolor='white', alpha=0.8))
    else:
        print("\nCould not align samples for MAE calculation.")

    plt.tight_layout()
    plt.savefig("scratch/final_comparison.png")
    print("\nComparison plot saved to scratch/final_comparison.png")

if __name__ == "__main__":
    run_verification()
