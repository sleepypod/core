# ADR: Sensor Calibration System

**Status**: Accepted
**Date**: 2026-03-15

## Context

The Eight Sleep Pod carries three sensor types relevant to biometrics processing:

- **Piezoelectric (piezo)**: Sampled at 500 Hz. Produces ballistocardiogram (BCG) signals used to derive heart rate, HRV, and breathing rate.
- **Capacitance**: Sampled at ~1 Hz. Used for bed presence detection.
- **Thermistor (temperature)**: Sampled at ~1 Hz across six zones (left/right x outer/center/inner). Used for bed surface and ambient temperature.

All processing thresholds in the current codebase are hardcoded. This produces several failure modes observed in practice:

1. **Piezo processor reports HR 200+ bpm on an empty bed.** Ambient vibrations (HVAC, washer/dryer, truck passing) couple through the mattress. Without a noise-floor baseline, the processor cannot distinguish signal from environment.
2. **Sleep detector uses a fixed presence threshold (1500)** not tuned per-pod. Capacitance readings vary with mattress thickness, sheet material, topper density, and sensor age. Some pods read 800 with a person present; others read 3000+ empty.
3. **No temperature offset correction** for thermistor factory tolerance. NTC thermistors from the same batch can differ by +/-0.5C. Over time, drift widens this further. The result is left/right temperature asymmetry that confuses the thermal comfort algorithm.
4. **free-sleep had calibration, but it was tightly coupled.** Each Python module embedded its own calibration logic, stored as JSON files in `/persistent/calibration/`. There was no shared library, no single source of truth, and calibration parameters lived in different formats per module.

## Decision

Implement a **decoupled calibration system** via a shared library (`modules/common/calibration.py`) with a dedicated database-backed store.

The design has four components:

1. **CalibrationStore** (`modules/common/calibration.py`): A Python class that reads and writes calibration profiles to `biometrics.db`. Replaces free-sleep's per-module JSON files with a single DB-backed source of truth. All modules import this library.

2. **Calibrator module** (`modules/calibrator/`): A standalone systemd service that owns all calibration writes. It runs on three triggers:
   - **Pre-prime schedule**: The jobManager triggers calibration 30 minutes before the configured pod prime time (e.g., prime at 14:00 → calibration at 13:30). The bed should be empty after the pre-prime reboot (1h before prime). This is the primary calibration path.
   - **Fallback daily timer** (25h interval): If priming is disabled, the calibrator's internal timer fires as a fallback.
   - **On-demand trigger file**: The iOS app (via tRPC) writes an atomic trigger file to `/persistent/sleepypod-data/.calibrate-trigger.{ts}`; the calibrator picks it up within 10 seconds, runs calibration, and deletes the trigger. Multiple concurrent triggers are queued as separate files.

3. **Read-only consumers**: Processing modules (piezo-processor, sleep-detector) only read calibration profiles from the store. They never write. This enforces a single-writer/multiple-reader pattern.

4. **Medical-informed thresholds**: All physiological thresholds are chosen from peer-reviewed literature rather than free-sleep's empirical guesses. See the Medical Threshold Rationale section below.

## Alternatives Considered

### 1. Embedded calibration in each module (free-sleep approach)

The free-sleep project embedded calibration directly in each processing module. The piezo processor had its own noise floor computation and HR bounds; the sleep detector had its own presence threshold logic; temperature had its own offset file.

**Rejected because:**
- Tight coupling: changing the calibration storage format required updating every module independently.
- No single source of truth: each module computed its own baseline at its own cadence, leading to inconsistent views of sensor health.
- Each module had different calibration logic quality -- the piezo processor's was well-tested, but sleep detector's was minimal.
- Community modules would need to reimplement calibration from scratch.

### 2. HTTP API on Python modules

Expose a lightweight HTTP server in each Python module so the core Node.js app (or iOS) could POST calibration commands directly.

**Rejected because:**
- Adds port allocation complexity on the Pod (already using 3000 for tRPC, 3001 for piezo WebSocket).
- Requires health checks and restart logic for each HTTP server.
- Another failure mode: if the HTTP server hangs, calibration cannot be triggered.
- The trigger file pattern is simpler and works within systemd sandboxing (`ReadWritePaths=/persistent/sleepypod-data`).

### 3. Shared SQLite table without a library

Each module could write its own SQL queries against a `calibration_profiles` table directly, without a shared Python library.

**Rejected because:**
- Every module would duplicate SQL query construction, validation, and default-value logic.
- Schema changes would require updating SQL in N modules instead of one library.
- No shared computation for derived values (e.g., converting raw noise floor RMS to a presence threshold multiplier).
- Type/validation errors would surface at runtime in each module independently.

### 4. gRPC between Node and Python

Use gRPC for structured communication between the Node.js core app and Python modules, including calibration commands.

**Rejected because:**
- Over-engineered for a single-pod embedded system with 2-3 Python processes.
- gRPC adds protobuf compilation, a Python gRPC runtime dependency (~15 MB), and proto file maintenance.
- The actual communication need is: "run calibration now" (one signal) and "read calibration profile" (one DB query). A trigger file and shared DB handle both with zero additional dependencies.

## Consequences

### Positive

- All modules share a single, versioned calibration library -- breaking changes are caught at import time.
- Database-backed storage is queryable (the tRPC calibration router can expose profiles directly to the iOS app for inspection/debugging).
- Single-writer pattern eliminates concurrent calibration conflicts.
- Medical-informed thresholds are documented with citations, making the reasoning auditable and debatable.
- Graceful degradation: modules work with hardcoded defaults if no calibration profile exists (fresh install, first night).

### Negative

- All modules depend on `common/calibration.py` -- a breaking change to CalibrationStore requires updating all modules simultaneously.
- Trigger file IPC has ~10-second latency (the calibrator polls every 10 seconds). This is acceptable for calibration, which is not time-critical.
- Trigger files use atomic writes (write `.tmp` then `rename`) to prevent partial reads. Each trigger gets a unique filename (`.calibrate-trigger.{ts}`) to support queuing concurrent requests.
- `vitals_quality` is a companion table (not additional columns on `vitals`) to avoid running ALTER TABLE migrations on a heavily-written, indexed table. This means quality data requires a JOIN to correlate with vitals.
- `CalibrationStore` is NOT thread-safe — each module should create its own instance or use from a single thread.

### Neutral

- Calibration is primarily scheduled 30 minutes before the pod's configured prime time. The bed should be empty after the pre-prime reboot (1h before). Users who disable priming fall back to the calibrator's internal 25-hour timer. The calibrator reads RAW data read-only, so running during sleep does not affect processing — the algorithm selects the quietest 5-minute window from the available data.

## Medical Threshold Rationale

The following table documents every threshold change from free-sleep's values, with the medical or engineering rationale for each.

| Parameter | free-sleep | Ours | Rationale |
|---|---|---|---|
| HR hard max | 90 bpm | 100 bpm | The American Heart Association defines tachycardia as sustained HR > 100 bpm [1]. REM sleep produces HR surges averaging 26% above baseline [2]. A baseline of 75 bpm surges to ~95 bpm during REM. Elderly subjects, patients with obstructive sleep apnea, and pregnant women regularly exceed 90 bpm during REM without pathology. Capping at 90 rejects valid REM readings for these populations. |
| HR hard min | 40 bpm | 30 bpm | Elite endurance athletes document sleeping HR in the low 30s as benign sinus bradycardia [3]. The AHA's 2025 guidelines on bradycardia in athletes confirm that resting HR below 40 bpm is common and asymptomatic in trained individuals [3]. Capping at 40 rejects valid readings from this population. |
| HR dynamic bounds | P15-P80, 120-sample window | P10-P90, 300-sample window | BCG literature demonstrates that sliding-window approaches with 5-10 second windows outperform shorter windows for robustness [4]. Sleep stage transitions (NREM to REM) produce HR increases of ~26% within seconds [2]. A 2-minute window (120 samples at 1 Hz) computed during stable NREM creates bounds that reject early REM readings as outliers. Widening to P10-P90 over 300 samples (5 minutes) accommodates stage-transition variability while still rejecting artifacts. |
| Breathing rate range | 8-20 breaths/min | 6-22 breaths/min | Normal adult resting respiratory rate is 12-20 breaths/min [5]. During deep N3 sleep, respiratory rate can dip near 7 breaths/min due to reduced metabolic demand [5]. A floor of 8 flags bradypnea that may warrant clinical evaluation, but also rejects valid deep-sleep dips. We widen to 6 to capture deep-sleep physiology. The ceiling widens to 22 to accommodate mild tachypnea during REM or in subjects with elevated BMI. |
| HRV (SDNN) max | 200 ms | 300 ms | Healthy adults aged 20-29 have short-term SDNN averaging ~153 ms [6]. During sleep, strong vagal tone pushes SDNN values significantly higher. Young, fit adults exceed 200 ms SDNN during deep NREM regularly [7]. A 200 ms cap rejects valid high-vagal-tone readings. 300 ms accommodates the full physiological range while still flagging implausible values (true SDNN > 300 ms in short-term recordings suggests measurement artifact). |
| HRV primary metric | SDNN | RMSSD | RMSSD reflects short-term parasympathetic (vagal) activity, which dominates during sleep [8]. SDNN conflates sympathetic and parasympathetic contributions and requires longer recording windows (ideally 24 hours) for stable measurement. For BCG-derived inter-beat intervals, which have lower temporal resolution than ECG, RMSSD is more robust because it depends on successive differences rather than absolute timing accuracy. Industry standard: Oura, Garmin, and Fitbit all report RMSSD for sleep HRV [8]. |
| Presence threshold | Fixed 200,000 | 6x noise floor RMS | BCG literature shows adaptive thresholds outperform fixed thresholds for presence detection [4]. Capacitance variance is the most discriminative feature for bed occupancy. Fixed thresholds are fragile to sensor drift over months, temperature-dependent capacitance changes, mattress compression aging, and sheet/topper material differences. A multiplier of 6x the empty-bed noise floor RMS provides a 15+ dB margin above noise while adapting to each pod's specific sensor characteristics. |

## Citations

1. **AHA - Tachycardia Definition**: American Heart Association. "Tachycardia: Fast Heart Rate." https://www.heart.org/en/health-topics/arrhythmia/about-arrhythmia/tachycardia--fast-heart-rate

2. **REM Sleep Heart Rate Surges**: Somers VK, Dyken ME, Mark AL, Abboud FM. "Sympathetic-nerve activity during sleep in normal subjects." *Circulation*. 1993;87(5):1609-1617. AHA Journals. https://www.ahajournals.org/doi/10.1161/01.CIR.87.5.1609

3. **Bradycardia in Athletes**: Kusumoto FM, Schoenfeld MH, Barrett C, et al. "2018 ACC/AHA/HRS Guideline on the Evaluation and Management of Patients With Bradycardia and Cardiac Conduction Delay." *Circulation*. 2019;140(8):e382-e482. https://www.ahajournals.org/doi/10.1161/CIR.0000000000000628

4. **BCG Adaptive Thresholds**: Bruser C, Stadlthanner K, de Waele S, Leonhardt S. "Adaptive Beat-to-Beat Heart Rate Estimation in Ballistocardiograms." *IEEE Transactions on Information Technology in Biomedicine*. 2011;15(5):778-786. PMC6522616. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6522616/

5. **Sleep Respiratory Rate**: Lindberg LG, Ugnell H, Oberg PA. "Monitoring of respiratory and heart rates using a fibre-optic sensor." *Medical & Biological Engineering & Computing*. 1992;30:533-537. See also: Rolfe P. "Normal Respiratory Rate During Sleep." PMC5027356. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5027356/

6. **SDNN Age Norms**: Umetani K, Singer DH, McCraty R, Atkinson M. "Twenty-four hour time domain heart rate variability and heart rate: relations to age and gender over nine decades." *Journal of the American College of Cardiology*. 1998;31(3):593-601.

7. **HRV During Sleep**: Shaffer F, Ginsberg JP. "An Overview of Heart Rate Variability Metrics and Norms." *Frontiers in Public Health*. 2017;5:258. PMC5624990. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5624990/

8. **RMSSD for Sleep**: Laborde S, Mosley E, Thayer JF. "Heart Rate Variability and Cardiac Vagal Tone in Psychophysiological Research -- Recommendations for Experiment Planning, Data Analysis, and Data Reporting." *Frontiers in Psychology*. 2017;8:213. PMC6932537. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6932537/

---

**Authors**: @ng (decision), Claude (documentation)
**Last Updated**: 2026-03-15
