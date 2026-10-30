# Recording boundaries in sleep-stage views

Rule-based staging assigns a provisional duration to each sensor sample. Its last
sample previously extended five minutes beyond its timestamp, including beyond
the recording end. Same-stage chart blocks also joined across arbitrarily large
sensor gaps. Both could overstate classified time.

Stage views now clip model and rule epochs to the requested recording and the
next epoch. Rule previews and candidate-model comparisons use the same bounds.
Block merging joins only touching or overlapping epochs of the same stage;
missing samples remain visible gaps. These changes do not turn occupancy into
measured sleep or establish that the experimental stage labels are correct.

The biometric manifest and stage component advance to 1.0.1, pinning both stage
source files. Old evaluation receipts are not silently treated as validation of
the corrected implementation. Existing incompatible personalized profiles retain
their stored identity and use the established explicit fallback/review path.
Before deployment, inspect active profiles and retain the controller rollback.
No sensor calibration, routine, alarm, temperature policy or actuator is changed
by these view corrections.
