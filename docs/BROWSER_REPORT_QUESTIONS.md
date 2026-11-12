# Browser report questions

This implements the browser follow-up flow for approved improvement 12. The browser can ask about
an explicitly shared report's original calculated facts. Its provider/model choice
is prefilled from that report, and each request requires a fresh five-minute
review. Generating and saving are separate actions. This does not import newer
Health history, train a model or command hardware.

## Provider boundary

The browser uses the person's own key for one direct request; there is no shared
server secret or Pod proxy. Keys remain in request memory and are cleared from
the form when the review begins. Hidden pages, account changes, cancellation and
review expiry withdraw the request. No browser storage or service-worker cache
is used for keys, unsaved answers or report evidence. A secure browser context is
required; ordinary HTTP at the Pod's LAN address remains a reader and explains
the HTTPS/iPhone alternatives. The separate remote gateway still needs deployment.

OpenAI uses [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
with `store: false`, no tools and no automatic retries. This flag is not a promise
that all provider retention is disabled. Gemini uses
[generateContent](https://ai.google.dev/api/generate-content), and Anthropic uses
Messages with its documented browser-access header. Anthropic
[organization policies](https://platform.claude.com/docs/en/manage-claude/authentication)
can reject browser requests even with a valid key; the native client remains an
alternative. Credentials are never sent as URL query parameters.

An Ollama destination must be an explicit HTTPS origin, or HTTP on this browser's
loopback host. Its `/api/generate` response must finish normally. Its operator must
allow the app origin using [Ollama's origin configuration](https://docs.ollama.com/faq).
This is not a server-side arbitrary-URL proxy. It receives no cloud-provider key.
Apple's local model is not exposed by the browser and never falls back to cloud.

All providers have bounded response sizes, request cancellation and complete-text
checks. Refusals, tool requests and token-truncated answers are not saved as normal
answers. Failed requests may still incur provider charges; the UI does not retry.

## Account and save contract

Before and after generation, verify current account access and the original
report revision. The same checks precede the optional upload. Owner and personal
transports use their separate existing endpoints. The personal path never carries
an owner key and pins the authenticated sleeper header.

The upload appends an answer to the immutable original and supplies its current
revision. Its reply is followed by an authenticated read-back. A lost reply enters
an uncertain state; a read either finds that exact answer, confirms the unchanged
copy before another explicit save, or requires refreshing a changed report.
The user's separate encrypted iPhone archive is not silently overwritten.

```mermaid
flowchart LR
  Report[Saved report and revision] --> Review[Question, facts and destination]
  Review -->|Explicit send| Model[Chosen provider]
  Model --> Verify[Recheck account and report]
  Verify --> Answer[Unsaved rendered answer]
  Answer -->|Separate save consent| Pod[Append with expected revision]
  Pod --> Read[Authenticated read-back]
```

## Verification record

The report and personal-web regression suite passes 290 tests, including
cancellation, changed accounts, expiry, source preservation, consent,
oversized/unfinished output and uncertain-save recovery. The production build,
focused lint and all 17 browser scenarios pass. The browser cases cover mobile,
tablet dark mode, desktop, provider errors, cancellation after dispatch, separate
save consent, lost-save read recovery and personal routes that never upload to
the owner's library.

An initial browser run found duplicate React sibling keys that could retain a
withdrawn report. Distinct reading/question keys corrected it; withdrawal and
account-revision scenarios now verify that the old content is removed. The first
build's fixture inference error was corrected by parsing the actual report schema.
The first nine question-flow captures and empty detector result are retained under
`.impeccable/review/report-questions/`; earlier failures are retained separately.
The independent review identified lost keyboard focus, generic provider errors
and missing read-recovery progress. The fix batch adds logical phase focus,
controlled error categories and cancellable read-back progress. A keyboard-only
scenario traverses review, cancellation, answer and both consent steps; delayed
read-back and usage-limit scenarios also pass. Twelve fresh captures are retained
in `.impeccable/review/report-questions-fixed/`. The independent verdict scored all four findings resolved and returned `ship`
for that fix batch. The extension retains the existing typography, palette and
report components; it does not replace any design-system files. Hosted checks
and live provider/Pod acceptance remain pending. No personal records or real provider keys were used.
