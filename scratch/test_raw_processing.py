import sys
import os
from pathlib import Path
import numpy as np
import cbor2
import struct
import matplotlib.pyplot as plt

# Add the project root to path for imports
PROJECT_ROOT = Path("/Users/onemec/Documents/GitHub/core")
sys.path.insert(0, str(PROJECT_ROOT / "modules" / "piezo-processor"))

from main import (
    _bandpass, _autocorr_quality, PresenceDetector, _compute_autocorr, HR_BAND,
    SAMPLE_RATE, VITALS_INTERVAL_S, HR_WINDOW_S, 
    ASYMMETRIC_PUMP_RPM_MIN
)
import scipy.signal as signal

RAW_FILE = "sample_data/raw_data/00381528.RAW"

def read_raw_record(f):
    b = f.read(1)
    if not b: raise EOFError
    if b[0] != 0xa2: raise ValueError('Expected 0xa2')
    f.read(4) # seq key
    # Skip seq value
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

def process_raw():
    print(f"Processing {RAW_FILE}...")
    
    left_samples = []
    right_samples = []
    
    with open(RAW_FILE, 'rb') as f:
        try:
            while True:
                data_bytes = read_raw_record(f)
                if not data_bytes: continue
                record = cbor2.loads(data_bytes)
                if record.get('type') == 'piezo-dual':
                    l = np.frombuffer(record.get('left1', b""), dtype=np.int32)
                    r = np.frombuffer(record.get('right1', b""), dtype=np.int32)
                    left_samples.extend(l)
                    right_samples.extend(r)
        except EOFError:
            pass

    for side, full_signal in [("Left", np.array(left_samples)), ("Right", np.array(right_samples))]:
        print(f"\n--- Analysis for {side} side ---")
        duration_s = len(full_signal) / SAMPLE_RATE
        
        # Analyze in 5s windows
        window_size = int(5 * SAMPLE_RATE)
        step = window_size
        
        stds = []
        acrs = []
        
        for i in range(0, len(full_signal) - window_size + 1, step):
            chunk = full_signal[i:i + window_size]
            filt = _bandpass(chunk, 1.0, 10.0, SAMPLE_RATE)
            stds.append(np.std(filt))
            acrs.append(_autocorr_quality(chunk, SAMPLE_RATE))

        print(f"Max STD: {np.max(stds):.0f}")
        print(f"Max ACR: {np.max(acrs):.2f}")

        # HR estimation for the last 3 minutes
        last_chunk = full_signal[-int(3 * 60 * SAMPLE_RATE):]
        filtered = _bandpass(last_chunk, HR_BAND[0], HR_BAND[1], SAMPLE_RATE)
        acr = _compute_autocorr(filtered, SAMPLE_RATE)
        if acr is not None:
            min_lag = int(SAMPLE_RATE * 60 / 120)
            max_lag = int(SAMPLE_RATE * 60 / 45)
            search = acr[min_lag:max_lag + 1]
            peaks, _ = signal.find_peaks(search, height=0.01, distance=int(SAMPLE_RATE * 0.15))
            if len(peaks) > 0:
                best_lag = peaks[0] + min_lag
                hr = 60.0 * SAMPLE_RATE / best_lag
                print(f"Best HR Candidate (Last 3 min): {hr:.1f} bpm (ACR Peak: {search[peaks[0]]:.2f})")

    # Plot
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8), sharex=True)
    
    ax1.plot(times, stds, label='Signal STD')
    ax1.axhline(y=400000, color='r', linestyle='--', label='Enter Threshold')
    ax1.axhline(y=150000, color='g', linestyle='--', label='Exit Threshold')
    ax1.set_ylabel('STD')
    ax1.set_title('Presence Detection Features (Right Side)')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    
    ax2.plot(times, acrs, label='Autocorr Quality')
    ax2.axhline(y=0.45, color='r', linestyle='--', label='ACR Threshold')
    ax2.set_ylabel('ACR Quality')
    ax2.set_xlabel('Time (minutes)')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    
    plt.tight_layout()
    print(f"\nGlobal Max Stats:")
    print(f"Max STD: {np.max(stds):.0f}")
    print(f"Max ACR: {np.max(acrs):.2f}")

    # HR estimation for the last 3 minutes
    last_chunk = full_signal[-int(3 * 60 * SAMPLE_RATE):]
    
    filtered = _bandpass(last_chunk, HR_BAND[0], HR_BAND[1], SAMPLE_RATE)
    acr = _compute_autocorr(filtered, SAMPLE_RATE)
    if acr is not None:
        min_lag = int(SAMPLE_RATE * 60 / 120)
        max_lag = int(SAMPLE_RATE * 60 / 45)
        search = acr[min_lag:max_lag + 1]
        peaks, _ = signal.find_peaks(search, height=0.02, distance=int(SAMPLE_RATE * 0.15))
        if len(peaks) > 0:
            best_lag = peaks[0] + min_lag
            hr = 60.0 * SAMPLE_RATE / best_lag
            score = search[peaks[0]]
            print(f"\nBest HR Candidate (Last 3 min):")
            print(f"HR: {hr:.1f} bpm (Autocorr Peak Height: {score:.2f})")
        else:
            print("\nNo HR peaks found in autocorrelation.")

if __name__ == "__main__":
    process_raw()
