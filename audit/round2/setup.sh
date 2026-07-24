#!/usr/bin/env bash
# Setup harness for AIHub Enterprise 二开 — independent audit round 2.
# Generates one self-contained Codex prompt per partition.
set -euo pipefail
ROOT=/Users/konata/code/AIHub
cd "$ROOT"
mkdir -p audit/round2/partitions audit/round2/logs audit/round2/prompts

read -r -d '' PREAMBLE <<'PRE' || true
You are a senior software architect and code-quality auditor performing an INDEPENDENT, from-scratch audit of the "AIHub" enterprise secondary-development (二开) layer, which is built on top of the open-source LobeHub monorepo.

=== ENTERPRISE 二开 BOUNDARY (what counts as in-scope for REPORTING) ===
The 二开 layer lives in these roots:
- src/enterprise/**                         (client / SPA admin console)
- apps/server/src/enterprise/**             (server: services, routers, security, guards, contracts)
- packages/database/src/{models,schemas,repositories}/platform/**
- packages/database/migrations/0135_*.sql .. 0146_*.sql   (enterprise migrations)
- packages/types/src/platform/**  and  packages/const/src/platform/**
- src/business/**  and  packages/business/**
- scripts/enterprise/**
- the `admin` i18n namespace (packages/locales/src/default/admin.ts, locales/en-US/admin.json, locales/zh-CN/admin.json)
Everything else is UPSTREAM LobeHub and is OUT OF SCOPE for reporting.

=== HARD RULES ===
1. Audit and REPORT issues ONLY for files inside YOUR PARTITION (listed at the bottom). You MAY read any other file (upstream or other partitions) to understand contracts, call sites and context, but only report a finding when its fix belongs to a file in your partition.
2. Upstream LobeHub defects are OUT OF SCOPE — do not report them.
3. This is an INDEPENDENT audit. Do NOT open or read the `audit/` directory or any prior audit report. Form every conclusion directly from the source.
4. You are in a READ-ONLY sandbox: you cannot and must not modify, create, or delete any file. Do not attempt writes or run any mutating command.
5. No speculation. Before reporting, read the actual code path and confirm the defect is real. If you cannot fully confirm, mark Confidence LOW and explain the gap.

=== FIVE AUDIT DIMENSIONS ===
① Code smells — over-long functions/files/classes; duplicated logic; deep nesting; tangled conditionals; muddled/mixed responsibilities; circular dependencies; over-coupling; magic values; unclear naming; ineffective/leaky abstractions; unhandled exceptions/rejections; resource leaks (unclosed handles, un-awaited promises, missing cleanup); obvious performance problems (N+1 queries, unbounded/paginationless queries, work in tight loops, redundant re-computation, missing indexes surfaced in queries).
② Test rot — dead/duplicated tests; long-`skip`/`todo`/`only` tests; tests with no meaningful assertions; flaky tests coupled to execution order, wall-clock time, timezone, randomness, network, or shared/global mutable state; tests that assert stale or wrong behavior (i.e. they lock in a bug); missing critical regression tests for risky logic in this partition. For each, state the action: DELETE (no value), FIX (valuable but broken/wrong), or ADD (missing regression).
③ Dead code & dev cruft — unused functions/classes/vars/exports/types/deps/config/scripts/assets; deprecated compatibility code with zero callers; commented-out old code; leftover debug/console/temporary code; stale or false TODO/FIXME; committed build artifacts, caches, backups, sample junk, duplicate/contradictory config.
④ Missing Simplified-Chinese (zh-CN) i18n — user-facing strings hardcoded in TSX/TS instead of using i18n keys; keys present in en-US but MISSING in zh-CN; keys whose zh-CN value is still English (untranslated); keys referenced in code (t('...')) but absent from the locale files; wrong namespace usage.
⑤ Functional bugs (FRONTEND + BACKEND) — real correctness defects: race conditions and lost-update/overwrite bugs; fail-OPEN authorization or missing authz checks; CAS/optimistic-concurrency gaps; state that strands or misreports a committed change; FE/BE contract mismatches (client sends/expects a shape the server does not honor, and vice-versa); wrong error handling / swallowed errors; secret or PII leakage; injection / SSRF / path traversal; incorrect pagination or filtering; enable/disable or delete flows that leave dangling references. THESE ARE THE HIGHEST-VALUE FINDINGS — hunt them aggressively, especially at authorization, state-mutation, concurrency, secret-handling, and FE↔BE boundaries.

=== METHOD ===
- Explore strategically with grep/read; you need not read every line. Start from the riskiest surfaces: authorization/registration, write/mutation paths, concurrency & transactions, secret handling, and the client↔server contract.
- Trace at least the critical mutation and authorization paths end-to-end (UI action → service → db) to catch contract mismatches and fail-open logic.
- Rank each finding: CRITICAL (data loss / security / authz bypass / evidence destruction) > HIGH (serious correctness or state loss) > MEDIUM (real but bounded) > LOW (polish / minor).

=== OUTPUT FORMAT (STRICT) ===
Your FINAL message IS the report and is captured verbatim to a file. Do NOT write files yourself. Do NOT include any greeting, plan, or trailing commentary. Begin directly with the heading. Use exactly this Markdown:

# Partition: <NAME>

## Summary
One short paragraph on the overall health of this partition, followed by counts: `CRITICAL: n · HIGH: n · MEDIUM: n · LOW: n`.

## Findings
Number findings F1, F2, … ordered by severity (highest first). Each finding:

### F<n> [<SEVERITY>][D<dimension number 1-5>] <concise title>
- **Location:** `path:line` (list every relevant `path:line`)
- **Evidence:** what the code actually does — quote the key line(s).
- **Impact / failure scenario:** concrete inputs or sequence → the wrong outcome.
- **Fix:** the specific, minimal change.
- **Confidence:** HIGH | MEDIUM | LOW

## Dimension coverage
One line each for ①②③④⑤: what you checked and whether it is clean or where issues cluster.

If a dimension is genuinely clean, say so explicitly — do NOT invent findings to fill space. Precision beats volume, but do not miss real defects. Report as many real findings as exist.
PRE

gen () {
  local name="$1"; shift
  local scope="$1"
  {
    printf '%s\n\n' "$PREAMBLE"
    printf '=== YOUR PARTITION: %s ===\n%s\n' "$name" "$scope"
  } > "audit/round2/prompts/$name.txt"
  echo "wrote prompts/$name.txt ($(wc -l < audit/round2/prompts/$name.txt | tr -d ' ') lines, $(wc -c < audit/round2/prompts/$name.txt | tr -d ' ') bytes)"
}

# ---------------------------------------------------------------------------
gen agents "$(cat <<'S'
Vertical slice: platform AGENT CATALOG (managed assistants) — server service + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/agentCatalog/**
- src/enterprise/client/features/admin/agents/**
- packages/database/src/schemas/platform/agents.ts (+ agents.test.ts, agents.migration.test.ts)
- packages/database/migrations/0140_platform_agent_version_delete_guard.sql
- packages/database/migrations/0146_platform_agent_materialization_tombstones.sql
Domain notes: draft/publish revisions, hard-delete guards, materialization of managed agents into user-visible assistants, provenance/tombstones, user-list projection. Focus dimension ⑤ on: stale-state / CAS on delete & publish, materialization provenance leaks (managed content reappearing as an editable local agent), SWR retained-data showing/mutating the wrong agent across route changes.
S
)"

gen ai "$(cat <<'S'
Vertical slice: platform AI PROVIDER / MODEL CATALOG — server service + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/aiCatalog/**
- src/enterprise/client/features/admin/ai/**
- packages/database/src/schemas/platform/ai.ts
- packages/database/src/models/platform/aiCatalog.ts
Domain notes: provider CRUD, model batches, publication + connection-testing, runtime adapter that projects platform config into agent-runtime, BYOK fallback. Focus dimension ⑤ on: disabled/archived provider failing OPEN to user BYOK, stale connection-test bypass on transport/credential changes, request-format (Responses vs Chat Completions / enableResponseApi) being dropped, partial batch commits without an outer transaction, secret leakage in provider config projection.
S
)"

gen connectors "$(cat <<'S'
Vertical slice: platform CONNECTORS (builtin tools / plugins) + CONNECTOR GOVERNANCE — server + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/connectorCatalog/**
- apps/server/src/enterprise/services/connectorGovernance/**
- src/enterprise/client/features/admin/connectors/**
- packages/database/src/models/platform/connectorGovernance.ts (+ connectorGovernance.test.ts)
- packages/database/src/schemas/platform/connectors.ts, connectorGovernance.ts (+ *.migration.test.ts)
- packages/database/migrations/0139_platform_connector_governance.sql
- apps/server/src/enterprise/routers/user/connectors.ts (+ connectors.test.ts)
Domain notes: builtin-tool permission matrix, platform-hosted shared OAuth (masked-secret retention/restore), governance resolution consumed at runtime. Focus dimension ⑤ on: governance READ failure failing OPEN (restoring per-user tool/identity when policy should deny), shared-OAuth secret restore/redaction correctness, mandatory-shared-OAuth bypass.
S
)"

gen audit "$(cat <<'S'
Vertical slice: platform AUDIT (operation log, evidence, export, legal hold, retention) + STATS — server + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/audit/**
- apps/server/src/enterprise/jobs/**
- apps/server/src/enterprise/routers/admin/audit.ts (+ audit.test.ts), stats.ts (+ stats.test.ts)
- src/enterprise/client/features/admin/audit/**
- src/enterprise/client/features/admin/stats/**
- packages/database/src/models/platform/{auditConversation,auditExport,auditLegalHold,auditLog,auditPolicy,auditRetention,auditRetentionHoldLock,auditRetentionRun,auditCredentialMask,globalStats}.ts (+ their *.test.ts)
- packages/database/src/schemas/platform/{auditAdmin,auditLogs}.ts
- packages/database/migrations/0141_platform_audit_admin_foundation.sql
Domain notes: retention worker deletes evidence (DB rows + S3 objects) under lease/checkpoint; legal holds must protect evidence; export produces signed URLs; access logging must be atomic with sensitive mutations. Focus dimension ⑤ HARD on: legal-hold vs retention deletion races, deletion-before-durable-checkpoint, expired-hold acceptance, cross-user data exposure via stats/global-model rows (messages.metadata, tool results, local-file snapshots), audit-append failures swallowed after a mutation commits.
S
)"

gen identity "$(cat <<'S'
Vertical slice: platform IDENTITY PROVIDERS / auth settings — server + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/identityProvider/**
- src/enterprise/client/features/admin/identityProviders/**
- src/enterprise/client/features/admin/securityAuth/**
- apps/server/src/enterprise/routers/admin/{identityProviders,identityProvidersSupport,authSettings,security}.ts (+ their *.test.ts)
- packages/database/src/models/platform/{identityProvider,identityProviderPublishedRevisionLock,authSettings,accessStatus}.ts (+ their *.test.ts)
- packages/database/src/schemas/platform/{identity,authSettings}.ts (+ their *.migration.test.ts)
- packages/database/migrations/0136_*.sql, 0142_*.sql, 0144_*.sql
Domain notes: OIDC/DB-backed identity providers, published-revision locks, startup snapshot + last-known-good (LKG) convergence, open-registration + email-domain allowlist (better-auth sign-up guard), reauth. Focus dimension ⑤ on: ability to DISABLE/REVOKE a single published/compromised provider (tombstone honored at startup & in LKG), registration-guard bypass, secret-state handling, fail-open on IdP read failure.
S
)"

gen skills "$(cat <<'S'
Vertical slice: platform SKILLS catalog + import — server + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/skillCatalog/**
- apps/server/src/enterprise/routers/admin/{skills,skillsSupport,skillsImportParse}.ts (+ skills*.test.ts)
- src/enterprise/client/features/admin/skills/**
- src/enterprise/client/features/skills/**
- packages/database/src/models/platform/{skillCatalog,skillCatalog.model,skillCatalog.pointer,skillCanonicalize}.ts
- packages/database/src/schemas/platform/skills.ts
Domain notes: skill CRUD, import-source parsing (parseImportSource), canonicalization, pointers/versions, alignment with the user-facing skills UI. Focus dimension ⑤ on: import-source parsing edge cases / injection, canonicalization correctness, delete/dedupe with built-in tags, publish/version races.
S
)"

gen settings-branding "$(cat <<'S'
Vertical slice: platform SETTINGS POLICIES + BRANDING — server + admin UI + schema + branding scripts.
Report issues only in these paths:
- apps/server/src/enterprise/services/settings/**
- apps/server/src/enterprise/services/branding/**
- apps/server/src/enterprise/routers/admin/{settings,branding}.ts (+ settings.audit.test.ts, branding.test.ts)
- src/enterprise/client/features/admin/settings/**
- src/enterprise/client/features/admin/branding/**
- src/enterprise/client/features/admin/generalSettings/**
- src/enterprise/client/features/branding/**
- packages/database/src/models/platform/{settings,branding}.ts
- packages/database/src/schemas/platform/{settings,branding}.ts
- scripts/enterprise/brandingLiterals.ts (+ .test.ts), brandingLiteralFiles.ts, brandingFormatFragments.ts, scan-branding-literals.ts (+ .test.ts), branding-literals-baseline.json
Domain notes: setting-policy draft/publish (per-owner path filtering), whole-snapshot save flows, effective-value backfill, reset-to-default, branding literal scanning. Focus dimension ⑤ on: empty-draft publish deleting shared rows across the whole table (owner-path filter correctness), whole-snapshot overwrite losing concurrent edits, reauth wrapping the right operations (publish vs saveDraft), redaction of settings values.
S
)"

gen platform-instance "$(cat <<'S'
Vertical slice: platform INSTANCE / SYSTEM / OBSERVABILITY / GLOBAL CREDENTIALS — server + admin UI + schema.
Report issues only in these paths:
- apps/server/src/enterprise/services/platformInstance/**
- apps/server/src/enterprise/services/platformSystem/**
- apps/server/src/enterprise/services/platformObservability/**
- apps/server/src/enterprise/services/platformGlobalCredentials/**
- src/enterprise/client/features/admin/system/**
- apps/server/src/enterprise/routers/admin/{system,creds,credsSupport}.ts (+ system.test.ts, creds.test.ts)
- packages/database/src/models/platform/{globalCredential,globalStats}.ts (+ globalCredential.test.ts)
- packages/database/src/schemas/platform/{instances,credentials}.ts (+ *.migration.test.ts)
- packages/database/migrations/0135_*.sql, 0138_*.sql, 0145_*.sql
Domain notes: platform instance revisions, restart/rotation ledger, bounded overview queries, platform-global (platform-hosted) credentials with secret rotation, system health page. Focus dimension ⑤ on: incomplete secret rotation, actor-ownership + CAS on global credentials, restart/pending-restart convergence, unbounded overview queries.
S
)"

gen users-rbac "$(cat <<'S'
Vertical slice: platform USERS & RBAC — admin UI + user routers + roles/permissions.
Report issues only in these paths:
- src/enterprise/client/features/admin/users/**
- apps/server/src/enterprise/routers/admin/users.ts (+ users.*.test.ts: adversarial, create, delete, r2, rework)
- packages/database/src/models/platform/{ensureDefaultRole,accessStatus}.ts (+ ensureDefaultRole.test.ts)
- packages/const/src/platform/{permissions,roles}.ts (+ their *.test.ts)
Domain notes: user CRUD incl. hard-delete cascade, per-role grant revocation, ban/access-status, role-grant preservation (finite-term grants must not be wiped), session-scoped revocation, dangerous-zone UX. Focus dimension ⑤ on: per-role revoke preserving other roles' grants (preserveRoleNames), hard-delete cascade completeness (no orphans), ban enforcement at runtime, edit races, draft/publish of role changes.
S
)"

gen routers "$(cat <<'S'
Horizontal pass: TRPC ROUTER SURFACE — input validation, authorization registration, procedure→service wiring.
Report issues only in these paths:
- apps/server/src/enterprise/routers/**   (all admin/* and user/* routers and *Support.ts files, plus routers index)
- apps/server/src/enterprise/index.ts
Focus: every admin procedure must be registered in BOTH the security registry AND the policy registry (a new procedure missing from either is a defect); input zod schemas must be strict (no unvalidated passthrough, correct output schemas that do not leak model rows); reauth/rate-limit middleware applied where required; consistent error mapping. Cross-check that each router delegates to its service correctly (no business logic leaking into routers, no missing authz on a mutation). Dimension ⑤ is primary here: missing/duplicated authz registration, output schemas that echo raw DB rows, procedures reachable without the intended permission. Also cover ①②③④ for the router files themselves.
S
)"

gen security-guards "$(cat <<'S'
Horizontal pass: SECURITY primitives + GUARDS + SECRET REWRAP.
Report issues only in these paths:
- apps/server/src/enterprise/security/**   (redaction, secret, rateLimit, outboundHttp/SSRF, policy, betterAuthAdminBlock)
- apps/server/src/enterprise/guards/**
- apps/server/src/enterprise/services/secretRewrap/**
- packages/database/src/models/platform/{secretPatterns,redact,adminMutationRate}.ts (+ adminMutationRate.pg.test.ts, auditCredentialMask.test.ts if secret-related)
Focus dimension ⑤ HARD: redaction completeness (canary-secret leakage, patterns that miss real secrets or over-redact), SSRF/outbound-HTTP allowlist correctness and bypass, rate-limit window correctness under concurrency, policy-guard fail-open, secret encryption/rewrap correctness (key rotation, single-active job, envelope), admin-block (break-glass) logic actually usable. Also ①②③ for these files.
S
)"

gen contracts "$(cat <<'S'
Horizontal pass: SHARED CONTRACTS / DTOs / TYPES / CONSTS between client and server.
Report issues only in these paths:
- apps/server/src/enterprise/contracts/**
- packages/types/src/platform/**
- packages/const/src/platform/**
Focus: zod schema correctness (over-permissive .passthrough/.any, missing refinements, wrong optionality), mappers between DB rows and DTOs that leak secret/PII fields, error-code and capability constant consistency, drift between a type and its runtime schema, feature-flag defaults. Dimension ⑤: contract shapes that permit fields the UI does not expect or that expose sensitive fields. Also ①②③ (dead types/exports, duplicated shapes) and ④ where user-facing labels live in consts.
S
)"

gen db-core "$(cat <<'S'
Horizontal pass: DATABASE core — platform schemas, shared models, migrations, triggers/constraints.
Report issues only in these paths:
- packages/database/src/models/platform/{revision,checksum,cursor,errors,job,managedResourcePolicy,index}.ts and any platform model not owned by a vertical (audit/ai/identity/etc. verticals own their table's BUSINESS logic — you own SCHEMA/constraint/index/trigger/migration correctness and shared model helpers across ALL platform tables)
- packages/database/src/schemas/platform/{common,index,revisions,managedPolicy,jobs}.ts and cross-cutting schema concerns
- packages/database/src/repositories/platform/**
- packages/database/migrations/0135_*.sql .. 0146_*.sql (idempotency, ordering/folderMillis, reversibility, guards)
Focus: migration idempotency & ordering, immutability triggers (e.g. version rows) and their GUC/transaction escape hatches, foreign keys / ON DELETE behavior (cascade vs orphan), unique/partial indexes matching query patterns, NOT NULL / default correctness, checksum/cursor/revision helper correctness, single-active partial unique constraints. Dimension ⑤: schema-level bugs that permit orphans, lost updates, or broken immutability. Also ①②③ across these files, and flag any migration that is non-idempotent or conflicts by folderMillis.
S
)"

gen shared-infra "$(cat <<'S'
Horizontal pass: CLIENT shared infrastructure + admin shell + business layer.
Report issues only in these paths:
- src/enterprise/client/{providers,nav,boot,errors,hooks,routes,services}/**
- src/enterprise/client/features/admin/{layout,primitives,reauth,gates,overview,pages,unified,managedResources}/**
- apps/server/src/enterprise/{featureFlags,runtimeConfig,bootstrap,observability,testing}/**
- src/enterprise/server/**
- src/business/**
- packages/business/**
Domain notes: enterprise mount/boot gating, admin routing & nav, feature-flag gates, reauth modal wiring, primitives (DataTable, box layouts, modals), admin overview data-viz, managed-resources sidebar, break-glass/admin-route gate, runtime config, business config/const/model-bank. Focus dimension ⑤ on: default-off isolation regressions (enterprise features leaking when disabled), dynamic admin route security, reauth flows that fail to gate, imperative-modal scope-store wiring, SWR/data-fetching hooks with stale/leaked state. Also ①②③④ across these files (many user-facing strings live here → check zh-CN).
S
)"

gen scripts-tooling "$(cat <<'S'
Horizontal pass: ENTERPRISE TOOLING & CI scripts (NOT shipped to users; audit for dead code, test rot, correctness of the gates themselves).
Report issues only in these paths:
- scripts/enterprise/** EXCEPT the branding* files (branding scripts belong to settings-branding partition)
  i.e.: production-readiness/**, security-acceptance/**, upstream-rebase-ci/**, verify-migration/** (+ verify-migration.ts/.test.ts/.integration.test.ts), prometheus-alerts/**, failure-drills/**, preflight.ts, pathBoundaries.ts (+ .test.ts), check-path-boundaries.ts, rebase-report.ts (+ .test.ts), recovery-drill.ts
Focus PRIMARILY on dimensions ②②③① here: test rot (skipped/assertion-free/flaky integration tests, tests coupled to time/network/owned-postgres/shared state), dead code & cruft (unused adapters, orphan scripts, duplicated config, stale fixtures/baselines), and code smells. Dimension ⑤: correctness of the GATES themselves — a security/migration/rebase gate that passes when it should fail (fail-open gate) is a CRITICAL finding. i18n (④) is unlikely here (non-user-facing) — note if clean.
S
)"

gen i18n "$(cat <<'S'
Dedicated sweep: SIMPLIFIED-CHINESE (zh-CN) I18N COMPLETENESS for the enterprise admin console.
Report issues only in these paths (but you MUST grep the whole client tree to find hardcoded strings and used keys):
- packages/locales/src/default/admin.ts
- locales/en-US/admin.json
- locales/zh-CN/admin.json
Method:
1. Compare admin keys across en-US and zh-CN: list keys present in en-US but MISSING in zh-CN, and keys whose zh-CN value is identical to English / obviously untranslated (still English words). These are dimension ④ findings.
2. Grep src/enterprise/client/** and src/business/client/** for user-facing strings rendered directly (JSX text, placeholder=, title=, label=, Button children, message.*/notification.* text, toast text) that are NOT wrapped in t(...) → hardcoded-string findings (④). Give path:line and the literal.
3. Grep for t('admin....') / useTranslation('admin') usages whose key does NOT exist in admin.ts → missing-key findings (④, and a ⑤ bug because it renders the raw key).
Report the concrete missing/untranslated keys and hardcoded strings with path:line. This partition is almost entirely dimension ④; also note any ⑤ where a missing key would render a raw key string to end users. Be exhaustive but list representative examples if a pattern repeats many times (state the count and the pattern).
S
)"

echo "=== all prompts generated ==="
ls -la audit/round2/prompts/
