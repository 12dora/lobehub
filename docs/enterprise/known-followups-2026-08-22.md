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

## Scanned-PDF batch (2026-08-22 afternoon, live-tested on a 16-card scanned collage)
- **Image-only PDFs are rasterized server-side** (pdfjs + @napi-rs/canvas) and attached as page images for ChatGPT/ChatGPTWeb/Grok/SuperGrok/Cursor; triggered only when the extracted text is < 20 chars. Plain API providers (OpenAI/Anthropic/…) are not in the hook's provider set — add them to `OWN_ORIGIN_ATTACHMENT_INLINE_RUNTIMES` if needed.
- **Codex backend does not rasterize PDFs** (`input_file` of a scan → "blank page"); the official Codex client and ChatGPT web do their own conversion. Our page images are the equivalent.
- **Agent loops may still prefer tools over attached images** (Codex first trusted an empty tool read; Grok Build tried to upscale via the sandbox, which has no `pdftoppm`). Mitigated by the explicit notice + rewritten `<file>` body; dense pages get zoomed 2×2 tiles (t8). Consider adding poppler/pdf tooling to the sandbox image.
- `docker logs --since` returned nothing after the Docker Desktop crash/restart (daemon clock skew); use `--tail N` instead.
- Host crash on 2026-08-22: Docker image builds + parallel agent test suites + three agent-mode experiments (each spawning a sandbox container) saturated the CPU. Rule: one heavy job at a time; lower the Docker Desktop CPU cap before builds.

## Document render batch (2026-08-22 evening, design v2 P1–P3)
Codex review findings judged over-defensive or deferred to P4; everything else in the review was fixed in-batch.
- **Gotenberg endpoint is admin-configured and not run through the SSRF destination policy.** It is an internal sidecar URL set by `SYSTEM_OPERATE` admins — the same trust model as the mail and object-storage endpoints. The setting is validated as an http(s) URL; a hostname allowlist can be added if deployments need it.
- **Artifact cleanup after file deletion is best-effort (fire-and-forget after the row delete).** A crash between the row delete and the prefix purge leaves orphan objects under `files/render/<fileId>/`. The design's daily orphan-prefix scan (§13.3, P4) is the durable fix; until then `deleteDocumentRenderArtifacts` can be re-run by id.
- **No sha256 artifact reuse / `render.refs`** (§13.3): each file row renders its own artifacts. Duplicate uploads of the same deck render twice.
- **No per-page `text/<n>.md` artifacts, no xlsx `sheets[]` in metadata, no relevance-ranked page selection** (P4): the feed picks pages by explicit mention → visual pages → first page.
- **Retention days / orphan scan / feed counters on the status page** (§6.3, §13.7) are not implemented; the setting is stored but unused.
- **`viewDocumentPages` 3-calls-per-turn limit is prompt-only**; the runtime has no counter.
- **Custom providers with `sdkType: 'cursor'`** still receive the `viewDocumentPages` tool (the Cursor exclusion keys on the builtin `cursor` provider id; the agent service does not pass the resolved runtime provider into the tools engine yet).
- **Sidecar-outage retries have no backoff**: the worker marks the job failed (retryable) and the dispatcher retries on its next tick, so three attempts burn in seconds; `force` re-enqueue (tool or admin retry) recovers the document once the sidecar is back.
- **Sandbox attachment copies depend on an S3 URL the sandbox container can reach.** `Sandbox file init` hands the sandbox a presigned `S3_PUBLIC_DOMAIN` URL; on the demo that is `localhost:9010` (a socat forward inside the app container's namespace), so the curl inside the sibling sandbox container fails and `/mnt/data/uploads/` stays empty (the marker still reports `success=true`). Pre-existing; affects any deployment where the public S3 host is not routable from the sandbox network. Durable fix: push bytes through the local provider (Docker `putArchive`/exec-stdin) instead of curl. Live-tested 2026-08-22 (topic `tpc_3GOJtHIgRsdn`): Grok Build spent several tool turns hunting for the file.
- **`viewDocumentPages` tool message persisted with empty `content`** in one live run (topic `tpc_FtgwInJ6EPkg`, call `pages:[9], zoom:'tiles'`, page had no tiles so the runtime should have fallen back to the page PNG). The runtime never returns an empty string, so something between `ToolExecutionService` and message persistence dropped it; verify with `DEBUG=lobe-server:tools:*` on the next run and check the synthetic image turn reached the provider.
