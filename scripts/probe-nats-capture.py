#!/usr/bin/env -S uv run --with nats-py --with cbor2 --quiet --no-project
"""
NATS raw.> stream capture — discovery probe for new Pod 5 firmware.

Records every message published to subjects matching the configured filter
(default raw.>) for a fixed duration. Each message is written as one NDJSON
line containing subject, headers, payload size, base64 payload, and the
CBOR-decoded payload (or a decode error). Prints a per-subject summary
(count, rate, total bytes, decoded shape sample) on exit.

Use to learn what the firmware actually publishes before designing the
consumer. The output file is grep/jq-friendly; SCP it off the pod and
inspect locally.

Usage on a pod (new firmware only — needs nats-server up):
  sudo -u dac /home/dac/sleepypod-core/scripts/probe-nats-capture.py
  sudo -u dac /home/dac/sleepypod-core/scripts/probe-nats-capture.py \
      --duration 30 --subject 'raw.>' --out /tmp/raw-capture.ndjson

Inspect afterwards:
  jq -r '.subject' < /tmp/raw-capture.ndjson | sort | uniq -c | sort -rn
  jq 'select(.subject == "raw.piezo") | .cbor' < /tmp/raw-capture.ndjson | head

Output paths default under /tmp to avoid burning eMMC during exploration.
Move captures you want to keep to /persistent before reboot.
"""

import argparse
import asyncio
import base64
import json
import signal
import time
from collections import Counter, defaultdict

import cbor2
import nats


def stringify_cbor(value, depth=0):
    """Convert CBOR-decoded value into a JSON-safe shape preview.

    For dicts/lists, recurse with depth cap so we don't dump huge payloads
    into the summary. Bytes become {hex|len}; arrays of numbers become
    {len|first|last}.
    """
    if isinstance(value, dict):
        if depth > 3:
            return {"_dict_keys": list(value.keys())}
        return {str(k): stringify_cbor(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        if depth > 3 or len(value) > 8:
            head = [stringify_cbor(v, depth + 1) for v in value[:3]]
            return {"_list_len": len(value), "_head": head}
        return [stringify_cbor(v, depth + 1) for v in value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"_bytes_len": len(value), "_hex_head": bytes(value)[:16].hex()}
    return value


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--duration", type=int, default=60, help="seconds to capture (default 60)")
    p.add_argument("--subject", default="raw.>", help="subject filter (default raw.>)")
    p.add_argument("--url", default="nats://localhost:4222", help="NATS server URL")
    p.add_argument(
        "--out",
        default=f"/tmp/nats-capture-{int(time.time())}.ndjson",
        help="output NDJSON path",
    )
    p.add_argument(
        "--no-cbor",
        action="store_true",
        help="skip CBOR decode (record raw bytes only)",
    )
    p.add_argument(
        "--max-bytes",
        type=int,
        default=50 * 1024 * 1024,
        help="cap output file size in bytes (default 50 MB); recorder stops early when reached",
    )
    args = p.parse_args()

    print(f"connecting to {args.url} ...")
    nc = await nats.connect(args.url, connect_timeout=2)
    print(f"connected. capturing subject={args.subject!r} for {args.duration}s → {args.out}")
    print(f"(max output: {args.max_bytes // (1024 * 1024)} MB; ctrl-c to stop early)")

    subject_count: Counter[str] = Counter()
    subject_bytes: dict[str, int] = defaultdict(int)
    decode_errors: Counter[str] = Counter()
    out = open(args.out, "w", buffering=8192)
    bytes_written = 0
    stop_event = asyncio.Event()

    async def handler(msg):
        nonlocal bytes_written
        rec: dict[str, object] = {
            "ts": time.time(),
            "subject": msg.subject,
            "size": len(msg.data),
            "headers": dict(msg.header) if msg.header else {},
            "payload_b64": base64.b64encode(msg.data).decode("ascii"),
        }
        if not args.no_cbor:
            try:
                rec["cbor"] = stringify_cbor(cbor2.loads(msg.data))
            except Exception as exc:  # noqa: BLE001 — any decode failure is signal
                rec["cbor_error"] = repr(exc)
                decode_errors[type(exc).__name__] += 1
        line = json.dumps(rec, default=str) + "\n"
        out.write(line)
        bytes_written += len(line)
        subject_count[msg.subject] += 1
        subject_bytes[msg.subject] += len(msg.data)
        if bytes_written >= args.max_bytes:
            stop_event.set()

    await nc.subscribe(args.subject, cb=handler)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    started = time.monotonic()
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=args.duration)
        reason = "size cap reached" if bytes_written >= args.max_bytes else "stopped by signal"
    except asyncio.TimeoutError:
        reason = "duration elapsed"

    elapsed = time.monotonic() - started
    await nc.flush()
    await nc.close()
    out.close()

    total = sum(subject_count.values())
    print(f"\n{reason}; captured {total} msgs in {elapsed:.1f}s ({bytes_written / 1024:.1f} KB written)")
    if not subject_count:
        print("no messages received — confirm `nats stream info raw` shows traffic flowing")
        return

    print(f"\n{'subject':50} {'msgs':>8} {'msg/s':>10} {'bytes':>12}")
    for subj, n in subject_count.most_common():
        print(f"{subj:50} {n:>8} {n / elapsed:>10.2f} {subject_bytes[subj]:>12}")

    if decode_errors:
        print("\nCBOR decode errors:")
        for kind, n in decode_errors.most_common():
            print(f"  {kind}: {n}")


if __name__ == "__main__":
    asyncio.run(main())
