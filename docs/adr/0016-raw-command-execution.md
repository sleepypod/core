# ADR: Raw Hardware Command Execution Endpoint

**Status**: Accepted
**Date**: 2026-03-29

## Context

Power users and developers need direct access to hardware commands for debugging, testing, and advanced automation. The existing typed endpoints (setTemperature, setPower, etc.) provide safety and validation but don't expose all available hardware capabilities.

## Decision

Add a `POST /device/execute` endpoint that accepts a hardware command name and optional arguments string, mapping directly to the franken command protocol. This is a passthrough with no validation beyond command name allowlisting.

## Consequences

### Positive

- Enables advanced debugging without SSH access
- Allows experimentation with hardware features not yet exposed via typed endpoints
- Provides escape hatch for automation scripts

### Negative

- No input validation on command arguments
- Can cause unexpected hardware state if misused
- Not covered by the standard safety/debounce mechanisms

## Disclaimer

This is a power user feature. It is unsupported, undocumented beyond this ADR, and carries no guarantees. Misuse can lead to unexpected hardware behavior. The sleepypod project assumes no liability for issues arising from raw command execution.
