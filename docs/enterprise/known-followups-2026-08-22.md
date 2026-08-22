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

## Document render batch (2026-08-22 evening, design v2 P1–P3; P4 closed 2026-08-22 night)

Codex review findings judged over-defensive, plus what P4 deliberately left open.

- **Gotenberg endpoint is admin-configured and not run through the SSRF destination policy.** It is an internal sidecar URL set by `SYSTEM_OPERATE` admins — the same trust model as the mail and object-storage endpoints. The setting is validated as an http(s) URL; a hostname allowlist can be added if deployments need it.
- **Artifact cleanup after file deletion is still fire-and-forget**, but the daily GC job (`platform.document.render.gc.v1`: orphan `files/render/` prefix scan + retention expiry + temp-dir sweep, admin "Run cleanup now") is now the durable backstop.
- **sha256 reuse copies artifacts per file** (no `render.refs`): duplicate uploads cost storage, not a second render. Reuse is not user-scoped on purpose — artifacts derive from identical bytes and carry no per-user data.
- **xlsx `sheets[].page` is not filled** — LibreOffice's page-per-sheet mapping is not reliable; sheet names only.
- **Feed counters are per process** (since process start; multi-replica deployments see one replica's numbers).
- **`viewDocumentPages` budget keys on `operationId`** (the whole user turn, 15 min TTL); fallbacks are `assistantMessageId`, then user+topic.
- **`viewDocumentPages` empty `content` (topic `tpc_FtgwInJ6EPkg`)**: no code path producing an empty string was found (runtime `ok()/fail()` always return text; executor/archive/persist pass it through). The runtime now logs `markerCount`/`contentChars` under `DEBUG=lobe-server:tools:document-pages` and never returns empty content; re-check on the next live run.
- **Sandbox push path does not reuse the topic-init copy** (`cp /mnt/data/<name>` → `uploads/…`): the push re-reads the object from S3. Remote sandbox providers (market/onlyboxes) still use presigned-URL curl.
- **Artifact reuse trusts the client-supplied `files.file_hash`** (codex P4 review #1). The upstream upload contract already deduplicates object storage by that hash (`checkHash` / `global_files`), so a spoofed hash already serves the first uploader's bytes to later uploaders; render-artifact reuse adds no new exposure. A server-verified digest at upload would close both at once.
- **Retention expiry vs. a concurrent retry/feed** (codex #4): GC selects old ready/partial rows and deletes without re-checking status under a lock; an operator retry issued in that window could lose its fresh artifacts once. Next scheduled render re-creates them; not serialized on purpose.
- **Feed notices/counters describe planned images** (codex #11): if an artifact object is missing at load time the notice may still claim it was attached. Cosmetic; artifacts only vanish through deletion/GC.

## Office preview batch (2026-08-23)

- **GC expiry vs. an on-demand preview conversion of the same file** (codex #4): GC deletes the prefix and clears `render.pdf` without a lock; a conversion that uploads in that window can leave a dangling `pdf` key for one request. The preview path checks object existence before presigning and reconverts on the next request, so the damage is one failed load. Not serialized on purpose.

## Sandbox interrupt + package ledger (2026-08-23)

- **Stop during sandbox cold start / before the pid file exists** (codex #2): `interrupt()` finds no container (or no `/tmp/lobe-fg-*.pid` yet) and reports `killed: 0`; the command then runs to completion or GNU `timeout`. Window is the provisioning time plus a few ms; closing it needs a pending-exec registry consulted at exec start. Not done on purpose — a second Stop a moment later works.
- **Ledger `installs` is a lifetime counter per (user, manager, package)** (codex #9): the window only selects which rows count (`last_at`), so a package installed 100× last year and once today shows 101. Documented in the contract and labelled "累计安装" in the UI; per-event storage is a follow-up if the ranking ever needs true windows.
- **Ledger records attempts, not verified installs** — the pattern is matched before the command runs (including strings inside `executeCode` source), capped at 20 packages per call and 500 rows per user.
