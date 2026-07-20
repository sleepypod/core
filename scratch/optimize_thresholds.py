import sys
from pathlib import Path
import numpy as np
import cbor2
import struct
# No matplotlib needed here

# Add the project root to path for imports
PROJECT_ROOT = Path("/Users/onemec/Documents/GitHub/core")
sys.path.insert(0, str(PROJECT_ROOT / "modules" / "piezo-processor"))

from main import _bandpass, _autocorr_quality, SAMPLE_RATE

RAW_FILE = PROJECT_ROOT / "sample_data/raw_data/00381528.RAW"

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

def extract_features():
    print(f"Extracting features from {RAW_FILE}...")
    right_samples = []
    with open(RAW_FILE, 'rb') as f:
        try:
            while True:
                data_bytes = read_raw_record(f)
                if not data_bytes: continue
                record = cbor2.loads(data_bytes)
                if record.get('type') == 'piezo-dual':
                    r = np.frombuffer(record.get('right1', b""), dtype=np.int32)
                    right_samples.extend(r)
        except EOFError:
            pass
    
    full_signal = np.array(right_samples)
    window_size = int(5 * SAMPLE_RATE)
    step = window_size
    
    features = []
    for i in range(0, len(full_signal) - window_size + 1, step):
        chunk = full_signal[i:i + window_size]
        filt = _bandpass(chunk, 1.0, 10.0, SAMPLE_RATE)
        std = np.std(filt)
        acr = _autocorr_quality(chunk, SAMPLE_RATE)
        features.append((std, acr))
    return features

def grid_search(features):
    print("\nRunning Grid Search for Optimal Thresholds...")
    print("Goal: Capture the ~4 minutes of user activity while remaining sensitive.")
    
    # Range of thresholds to test
    std_range = np.linspace(100000, 500000, 20)
    acr_range = np.linspace(0.1, 0.5, 20)
    
    best_config = None
    target_minutes = 4.0
    min_diff = float('inf')
    
    results = []
    
    for std_thresh in std_range:
        for acr_thresh in acr_range:
            # Simulate PresenceDetector logic
            detected_windows = 0
            is_present = False
            consecutive_low = 0
            
            for std, acr in features:
                if not is_present:
                    if std > std_thresh or acr > acr_thresh:
                        is_present = True
                        detected_windows += 1
                else:
                    if std < (std_thresh * 0.5) and acr < acr_thresh:
                        consecutive_low += 1
                        if consecutive_low >= 3:
                            is_present = False
                            consecutive_low = 0
                    else:
                        consecutive_low = 0
                        detected_windows += 1
            
            detected_minutes = (detected_windows * 5) / 60
            diff = abs(detected_minutes - target_minutes)
            results.append((std_thresh, acr_thresh, detected_minutes))
            
            if diff < min_diff:
                min_diff = diff
                best_config = (std_thresh, acr_thresh, detected_minutes)

    print("-" * 50)
    print(f"Best Configuration Found:")
    print(f"STD Threshold: {best_config[0]:.0f}")
    print(f"ACR Threshold: {best_config[1]:.2f}")
    print(f"Detected Time: {best_config[2]:.2f} minutes")
    print("-" * 50)

if __name__ == "__main__":
    features = extract_features()
    grid_search(features)
