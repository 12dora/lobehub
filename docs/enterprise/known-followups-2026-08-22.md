# Known follow-ups (batch 2026-08-21/22)

Items raised by code review that were judged low-impact / theoretical for this deployment and deliberately deferred. Each entry names the reviewing pass and the reason it was not fixed in-batch.

## Auth / sessions
- **Cross-instance positive liveness cache (5s).** `assertUserActiveCached` caches a positive session-liveness result for 5s per process; a revoke performed on another replica is honoured only after that window. Single-replica deployments are unaffected. (t4c #4)

## Settings policy admin page
- `headless` option label in the approval policy differs from the chat-side "Managed by your organization" wording; the option is not user-selectable so no behaviour impact. (t6a #1)

## Native search
- Chats that stored `useModelBuiltinSearch: false` on a provider whose search metadata is `internal` keep the flag; routing already ignores it. (C7 report)

## ChatGPT Web SSE
- Default `maxResumes` (3) may chain extra empty resumes when a leg withheld an ambiguous prefix; safe, only delays document recovery. (C5 report)

## Local sandbox
- Idle reaper / capacity are per-process plus label reconcile on start; cross-replica leasing is out of scope (single replica assumed). (t3 #4, by design)
- Sandbox egress is allowed by default (product decision); blocking private CIDRs requires a dedicated Docker network — see docs/self-hosting/environment-variables/cloud-sandbox.mdx.
