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

Validation: 37 targeted HTTP/history tests, TypeScript and focused ESLint passed.
They cover authenticated account resolution, unavailable upload, unauthorized
sessions and continued rejection of personal credentials by legacy APIs. Native
phone/tablet review, hosted checks and paired release are separate acceptance.
No live controller configuration, Health records or physical controls changed.
