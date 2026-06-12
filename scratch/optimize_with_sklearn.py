import sys
from pathlib import Path
import numpy as np
import cbor2
import struct
from sklearn.tree import DecisionTreeClassifier
from sklearn import tree
import matplotlib.pyplot as plt

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
    
    X = []
    for i in range(0, len(full_signal) - window_size + 1, step):
        chunk = full_signal[i:i + window_size]
        filt = _bandpass(chunk, 1.0, 10.0, SAMPLE_RATE)
        std = np.std(filt)
        acr = _autocorr_quality(chunk, SAMPLE_RATE)
        X.append([std, acr])
    return np.array(X)

def optimize():
    X = extract_features()
    print(f"Feature stats: STD mean={X[:,0].mean():.0f}, max={X[:,0].max():.0f}")
    print(f"Feature stats: ACR mean={X[:,1].mean():.2f}, max={X[:,1].max():.2f}")
    
    # Create labels based on user notes:
    # "laying on right for last 3 minutes"
    # Total duration is 4.5 minutes of piezo data.
    # So the last 3 minutes are "PRESENT", first 1.5 minutes are "ABSENT"?
    # Wait, the user said "laying on right for last 3 minutes ... and 1 minute earlier".
    # Since we only have 4.5 minutes of piezo, maybe the 1 minute was the beginning?
    
    # We'll label based on our observation of the signal.
    # The signal clearly spikes at the end.
    n_windows = len(X)
    y = np.zeros(n_windows)
    
    # Last 3 minutes = 180s = 36 windows (of 5s)
    y[-36:] = 1
    
    print(f"Present Class (y=1) stats: STD mean={X[y==1, 0].mean():.0f}, ACR mean={X[y==1, 1].mean():.2f}")
    print(f"Absent Class (y=0) stats: STD mean={X[y==0, 0].mean():.0f}, ACR mean={X[y==0, 1].mean():.2f}")
    
    print(f"\nTraining DecisionTreeClassifier on {n_windows} windows...")
    clf = DecisionTreeClassifier(max_depth=2) # Depth 2 to get simple STD/ACR thresholds
    clf.fit(X, y)
    
    # Extract thresholds from the tree
    # The tree splits will be our thresholds!
    tree_rules = tree.export_text(clf, feature_names=["STD", "ACR"])
    print("\nDecision Tree Rules:")
    print(tree_rules)
    
    # Find the STD and ACR thresholds from the tree
    # Typically: if STD <= X: if ACR <= Y: ABSENT
    # So X and Y are our thresholds.
    
    # Plotting the decision boundary
    plt.figure(figsize=(10, 6))
    plt.scatter(X[y==0, 0], X[y==0, 1], label="Absent", alpha=0.5)
    plt.scatter(X[y==1, 0], X[y==1, 1], label="Present", alpha=0.5)
    plt.xlabel("Signal STD")
    plt.ylabel("ACR Quality")
    plt.title("Decision Boundary Analysis")
    plt.legend()
    plt.savefig("scratch/decision_boundary.png")
    print("\nPlot saved to scratch/decision_boundary.png")

if __name__ == "__main__":
    optimize()
