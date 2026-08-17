# E5 — Request-path and client-driven load (per-request cost, polling, caches, algorithmic hotspots)

Read EXPLORE_RULES.md (same directory) first. Write the report to `../explore/E5_request_path.md`.

Task: find what an *active* deployment pays per request and per connected browser tab, and list
algorithm / implementation-level optimizations. E1 covers boot + idle of the server process; you cover
"one admin and a few users are logged in".

## Measure (real machine, non-destructive, read-only accounts)
- Use the demo at http://localhost:3010 (creds: `~/.local/share/aihub/secrets/demo-admin-password.txt`
  → admin@aihub.local; `demo-user-password.txt` → user@aihub.local). Sessions are short — re-login as
  needed. Playwright is available (`bunx playwright` in the repo; a working login+screenshot helper
  from an earlier batch may exist at ../../batch/shot.mjs — reuse if present).
- With one browser tab idle on (a) the chat home, (b) `/admin` overview, (c) `/admin/system/status`
  (or whichever polls), (d) `/admin/audit/live`, record over 60s: number of tRPC/webapi requests, which
  procedures, their period, and server CPU (`docker stats aihub-demo-app` samples). Produce a table
  procedure / period / trigger (SWR refreshInterval, useEffect loop, EventSource/SSE, WebSocket) /
  file:line on the client / server cost (query count).
- Server logs (`docker logs aihub-demo-app --since 5m`) for per-request debug lines if any.

## Static analysis
1. tRPC context creation and middleware chain per request (`apps/server/src/**/context*`, `trpc`
   package): auth lookup, user settings fetch, permission resolution (`withPlatformPermission` — how many
   queries per admin call? is there per-request caching?), feature-flag provider reads (Redis on every
   call?), server config, i18n, model-bank list building. Count queries for one representative admin
   procedure and one chat request. Look for N+1 patterns, unbounded `Promise.all` fan-out, JSON.parse
   of large blobs per request, `structuredClone`/deep merges of large default objects
   (`DEFAULT_MODEL_PROVIDER_LIST`, agent configs), zod parsing of huge schemas per request.
2. Chat / streaming path: `ModelRuntime` construction per call (any expensive setup? provider list
   scanning?), moderation wrapper (regex worker, LLM judge — cost per message), network proxy
   `resolveEgress` per fetch, audit evidence writes per message (sync? batched?), token counting
   (tiktoken load), context engine, memory. Which of these are per-message fixed costs an operator
   would want to disable.
3. Caches: in-memory Maps / LRU without bounds or TTL, module-level singletons that grow (list them
   with file:line); SWR global config on the client (`dedupingInterval`, `refreshInterval`,
   `revalidateOnFocus`) and admin hooks that poll.
4. Client bundle: size of the SPA entry chunks (`dist/` or `.next/static` in the image; `vite build`
   report if cheap) — is the admin bundle code-split from the user app? Big deps loaded on the chat
   home (editor, pdf, mermaid, katex, xlsx …) that could be lazy.

## Output
- Section A: top-10 optimizations ranked by (expected saving × ease), each with file:line, whether it
  is upstream or fork code, and whether it is "algorithmic" (change the algorithm/caching) vs
  "toggle" (make it optional).
- Section B: measured polling table + query-count table.
- Section D: what not to touch (streaming correctness, auth, audit integrity).
