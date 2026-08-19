# Browser simulation alignment plan for ChatGPT Web

> Agent handoff document. Updated 2026-08-19.
>
> This plan intentionally includes only changes that are implementable in the existing
> server-side simulation architecture and have a credible connection to browser identity,
> request lifecycle, or expensive-model routing. It does not treat every observable HAR
> difference as a task.

## Objective

Align the server-side browser simulation closely enough to the observed ChatGPT Web session that
a requested Pro model is not silently served as mini, while keeping reusable browser-session
infrastructure provider-neutral.

The target architecture remains server-side. It may use a long-running impersonated transport,
but it does not require controlling the user's real Chrome for every inference.

## Current evidence and constraints

- Clean Chrome HAR baseline: a `gpt-5-6-pro` request was served by `gpt-5-6-pro`.
- The clean turn used two non-blocking prepare calls followed by `/f/conversation`.
- Both prepare calls returned `{ "status": "ok", "conduit_token": null }` after the
  conversation request was already in flight.
- All captured ChatGPT requests used one HTTP/2 connection.
- The requirements/proof/turnstile bundle on the conversation was not produced by the Sentinel
  prepare/finalize captured after that conversation; every digest differed. The captured
  handshake therefore prepared another bundle, most likely the next one.
- Real Sentinel finalize body keys were `prepare_token`, `proofofwork`, and `turnstile`.
- Current code synchronously obtains a new Sentinel bundle before every turn and sends
  `proof_token` / `turnstile_token` aliases.
- A current Chrome Copy-as-cURL carried 28 cookies, including chunked session cookies and the
  original `oai-did`. The normal AIHub paste flow discards that device id and creates a random
  one.
- Repeated validation has put the account/browser into a risk-controlled state where real Chrome
  also receives mini. No task in this plan should perform upstream validation until the real
  Chrome control is healthy again.

Existing fixes that agents must preserve:

- commit `bb19f8f225`: browser-impossible system turns are folded into user turns; real
  `model_slug` is observable;
- commit `0a720e3370`: null conduit token is normal; Pro defaults to `thinking_effort:
"standard"`; Pro prepare calls are non-blocking and share turn identity with the send;
  authenticated bootstrap detects the `/unauth-mweb/` shell; a Sentinel bundle pool
  (`sentinelBundlePool.ts`) replaces the per-turn synchronous handshake;
- commit `cd38ff93db`: C1/C2 landed as `apps/server/src/enterprise/services/browserSession/`
  (context registry + generalized cookie jar) plus a thin ChatGPT-specific adapter over it;
- commit `f40d0d7bb6`: G1/G2 landed — device-id mismatch rejection, `webSessionOnly` device
  preference, session-cookie chunk-shape preservation.

### Blocking requirement carried into G7 (from the Round 1 codex review)

An independent review of the C1/C2/G1/G2/G4 commits above found that the ChatGPT cookie jar
(`chatgptWeb/transport/cookieJar.ts` → `browserSession/cookieJar.ts`) and the Sentinel bundle pool
(`sentinelBundlePool.ts`) are both still keyed by **device id only**, not by account/credential
identity. `browserSession/contextRegistry.ts` exists but has **no production caller yet** — this
was expected at this stage (C1/C2 are foundation, not wiring), but it means today the same
physical browser device pasted for two different ChatGPT accounts (a real scenario now that G1
prefers the real, stable `oai-did` over a random per-connect id) would share jar and Sentinel
bundle state across those accounts. **G7 must close this**: every call site G7 touches needs to
key off the Browser Session Context (which already carries `provider + account/credential
identity + origin + browser-profile revision`), not off a bare device id. Treat this as an
acceptance criterion for G7, not an optional cleanup — do not consider G7 done while
`cookieJar.ts`/`sentinelBundlePool.ts` are still device-id-only.

### G3/G5/G7 landed — account-scoped context wiring (6 review rounds)

The Browser Session Context is now actually wired into the runtime
(`apps/server/src/enterprise/services/chatgptWeb/browserSession.ts`,
`packages/model-runtime/src/providers/chatgptWeb/sessionContext.ts`), closing the device-id-only
gap above: the jar, Sentinel pool, page session id, and bootstrap cache are all keyed by
`accountId` (the specific stored connection's own identity — provider revision, or
`user:workspace:provider` for BYOK — never the device id). Six independent codex review rounds
were needed to get this right; each found and closed a real, progressively narrower gap:
ownership-key threading at several construction call sites, a staged-verification design so
credential checks never touch the live context, cookie-family filtering during staging, commit-time
clearing of a stale prior-account session cookie, malformed-response rejection, and finally
reordering commit to happen only after durable vault persistence succeeds (never before).

**Known, deliberately accepted residual limitations — read before scaling this deployment:**

- **The context registry is process-local (in-memory), by original C1 design.** This was always
  the documented scope for this phase (C1's basic direction explicitly says "leave room for a
  distributed owner/lease implementation" as future work, not build one now). The 6th review round
  confirmed the consequence: **if this server ever runs as more than one OS process — multiple
  replicas, PM2/cluster mode, multiple Node workers — a same-device account switch persisted by one
  worker is invisible to the others**, which keep serving the old account's session cookie from
  their own warm in-memory context even after the new account's credential is durably stored. AIHub's
  current deployment (`ENTRYPOINT ["/bin/node"]` / `CMD ["/app/startServer.js"]`, one `app` service,
  no `deploy.replicas`) is single-process, so this is not an active risk today. **This is a hard
  blocking prerequisite for C3/C4 (or any horizontal-scaling change) — do not scale this server to
  multiple processes/replicas until the registry has a real distributed invalidation mechanism.**
- **The user-connect path (`oauthDeviceFlow.ts`) has no CAS/lock around its vault write**, unlike
  the admin path (which has `expectedRevision`/draft-token CAS on `applyProviderImmediate`). Two
  fully concurrent reconnects of the same stored connection could still commit/persist in
  interleaved order. This is far narrower than the original bug (requires overlapping reconnects of
  the same connection, not just "two accounts share a device"), and no existing cheap
  serialization primitive was found to reuse — building one from scratch was judged out of scope
  for this fix. Revisit if concurrent reconnects of the same user connection turn out to be a real
  operational occurrence.
- **`ChatGPTWebOAuthSessionOps.exchangeCallback`** (the original authorization-code-paste flow)
  still rotates the page session immediately after a successful token exchange, before the caller
  persists to the vault — the same class of bug fixed everywhere else in this round, just not here.
  This is currently **unreachable for `chatgptweb`** (the provider is `webSessionOnly`; both routers
  reject callback-based connections for it) — left as documented debt rather than risking a rushed
  fix to dead code. If any other authorization-code-paste provider ever reuses this same service
  class, this must be fixed first.

## Scope boundary

### Common browser-simulation infrastructure

The following concepts are provider-neutral and may be used by any browser-backed endpoint:

- persisted browser/device profile;
- logical browser-session context;
- provider/account/origin isolation;
- cookie storage, expiry, rotation, and chunk support;
- persistent impersonated transport and connection pooling;
- proxy/egress selection;
- context lifecycle, ownership, and cleanup;
- secret-safe request staging and logging.

Suggested home:

```text
apps/server/src/enterprise/services/browserSession/
├── contextRegistry.ts
├── cookieJar.ts
├── lifecycle.ts
├── transportPool.ts
└── types.ts
```

The current generic pieces under `apps/server/src/enterprise/services/chatgptWeb/transport/` may
move behind this layer. Keep a thin ChatGPT Web adapter for provider-specific behavior.

### ChatGPT Web-specific implementation

The following belong only to the ChatGPT Web provider and must not enter the common browser
profile or affect Grok/Cursor:

- `OAI-Device-Id`, `OAI-Session-Id`, and `oai-did`;
- ChatGPT web-session/access-token parsing and renewal;
- ChatGPT session-cookie chunking rules;
- authenticated ChatGPT bootstrap and client build markers;
- Sentinel prepare, proof-of-work, Turnstile, finalize, and bundle lifecycle;
- `OpenAI-Sentinel-*`, `X-Oai-Is-Client-Observation`, and `X-Oai-Turn-Trace-Id`;
- `/f/conversation/prepare`, `/f/conversation`, resume, recovery, and cleanup;
- Pro model effort and routing behavior.

Keep these under:

```text
packages/model-runtime/src/providers/chatgptWeb/
apps/server/src/enterprise/services/chatgptWeb/
```

### Existing shared-profile consumers

The global installation identity is also consumed by:

- Grok, which derives its agent id from `installationId`;
- Cursor, which derives a CLI session id from `installationId + conversationKey`.

The implementation must therefore preserve these invariants:

- never regenerate the global `installationId` because ChatGPT reconnects;
- never use the global `installationId` as ChatGPT's `oai-device-id`;
- never place ChatGPT cookies, Sentinel state, or OAI session state in the global profile;
- namespace browser contexts by provider and account;
- never share cookies or live transport connections between ChatGPT, Grok, and Cursor.

## Actionable tasks

### C1 — Common Browser Session Context

**Priority:** P0\
**Scope:** common infrastructure

Create a long-lived logical context keyed by at least:

```text
provider + account/credential identity + origin + browser-profile revision
```

The common context should own only provider-neutral state:

- context id;
- logical page id;
- created/last-used timestamps;
- browser-profile revision;
- cookie-jar reference;
- transport-pool key;
- lifecycle status and owner lease.

Provider-specific adapters may attach namespaced state, but the common type must not understand
OAI or Sentinel fields.

**Basic direction**

1. Add a context registry interface and process-local implementation.
2. Key the registry with a credential-safe digest rather than a token.
3. Add explicit `acquire`, `invalidate`, `touch`, and `release` operations.
4. Invalidate atomically when the device id, credential, proxy outlet, or profile revision changes.
5. Leave room for a distributed owner/lease implementation; persistent connections must have one
   active owner.

**Acceptance criteria**

- repeated requests for the same provider/account/profile reuse one context;
- different accounts never share jar/session/transport state;
- reconnect or profile revision invalidates the old context;
- Grok and Cursor retain their existing installation-derived identities;
- no credential appears in registry keys, logs, or metrics.

### C2 — Provider-isolated Cookie Jar

**Priority:** P0\
**Scope:** common infrastructure with provider-specific seed adapters

Generalize the existing Netscape jar so a Browser Session Context owns it. The common component
must support:

- duplicate/chunked cookie names;
- expiry and deletion;
- `Set-Cookie` rotation;
- atomic replacement;
- owner-only filesystem permissions;
- context-scoped cleanup.

ChatGPT-specific code remains responsible for deciding which cookies to seed.

**Basic direction**

1. Extract generic jar parsing/writing/merging from `chatgptWeb/transport/cookieJar.ts`.
2. Preserve cookie domain, path, secure, HttpOnly, expiry, and chunk suffixes.
3. Make jar reset part of context invalidation.
4. Keep response-written Cloudflare cookies when reseeding provider credentials.
5. Do not ingest every cookie from a Chrome export; only provider-declared credential and routing
   cookies should cross the connection boundary.

**Acceptance criteria**

- `.0/.1` session chunks survive read/write round trips;
- a rotated session removes obsolete chunks;
- response-created CF cookies survive reseeding `oai-did`;
- jar permissions remain 0600 and parent directory 0700;
- no cross-context cookie read is possible.

### G1 — Preserve the ChatGPT Device Binding

**Priority:** P0\
**Scope:** ChatGPT Web-specific

The Copy-as-cURL connection path must preserve the device that created the session.

**Basic direction**

1. Extend `parseChatGPTWebPaste` to return an optional device id.
2. Extract both `OAI-Device-Id` and `oai-did`.
3. If both are present and differ, reject the paste rather than choosing one.
4. Carry the device id through user/admin contracts and the shared connection service.
5. For `webSessionOnly`, prefer the pasted device id over the random authorization envelope id.
6. When only a bare session token is pasted, generate a device id once and persist it as a new
   logical browser connection.
7. Seed the ChatGPT jar and headers from the same stored value.

Primary files:

```text
packages/utils/src/chatgptWebPaste.ts
apps/server/src/enterprise/contracts/aiProviderOAuth.ts
apps/server/src/enterprise/routers/admin/aiProviderOAuthSupport.ts
apps/server/src/enterprise/services/chatgptWeb/oauthService.ts
apps/server/src/enterprise/services/chatgptWeb/oauthService.session.ts
```

**Acceptance criteria**

- pasted header/cookie device ids must agree;
- vault `oauthDeviceId`, outbound `OAI-Device-Id`, and `oai-did` are identical;
- reconnect with the same browser does not generate another id;
- a device change invalidates the previous ChatGPT Browser Session Context and jar;
- raw device/session/token material is never logged.

### G2 — Preserve ChatGPT Session-Cookie Shape

**Priority:** P0\
**Scope:** ChatGPT Web-specific adapter over C2

Keep a logical session token for refresh bookkeeping, while writing browser-shaped chunks to the
outbound jar.

**Basic direction**

1. Preserve original `.0/.1/...` chunks when the paste supplies them.
2. If the upstream rotates to one logical token, split it using the same conservative cookie-size
   boundary before writing the jar.
3. Remove every stale chunk before installing the new set.
4. Continue treating the vault token as authoritative; the jar is transport state.

**Acceptance criteria**

- a two-chunk Chrome paste remains two chunks outbound;
- rotation cannot leave an old `.1` beside a new unchunked cookie;
- `/api/auth/session` mint and refresh continue to work;
- the logical token can still be compared/CAS-updated without depending on chunk layout.

### G3 — Authenticated ChatGPT Bootstrap

**Priority:** P0\
**Scope:** ChatGPT Web-specific

The page bootstrap should use the active ChatGPT cookie jar, exactly as a browser navigation does.
It must still omit Bearer and OAI request headers.

**Basic direction**

1. Attach the private context/jar reference to bootstrap transport requests.
2. Keep the navigation header allowlist.
3. Parse build number, client version, and Sentinel SDK/resource markers from authenticated HTML.
4. Cache them on the ChatGPT namespaced state attached to C1.
5. Use pinned constants only after an explicit failed/unauthenticated bootstrap.

Primary files:

```text
packages/model-runtime/src/providers/chatgptWeb/client.ts
packages/model-runtime/src/providers/chatgptWeb/headers.ts
packages/model-runtime/src/providers/chatgptWeb/constants.ts
apps/server/src/enterprise/services/chatgptWeb/transport/
```

**Acceptance criteria**

- a valid web session no longer always receives `unauth-mweb`;
- bootstrap sends cookies but no Authorization/OAI headers;
- parsed build/version are used by later requests in the same context;
- profile/device change clears cached bootstrap resources.

### G4 — Sentinel Bundle Manager

**Priority:** P0\
**Scope:** ChatGPT Web-specific

Replace the per-turn synchronous Sentinel handshake with a context-scoped pool of ready bundles.

Each bundle contains the requirements token, proof token, Turnstile token, expiry, and consumption
state. It is single-use unless evidence proves otherwise.

**Basic direction**

1. On context initialization/reconnect, synchronously warm one bundle.
2. A turn atomically acquires one ready bundle.
3. The turn sends conversation requests without starting another blocking handshake.
4. After the conversation starts, replenish the next bundle asynchronously.
5. Bind bundles to context/device/profile/build revision.
6. Discard expired, failed, consumed, or superseded bundles.
7. Serialize acquisition with a lease so concurrent turns cannot spend the same bundle.
8. Use the HAR field names in finalize:

   ```json
   {
     "prepare_token": "...",
     "proofofwork": "...",
     "turnstile": "..."
   }
   ```

Primary files:

```text
packages/model-runtime/src/providers/chatgptWeb/client.ts
packages/model-runtime/src/providers/chatgptWeb/sentinel.ts
packages/model-runtime/src/providers/chatgptWeb/pow.ts
packages/model-runtime/src/providers/chatgptWeb/types.ts
```

**Acceptance criteria**

- a ready bundle is acquired before a turn without a same-turn Sentinel handshake;
- the next handshake may overlap the current conversation stream;
- the current conversation bundle and replenished bundle are distinct;
- no bundle can be acquired twice under concurrency;
- stale proof replay is impossible;
- finalize request keys exactly match the HAR;
- failed replenishment leaves the current turn intact and makes the next acquisition retryable.

### G5 — ChatGPT Page Session ID

**Priority:** P0\
**Scope:** ChatGPT Web-specific adapter over C1

Map the Browser Session Context's logical page id to `OAI-Session-Id`.

**Basic direction**

1. Generate a UUIDv4 when a ChatGPT context is created.
2. Persist it with that logical context rather than deriving it from a process nonce.
3. Reuse it across `/api/auth/session`, `/me`, `/models`, Sentinel, prepare, conversation, resume,
   document recovery, and hide calls.
4. Rotate on reconnect, explicit logical reload, or profile/device change.

**Acceptance criteria**

- all ChatGPT endpoints in one context use the same UUID;
- a Node/Next runtime construction does not rotate it;
- reconnect/profile/device changes do rotate it;
- other providers do not receive or depend on this value.

### G6 — Pro Turn Coordinator

**Priority:** P0\
**Scope:** ChatGPT Web-specific

Retain and finish the current workspace implementation rather than returning to a prepare gate.

**Basic direction**

1. Acquire one Sentinel bundle from G4.
2. Create one turn trace/observation identity.
3. Start prepare `success` and prepare `sent` using the same context and identity.
4. Start `/f/conversation` without waiting for either prepare response.
5. Observe prepare completion to avoid unhandled errors.
6. Ignore a conduit token that arrives after send; null remains normal.
7. Route all three requests through the same C3 transport session when available.

**Acceptance criteria**

- conversation begins before either prepare response settles;
- prepare and send share trace id and observation suffix;
- `conduit_token: null` never invokes the legacy endpoint;
- a late prepare failure cannot crash an already-running turn;
- real `model_slug` remains observable.

### C3 — Persistent Impersonated Transport

**Priority:** P1\
**Scope:** common infrastructure; initially consumed by ChatGPT Web

The current one-process-per-request curl adapter cannot reproduce HTTP/2 connection continuity.
Replace it with a long-running transport worker or sidecar that owns connection pools.

Possible implementation directions:

- a small libcurl-multi sidecar with local RPC;
- another maintained client capable of the required Chrome TLS/H2 impersonation and persistent
  pools;
- a long-running helper process rather than invoking curl CLI per request.

Do not expose credentials in argv or process telemetry.

Pool keys must include at least:

```text
browser context + origin + proxy/egress outlet + impersonation profile revision
```

**Acceptance criteria**

- related prepare/conversation/Sentinel requests reuse one HTTP/2 connection;
- parallel streams are multiplexed rather than serialized;
- different browser contexts do not share Cookie state or authenticated connections;
- changing proxy/profile/context drains the old pool;
- request abort, deadlines, streaming backpressure, and response-header parsing remain correct;
- secrets continue to travel over private IPC/stdin, never argv.

### C4 — Context Ownership and Cleanup

**Priority:** P1\
**Scope:** common infrastructure

Productionize C1/C3 so long-lived sessions do not leak resources or split ownership.

**Basic direction**

1. Add one active owner lease per context.
2. Add idle expiry and a bounded context count.
3. Drain connections before removing jars/state.
4. Fence every state write with profile/context revision.
5. On reconnect, invalidate old credentials, bundles, jar, bootstrap cache, and transport together.
6. Provide deterministic cleanup hooks for tests and shutdown.

**Acceptance criteria**

- no unbounded jar/context/child-process growth;
- stale workers cannot write into a replacement context;
- cleanup of one account cannot affect another;
- crash recovery produces a new coherent context rather than a partial old one.

### G7 — Route All ChatGPT Endpoints Through One Context

**Priority:** P1\
**Scope:** ChatGPT Web-specific integration

Make the context the single source of browser identity for:

```text
GET  /
GET  /api/auth/session
GET  /backend-api/me
GET  /backend-api/models
POST /backend-api/sentinel/chat-requirements/prepare
POST /backend-api/sentinel/chat-requirements/finalize
POST /backend-api/f/conversation/prepare
POST /backend-api/f/conversation
POST /backend-api/f/conversation/resume
GET/PATCH conversation document endpoints
```

Each endpoint keeps a strict allowlist of headers. Blob/CDN requests must not inherit OAI,
Authorization, Sentinel, or private context headers.

**Acceptance criteria**

- device id, page session id, profile revision, jar, build markers, and transport context remain
  coherent across the listed endpoints;
- navigation and session-mint requests omit inappropriate Bearer/OAI headers;
- prepare omits Sentinel proof headers;
- conversation sends the acquired Sentinel bundle;
- off-origin asset requests receive none of the ChatGPT identity headers.

## Dependency and implementation order

```text
C1 Browser Session Context
 ├─ C2 Cookie Jar
 │   ├─ G1 Device Binding
 │   ├─ G2 Session Cookie Shape
 │   └─ G3 Authenticated Bootstrap
 ├─ G5 Page Session ID
 └─ G4 Sentinel Bundle Manager
      └─ G6 Pro Turn Coordinator

C3 Persistent Transport
 ├─ C4 Ownership/Cleanup
 └─ G7 All-endpoint Integration
```

Recommended delivery sequence:

1. C1 and C2;
2. G1 and G2;
3. G3 and G5;
4. G4 and G6;
5. C3 and C4;
6. G7 integration and regression suite.

## Extending isolation to Grok and Cursor

C1/C2 (`apps/server/src/enterprise/services/browserSession/`) were built provider-neutral, but only
ChatGPT Web was ever wired to them. Grok and Cursor were investigated (research pass, 2026-08-20)
to see whether they could reuse the same context/cookie-jar machinery. **They cannot, structurally
— do not attempt to wire them into `browserSession/{contextRegistry,cookieJar}.ts`:**

- Grok is a stateless Bearer-token JSON API client (`packages/model-runtime/src/providers/grok/index.ts`).
  No cookies, no TLS/H2 impersonation, no persistent connection object — plain `undici.fetch`. There
  is nothing for a cookie jar or an impersonated transport to hold.
- Cursor doesn't make its own HTTP calls at all. `apps/server/src/enterprise/services/cursorAgent/transport.ts`
  spawns the real, official `cursor-agent` CLI binary per turn and relays its stdout; the genuine
  CLI does its own networking with its own TLS stack. AIHub never needs to impersonate a browser for
  Cursor, because it is running the real client.

However, the investigation found a **real, distinct isolation gap in both** — structurally similar
in spirit to the ChatGPT bug this whole plan fixes, but shaped differently enough that it needs its
own, separate tasks, not a reuse of G1–G7:

### GX1 — Account-scope the Grok agent identity

**Priority:** P2 — no evidence of active harm today; this is a deliberate design question, not an
obvious bug. Do not implement without an explicit decision (see below).

`deriveGrokAgentId` (`packages/model-runtime/src/browserProfile/identity.ts`) is a pure function of
the single, global, deployment-wide `installationId` — `UUIDv5("aihub-grok-agent:" + installationId)`.
Every stored Grok connection on a deployment (the platform-managed shared account, and any number of
individual users' own BYOK connections) therefore presents the **identical** `x-grok-agent-id` to
xAI, always, by construction. This is the SAME shape of problem G1 fixed for ChatGPT (identity not
scoped by account) — except here it is the current, deliberate, documented design (see "Existing
shared-profile consumers" above: "Grok... derives its agent id from `installationId`"), not an
accident.

**Decision needed before implementing:** is a single shared `x-grok-agent-id` across every account
on a deployment an acceptable simplification, or a real risk? xAI may or may not correlate/rate-limit/
risk-score by this header the way chatgpt.com does by device id — that is currently unknown and
unresearched. Do the same kind of evidence-gathering this plan's ChatGPT investigation did (HAR
comparison, documented account behavior) before assuming this needs fixing; do not fix it reflexively
just because it looks structurally similar.

**If the decision is to fix it:** fold an account-scoped identity (reuse the same
`accountId` shape ChatGPT Web uses — provider revision, or `user:workspace:provider` for BYOK; do
not invent a second convention) into `deriveGrokAgentId`, so distinct stored connections present
distinct agent ids. Keep it stable across reconnects of the same stored connection. The global
`installationId` itself must not be touched — only how Grok further derives its own header value
from it changes. `x-grok-user-id` (already derived per-request from the JWT's `principal_id`/`sub`
claim) already differentiates accounts at the wire level for THAT header — check whether that
alone is sufficient before concluding `x-grok-agent-id` also needs to change.

### CX1 — Isolate the Cursor CLI state cache per connection

**Priority:** P1 — this one has a more concrete correctness case, independent of any xAI-style
"design decision."

`apps/server/src/enterprise/services/cursorAgent/transport.scratch.ts` maintains ONE shared
`config-seed` directory per server instance (`ensureCursorAgentStateDir`), holding the CLI's own
`authInfo`, `version`, and `privacyCache.ghostMode` (`cli-config.json`) plus `statsig-cache.json`.
This is copied into every turn's scratch dir as a starting point and best-effort copied back
afterward, **regardless of which stored Cursor connection (platform-shared, or any user's own BYOK)
is making that turn.** Two different accounts' turns on the same server instance currently read and
write the same cache.

The actual bearer credential is NOT at risk here — `CURSOR_AUTH_TOKEN` is passed fresh per spawn via
env, and `AGENT_CLI_CREDENTIAL_STORE=memory` already stops the CLI from persisting it to its own
on-disk store. The risk is state bleed, not credential leak: one account's ghost-mode/privacy
preference, cached CLI version negotiation, or statsig experiment bucket could silently apply to a
completely different account's turn.

**Basic direction:**

1. Key the config-seed directory by the same `accountId` concept (one per stored Cursor connection),
   not one global directory per server instance.
2. Confirm nothing in `authInfo`/`statsig-cache.json` is actually credential-shaped before assuming
   the fix is purely a correctness improvement — verify the "no real leak" premise above rather than
   taking it on faith.
3. Preserve existing per-turn scratch-dir creation/cleanup and the compare-and-swap-on-digest
   copy-back behavior; only the "which persistent seed dir do we start from" part changes.

**Acceptance criteria:** two different stored Cursor connections never read or write the same
config-seed directory; the platform-managed shared connection's seed stays stable across turns and
reconnects, same as today; per-turn scratch/cleanup timing is unaffected.

## Validation policy

Most validation must be offline until the account's real Chrome control again returns Pro.

Offline tests should cover:

- HAR-exact request bodies and header allowlists;
- context identity and invalidation;
- cookie chunking and rotation;
- Sentinel bundle single-consumption/concurrency;
- non-blocking prepare/send ordering;
- persistent-transport connection reuse against a local HTTP/2 fixture;
- cross-account and cross-provider isolation;
- secret redaction and argv exclusion.

When the control recovers:

1. make one real Chrome Pro request and verify its true `model_slug`;
2. capture both prepares, conversation, and the overlapping next Sentinel handshake;
3. make one AIHub request with G1–G6 enabled;
4. judge only by observed `model_slug`;
5. stop immediately if real Chrome again returns mini.

## Deliberately excluded work

The following are not implementation tasks for this plan:

- fabricating `oai-echo-logs` without a real ChatGPT page lifecycle;
- random typing delays or synthetic human-behavior events;
- importing all 28 Chrome cookies into production storage;
- further UA/timezone/screen tweaking after the captured values already match;
- reproducing the complete Chrome JS/DOM/Service Worker environment in Node;
- changing upstream conversation persistence for the initial-turn Pro downgrade;
- relying on copied/stale Sentinel proof tokens;
- fixed artificial delays chosen only because one HAR showed 98 ms;
- assuming any change can reset an account/device risk score that has already been applied.

These items are either not authentically achievable in the current architecture, lack a credible
causal link to the clean first-turn downgrade, or risk making the simulated identity more
synthetic rather than less.
