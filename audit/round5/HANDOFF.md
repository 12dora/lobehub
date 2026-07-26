# Round 5 remediation handoff

**Handoff date:** 2026-07-26
**Scope:** the 113 findings kept by `audit/round5/TRIAGE.md`
**State:** staged milestone, intentionally handed off before every verifier reached PASS

The user asked to stop waiting for every verification loop, preserve the current work, document the
remaining gaps, and push it. This document is the continuation contract. Do not describe this branch
as fully remediated until the open bundles below pass independent verification.

## Executive status

| Bundle | Domains                                                          | State                                                                                          |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A      | ops-tests-docs, pkg-shared, srv-fork-seams                       | Large implementation landed; verifier FAIL; rework was interrupted                             |
| B      | srv-audit, srv-security-guards                                   | **Independent PASS** on pass 3                                                                 |
| C      | srv-identity, srv-routers-contracts, srv-platform-core           | **Independent PASS** on pass 2                                                                 |
| D      | srv-connector, srv-agent-skill-catalog, srv-ai-settings-branding | Functional work largely passed; presentation rework was interrupted after verifier pass-2 FAIL |
| E1     | adm-agents-skills, fe-user-surface                               | Most findings passed; settings reset lifecycle still fails verifier                            |
| E2     | adm-audit, adm-users-identity                                    | Implementation and scoped checks passed; independent verification was interrupted              |
| E3     | adm-connectors-shell plus locale normalization                   | **Not started**                                                                                |
| E4     | adm-settings-system plus adm-ai                                  | **Not started**                                                                                |

`REMEDIATION.md` is the durable bundle ledger. Original evidence and adversarial reports remain in
the sibling audit and `verify/` documents.

## Independently passed bundles

### B — audit and security guards

Passed after three verifier rounds.

- Recursive fingerprint removal is applied to admin detail and export reads, and public contract
  comments now match that boundary.
- Export snapshot lease maintenance, pre-write staging limits, batched message reads, purge intent
  attribution, structured object-not-found handling, and atomic failure/dead-letter audit appends
  were implemented.
- Purge count attribution uses an atomic JSONB update. A real multi-connection PostgreSQL test
  proves two concurrent purge intents produce a final count of `2`.
- The real-PostgreSQL attribution suite is explicitly scheduled in the failure-drill workflow and
  included in evidence collection and digest verification.
- Outbound redirect/header and abort-listener fixes, persistent-worker backoff, and the production
  master-key startup gate were verified.

Key evidence:

- Bundle implementation gate: 172 tests, lint clean.
- Real-PostgreSQL attribution: 1 passed, 0 skipped/pending.
- Failure-drill runner: 10/10.
- Upstream-rebase evidence: 24/24.

### C — identity, router contracts, and platform core

Passed after two verifier rounds.

- Disabled-provider outage handling uses a signed/encrypted revocation journal with
  order-independent, pending-dominant, maximum-generation folding.
- Secret rewrap avoids holding database transactions across Vault calls.
- All existing-provider mutation sanitizers include the provider identity/current secret context.
- Credential outputs use strict allowlists, including nested summaries.
- Managed-resource partial-commit responses, catalog coalescing/tombstone targets, convergence and
  health reporting, resolver cleanup, and break-glass normalization were verified.

Key evidence:

- Independent pass: 138 focused tests passed, 1 existing conditional skip.
- Scoped lint and `git diff --check` passed.

## Open blockers

### A — migration/shared/fork seams

The implementation added a regenerated final-state baseline, real snapshots, a
`0001_upgrade_from_2_2_10.sql` bridge, historical fixture materialization, Docker lanes, CI wiring,
OIDC/analytics/transport/runtime fixes, and extensive tests. Its first implementation gate reported
358 tests passing. Independent verification nevertheless found the migration check was false-green.

Required continuation:

1. Finish and verify normalized fresh-vs-upgrade catalog parity:
   - `global_files.creator` nullability;
   - validate 21 connector/tool/binding constraints currently left `NOT VALID`;
   - add two missing RAG evaluation-record foreign keys;
   - normalize legacy `files_to_messages_*` versus `messages_files_*` constraints;
   - remove seven redundant `UNIQUE(id)` artifacts;
   - align `users.normalized_email` constraint/index semantics.
2. Keep the Docker verifier comparing normalized column type/nullability/default, constraint
   definitions and validation state, indexes, and triggers—not only representative invariants.
3. Complete the production consumer for `interventionOutcome`. The verifier found metadata was
   written but not exposed/consumed by status/event/UI paths. Keep approval UI pending until accepted
   and localize stale/mismatch/already-consumed outcomes, including reconnect tests.
4. Retain/add the non-UTC PostgreSQL-session analytics regression.

The A rework agent was interrupted while editing. Review the current A diff carefully before
continuing; do not assume every partially edited path compiles.

### D — connector, Skill catalog, AI/settings/branding

Verified functional fixes include live and pinned aggregate Skill byte limits, mandatory-corrupt
fail-closed readiness, cached permanent/temporary owner bans, O(N) model batching, invalidation
warnings, branding cleanup, backfill rollback, and emergency operations. Verifier pass 2 still found
three real presentation paths unwired:

1. Connector runtime failures still need safe localized content at the actual tool-card/tool-result
   consumer; a `messageCode` field alone is insufficient.
2. Platform Agent errors must be mapped at the actual chat/gateway boundary before `GatewayError`
   persistence, not only in the admin mapper.
3. `FileCredForm` must map the stable upload code in the `setting` namespace and render real
   en-US/zh-CN copy instead of `error.message`.

Also adapt the AI runtime projection direct-DB fixture to bump/invalidate the generation-keyed
authority cache. The D rework agent was interrupted after beginning these changes; inspect for
half-completed consumer wiring.

### E1 — Agents/Skills admin and end-user surface

The verifier cleared platform RBAC, draft flush durability, bounded pagination and retry feedback,
real managed Connector routes, Profile/Chat retry items, copy/i18n, motion/Flexbox, provider-tree
cleanup, and several generations of settings write races.

Two reset lifecycle gaps remain:

1. If `resetUserSettings` succeeds but the following refresh fails, queued post-reset edits currently
   reject instead of persisting. The write barrier should release after the authoritative reset
   mutation even if freshness reconciliation fails.
2. The only production caller,
   `src/routes/(main)/settings/storage/features/Advanced.tsx`, fires `resetSettings()` without
   awaiting/catching it and immediately shows success. It must await, show success only on success,
   and surface failure without an unhandled rejection.

Add exact regressions for successful-reset/refresh-failure plus a queued edit, and for production UI
failure feedback.

### E2 — Admin Audit and Users/Identity

Implementation completed and the scoped gate reported 20 files lint-clean and 36 tests passing.
Independent verification was stopped before a verdict. Resume with a fresh high-effort verifier
covering:

- policy conflict draft preservation and latest-revision retry;
- export code localization/no raw fallback;
- retention failure transition feedback and auxiliary evidence error/retry states;
- render-pure message entrance tracking;
- same-day future expiry semantics;
- populated create-user Escape/X confirmation;
- benign reauthentication cancellation;
- restart polling motion and reduced-motion behavior.

### E3 and E4 — not started

Resume directly from:

- `adm-connectors-shell.md` plus locale normalization;
- `adm-settings-system.md` plus `adm-ai.md`.

Use the same workflow: medium-effort implementer, then a different high-effort verifier; failed
verification returns to the original implementer.

## Validation state at handoff

Known successful bundle gates and focused suites are recorded above and in agent reports captured in
`REMEDIATION.md`. At the final stop point:

- `git diff --check` passed.
- Runtime branding and enterprise path-boundary gates passed.
- The worktree includes generated migration SQL/snapshots; most of the large line count is generated
  DDL/metadata, not handwritten application code.
- The final `bun run check --type` **failed** after the interrupted A/D edits. Exact diagnostics:
  - `apps/server/src/routers/lambda/__tests__/aiAgent.heteroIngest.test.ts` (three assignments):
    its event union does not include `human_intervention_outcome`;
  - `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.test.tsx:298`:
    `"accepted"` is not assignable to the inferred `"idle"` literal;
  - `src/features/ProfileEditor/useManagedAgentSkills.test.ts:216`: `label` is accessed without
    narrowing the menu-item union;
  - `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:51` and
    `ImportFromUrlModal.tsx:50`: callbacks may resolve to `SkillImportResult | undefined` where
    `Promise<void>` is required;
  - `src/store/user/slices/settings/action.test.ts:523`: a `Promise<void>` mock does not match the
    query-result promise contract.
- Therefore the next owner should begin with:

  ```bash
  git diff --check
  bun run check --type
  ```

  Then run focused checks for any files reported by type-check before resuming verifier loops.

Do not run the full `bun run test`. Use `bun run check <changed-files...>` or package-local focused
Vitest commands per `AGENTS.md`.

## Git/publish notes

- The working branch was created from local `main`, which was already six commits ahead of
  `origin/main` before the Round-5 milestone commit.
- The original worktree was otherwise clean except for the user-provided untracked `audit/`
  directory.
- The milestone intentionally includes the audit archive, remediation ledger, and this handoff so a
  new owner can continue without the chat transcript.
- Review the pushed branch/PR as a draft milestone, not a release-ready remediation.
