"""Protocol tests for RAW framing, independent of follower tests' module stubs."""
import importlib.util
import io
from pathlib import Path
import pytest

# Follower tests stub common.cbor_raw. Load the actual parser under a private
# name so collection order cannot select the stub instead of production code.
_spec = importlib.util.spec_from_file_location(
    "_raw_parser_under_test", Path(__file__).with_name("cbor_raw.py")
)
_parser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_parser)
read_raw_record = _parser.read_raw_record

SEQ_ENCODINGS = [
    b"\x00", b"\x17", b"\x18\xff", b"\x19\x12\x34",
    b"\x1a\x12\x34\x56\x78", b"\x1b\x01\x02\x03\x04\x05\x06\x07\x08",
]
LENGTH_ENCODINGS = [
    b"\x43", b"\x58\x03", b"\x59\x00\x03",
    b"\x5a\x00\x00\x00\x03", b"\x5b\x00\x00\x00\x00\x00\x00\x00\x03",
]


def record(seq=b"\x1a\x00\x00\x00\x01", length=b"\x43", payload=b"abc"):
    return b"\xa2\x63seq" + seq + b"\x64data" + length + payload


@pytest.mark.parametrize("seq", SEQ_ENCODINGS)
@pytest.mark.parametrize("length", LENGTH_ENCODINGS)
def test_accepts_unsigned_sequence_and_byte_string_length_widths(seq, length):
    encoded = record(seq, length)
    stream = io.BytesIO(encoded + record(payload=b"xyz"))
    assert read_raw_record(stream) == b"abc"
    assert stream.tell() == len(encoded)
    assert read_raw_record(stream) == b"xyz"
    assert stream.tell() == len(stream.getvalue())
    with pytest.raises(EOFError):
        read_raw_record(stream)


@pytest.mark.parametrize("seq", SEQ_ENCODINGS)
@pytest.mark.parametrize("length", LENGTH_ENCODINGS)
def test_every_incomplete_prefix_is_retryable_eof(seq, length):
    encoded = record(seq, length)
    for end in range(len(encoded)):
        with pytest.raises(EOFError):
            read_raw_record(io.BytesIO(encoded[:end]))


def test_placeholder_consumes_only_its_record():
    placeholder = record(length=b"\x40", payload=b"")
    stream = io.BytesIO(placeholder + record())
    assert read_raw_record(stream) is None
    assert stream.tell() == len(placeholder)
    assert read_raw_record(stream) == b"abc"


@pytest.mark.parametrize("size", [23, 24, 255, 256, 4096, 5000, 65536, 1_000_000])
def test_real_file_cursor_does_not_skip_records_across_buffer_boundaries(tmp_path, size):
    payload = bytes(range(256)) * (size // 256) + bytes(range(size % 256))
    encoded = record(length=b"\x5a" + size.to_bytes(4, "big"), payload=payload)
    path = tmp_path / "frame.RAW"
    path.write_bytes(encoded + record())
    with path.open("rb") as stream:
        assert read_raw_record(stream) == payload
        assert stream.tell() == len(encoded)
        assert read_raw_record(stream) == b"abc"


@pytest.mark.parametrize("encoded, message", [
    (b"\xa1", "Expected outer map"),
    (b"\xa2\x63bad", "Expected seq key"),
    (record(seq=b"\x20"), "seq must be unsigned"),
    (record(seq=b"\x1c"), "Unexpected seq encoding"),
    (record(seq=b"\x1f"), "Unexpected seq encoding"),
    (b"\xa2\x63seq\x00\x64oops", "Expected data key"),
    (record(length=b"\x63"), "data must be a byte string"),
    (record(length=b"\x5c"), "Unsupported data length encoding"),
    (record(length=b"\x5f"), "Unsupported data length encoding"),
    (record(length=b"\x5a" + (1_000_001).to_bytes(4, "big"), payload=b""), "Implausibly large"),
])
def test_rejects_malformed_structure_without_waiting_for_payload(encoded, message):
    with pytest.raises(ValueError, match=message):
        read_raw_record(io.BytesIO(encoded))
