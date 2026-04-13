# Piezo Processing

Heart rate, HRV, and breathing rate extraction from raw piezoelectric ballistocardiogram (BCG) sensor data. Part of the [[biometrics-system]].

## Overview

The piezo-processor tails CBOR-encoded `.RAW` files, processes dual-channel (left/right) signals at 500 Hz, and writes vitals rows to `biometrics.db` every 60 seconds per occupied side.

## Why V2

V1 produced garbage under real pod conditions:
- **Pump noise** — no gating, so pump cycles contaminated every window
- **Harmonic locking** — simple autocorrelation locked onto 2nd/3rd harmonic (reporting 160 BPM instead of 80)
- **Broken presence** — energy threshold triggered false presence on empty side from vibration coupling
- **Locked breathing** — Welch PSD converged to exactly 12.0 BPM regardless of actual breathing

## Signal Processing Pipeline

**RAW ingestion** → **Pump gating** → **Per-side buffering** → **Presence detection** → **Vitals computation** → **DB write**

### Buffers per side

| Buffer | Window | Samples | Purpose |
|--------|--------|---------|---------|
| HR | 30s | 15,000 | Heart rate extraction |
| BR | 60s | 30,000 | Breathing rate extraction |
| HRV | 300s | 150,000 | HR variability index |

## Pump Gating

The pod's air pump creates broadband high-energy vibrations on both piezo channels. Detection uses dual-channel energy correlation:

1. Energy ratio: `min(L,R) / max(L,R)` — pump produces ratio > 0.5 (affects both channels equally); heartbeat is lateralized
2. Spike detection: energy > 10× baseline AND ratio > 0.5 → pump flagged
3. **5-second guard period** after detection for spin-down/resonance decay

## Presence Detection

Hysteresis state machine with dual features:

| Feature | Entry Threshold | Exit Threshold |
|---------|----------------|----------------|
| Median std (1-10 Hz) | > 400,000 | < 150,000 |
| Autocorrelation quality | > 0.45 | < 0.225 |

Exit requires 3 consecutive low windows (3 minutes of silence) to prevent deep-sleep dropout. Thresholds calibrated from Pod 5 data (2026-03-16). See [[sensor-calibration]] for adaptive thresholds.

## Heart Rate Extraction

### Bandpass: 0.8-8.5 Hz
Lower cutoff preserves fundamentals down to 48 BPM (important for athletes/deep sleep). Upper cutoff captures 5th harmonic of 100 BPM.

### Subharmonic Summation (SHS)
Solves the harmonic locking problem. For each candidate peak at lag `L`:

```
score(L) = 1.0 × ACR(L) + 0.8 × ACR(L/2) + 0.6 × ACR(L/3)
```

The fundamental's sub-harmonics align with actual harmonic peaks; a harmonic's sub-harmonics land on noise. Eliminates all harmonic errors in validation.

### Inter-Window Tracking (HRTracker)
Second line of defense: maintains history of 5 accepted HR values, applies Gaussian consistency check (weight > 0.3 ≈ delta < 20 BPM). Tries half/double corrections for escaped harmonics.

## Breathing Rate (Hilbert Envelope)

V1's direct bandpass + Welch PSD locked at 12.0 BPM. V2 uses the Hilbert envelope method:

1. Bandpass 0.8-10 Hz (cardiac band)
2. Hilbert transform → instantaneous amplitude envelope
3. Bandpass 0.1-0.7 Hz on envelope (respiratory modulation)
4. Peak counting with outlier rejection
5. Validity gate: 6-30 BPM

Works because heartbeat amplitude is modulated by breathing (thoracic impedance changes with lung volume).

## HRV Index

**Not clinical RMSSD.** Computes successive differences of window-level IBI estimates (10-second sub-windows with 50% overlap), not beat-to-beat intervals. Measures HR stability across windows.

Pipeline: SHS autocorrelation per sub-window → IBI validity gate [400-1500ms] → harmonic gate (18% tolerance) → Hampel filter → gap-aware successive differences → validity gate [5-100ms].

Requires 300-second buffer (5 minutes). First 5 minutes after presence detection produce no HRV.

## V1 vs V2 Validation (Pod 5, 2026-03-16)

| Metric | V1 | V2 |
|--------|----|----|
| HR range (occupied) | 61-171 BPM | 78.7-82.6 BPM |
| Harmonic errors | 3/8 windows | 0/12 windows |
| HR std dev | ~35 BPM | ~1.2 BPM |
| Empty side false presence | 100% | 13% |
| Breathing rate | Locked 12.0 | 16-25 BPM |

## Known Limitations

1. Cross-side vibration coupling can cause false presence (2/15 in validation)
2. Heavy pump gating (>30% of window) degrades HR — minimum 10s clean data required
3. HRV cold start: 5 minutes before first output
4. Single-pod calibration (Pod 5) — other pods may need threshold adjustment
5. No motion artifact handling beyond presence hysteresis
6. Fixed filter parameters — not adaptive to individuals

## Sources

- `docs/piezo-processor.md`
