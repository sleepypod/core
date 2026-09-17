import sys
import os
import cbor2
import struct
from datetime import datetime, timezone

RAW_FILE = "sample_data/raw_data/00381528.RAW"

def read_raw_record(f):
    b = f.read(1)
    if not b: raise EOFError
    if b[0] != 0xa2: raise ValueError('Expected 0xa2')
    f.read(4) # seq key
    
    # seq value
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

def check_ts():
    print(f"Checking for timestamps in {RAW_FILE}...")
    with open(RAW_FILE, 'rb') as f:
        try:
            for _ in range(3000): # Check all records
                data_bytes = read_raw_record(f)
                if not data_bytes: continue
                record = cbor2.loads(data_bytes)
                if 'ts' in record or 'timestamp' in record:
                    ts = record.get('ts') or record.get('timestamp')
                    print(f"Found timestamp: {ts} ({datetime.fromtimestamp(ts, timezone.utc)})")
                    return
                # Check for nested keys
                if isinstance(record, dict):
                    for k, v in record.items():
                        if isinstance(v, dict) and ('ts' in v or 'timestamp' in v):
                             ts = v.get('ts') or v.get('timestamp')
                             print(f"Found nested timestamp in {k}: {ts}")
                             return
        except EOFError:
            pass
    print("No timestamps found in records.")

if __name__ == "__main__":
    check_ts()
