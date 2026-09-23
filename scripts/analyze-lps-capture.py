#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib==3.10.6"]
# ///
"""Offline LPS/piezo JSONL analysis. Never writes to the source capture."""

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import statistics
import struct

CHANNELS = ("left1", "left2", "right1", "right2")
SENTINEL = 0x7FFFFFFF


def decode_record(record):
    """Return channel samples; candidate invalid samples retain their indices."""
    frame = record["frame"]
    kind = frame["type"]
    if kind not in ("lps", "piezo-dual"):
        raise ValueError(f"unsupported frame type: {kind}")
    if not isinstance(record["phase"], str) or not record["phase"]:
        raise ValueError("phase must be a nonempty string")
    ts = frame["ts"]
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts):
        raise ValueError("ts must be a finite firmware timestamp")
    payload = frame["pres"] if kind == "lps" else frame
    freq = payload["freq"]
    if type(freq) is not int or freq <= 0:
        raise ValueError("freq must be a positive integer")
    channels, invalid = {}, {}
    for channel in CHANNELS:
        if kind == "piezo-dual" and channel not in payload:
            continue
        value = payload[channel]
        if kind == "lps":
            if value["type"] != "Buffer":
                raise ValueError(f"{channel}: expected serialized Buffer")
            data = value["data"]
            if not isinstance(data, list) or any(type(b) is not int or not 0 <= b <= 255 for b in data):
                raise ValueError(f"{channel}: invalid byte array")
            if len(data) != freq * 4:
                raise ValueError(f"{channel}: expected one second of int32 bytes")
            samples = list(struct.unpack(f"<{freq}i", bytes(data)))
        else:
            if not isinstance(value, list) or len(value) != freq or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                for v in value
            ):
                raise ValueError(f"{channel}: expected one second of finite numeric samples")
            samples = value
        invalid[channel] = [i for i, sample in enumerate(samples) if sample == SENTINEL]
        channels[channel] = [math.nan if sample == SENTINEL else sample for sample in samples]
    if kind == "piezo-dual" and not all(c in channels for c in ("left1", "right1")):
        raise ValueError("piezo-dual requires left1 and right1")
    return dict(phase=record["phase"], type=kind, ts=ts, freq=freq,
                channels=channels, invalid=invalid)


def read_capture(path):
    records = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            records.append(decode_record(json.loads(line)))
        except (ValueError, KeyError, TypeError, struct.error) as error:
            raise ValueError(f"line {line_number}: {error}") from error
    if not records:
        raise ValueError("capture is empty")
    for kind in ("lps", "piezo-dual"):
        timestamps = [r["ts"] for r in records if r["type"] == kind]
        if any(b <= a for a, b in zip(timestamps, timestamps[1:])):
            raise ValueError(f"{kind}: timestamps must be strictly increasing")
    return records


def frame_stats(samples):
    valid = [s for s in samples if math.isfinite(s)]
    return (statistics.mean(valid), statistics.pstdev(valid)) if valid else (None, None)


def median_valid(values):
    valid = [v for v in values if v is not None]
    return statistics.median(valid) if valid else None


def summarize(records, source_hash):
    report = dict(source_sha256=source_hash, records=len(records), streams={}, phases={}, sentinel_bursts=[])
    for kind in ("lps", "piezo-dual"):
        frames = [r for r in records if r["type"] == kind]
        timestamps = [r["ts"] for r in frames]
        report["streams"][kind] = dict(
            frames=len(frames), first_ts=min(timestamps, default=None), last_ts=max(timestamps, default=None),
            timestamp_steps=dict(Counter(b - a for a, b in zip(timestamps, timestamps[1:]))),
            frequencies=sorted({r["freq"] for r in frames}))
    for phase in dict.fromkeys(r["phase"] for r in records):
        report["phases"][phase] = {}
        for kind in ("lps", "piezo-dual"):
            frames = [r for r in records if r["phase"] == phase and r["type"] == kind]
            # Matches the documented exploratory comparison; this is not calibration.
            tail = frames[-20:]
            channels = {}
            for channel in CHANNELS:
                stats = [frame_stats(r["channels"][channel]) for r in tail if channel in r["channels"]]
                if stats:
                    channels[channel] = dict(median_frame_mean=median_valid(a for a, _ in stats),
                                             median_frame_sd=median_valid(b for _, b in stats))
            report["phases"][phase][kind] = dict(frames=len(frames), summary_frames=len(tail), channels=channels)
    for record in records:
        for channel, indices in record["invalid"].items():
            if indices:
                report["sentinel_bursts"].append(dict(type=record["type"], ts=record["ts"], phase=record["phase"],
                    channel=channel, indices=indices, seconds_in_frame=[i / record["freq"] for i in indices]))
    return report


def sample_series(records, kind, channel, origin):
    """Use firmware time, leaving both invalid samples and missing frames as gaps."""
    times, values = [], []
    previous_end = None
    for record in records:
        if record["type"] != kind or channel not in record["channels"]:
            continue
        start = record["ts"] - origin
        if previous_end is not None and start > previous_end + 1e-6:
            times.append(previous_end)
            values.append(math.nan)
        samples = record["channels"][channel]
        times.extend(start + i / record["freq"] for i in range(len(samples)))
        values.extend(samples)
        previous_end = start + len(samples) / record["freq"]
    return times, values


def plot_capture(records, output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    origin = min(r["ts"] for r in records)
    fig, axes = plt.subplots(4, 2, figsize=(17, 12), sharex=True)
    colors = ("#eef2ff", "#dcfce7", "#f1f5f9", "#ffedd5", "#f1f5f9")
    for column, kind in enumerate(("lps", "piezo-dual")):
        frames = [r for r in records if r["type"] == kind]
        spans = []
        for r in frames:
            start = r["ts"] - origin
            if spans and spans[-1][0] == r["phase"] and start == spans[-1][2]:
                spans[-1][2] = start + 1
            else:
                spans.append([r["phase"], start, start + 1])
        for row, channel in enumerate(CHANNELS):
            ax = axes[row, column]
            for index, (phase, start, end) in enumerate(spans):
                ax.axvspan(start, end, color=colors[index % len(colors)], zorder=0)
                if row == 0:
                    ax.text((start + end) / 2, 1.02, phase, ha="center", fontsize=8,
                            transform=ax.get_xaxis_transform())
            times, values = sample_series(records, kind, channel, origin)
            if times:
                ax.plot(times, values, color="#334155", linewidth=0.35, rasterized=True)
                # Per-frame summaries remain gaps when no valid samples exist.
                means = [frame_stats(r["channels"][channel])[0] for r in frames if channel in r["channels"]]
                centers = [r["ts"] - origin + 0.5 for r in frames if channel in r["channels"]]
                ax.scatter(centers, means, color="#2563eb", s=4, label="Frame mean", zorder=3)
                for r in frames:
                    indices = r["invalid"].get(channel, [])
                    if indices:
                        ax.plot([r["ts"] - origin + i / r["freq"] for i in indices],
                                [0.97] * len(indices), "|", color="#dc2626", markersize=5,
                                transform=ax.get_xaxis_transform())
                finite = [v for v in values if math.isfinite(v)]
                if finite and max(finite) - min(finite) > 10000:
                    ax.set_yscale("symlog", linthresh=1000)
                    # Avoid crowded default ticks around the linear region.
                    low, high = ax.get_ylim()
                    ticks = [-10**n for n in range(10, 2, -1)] + [0] + [10**n for n in range(3, 11)]
                    ax.set_yticks([t for t in ticks if low <= t <= high])
                    ax.set_ylabel("Raw counts (symlog)")
                else:
                    ax.ticklabel_format(axis="y", style="plain", useOffset=False)
                    ax.set_ylabel("Raw counts (linear)")
            else:
                ax.text(0.5, 0.5, "Channel absent", ha="center", transform=ax.transAxes)
                ax.set_yticks([])
            ax.set_title(f"{kind} / {channel}", fontsize=10, pad=23 if row == 0 else 6)
            ax.grid(alpha=0.2)
    for ax in axes[-1]:
        ax.set_xlabel(f"Seconds from firmware timestamp {origin}")
    fig.suptitle("LPS and piezo capture — firmware channel names preserved", fontsize=15)
    fig.text(0.5, 0.015, "Gray: samples · Blue: valid-sample frame means · Red ticks: candidate sentinel gaps\n"
             "Panels scale independently. Shading follows each stream's recorded phase labels; no inferred time shift.",
             ha="center", fontsize=10)
    fig.tight_layout(rect=(0, 0.055, 1, 0.965))
    fig.savefig(output, dpi=160)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--summary-only", action="store_true", help="No matplotlib required")
    args = parser.parse_args()
    try:
        outputs = [args.output_dir / "summary.json", args.output_dir / "channels.png"]
        if args.capture.resolve() in [p.resolve() for p in outputs]:
            raise ValueError("output would overwrite the source capture")
        records = read_capture(args.capture)
        report = summarize(records, hashlib.sha256(args.capture.read_bytes()).hexdigest())
        args.output_dir.mkdir(parents=True, exist_ok=True)
        outputs[0].write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        if not args.summary_only:
            plot_capture(records, outputs[1])
        print(f"Analyzed {len(records)} records; {len(report['sentinel_bursts'])} affected channel buffers")
        print(f"Results: {args.output_dir.resolve()}")
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
