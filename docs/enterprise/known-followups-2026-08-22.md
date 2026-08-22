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

## Batch 2026-08-22b (attachments / native files / generation)
- **ChatGPT Web `auto` / `instant` still served as `gpt-5-5-mini` on the demo account.** The conduit-less conversation POST was fixed (prepare now awaited ≤4 s and the token attached — logs: `sending conversation with a conduit token`), but the served `model_slug` is unchanged, so the conduit timing was not the discriminator. Egress is the same `mac-upstream` node as Chrome. Next step per `chatgpt-web-pro-downgrade-investigation.md`: capture ONE fresh Chrome HAR of an `auto` turn (both prepares + `/f/conversation`) and A/B one variable at a time (cookie jar, `OAI-Session-Id`, `oai-echo-logs`, device id). Do not spam the account meanwhile.
- **Grok Build (cli-chat-proxy) refuses native files on zero-data-retention accounts** (`400 File content is currently unsupported for ZDR customers`). The runtime retries once with extracted text (`lobe-grok:zdr ZDR account refused native files; retried with extracted text`), so file turns still succeed. True native files need ZDR turned off at the xAI team level. `generateObject` is not retried.
- **SuperGrok Files API**: uploads use a fixed 24 h `expires_after`; public http(s) document URLs are downloaded and uploaded rather than passed as `file_url`.
- **Manual approval + sandbox export stalled once** (topic `tpc_lbejwBgCAgE7`, Grok Build): after approving `exportFile` the assistant turn stayed in "灵感加载中" for >6 min and no tool result was persisted; auto-approval on a fresh topic completed normally. Reproduce with the approval flow before blaming the provider.
- **Cloud sandbox only mounts in agent mode with `agencyConfig.executionTarget = 'sandbox'`**; a plain-chat agent (enableAgentMode=false) never sees the tool and models answer "no sandbox tool in this session". Demo agent `agt_m0lYKmWGKitu` was switched via DB for the experiment.
- **Codex `gpt-image-2` must be enabled on the chatgpt platform provider** (it is off by default after sync); ChatGPT Web's copy is separate.
- Demo: the memory tool's embedding provider is unconfigured (`userMemories.toolSearchMemory` → `InvalidProviderAPIKey` on every turn) — noise only.
- Demo compose: recreate `app` and `s3-forward` together (`up -d --force-recreate` without a service name); recreating only `app` leaves the sidecar's shared network namespace stale (`ECONNREFUSED 127.0.0.1:9010` in the inliner).
