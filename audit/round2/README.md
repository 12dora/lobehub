<!--
  AIHub Enterprise 二开 — Independent Code Audit (Round 2)
  Generated 2026-07-24 by a Codex reviewer fleet + a Claude verification fleet,
  orchestrated by Claude Code (commander). This folder is an audit deliverable,
  not application code. Safe to review, commit, or delete.
-->

# 📋 AIHub 二开 独立代码审计・Round 2 (Verified)

> **This is an INDEPENDENT audit**, run from scratch after the previous round's findings were remediated. Reviewers were barred from reading the prior `audit/` reports and physically could not modify source. Upstream LobeHub code was out of scope.

## How this was produced (two-stage, cross-model)

1. **Discovery — 16 × Codex `gpt-5.6-sol` (high reasoning, read-only sandbox).** Each owned one domain-coherent partition (mostly a _vertical slice_: server service + its admin UI + schema) and audited all five requested dimensions: **① code smells · ② test rot · ③ dead code & cruft · ④ missing zh-CN i18n · ⑤ FE/BE functional bugs.** Raw per-partition reports live in [`audit/round2/partitions/`](./partitions/).
2. **Verification — 48 × Claude (cross-model, adversarial).** Every CRITICAL and HIGH finding was independently re-checked by a _different model_ instructed to **try to refute it** against the real source — hunting the guard, transaction, caller, or feature-flag a first-pass reviewer might miss, and re-judging severity from scratch. Machine-readable verdicts: [`audit/round2/verdicts.json`](./verdicts.json).

**Scope reviewed:** \~199K lines / \~1,000 files across `src/enterprise/**`, `apps/server/src/enterprise/**`, `packages/database/src/**/platform/**` + migrations `0135–0146`, `packages/{types,const}/src/platform/**`, `src/business/**`, `packages/business/**`, `scripts/enterprise/**`, and the `admin` locale namespace.

---

## 1. Executive Summary

Codex reported **135 findings (9 CRITICAL · 39 HIGH · 51 MEDIUM · 36 LOW)**. The 48 CRITICAL/HIGH claims were then adversarially verified. The headline result:

> **Codex made ZERO false positives** — every one of the 48 verified findings describes a _real code condition_. But the adversarial verifiers **downgraded severity on 31 of 48**, all in the "overstated" direction, because codex systematically escalated bounded/degradation-gated issues to HIGH/CRITICAL.

### Verified severity (the 48 CRITICAL/HIGH claims, re-judged)

| Verified        | Count  | Δ from claimed                  |
| --------------- | ------ | ------------------------------- |
| 🔴 **CRITICAL** | **2**  | 9 → 2 (7 downgraded)            |
| 🟠 **HIGH**     | **19** | —                               |
| 🟡 MEDIUM       | 25     | (downgraded from HIGH/CRITICAL) |
| ⚪ LOW          | 2      | (downgraded)                    |
| ❌ REFUTED      | 0      | —                               |

Plus **87 MEDIUM/LOW** findings from codex (dimensions ①②③④ + bounded ⑤) carried forward _as reported_ (not independently re-verified — lower stakes).

### 🚦 Release-readiness call: **NOT READY — 2 confirmed CRITICAL blockers.**

The two confirmed CRITICALs both sit in the **audit-evidence** and **identity-revocation** subsystems — _the same two subsystems that produced CRITICALs in the previous round._ The prior fixes closed specific instances; these are **different, adjacent bugs in the same code**, which tells us those two subsystems carry systemic risk and deserve a design-level hardening pass, not just point fixes. Everything else is shippable-with-follow-ups: no confirmed CRITICAL outside those two, and the 19 HIGHs are real correctness/security defects but each is bounded.

---

## 2. Read this before reacting to severities

The verification stage matters as much as the discovery stage. Two calibration facts:

- **Codex's _facts_ were reliable; its _severities_ were inflated.** 0/48 refuted means the code really does what each report says — cited lines, mechanisms, and impact chains held up. Trust the reports' technical content.
- **The verifiers were deliberately skeptical, and it was not rubber-stamping.** In several cases they corrected the _mechanism_, not just the label:
  - `identity/F3` — codex's cited "discovery endpoint unavailable" trigger actually **fails closed** (the LKG fallback re-runs discovery for all providers, so a co-provider failure also fails the fallback into break-glass). The real defect needs _corrupted/tampered DB state_ → **MEDIUM, not CRITICAL**.
  - `db-core/F1` — normal job errors **are** caught and routed to `fail()`, which _does_ enforce `maxAttempts` and dead-letters; only an uncaught process crash bypasses the budget, and the affected jobs are idempotent → **MEDIUM**.
  - `routers/F2` — a self-heal path exists: the 30 s Redis lease auto-expires and a routine `getCapabilities` call republishes the correct mode → **MEDIUM**.
  - `platform-instance/F1` — the claimed "silently revert a rotated secret" scenario _cannot occur_ (disjoint per-key merge under `FOR UPDATE`); the real issue is a name/description last-writer-wins → **MEDIUM**.

The truth for most downgraded items lands between codex's "HIGH" and the verifier's "MEDIUM": they are real defects worth fixing, gated behind an unusual precondition (concurrent trusted admins, infra degradation, operator misconfiguration, or an ops flag toggle). Severities below are the **verified** values; the codex-claimed value is shown where it differed.

---

## 3. 🔴 CRITICAL — release blockers (2, both CONFIRMED)

### C1 · Destructive audit jobs become runnable _before_ their required audit record exists

`audit/F1` — **CONFIRMED CRITICAL** (confidence HIGH)

- **Where:** `apps/server/src/enterprise/services/audit/retentionService.ts:205,221` · `exportService.ts:284,318` · `retentionWorker.ts:417,488` · `exportWorker.ts:243-275`
- **What the code does:** Retention/export services `enqueue(...)` a destructive job and only _afterward_ `appendAuditAccessLog(... required: true)`. There is **no wrapping `db.transaction`** (both services run on `ctx.serverDB`; neither file contains a transaction), so each step auto-commits independently. `PlatformJobModel.claimNext` selects `pending` jobs **with no scheduling delay**, and a persistent poller (`ensurePlatformAuditRetentionWorkerStarted`, 3 s interval) runs whenever `ENABLE_PLATFORM_ADMIN` is set — **AIHub's deployment mode**.
- **Failure scenario:** A worker claims the execute-retention job in the window between the enqueue commit and the audit append (or the API process is killed/redeployed in that window, so the compensation `catch` never runs). It **permanently deletes evidence** (DB rows + S3 objects), and the required request-audit record is never written. For exports, sensitive evidence is materialized for a request that ultimately failed its audit requirement.
- **Why CRITICAL:** irreversible destruction of legal-hold / compliance evidence with the mandated audit record permanently missing — it breaks the subsystem's own declared fail-closed invariant.
- **Fix:** Create/link the run or export, enqueue its job, and append the required audit record **in one transaction** so no worker can observe the job before commit. Use a durable outbox for the external (S3) deletion so object-store cleanup is decoupled from the audit transaction. Add a concurrent-worker regression that blocks the audit append and proves no job can be claimed.

### C2 · Disabling a compromised identity provider does not actually stop it accepting logins

`identity/F1` — **CONFIRMED CRITICAL** (confidence HIGH)

- **Where:** `apps/server/src/enterprise/services/identityProvider/publicationService.ts:1326-1332` (disable) vs `:976,994` (publish) · `systemService.ts:205-212,255-296,374-379` · `src/auth.ts:7-16` · `define-config.ts:130-132` · `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:138,239`
- **What the code does:** Disable writes `status:'disabled', activationRevision:null`, whereas publish writes `status:'pending_restart', activationRevision:next`. `getAuthSnapshotStatus` derives `pendingRestart` **only** from rows with `status='pending_restart'` and a non-null activation revision — so a pure tombstone yields `pendingRestart:false`. The running Better Auth config is **process-cached** (`getInitializedIdentityProviderRuntimeArtifact()` read once at module eval; `enabled!==false` filtered against that startup snapshot with **no per-login DB recheck**). The only restart path (`restartController.schedule`) is reachable solely via `requestRestart`, which is gated on `pendingRestart`/`restart.supported` — all false for a tombstone.
- **Failure scenario:** An OIDC provider is compromised. An admin clicks **Disable**; the DB and audit log say "disabled," but the live Better Auth configuration stays cached, the system reports **no restart pending**, and the UI offers **no restart action**. The compromised provider keeps accepting logins until an _external_ process restart happens. No compensating control (no auto-restart on divergence, no per-request `enabled` recheck) mitigates it.
- **Why CRITICAL:** failure-to-revoke of a live authentication path — the exact operation an operator reaches for during an incident does not take effect.
- **Fix:** Treat a tombstone as a pending activation: retain its revision, include tombstones in restart status, compute the empty-provider-set identity instead of returning null, refresh runtime status immediately after disable, and reconcile to `disabled` only after every instance reports the tombstoned target. **Related:** `routers/F3` (below) shows `admin.identityProviders.disable` is also **missing from the mutation-policy registry** — the same disable flow is under-governed on two axes.

---

## 4. 🟠 HIGH — real, bounded defects (19)

Grouped by theme. Each was CONFIRMED against source (severity shown where codex over-claimed).

### 4a. Authorization / policy fail-open & data exposure

| #                    | Finding                                                                                                                                                                                                 | Location                                                                 | Note                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `audit/F2`           | User-timeline route uses `AUDIT_READ` not `AUDIT_CONVERSATION_READ`, and skips the disabled-policy gate → an auditor without conversation permission enumerates other users' topic/session IDs + titles | `routers/admin/audit.ts:243`, `adminAuditService.ts:808`                 | CONFIRMED                                                                  |
| `audit/F3`           | Disabling conversation access does **not** stop conversation/timeline **exports** (kill-switch helper absent from export create/worker/download)                                                        | `contentPolicy.ts:28`, `exportService.ts:241,505`, `exportWorker.ts:247` | CONFIRMED                                                                  |
| `audit/F4`           | `STATS_READ`-only role can read global conversation **titles + topic IDs** via `rankTopics` (returns model rows, not aggregates)                                                                        | `routers/admin/stats.ts:32,230`, `globalStats.ts:292`                    | CONFIRMED                                                                  |
| `ai/F1`              | Hard-deleting a _published_ provider removes the fail-closed tombstone row → runtime returns NotFound → **user BYOK re-enabled**, bypassing the admin's provider prohibition                            | `aiCatalog/adminService.ts:394-459`, `runtimeAdapter.ts:395-402`         | was CRITICAL; bounded because user must independently hold their own creds |
| `contracts/F2`       | `emailDomainAllowlistEnabled:true` + empty list passes schema; matcher treats empty list as "no restriction" → allowlisting enabled but **every domain self-registers**                                 | `types/platform/authSettings.ts:37`, matcher                             | CONFIRMED (dup of `identity/F7`)                                           |
| `security-guards/F1` | Alibaba Cloud metadata IP `100.100.100.200` missing from the permanent SSRF denyset → under `allow-private`, IMDS/RAM-credential endpoint reachable                                                     | `security/outboundHttp/policy.ts:74-78`                                  | CONFIRMED                                                                  |

### 4b. Lost-update / stale-state overwrites (missing CAS)

| #                      | Finding                                                                                                                                                                                                                   | Location                                                               | Note      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------- |
| `agents/F1`            | Assignment/rollout writes advance `draftSequence` but not `revision`; the refresh-lock freshness gate requires `revision` to strictly increase → **detail page permanently locks** in refresh-failed state                | `AgentDetailView.tsx:66`, `agentCatalog/adminService.ts:349`           | CONFIRMED |
| `agents/F2`            | Version IDs are random nanoids; `listVersions`/editor use `versions[0]` with no ordering → UI can publish/edit an **arbitrary historical version**                                                                        | `schemas/platform/agents.ts:124`, `useAgentEditor.ts:20`               | CONFIRMED |
| `settings-branding/F1` | Enabling `ENABLE_PLATFORM_SETTINGS_POLICY` overwrites registered legacy user prefs (fontSize, agent models, memory, approval policy) with defaults on read (legacy row preserved but shadowed)                            | `settings/effectiveResolver.ts:145,215`                                | CONFIRMED |
| `settings-branding/F2` | Effective-settings cache key omits `legacyUserSettings`; runtime adapters call with different partial slices → a cached result from `{tool}` is served for a `{defaultAgent}` read, **losing unregistered legacy fields** | `settings/effectiveResolver.ts:276`, `effectiveSettingsService.ts:212` | CONFIRMED |

### 4c. Secret / evidence integrity

| #              | Finding                                                                                                                                                                                                                            | Location                                                   | Note      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `skills/F1`    | A version whose validation flags `secret_material_detected` is **still persisted immutably** (create proceeds unconditionally); any `SKILL_READ` admin can later read the embedded credential, and there is no version-delete path | `skillCatalog/adminService.ts:450-486`, `validator.ts:536` | CONFIRMED |
| `contracts/F4` | Cancelled/`dead` secret-rotation jobs can't be restarted (retry requires `expectedStatus:'failed'`; start dedups by target key and returns the terminal job) → old-key ciphertext can't be retired                                 | `contracts/adminSecretRotation.ts:13,48`                   | CONFIRMED |

### 4d. Availability / self-DoS & catalog integrity

| #           | Finding                                                                                                                                                                                                                                                                                                                                      | Location                                           | Note      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------- |
| `skills/F2` | Resource canonicalization (CRLF→LF) keeps stale `sizeBytes`; publish re-validates canonical content but never re-checks byte length; read-path `.parse()` runs per-item with no isolation → **one bad published skill takes down the entire managed-skill catalog** for all users. Reachable _non-adversarially_ via any Windows-CRLF import | `skillCanonicalize.ts:256`, `readService.ts:239`   | CONFIRMED |
| `skills/F3` | Archiving a built-in override copies the mutable draft's `enabled:false` into the tombstone; catalog only honors _enabled_ tombstones → **bundled skill silently reactivates**, reversing an org-wide suppression                                                                                                                            | `skillCatalog.pointer.ts:64`, `readService.ts:222` | CONFIRMED |
| `audit/F6`  | `safeDelete` swallows every S3 delete error and retention only scans `completed`/`expired` rows → failed/cancelled exports leave **sensitive evidence objects orphaned indefinitely**                                                                                                                                                        | `exportWorker.ts:511`, `auditRetention.ts:532`     | CONFIRMED |

### 4e. Async UI state (false success / hidden action)

| #                    | Finding                                                                                                                                                                                                             | Location                                                      | Note                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| `identity/F4`        | Disable button is hidden for a provider whose head is `draft` (e.g. after editing/clearing its secret) even though its **older published revision is still live** → can't urgently revoke it from the UI            | `IdentityProviderPage.tsx:76-83,293`                          | CONFIRMED                                             |
| `connectors/F1`      | Governance LKG epoch is a best-effort invalidation counter, not the DB revision; on a _lost invalidation + sustained governance-read outage_ the resolver returns a stale **permissive** snapshot instead of DENIED | `connectorGovernance/service.ts:147`, `resolve.ts:23`         | was CRITICAL; needs compound infra failure            |
| `identity/F2`        | Group→role reconciliation fails open: a transient DB/seed fault during login lets a **deprovisioned admin keep `identity_admin`** (RBAC only reconciled at login, result discarded)                                 | `groupRoleMapping.ts:88-108`, `groupRoleMappingRuntime.ts:59` | was CRITICAL; needs transient fault, bounded exposure |
| `scripts-tooling/F1` | The "expand-only" migration gate only blocks `DROP TABLE`/`RENAME` of protected tables — **`DROP COLUMN`, narrowing type changes, `DROP CONSTRAINT`, schema-qualified `DROP TABLE public.x` all pass** the gate     | `verify-migration/migrations.ts:236-255`                      | was CRITICAL; CI defense-in-depth, not runtime        |

---

## 5. Cross-partition correlations (dedup)

Several defects were reported independently by multiple reviewers — corroboration that raises confidence, and clusters that should be fixed as one change:

| Root issue                                                                             | Reported by                                                                                                                                            | Verified severity                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Enabled email-allowlist + empty list fails open** (schema + model, two layers)       | `contracts/F2` + `identity/F7`                                                                                                                         | HIGH (schema fix) / MEDIUM (model fix) — **fix once with a cross-field refinement**               |
| **No-CAS full-document settings overwrite** (auth settings + sidebar)                  | `contracts/F3` + `identity/F6` (auth) · `shared-infra/F1` (managed-resources) · `platform-instance/F1` (credentials) · `settings-branding` post-commit | MEDIUM cluster — add revision/`expectedRevision` CAS across these singleton/full-document writers |
| **Disabled-connector `disconnect` returns false success** (no revocation)              | `connectors/F5` + `routers/F1` + test `routers/F7`                                                                                                     | MEDIUM — one flag-independent revocation path + fix the test that locks in the bug                |
| **Blocking (non-`CONCURRENTLY`) index build in migration 0145** on `topics`/`messages` | `db-core/F2` + `platform-instance/F3`                                                                                                                  | MEDIUM — one deployment-safe follow-up migration                                                  |
| **"Full" monthly stats silently truncate at 100k rows**                                | `audit/F8` + `routers/F4`                                                                                                                              | MEDIUM — paginated envelope or explicit truncation flag                                           |
| **Missing zh-CN keys for IdP disable/restart flow**                                    | `identity/F12` + `i18n/F1`                                                                                                                             | see §7                                                                                            |

---

## 6. 🟡 MEDIUM — verified downgrades + carried-forward (rollup)

The 23 HIGH/CRITICAL claims downgraded to MEDIUM are real but gated behind an unusual precondition. Highest-value ones to schedule:

- **`routers/F3` — `admin.identityProviders.disable` is missing from the mutation-policy registry** (present in security registry only; the repo's exhaustive registry check should be failing). Directly compounds **C2**. `routers/admin/identityProviders.ts:235`.
- `audit/F5,F7` — audit-completeness / retention-accounting gaps (destruction itself is durable; the _count_ or _outcome record_ can be lost on a transient window).
- `identity/F5` — an admin who pastes a raw client secret into a `reason` field can persist an _opaque_ secret to the append-only audit (pattern detector can't catch arbitrary opaque values).
- `identity/F6,F7` — auth-settings no-CAS reopen-registration + empty-allowlist (see §5).
- `security-guards/F2,F3` — write-path `redactSensitive` misses PEM/AWS/GCP shapes and non-classic GitHub token prefixes (primary input-validation path _does_ catch them; this is the secondary redactor).
- `contracts/F1` — read-only AI DTO exposes a 64-bit credential `fingerprint` to auditor roles (offline-guessable for low-entropy creds).
- `platform-instance/F4,F6` — system-health poll re-hashes the whole catalog every 3 s; usage aggregation returns an unbounded user-dimension result.
- `shared-infra/F2–F6` — client races: out-of-order admin-access checks restore stale permissions; all-errors→"not configured"; unsaved-changes modal can strand navigation on Esc/mask dismiss; stale vault-cred reference treated as present; DataTable row-activation also fires nested buttons.
- `users-rbac/F1` — immutability/append-only triggers trust caller-controlled GUCs (`current_setting` can't tell `SET LOCAL` from session `SET`) → post-compromise defense-in-depth gap.
- `scripts-tooling/F3–F8` — CI/production-readiness gates with fail-open or fail-safe-but-hollow behavior (path-boundary can pass scanning 0 files; forged failure-drill aggregates accepted; rollback gate does no rollback). Production trust is currently **disabled**, so these are latent until it's turned on — fix before enabling.

**Carried-forward MEDIUM (codex-reported, not independently re-verified):** \~40 more across the partitions — export OOM buffering (`audit/F10`), unbounded credential upload (`routers/F6`), error-misclassification as `INVALID_INPUT` (`routers/F5`), SemVer `NaN` draft version (`agents/F6`), effective-list overscan (`agents/F5`), never-published skill can't be archived (`skills/F6`), zip-URL truncation (`skills/F7`), branding stale-state / missing desktop+theme controls (`settings-branding/F3,F5`), general-settings rehydration overwrites unsaved edits (`settings-branding/F4`), malformed percent-encoding crashes audit masking (`security-guards/F5`), rewrap recovery ops require Vault config (`security-guards/F4`), and more. See the partition files.

---

## 7. ④ zh-CN i18n — the concrete gaps

The `admin` namespace is in **good shape**: 2,280 keys with exact en-US↔zh-CN key parity and no untranslated prose among matched values. Only these runtime-referenced keys are **missing from all locale files** (they render an English `defaultValue` today):

1. **IdP disable/restart flow (8 keys)** — `identityProviders.disable.{cancel,impact,confirm,title,success}`, `identityProviders.restart.failedWithCategory`, `identityProviders.columns.actions`, `identityProviders.actions.disable`. A zh-CN admin performing a **destructive auth revocation** sees English throughout, including the irreversible-impact warning. (`i18n/F1`, `identity/F12`)
2. **AI connection-test pending message** — `aiCatalog.editor.test.message.pending` (its `.success`/`.failure` siblings exist). (`i18n/F2`)
3. **Server-rendered OAuth/IdP callback result pages** hardcode English titles/messages and never localize by request locale. (`shared-infra/F8`)

**Action:** add the 9 keys to `packages/locales/src/default/admin.ts` + hand-write en-US/zh-CN mirrors; localize the two callback HTML pages. Low effort, and dimension ④ is otherwise clean.

---

## 8. ② Test rot & ③ dead code (rollups)

**② Tests that lock in a bug (must FIX, not just pass):** `ai/F2,F4` · `agents/F4` (mock models wrong CAS, hides `agents/F1`) · `connectors` same-epoch governance test · `routers/F7` (false-success disconnect) · `settings-branding/F7,F8` · `shared-infra/F7` (tests a local copy, not production) · `security-guards/F7` · `platform-instance/F7,F8`. **DELETE (no value):** `skills/F9` (empty `export {}` test file) · `routers/F8` (assertion-free duplicate). **Flaky (wall-clock / Docker / network coupled):** `ai/F4`, `platform-instance/F7`, `security-guards/F7`, `scripts-tooling/F11` (real Docker+180 s OTLP probe in a unit test), `scripts-tooling/F12`.

**③ Confirmed dead code / cruft:** `ai/F5` (`jsonContainsModelReference`) · `agents/F8` (`buildAdminAgentListKey`) · `connectors/F7` (`UNAVAILABLE_CONNECTOR_GOVERNANCE` alias) · `contracts/F8` (exported secret helpers) · `db-core/F6` (`assertImmutable`, now owned by a trigger) · `routers/F9` (`FIXED_AUDIT_REASON` export) · `scripts-tooling/F13` (several orphaned exports) · `security-guards/F8` (`DOCUMENTATION_PLACEHOLDER_MARKERS` + `void`) · **`security-guards/F9`** (`RESIDUAL.md` documents `allow-private` default while runtime is `public-only` — misleading security posture doc) · `shared-infra/F9` (commented-out route exports) · `skills/F8` (built-in source filter with no data source → always-empty table).

---

## 9. Per-partition index

| Partition         | Report                                                    | Codex C/H/M/L | Highlights                                                        |
| ----------------- | --------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| audit             | [audit.md](./partitions/audit.md)                         | 1 / 6 / 5 / 0 | **C1** evidence-before-audit race; conversation authz gaps        |
| identity          | [identity.md](./partitions/identity.md)                   | 3 / 4 / 4 / 2 | **C2** disable doesn't revoke; LKG/role fail-opens                |
| ai                | [ai.md](./partitions/ai.md)                               | 1 / 0 / 3 / 2 | hard-delete → BYOK fail-open                                      |
| connectors        | [connectors.md](./partitions/connectors.md)               | 1 / 1 / 3 / 2 | governance LKG fail-open; false-success disconnect                |
| scripts-tooling   | [scripts-tooling.md](./partitions/scripts-tooling.md)     | 3 / 5 / 3 / 3 | CI gates fail-open/hollow (latent until prod-trust on)            |
| agents            | [agents.md](./partitions/agents.md)                       | 0 / 3 / 3 / 2 | refresh-lock deadlock; arbitrary version publish                  |
| skills            | [skills.md](./partitions/skills.md)                       | 0 / 3 / 4 / 2 | secret persisted on fail; catalog-wide DoS; override reactivation |
| settings-branding | [settings-branding.md](./partitions/settings-branding.md) | 0 / 2 / 4 / 4 | legacy-pref wipe; cross-slice cache bug                           |
| contracts         | [contracts.md](./partitions/contracts.md)                 | 0 / 4 / 2 / 2 | empty-allowlist; no-CAS settings; fingerprint exposure            |
| platform-instance | [platform-instance.md](./partitions/platform-instance.md) | 0 / 3 / 3 / 2 | credential CAS; blocking index; unbounded usage                   |
| security-guards   | [security-guards.md](./partitions/security-guards.md)     | 0 / 3 / 2 / 4 | Alibaba IMDS SSRF; redaction coverage gaps                        |
| routers           | [routers.md](./partitions/routers.md)                     | 0 / 2 / 5 / 2 | **registry drift** (disable); false-success disconnect            |
| shared-infra      | [shared-infra.md](./partitions/shared-infra.md)           | 0 / 1 / 5 / 3 | client races; callback pages un-localized                         |
| users-rbac        | [users-rbac.md](./partitions/users-rbac.md)               | 0 / 1 / 2 / 2 | GUC-trust immutability bypass                                     |
| db-core           | [db-core.md](./partitions/db-core.md)                     | 0 / 1 / 2 / 3 | job retry budget; singleton row-id / blocking index               |
| i18n              | [i18n.md](./partitions/i18n.md)                           | 0 / 0 / 1 / 1 | 9 missing zh-CN keys (see §7)                                     |

---

## 10. Methodology & reproduction

- **Discovery prompts:** [`audit/round2/prompts/`](./prompts/) · **launcher:** [`run.sh`](./run.sh) · **generator:** [`setup.sh`](./setup.sh)
- **Verification:** cross-model, one Claude agent per CRITICAL/HIGH, adversarial "try to refute" framing, structured verdict (`verdict`, `trueSeverity`, `confidence`, `justification`, `decisiveEvidence`, `correctionNote`). Verdicts: [`verdicts.json`](./verdicts.json). One finding (`skills/F2`) hit the structured-output retry cap and was verified by a follow-up agent (CONFIRMED HIGH).
- **Independence controls:** reviewers ran in a read-only sandbox (could not modify source) and were instructed not to read the prior `audit/` reports; reports captured via `codex exec --output-last-message`.
- **Known limitation:** the adversarial verifiers skew toward downgrading; treat MEDIUM downgrades as "real but preconditioned," not "minor." The 87 MEDIUM/LOW codex findings were not independently re-verified.

## 11. Recommended action order

1. **Fix C1 + C2** (transactional enqueue+audit; tombstone-as-pending-restart). Design-review both subsystems — they've now produced CRITICALs twice.
2. **Register `admin.identityProviders.disable` in the policy registry** (`routers/F3`) — closes the governance half of C2 and un-breaks the registry-parity test.
3. **Batch the §5 dedup clusters** (empty-allowlist refinement; settings CAS; connector-disconnect revocation; concurrent-index follow-up migration; stats pagination).
4. **Land the 19 HIGH** by theme (authz/exposure → secret/evidence → availability → lost-update → async-UI).
5. **Add the 9 zh-CN keys** (§7) and **fix the bug-locking tests** (§8) — cheap, prevents regressions from re-hiding these.
6. **Before enabling production-trust**, fix the `scripts-tooling` gate fail-opens (§6).
