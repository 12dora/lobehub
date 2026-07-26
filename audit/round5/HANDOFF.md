# Round 5 remediation handoff

**Handoff date:** 2026-07-26

**Scope:** all 113 findings kept by [`TRIAGE.md`](./TRIAGE.md)

**Remediation state:** implementation and independent verification complete

**Publication state:** completed and pushed to `origin/agent/round5-remediation-handoff`

Round 5 is published and ready for final review. Every implementation bundle reached an independent
high-effort verifier PASS after any required rework. The original audit reports and adversarial
verification reports remain the evidence source; [`REMEDIATION.md`](./REMEDIATION.md) records the
execution ledger.

## Executive disposition

| Bundle | Domains                                                                | Independent disposition |
| ------ | ---------------------------------------------------------------------- | ----------------------- |
| A      | `ops-tests-docs`, `pkg-shared`, `srv-fork-seams`                       | **PASS**, pass 5        |
| B      | `srv-audit`, `srv-security-guards`                                     | **PASS**, pass 3        |
| C      | `srv-identity`, `srv-routers-contracts`, `srv-platform-core`           | **PASS**, pass 2        |
| D      | `srv-connector`, `srv-agent-skill-catalog`, `srv-ai-settings-branding` | **PASS**, pass 4        |
| E1     | `adm-agents-skills`, `fe-user-surface`                                 | **PASS**, pass 7        |
| E2     | `adm-audit`, `adm-users-identity`                                      | **PASS**, pass 2        |
| E3     | `adm-connectors-shell`, locale normalization                           | **PASS**                |
| E4a    | `adm-settings-system`                                                  | **PASS**, pass 3        |
| E4b    | `adm-ai`                                                               | **PASS**, pass 3        |

An additional independent inventory reconciled **59/59 kept findings** assigned to bundles B, C,
E1, E2, and E3. The remaining kept findings were reconciled by their bundle verifiers, giving full
coverage of the 113-finding triage scope.

## What changed

### A — migrations, shared packages, and fork seams

- Rebuilt the squashed migration baseline and snapshots, added a pinned `2.2.10` upgrade bridge,
  and made the compatibility verifier compare complete normalized catalogs rather than selected
  invariants.
- Aligned fresh and historical-upgrade schemas across column attributes, type/null/default
  semantics, constraints and validation state, indexes, triggers, and secret-bearing structures.
- Completed compatibility and safety work around OIDC, bounded analytics, device-control transport,
  legacy Connector request seams, and real-PostgreSQL scheduling.
- Made human-intervention outcomes a production wire/runtime/UI concept. Accepted, stale,
  mismatched, and already-consumed outcomes now preserve correct pending state and localized
  presentation across live and reconnect flows.

Generated migration artifacts intentionally included in the change:

- `packages/database/migrations/0000_squash_baseline.sql`
- `packages/database/migrations/0001_upgrade_from_2_2_10.sql`
- the corresponding `meta/0000_snapshot.json`, `meta/0001_snapshot.json`, and journal updates
- retained follow-on `0002_r4_w1_evidence.sql` and `0011_r4_w2_db.sql` histories and snapshots

The large generated diff is expected. Review the SQL and metadata as generated migration state, but
retain the compatibility assertions that guard its semantics.

### B — audit durability and security guards

- Recursively removed fingerprint material from admin detail and export reads.
- Added export lease maintenance, pre-write bounds, batched message reads, structured
  object-not-found handling, and atomic failure/dead-letter audit appends.
- Made purge-intent attribution atomic under concurrent PostgreSQL writers and wired the proof into
  failure-drill evidence.
- Corrected outbound response/header and abort handling, persistent-worker backoff, and the
  production master-key startup gate.

### C — identity, router contracts, and platform core

- Added a signed/encrypted provider-revocation journal with order-independent,
  pending-dominant, maximum-generation folding.
- Removed Vault calls from database transaction lifetimes and completed existing-provider secret
  sanitization.
- Tightened credential output allowlists, including nested summaries.
- Preserved managed-resource partial-commit recovery semantics and corrected catalog
  coalescing/tombstones, health/convergence reporting, resolver cleanup, and break-glass
  normalization.

### D — Connector, Skill catalog, AI settings, and branding services

- Enforced aggregate Skill byte budgets for live and pinned projections and fail-closed readiness
  for corrupt mandatory content.
- Added cached permanent/temporary owner-ban enforcement, batched model operations, invalidation
  warnings, branding cleanup, backfill rollback, and emergency-operation resilience.
- Wired stable Connector error codes to safe localized tool-card/tool-result content.
- Mapped platform-agent failures at the actual conversation gateway boundary before persistence,
  and mapped credential-upload failures in the `setting` namespace.
- Corrected the direct-database AI projection fixture to advance/invalidate the
  generation-keyed authority cache.

### E1 — Agents/Skills administration and end-user surfaces

- Completed platform RBAC, durable draft flushing, bounded pagination, retry feedback, real managed
  Connector routing, and Profile/Chat recovery behavior.
- Removed duplicate provider-tree implementation/tests and corrected copy, i18n, motion, and
  Flexbox details.
- Split reset mutation completion from refresh reconciliation so queued edits survive a successful
  reset followed by a refresh failure.
- Made the production Advanced settings caller await reset completion and show success or localized
  failure accurately.

### E2 — Audit, users, and identity-provider administration

- Preserved policy drafts across conflicts and retried with the latest revision.
- Localized export errors, made retention transitions and auxiliary evidence failures observable,
  and added retry paths.
- Kept message entrance tracking render-pure, corrected same-day future expiry behavior, and guarded
  populated create-user dismissal.
- Treated benign reauthentication cancellation correctly and repaired restart polling/motion.
- Fixed the late-found pending-to-failed retention notification, stale-data SWR revalidation error
  visibility, and the identity-provider phase regression fixture.

### E3 — Connector administration shell and locales

- Separated the unbounded active-query display map from the bounded 500-entry historical LRU so
  active labels cannot disappear under load.
- Replaced raw user identifiers with stable localized unknown-user labels.
- Made local-draft persistence return a discriminated result and emit at most one warning per
  session.
- Normalized the shipped Connector locale surface: the scan covers 144 keys with no unintended
  en-US/zh-CN equality and no banned English leakage, while preserving a technical-term allowlist.

### E4a — system settings administration

- Added unsaved-change guards across relevant tab/navigation paths.
- Made conflict recovery use the latest compare-and-swap revision and preserve the user draft.
- Bounded recovery records, synchronized clean editors from SWR snapshots, and kept dirty editors
  isolated from background replacement.
- Unified post-commit OAuth/branding feedback and completed the associated copy and localization.

### E4b — AI administration

- Corrected managed-policy editability and the explicit `null`/unlimited normalization contract.
- Serialized provider creation where required and made governance fetch failures visible.
- Preserved partial provider-order publication state and repaired provider extraction/editor state.
- Added focused regressions and completed the remaining copy, localization, and motion behavior.

## Validation evidence

All bundles were independently inspected and exercised after implementation. Recorded focused
evidence includes:

- A: Docker migration compatibility **4/4**; migration unit tests **23/23**; intervention
  live/reconnect/client/runtime tests **204/204**; heterogeneous wire-schema tests **7/7**; real
  PostgreSQL Asia/Singapore UTC-bucket regression **1/1**; scoped gate **262 passed, 1 conditional
  skip**.
- B: bundle gate **172 tests**; concurrent real-PostgreSQL attribution **1/1** with no skip;
  failure-drill runner **10/10**; upstream-rebase evidence **24/24**.
- C: independent focused suite **138 passed, 1 existing conditional skip**.
- D: Connector runtime integration regression **12/12**, followed by adversarial verifier PASS on
  pass 4 across the real presentation and cache-invalidation consumers.
- E1: settings lifecycle **19/19**; Advanced UI **4/4**; final scoped gate **29 tests**.
- E2: implementation scoped gate **36 tests**, followed by verifier PASS on pass 2 for the three
  late lifecycle/revalidation/type defects.
- E3: focused Connector shell/locale gate **26 tests**, followed by independent PASS.
- E4a and E4b: focused implementation and regression suites passed, followed by independent PASS on
  pass 3 for each bundle.

Final consolidated gates:

- `bun run check --type`: **clean**.
- Runtime branding verification: **clean**.
- Enterprise path-boundary verification: **clean across 11,809 files**.
- `git diff --check`: **clean**.

One environment-sensitive assertion expects the repository development contract
`APP_URL=http://localhost:3010`. A run with an unrelated inherited `APP_URL` failed that assertion;
using the repository’s expected port 3010 passed. This is an environment setup issue, not an
unresolved product defect.

## Residual risk and review guidance

- The full `bun run test` suite was intentionally not run, in accordance with `AGENTS.md`. Coverage
  is from targeted/scoped suites, real-PostgreSQL proofs, independent adversarial review, type
  checking, and repository boundary gates.
- Some broad D-suite attempts exhausted memory in the shared agent environment. The affected paths
  were split into focused runs, and the independent pass-4 verifier inspected the complete D scope.
  Treat the shared-host OOM as a test-infrastructure resource limit, while watching CI memory use.
- Generated migrations deserve focused human review because schema compatibility carries higher
  blast radius than ordinary application changes.
- Conditional database tests still require their documented environment. The recorded real-PG
  proofs ran with no silent skip where the verifier required execution.

## Git and continuation state

- Current branch: `agent/round5-remediation-handoff`.
- The branch was originally based on local `main`; local `main` contained the preceding enterprise
  remediation commits. Review/publish against `main` unless the deleted development branch is
  deliberately restored.
- `origin` now contains only `main` and `agent/round5-remediation-handoff`, as explicitly requested.
  `upstream` was not modified.
- Draft PR #1 closed automatically when its `canary` base branch was deleted.
- The completed remediation was committed as `fcd49ec347` and pushed to
  `origin/agent/round5-remediation-handoff`.
- This handoff status update is the final documentation-only follow-up on the same remote branch.

Review/continuation steps:

1. Review the complete branch diff, especially generated migration artifacts.
2. Run any release-specific CI gate desired beyond the recorded scoped evidence.
3. If a PR is wanted, open it against `main`; the previous `canary`-based PR cannot be reused.

Useful evidence:

- [`INDEX.md`](./INDEX.md) — audit inventory
- [`TRIAGE.md`](./TRIAGE.md) — 113 kept-finding decision set
- [`verify/`](./verify/) — independent finding-verification reports
- [`REMEDIATION.md`](./REMEDIATION.md) — implementation and verification ledger
