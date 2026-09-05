import cbor2
import sys
from datetime import datetime, timezone

RAW_FILE = "sample_data/raw_data/00381528.RAW"

def peek_raw():
    print(f"Peeking at {RAW_FILE}...")
    count = 0
    with open(RAW_FILE, 'rb') as f:
        try:
            # CBOR file contains multiple records
            while True:
                record = cbor2.load(f)
                count += 1
                if count == 1:
                    ts = record.get('timestamp', record.get('ts', 'N/A'))
                    dt = datetime.fromtimestamp(ts, tz=timezone.utc) if isinstance(ts, (int, float)) else ts
                    print(f"First record TS: {ts} ({dt})")
                    print(f"Keys: {list(record.keys())}")
                
                # Periodically print progress
                if count % 1000 == 0:
                    pass
        except EOFError:
            pass
        except Exception as e:
            print(f"Error reading: {e}")
    
    print(f"Total records: {count}")

if __name__ == "__main__":
    peek_raw()
