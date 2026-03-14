"""
Shared CBOR record reader for SleepyPod biometrics modules.

The cbor2 C extension (_cbor2) reads files in internal 4096-byte chunks,
so cbor2.load(f) advances f.tell() by 4096 bytes regardless of the actual
record size. Since RAW file records are typically 17-5000 bytes, this causes
nearly every record to be skipped silently.

This module provides a manual parser for the outer {seq, data} CBOR wrapper
that reads byte-by-byte using f.read(), keeping f.tell() accurate.

Protocol contract: Pod firmware always emits the outer map with keys in the
order "seq" then "data". The seq value is encoded as a fixed-width uint32
(0x1a) by the embedded CBOR encoder, regardless of value. This parser
validates that contract and raises ValueError on deviation.

See: https://github.com/throwaway31265/free-sleep/pull/46
"""

import struct

# Reject implausibly large data payloads (corrupt length field protection)
_MAX_DATA_LENGTH = 1_000_000


def read_raw_record(f):
    """Parse one outer {seq, data} CBOR record from file object *f*.

    Returns the raw inner data bytes, or ``None`` for empty placeholder
    records (Pod firmware writes ``data=b''`` as sequence-number markers).

    Raises:
        EOFError: End of file or incomplete record (not yet fully written).
        ValueError: Malformed CBOR structure.
    """
    b = f.read(1)
    if not b:
        raise EOFError
    if b[0] != 0xa2:
        raise ValueError('Expected outer map 0xa2, got 0x%02x' % b[0])

    # "seq" key — text(3) "seq"
    # Pod firmware always emits keys in order: seq, then data.
    seq_key = f.read(4)
    if len(seq_key) < 4:
        raise EOFError
    if seq_key != b'\x63\x73\x65\x71':
        raise ValueError('Expected seq key')

    # seq value — Pod firmware uses fixed-width uint32 (0x1a), but we accept
    # all valid CBOR unsigned integer encodings for forward compatibility.
    hdr = f.read(1)
    if not hdr:
        raise EOFError
    mt = hdr[0] >> 5
    ai = hdr[0] & 0x1f
    if mt != 0:
        raise ValueError('seq must be unsigned int, got major type %d' % mt)
    if ai <= 23:
        pass  # inline value, no additional bytes
    elif ai == 24:
        if len(f.read(1)) < 1:
            raise EOFError
    elif ai == 25:
        if len(f.read(2)) < 2:
            raise EOFError
    elif ai == 26:
        if len(f.read(4)) < 4:
            raise EOFError
    elif ai == 27:
        if len(f.read(8)) < 8:
            raise EOFError
    else:
        raise ValueError('Unexpected seq encoding: 0x%02x' % hdr[0])

    # "data" key — text(4) "data"
    data_key = f.read(5)
    if len(data_key) < 5:
        raise EOFError
    if data_key != b'\x64\x64\x61\x74\x61':
        raise ValueError('Expected data key')

    # data value — must be a byte string (major type 2)
    bs = f.read(1)
    if not bs:
        raise EOFError
    if bs[0] >> 5 != 2:
        raise ValueError('data must be a byte string, got major type %d' % (bs[0] >> 5))
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
    elif ai == 27:
        lb = f.read(8)
        if len(lb) < 8:
            raise EOFError
        length = struct.unpack('>Q', lb)[0]
    else:
        raise ValueError('Unsupported data length encoding: %d' % ai)

    if length > _MAX_DATA_LENGTH:
        raise ValueError('Implausibly large data field: %d bytes' % length)

    data = f.read(length)
    if len(data) < length:
        raise EOFError
    if not data:  # length==0: firmware placeholder record (sequence-number marker)
        return None
    return data
