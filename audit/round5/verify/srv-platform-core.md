# Verification — srv-platform-core

## Verdicts

| Finding ID             | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                               |
| ---------------------- | ----------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-platform-core-D5-1 | HIGH              | DOWNGRADED | MEDIUM             | The token mismatch is real, but it affects convergence telemetry rather than catalog runtime behavior, and the current admin UI does not display the erroneous domain status. |
| srv-platform-core-D5-2 | HIGH              | DOWNGRADED | MEDIUM             | SQL NULL semantics do corrupt the aggregate, but per-instance diagnostics and the canonical OIDC restart ledger still detect the lagging instance.                            |

## Details

### srv-platform-core-D5-1 — DOWNGRADED

- **What the original claimed:** Archiving a disabled builtin override produces an immutable tombstone, but the lightweight skill-catalog target omits it because it consults the mutable pointer’s `enabled` field. Runtime and health tokens therefore differ.

- **What I actually found:** The mismatch is reproducible from the current code.

  - Draft mutation persists `enabled: false` to the mutable skill row at `packages/database/src/models/platform/skillCatalog.model.ts:239-265`.
  - Archive publication forces only the immutable snapshot’s `skill.enabled` to `true` and records `builtinOverrideTombstone: true` at `packages/database/src/models/platform/skillCatalog.pointer.ts:64-75`.
  - Publication materialization updates `currentVersionId`, `revision`, `status`, and `updatedBy`, but not the mutable `enabled` field, at `packages/database/src/models/platform/skillCatalog.pointer.ts:42-55`.
  - The full runtime snapshot correctly recognizes the tombstone from immutable payload fields at `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:195-213`.
  - The lightweight target instead requires `row.enabled` at `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:389-400`, so the disabled pointer is skipped.
  - The existing integration test explicitly constructs this state and verifies payload `enabled: true` while the draft was disabled at `apps/server/src/enterprise/services/skillCatalog/adminService.test.ts:736-803`.
  - Tombstone presence is token-significant, as demonstrated by `apps/server/src/enterprise/services/platformInstance/catalogTokens.test.ts:49-74`.

- **Refutation attempts:**

  - I checked for a database constraint forcing archived builtin overrides to remain enabled. `platform_skills.enabled` is merely non-null, and the only relevant status constraint requires a version for `published` rows; it imposes no archived/enabled relationship at `packages/database/src/schemas/platform/skills.ts:110-140`.
  - I checked whether archive avoids tombstone publication when the pointer is disabled. It passes `builtinOverrideTombstone: skill.allowBuiltinOverride` regardless of `enabled` at `apps/server/src/enterprise/services/skillCatalog/publication.ts:224-247`.
  - I checked whether a warm authority cache masks the mismatch. Archive invalidates the authority token at `apps/server/src/enterprise/services/skillCatalog/publication.ts:248-249`, forcing the faulty projection to rebuild.
  - Existing lightweight-target coverage only exercises an enabled published row at `apps/server/src/enterprise/services/platformInstance/catalogAuthority.test.ts:170-227`; it does not cover disabled archived tombstones.
  - I checked the user-facing blast radius. The admin response exposes domain summaries at `apps/server/src/enterprise/services/platformSystem/adminService.ts:630`, but the current system page renders summaries and instance freshness without rendering domain convergence at `src/enterprise/client/features/admin/system/SystemPageView.tsx:109-121` and `src/enterprise/client/features/admin/system/components/InstancesTable.tsx:31-63`.

- **Verdict rationale:** The functional defect survives: the runtime token contains the tombstone while the lightweight target token does not. The HIGH classification does not. Runtime suppression of the builtin remains correct; the failure is a false-positive convergence signal in the service/API, currently not displayed by the admin UI.

- **Corrected severity and scope:** **MEDIUM.** Scoped to skill-catalog convergence telemetry after the specific publish → disable draft → archive sequence. No runtime resurrection, data loss, or authorization failure occurs.

### srv-platform-core-D5-2 — DOWNGRADED

- **What the original claimed:** A fresh healthy OIDC instance with `activeIdentityRevision = NULL` is counted as fresh but neither matching nor diverged against a non-null target, allowing the aggregate to report `converged`.

- **What I actually found:** The aggregate defect is real.

  - For a non-null target, `matches` is ordinary equality at `apps/server/src/enterprise/services/platformInstance/statusService.ts:384-387`.
  - Both divergent counting and issue selection negate that nullable expression at `apps/server/src/enterprise/services/platformInstance/statusService.ts:395-415`. With a null active revision, SQL evaluates both equality and its negation as `NULL`, which fails both filters.
  - `fresh` still counts the row, while `unreported` is fixed at zero at `apps/server/src/enterprise/services/platformInstance/statusService.ts:395-403` and `apps/server/src/enterprise/services/platformInstance/statusService.ts:452-460`.
  - `convergenceStatus` consequently returns `converged` when there are fresh rows and no counted degraded, diverged, or unreported rows at `apps/server/src/enterprise/services/platformInstance/statusService.ts:129-139`.
  - The state is permitted: `activeIdentityRevision` is nullable and its check explicitly allows null at `packages/database/src/schemas/platform/identity.ts:327-366`.
  - Registration writes the nullable startup snapshot value directly at `apps/server/src/enterprise/services/identityProvider/instanceRegistry.ts:180-217`. Tests demonstrate a healthy environment-sourced instance with a null revision at `apps/server/src/enterprise/services/identityProvider/systemService.test.ts:434-458`.
  - The target loader normally computes a real digest, including for an empty provider set, at `apps/server/src/enterprise/services/identityProvider/systemService.ts:91-102`.

- **Refutation attempts:**

  - I checked for a schema, startup, or registration guard forbidding healthy null reports. None exists; both the schema and production registration path allow them.
  - I checked the scoped PGlite coverage. Its OIDC aggregation case uses a matching non-null remote revision and does not exercise a null remote report against a non-null target at `apps/server/src/enterprise/services/platformInstance/statusService.pglite.test.ts:165-215`.
  - I checked individual diagnostics. They are null-safe in JavaScript and correctly classify a null loaded token against a non-null target as `diverged` at `apps/server/src/enterprise/services/platformInstance/statusService.ts:253-275`.
  - Although the SQL issue query omits the row, the baseline candidate query still includes recent rows at `apps/server/src/enterprise/services/platformInstance/statusService.ts:408-447`. Thus small inventories can contain an individually divergent diagnostic despite the aggregate saying converged.
  - The paginated inventory also uses the null-safe individual projection at `apps/server/src/enterprise/services/platformInstance/statusService.ts:517-522`; its admin mapping marks an identity divergence as `pendingRestart` at `apps/server/src/enterprise/services/platformSystem/adminService.ts:503-519`.
  - Most importantly, the user-facing OIDC summary uses a separate canonical restart ledger. That path requires exact target equality for every fresh instance at `apps/server/src/enterprise/services/identityProvider/systemService.ts:247-253`, retains pending publication until convergence at `apps/server/src/enterprise/services/identityProvider/systemService.ts:270-320`, and is used by the system status response at `apps/server/src/enterprise/services/platformSystem/adminService.ts:593-614`.

- **Verdict rationale:** The domain aggregate can falsely say `converged`, so the finding cannot be refuted outright. The asserted administration-wide concealment is overstated: detailed instance projection and the canonical OIDC pending-restart path independently detect the null report. The aggregate and detailed rows can nevertheless contradict each other, and large inventories may omit the affected row from the bounded issue-first set.

- **Corrected severity and scope:** **MEDIUM.** The defect affects the identity domain convergence summary and issue prioritization. It does not, by itself, clear the canonical OIDC pending-restart state or make a null-reporting instance appear converged in the per-instance projection.
