# Owner access in the unified fork

This fork requires `SLEEPYPOD_AUTH_TOKEN` (at least 32 characters of securely generated random material) for the controller API and sensor WebSocket. Store it in a private service environment file. Do not place it in a URL, source file, browser local storage, or a public deployment variable. Missing configuration closes the API with HTTP 503; it never falls back to trusting the LAN.

Native clients send `Authorization: Bearer <connection key>`. The web login exchanges the key for a signed twelve-hour HttpOnly, SameSite=Strict session. Cookie writes require a matching Origin; streams require a matching hostname because their listener uses a separate port. Rotating the owner key invalidates sessions and closes existing sensor connections on their next thirty-second access check.

Use private Tailscale HTTPS. Set `SLEEPYPOD_HTTPS_ONLY=1` behind the HTTPS proxy so session cookies require HTTPS; forward the browser's original Host and Origin. The WebSocket must be proxied under the same private hostname. Add that exact hostname to `SLEEPYPOD_ALLOWED_HOSTS` rather than weakening the host check. Plain HTTP remains available for trusted local setup, with bearer credentials visible to that network; HTTPS is the intended ongoing connection.

`/api/auth/session` exposes only configuration/session readiness without authentication. Route handlers recheck authorization independently of the Next proxy. Demo pages use simulated client data; the demo flag does not remove API authentication.

Authenticated responses from the generated REST and tRPC handlers, including
errors, use `Cache-Control: private, no-store` and vary by Authorization/Cookie.
The response wrapper preserves streaming bodies and existing adapter headers.

General-purpose MCP and raw hardware passthrough are disabled. `SLEEPYPOD_ENABLE_MCP=1` and `SLEEPYPOD_ENABLE_RAW_COMMANDS=1` are separate explicit diagnostic opt-ins; leave both unset in the home installation. Health import subprocesses inherit the service environment and send the connection key in an Authorization header, never as a command-line argument.

These are local implementation checks, not a completed deployment or external security review. The working Free Sleep installation has not been replaced.
