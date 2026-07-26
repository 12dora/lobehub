# Verification — srv-identity

## Verdicts

| Finding ID          | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                |
| ------------------- | ----------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-identity-D5-001 | CRITICAL          | DOWNGRADED | HIGH               | A stale readable LKG can restore the provider configuration, but usable sign-in additionally requires database recovery without another process restart.       |
| srv-identity-D2-001 | HIGH              | DOWNGRADED | MEDIUM             | The meaningful failure-retains-stale-LKG case is untested, but several proposed “error branches” are inherently safe and the omission is derivative of D5-001. |

## Details

### srv-identity-D5-001 — DOWNGRADED

- **What the original claimed:** A disable commits its database tombstone before a best-effort LKG update. If that update fails and the database is subsequently unavailable, startup loads the older LKG and reactivates the disabled provider.

- **What I actually found:** The underlying state transition is real. The database transaction inserts the tombstone and marks the provider disabled at `apps/server/src/enterprise/services/identityProvider/disableService.ts:48-170`. All LKG errors are caught after that commit at `apps/server/src/enterprise/services/identityProvider/disableService.ts:172-219`, and the operation returns the committed result at `apps/server/src/enterprise/services/identityProvider/disableService.ts:221-246`. A pre-rename filesystem failure can leave the previous LKG intact while producing `write_failed` at `apps/server/src/enterprise/services/identityProvider/lkg.ts:494-590`.

  On startup, `validatedTombstones` remains empty when database selection fails at `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:416-434`. The old LKG is then materialized without the database tombstone at `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:502-525`; `fromLkgPayload` filters only database-validated tombstones at `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:338-381`.

  The resulting snapshot is consumed once when the auth module initializes at `src/auth.ts:7-15`. Because the stale payload still has `enabled: true`, it passes the filter and is registered as a generic OAuth provider at `src/libs/better-auth/define-config.ts:127-145` and `src/libs/better-auth/define-config.ts:423-431`.

- **Refutation attempts:**

  - The published-revision lock and revision CAS at `apps/server/src/enterprise/services/identityProvider/disableService.ts:48-58` and `apps/server/src/enterprise/services/identityProvider/disableService.ts:121-139` protect database concurrency only; they do not cover the later filesystem operation.
  - Revision uniqueness and immutability exist at `packages/database/src/schemas/platform/revisions.ts:7-64` and `packages/database/migrations/0000_squash_baseline.sql:6805-6818`. They preserve the tombstone but cannot enforce it while startup cannot read the database.
  - Startup correctly excludes a tombstone whenever database selection succeeds at `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:150-183`. That guard disappears specifically when selection itself fails.
  - LKG signature, ownership, permissions, identity, and age checks at `apps/server/src/enterprise/services/identityProvider/lkg.ts:131-165` and `apps/server/src/enterprise/services/identityProvider/lkg.ts:339-423` authenticate the old snapshot; they do not prove it postdates the disable.
  - The process-local LKG lock serializes successful same-process writes, but is explicitly not cross-process protection at `apps/server/src/enterprise/services/identityProvider/lkg.ts:675-703`.
  - The normal restart workflow checks pending database state and the target identity revision at `apps/server/src/enterprise/services/identityProvider/systemService.ts:393-419` and `apps/server/src/enterprise/services/identityProvider/systemService.ts:581-595`. It never checks the disable’s LKG-advance result.
  - Better Auth’s provider adapter performs no live enabled/status lookup; it closes over the startup provider at `src/libs/better-auth/sso/platformIdentityProvider.ts:271-304`. The OAuth-state plugin validates flow binding, not current provider status, at `src/libs/better-auth/sso/platformIdentityProviderState.ts:45-74`.
  - The four cited files do not exist at baseline `4bab1636408e60a7ee17b640490fbf33a310a325`, so this is fork-owned and not out of scope.

- **Verdict rationale:** The core stale-configuration defect survives. However, the report overstates immediate sign-in availability during a _complete_ database outage. OAuth state is configured as database-backed at `src/libs/better-auth/define-config.ts:153-155`, and Better Auth uses the PostgreSQL adapter at `src/libs/better-auth/define-config.ts:229-241`. A login therefore cannot normally complete while that database remains unavailable.

  The security exposure arises if startup accepts the stale LKG during the outage and the database later recovers without another process restart. The already-created Better Auth configuration remains stale, at which point the disabled provider can authenticate again. This requires a prior live LKG, an LKG failure that leaves it readable, outage-time startup, and subsequent database recovery.

- **Corrected severity and scope:** **HIGH.** This remains a security-relevant revocation failure, but it is a compound recovery sequence rather than an immediately usable authentication bypass during the database outage. Not every reported LKG outcome is unsafe: `no_lkg` leaves no stale file to load, `stale_tombstone` represents a newer re-enable, and `rejected` can preserve a newer safe snapshot.

### srv-identity-D2-001 — DOWNGRADED

- **What the original claimed:** The Round-4 regression proves only successful LKG advancement. It does not test startup after missing-secret, missing-LKG, read/write-failure, or rejected advancement outcomes.

- **What I actually found:** The integration test at `apps/server/src/enterprise/services/identityProvider/publicationService.disable.test.ts:232-299` seeds a live LKG, supplies working secrets, disables the provider, simulates complete database failure, and verifies absence from the LKG startup result. The separate missing-secret test at `apps/server/src/enterprise/services/identityProvider/publicationService.disable.test.ts:301-340` checks only `lkgAdvance` and its audit row; it neither seeds a pre-disable LKG nor runs outage startup.

  The LKG unit suite proves successful advancement at `apps/server/src/enterprise/services/identityProvider/lkg.test.ts:321-349`, concurrent successful merging at `apps/server/src/enterprise/services/identityProvider/lkg.test.ts:351-404`, and safe stale-tombstone rejection at `apps/server/src/enterprise/services/identityProvider/lkg.test.ts:406-455`. It contains no coupled sequence where an update failure preserves a live provider and startup later loses database tombstones.

- **Refutation attempts:**

  - Repository-wide test searches for `missing_secret`, `no_lkg`, `read_failed`, `write_failed`, total-database-outage, and resurrection scenarios found no equivalent failure-to-startup coverage under another test name.
  - Startup tests cover ordinary database outage with an existing valid LKG at `apps/server/src/enterprise/services/identityProvider/startupSnapshot.test.ts:542-559`, but do not first disable the provider through a failed LKG update.
  - The report’s suggested matrix is overbroad. A `no_lkg` result cannot simultaneously preserve the seeded stale LKG the proposed test requires. `stale_tombstone` is deliberately safe, while `rejected` can mean a newer cross-process snapshot or re-enable must remain authoritative. Even `write_failed` can occur after rename during final verification or directory sync, when the updated file may already be safe.
  - The test file is fork-added relative to the stated baseline, so the coverage gap is not inherited upstream.

- **Verdict rationale:** A valuable regression is genuinely missing: inject a failure before replacement of a previously seeded live LKG, then prove outage startup fails closed. The stronger assertion that the invariant fails across every best-effort branch is not supported.

- **Corrected severity and scope:** **MEDIUM.** This is a real security-regression coverage gap, but it is not an independent production vulnerability and only a subset of failure outcomes can preserve a readable stale provider.
