# Device-local personal Health enrollment

The authenticated household session advertises `healthImport: true` for native
clients implementing explicit enrollment. This means permission to link the
person's own iPhone Health library to the returned account/sleeper identity.
It does not create a Health upload route, allow legacy-owner reads, turn on cloud
analysis, train models or change the bed arrangement.

Native clients must keep stable Pod/household/account/sleeper ownership separate
from bed sides and from ephemeral session/credential/assignment revisions. The
new native flow requires the person to confirm whose Health records are on the
device, stores its import encrypted locally, and rejects late work after account
changes, cancellation, locking or revocation. A retained, permitted personal
identity can read its cached import during an outage; new imports need the live
session. Existing owner history is not copied automatically.

Apple does not reveal whether Health read access was denied, so an empty import
cannot be called proof of zero sleep or a diagnosed permission failure.
[Apple Health authorization](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)

The original `preparation-v1.json` remains a valid older response with this
capability false. Current raw identity-store responses also remain conservative;
only the authenticated HTTP presentation advertises enrollment. The client checks
the capability before creating the local Health workspace. `cloudAnalysis`
remains false, and no `me/health` ingestion endpoint is exposed.

## Personal device reports

The authenticated session additionally advertises optional `personalDeviceReports`.
Older responses without it remain valid; native clients treat absence as unavailable.
This capability binds device-created reports to the current account and sleeper.
It does not turn on the Pod's `cloudAnalysis` capability or change the persisted
`cloudAnalysisConsent: false` preference.

The native report workspace uses its separately enrolled Health source, an
encrypted per-identity report archive and personal Keychain credentials. Apple
on-device inference is the default. A request to OpenAI, Gemini, Anthropic or an
explicit local model server requires a fresh review identifying the destination
and calculated evidence. Consent is consumed by that single request; switching
model, account or source requires a new review. Raw Health records and model keys
are not uploaded to the Pod.

This advertisement does not constitute TestFlight, local model availability,
provider access, personal-account onboarding or hardware acceptance. Model output
is a report for review and never becomes an actuator command.

The capability follow-up passes 49 targeted HTTP/history/report tests. They
add absent/false/true compatibility, reject non-boolean advertisements and
confirm that persistent cloud consent stays false. The native report enrollment
and per-account sharing flow are being validated separately before distribution.

Validation: 37 targeted HTTP/history tests, TypeScript and focused ESLint passed.
They cover authenticated account resolution, unavailable upload, unauthorized
sessions and continued rejection of personal credentials by legacy APIs. Native
phone/tablet review, hosted checks and paired release are separate acceptance.
No live controller configuration, Health records or physical controls changed.
