"""
Shared CBOR record reader for SleepyPod biometrics modules.

The cbor2 C extension (_cbor2) reads files in internal 4096-byte chunks,
so cbor2.load(f) advances f.tell() by 4096 bytes regardless of the actual
record size. Since RAW file records are typically 17-5000 bytes, this causes
nearly every record to be skipped silently.

This module provides a manual parser for the outer {seq, data} CBOR wrapper
that reads byte-by-byte using f.read(), keeping f.tell() accurate.

See: https://github.com/throwaway31265/free-sleep/pull/46
"""

import struct


def read_raw_record(f):
    """Parse one outer {seq, data} CBOR record from file object *f*.

    Returns the raw inner data bytes, or ``None`` for empty placeholder
    records (Pod firmware writes ``data=b''`` as sequence-number markers).

    Raises:
        EOFError: End of file (no more data to read).
        ValueError: Malformed CBOR structure.
    """
    b = f.read(1)
    if not b:
        raise EOFError
    if b[0] != 0xa2:
        raise ValueError('Expected outer map 0xa2, got 0x%02x' % b[0])

    # "seq" key — text(3) "seq"
    if f.read(4) != b'\x63\x73\x65\x71':
        raise ValueError('Expected seq key')

    # seq value — uint32 (0x1a) or uint64 (0x1b)
    hdr = f.read(1)
    if not hdr:
        raise EOFError
    if hdr[0] == 0x1a:
        seq_bytes = f.read(4)
        if len(seq_bytes) < 4:
            raise EOFError
    elif hdr[0] == 0x1b:
        seq_bytes = f.read(8)
        if len(seq_bytes) < 8:
            raise EOFError
    else:
        raise ValueError('Unexpected seq encoding: 0x%02x' % hdr[0])

    # "data" key — text(4) "data"
    if f.read(5) != b'\x64\x64\x61\x74\x61':
        raise ValueError('Expected data key')

    # data value — byte string length
    bs = f.read(1)
    if not bs:
        raise EOFError
    ai = bs[0] & 0x1f
    if ai <= 23:
        length = ai
    elif ai == 24:
        lb = f.read(1)
        if not lb:
            raise EOFError
        length = lb[0]
    elif ai == 25:
        lb = f.read(2)
        if len(lb) < 2:
            raise EOFError
        length = struct.unpack('>H', lb)[0]
    elif ai == 26:
        lb = f.read(4)
        if len(lb) < 4:
            raise EOFError
        length = struct.unpack('>I', lb)[0]
    else:
        raise ValueError('Unsupported length encoding: %d' % ai)

    data = f.read(length)
    if len(data) < length:
        raise EOFError
    if not data:
        return None  # empty placeholder record, caller should skip
    return data
