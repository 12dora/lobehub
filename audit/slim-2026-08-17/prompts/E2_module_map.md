# E2 — Module inventory & toggle seams (which features could become optional, and how they are wired)

Read EXPLORE_RULES.md (same directory) first. Write the report to `../explore/E2_modules.md`.

Task: build the **candidate list of optional modules** and, for each, the exact wiring that a "module
registry / capability" mechanism would have to gate. This report is the backbone of the plan — be
precise about file:line and about upstream vs fork ownership.

## Scope of candidates (verify each; add ones you find; drop ones that are not separable)
Upstream features: knowledge base / RAG (file upload, chunking, embeddings, pgvector, ParadeDB pg_search
BM25), image generation (ai_image), TTS/STT, web search / crawler (searxng + web-browsing tool),
market / discover (assistant + plugin store, remote fetch), MCP / plugins / tool store, changelog,
chat SDK bots / messenger gateway (discord / telegram / slack / feishu / wechat / line / qq / imessage
adapters, `GatewayService`), agent signal, memory (user memory), notebook / pages / documents editor,
python interpreter / cloud sandbox, desktop / device gateway / remote device, heterogeneous agents
(claude-code / codex adapters), workflows (upstash), OIDC provider (`ENABLE_DATABASE_OIDC`? vs upstream
`ENABLE_OIDC`), casdoor/logto SSO providers, telemetry / langfuse / OTel, S3 file storage, Redis.
Fork (enterprise) features: admin console (ENABLE_PLATFORM_ADMIN), managed AI / skills / connectors /
agents, settings policy, runtime branding, database identity providers, audit / evidence / retention /
export, content moderation, network proxy (mihomo), platform stats, shared OAuth providers, task
templates, ChatGPT web provider, DingTalk login.

## For every candidate, report
1. Ownership: upstream / fork / mixed. Rough size (files, LOC; `git ls-files | xargs wc -l` on its dirs).
2. Existing switch (if any): env var / FEATURE_FLAGS key / enterprise flag / server config field —
   file:line, default value, and **what the switch actually gates** (UI only? tRPC router mount?
   background job? DB migration? startup import?). Call out switches that only hide UI while the server
   still eagerly loads/runs the code.
3. Server-side wiring points that would need gating for a *real* disable: tRPC router registration
   (`apps/server/src/routers/**`, lambda/async/edge/tools routers), webapi routes under
   `src/app/(backend)/**`, startup imports (`src/instrumentation.ts`, `apps/server/src/enterprise/bootstrap`),
   background jobs / schedulers, Redis / S3 / external-service clients constructed at import time,
   heavy top-level imports (model-bank, tiktoken, pdf/office parsers, sharp, playwright, puppeteer …),
   DB tables/extensions only that module needs (pg_search / vector).
4. Client-side wiring points: sidebar / nav entries, routes in `src/spa/router/*`, feature-flag reads
   (`featureFlagsSelectors`), `serverConfig` fields (`platform.getCapabilities`, `globalConfig`,
   `__SERVER_CONFIG__`), i18n.
5. Admin-panel touchpoints: nav groups / routes under `src/features/Admin*` or `src/routes/(main)/admin/**`,
   permission codes (`PLATFORM_PERMISSIONS`), the security/policy registries for admin procedures.
6. Cross-module dependencies (e.g. moderation needs a provider; managed skills needs skills; audit needs
   S3 for export; knowledge base needs S3 + embeddings + pgvector).

## Also answer
- How the *existing* upstream `FEATURE_FLAGS` mechanism works end-to-end (env → server → client store →
  UI), and whether it is a good backbone to extend for "modules" or whether a separate `MODULES` /
  capabilities layer is cleaner (upstream-merge argument!).
- Whether upstream already has an "edition"/"business stub" concept (`packages/business*`, `src/business`)
  that could carry the module registry with minimal upstream diff.
- Where a single **server-side module registry** (`isModuleEnabled('knowledgeBase')`) would live so that
  the fewest upstream files change: e.g. one guard in the tRPC root router assembly, one guard in the
  webapi route handler wrapper, one in instrumentation, one in the SPA router config, one in the admin
  nav builder. Give file:line for each of these assembly points.
- Rank the candidates by (expected resource saving from E1's perspective: eager code + background work +
  external dependency) × (ease of gating). Section A must contain the top-10 ranked table.
