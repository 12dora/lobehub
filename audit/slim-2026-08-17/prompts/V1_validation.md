# V1 — End-to-end validation of the slim batch on a real image (three tiers + load)

You are the validation agent. Read audit/slim-2026-08-17/PLAN.md
§7 (acceptance) and §4b (load view), and the F1 report (…/scratchpad/slim/reports/F1.md) for the admin page behaviour.
Image under test: `aihub:slim-final` (built from branch feat/slim-modules; the commander tells you the tag if different).
Reference environment: docker network `aihub-dev_aihub-dev`, DB copy `lobechat_perf` (postgres container aihub-dev-postgres,
user postgres / password change_this_password_on_production), Redis `redis://aihub-dev-redis:6379/3`. Env files:
`/Users/konata/code/AIHub/.env.development` and `~/.local/share/aihub/demo/.env.platform`; the demo compose
(`~/.local/share/aihub/demo/docker-compose.app.yml`) lists the `environment:` entries to replicate with `-e` (DATABASE_URL →
lobechat_perf, REDIS_URL db 3, AUTH_COOKIE_PREFIX=aihub-perf, APP_URL=http://localhost:302X, PORT=3210, publish 127.0.0.1:302X:3210).
Admin creds: admin@aihub.local / `~/.local/share/aihub/secrets/demo-admin-password.txt`; user@aihub.local /
demo-user-password.txt. Playwright: `/Users/konata/code/AIHub/e2e/node_modules/playwright/index.mjs`; a working login+request-recorder
script is at …/scratchpad/slim/explore/e5_raw/measure.mjs (reuse the login flow; sessions are short — re-login as needed).
Put scripts/outputs under …/scratchpad/slim/uat/. Do NOT touch aihub-demo-app (3010) or the aihub-dev-* containers.

## 1. Three tiers, one container each (sequential; name aihub-uat-{full,standard,minimal}; ports 3024/3025/3026)
For each tier (env `LOBE_MODULE_PRESET=full|standard|minimal`; also `LOBE_NODE_HEAP_MB=1536`):
- boot; wait Ready; record boot time, `docker stats` RSS after 60s idle, CPU% median over 60s idle (20 samples), DB xact/s
  (`SELECT xact_commit FROM pg_stat_database WHERE datname='lobechat_perf'` delta/60s), and the `[modules] worker … skipped` log lines.
- Playwright as admin: open `/admin` (guide card visible only if `platform_module_settings` row absent — first tier: note it),
  `/admin/system/modules`: assert preset badge matches the tier, env-controlled rows show the badge and are disabled,
  summary bar renders; screenshot. Visit every admin nav entry (crawl the side nav) — 0 console errors / 0 page errors; for
  disabled modules assert the nav item is hidden and a direct link (e.g. /admin/audit/logs, /admin/audit/content-moderation,
  /admin/system/general?tab=network-proxy, /admin/agents, /admin/ai/connectors, /admin/ai/task-templates) renders 「模块未启用」
  (not 404, not 加载失败) with the env variable named; screenshot one.
- Playwright as user: chat home loads (0 errors); with knowledgeBase off (standard/minimal) the knowledge-base entry is hidden;
  with market off the market/discover entry hidden; record first-screen JS bytes/file count (from request log) for comparison
  with E5 (33.8MB/423 files) and F2 (22.4MB/127).
- API probes with the admin cookie: a disabled lazy router (`GET /trpc/lambda/knowledgeBase.getKnowledgeBases` on minimal) → 403
  `PLATFORM_MODULE_DISABLED`; an enabled core call → 200; `POST /api/agent/gateway/start` (bots off) → 200 `{disabled:true}`.
- Idle RSS 5 min after the browsing burst.
## 2. Full-tier module page round-trip (on the `full` container, DB row will be created)
- As admin on `/admin/system/modules`: click preset 「标准」→ save → confirm DangerConfirm for 审计 (if shown) → toast → row
  states update; the restart banner appears listing restart-kind modules; nav hides the now-disabled modules; direct link degrades
  with the "enable under 系统 → 模块" hint (not env). Then click 「立即重启」 (supervisor mode: `PLATFORM_RESTART_MODE=supervisor`
  env; container needs `--restart unless-stopped` so it comes back) → wait for the instance to return → banner gone, workers skipped in
  the log. Then set preset 「完整」 → save → restart → verify back to full. Screenshots at each step.
- Note: `admin.modules.update` audits to the operation log — check `/admin/audit/logs` shows `admin.modules.update`.
## 3. Load comparison (full vs minimal), same DB
- Start a fake OpenAI-compatible streaming server on the host (node script under uat/: `POST /v1/chat/completions` returning
  ~200 tokens SSE over 2s, `GET /v1/models`); make it reachable from containers via `host.docker.internal:<port>`.
- As admin, configure the platform-managed provider `openai` (or user BYOK for user@aihub.local via settings API) with that baseURL,
  and verify one chat completes in the UI.
- Drive 20 concurrent chat sessions for 2 minutes with the user cookie against `/webapi/chat/openai` (or the route the UI uses —
  capture it from the browser once) while one admin tab sits on `/admin`; sample container CPU/RSS every 3s and DB xact/s; p50/p95
  request latency. Repeat on the minimal container. Table: tier × {CPU p50/p95, RSS start/end, xact/s, latency p50/p95, errors}.
## 4. Report
…/scratchpad/slim/reports/V1.md (≤150 lines): tables for §1–3, list of every assertion with pass/fail, screenshots list, and
anything that looks wrong (with the exact URL / log line). Clean up all uat containers and the fake server. Final message =
report path + the §1 table + pass/fail count.
