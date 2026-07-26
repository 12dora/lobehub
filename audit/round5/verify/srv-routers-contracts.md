# Verification — srv-routers-contracts

## Verdicts

| Finding ID                 | Original severity | Verdict   | Corrected severity | One-line reason                                                                                                                                                      |
| -------------------------- | ----------------- | --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-routers-contracts-D5-1 | HIGH              | CONFIRMED | HIGH               | Four existing-provider mutations omit the provider ID during sanitization, allowing an opaque current secret to reach immutable revision comments and audit reasons. |
| srv-routers-contracts-D6-1 | HIGH              | CONFIRMED | HIGH               | The RPC rejects after an atomic policy commit, while the client marks publish failed and connector execution can remain globally fail-closed.                        |

## Details

### srv-routers-contracts-D5-1 — CONFIRMED

- **What the original claimed:** `delete`, `disable`, `publish`, and `rollback` fail to compare audit reasons against the provider’s stored opaque client secret, allowing that secret to be persisted.

- **What I actually found:** `sanitizeIdentityReason` only resolves the stored secret when `currentSecretTargetId` is present; otherwise it relies solely on pattern detection and replacement-secret values (`apps/server/src/enterprise/routers/admin/identityProviders.ts:148-179`). `update` supplies `input.id` (`apps/server/src/enterprise/routers/admin/identityProviders.ts:450-474`), while the four reported mutations omit it from both denied-reauth and normal sanitization:

  - Delete: `apps/server/src/enterprise/routers/admin/identityProviders.ts:275-295`
  - Disable: `apps/server/src/enterprise/routers/admin/identityProviders.ts:298-323`
  - Publish: `apps/server/src/enterprise/routers/admin/identityProviders.ts:358-383`
  - Rollback: `apps/server/src/enterprise/routers/admin/identityProviders.ts:386-411`

  The input contract rejects recognizable credential shapes, but not arbitrary opaque values (`apps/server/src/enterprise/contracts/identityProviders.ts:158-166`). The detector itself only recognizes known shapes, assignments, credential URLs, and sensitive object keys (`packages/database/src/models/platform/redact.ts:257-290`).

  Downstream persistence is real:

  - Denied reauthentication writes the resolved reason directly to the audit service (`apps/server/src/enterprise/guards/reauth.ts:109-127`).
  - Delete writes it on successful and failed audit paths (`apps/server/src/enterprise/services/identityProvider/adminService.ts:152-178`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:297-350`).
  - Disable writes it as an immutable revision comment and audit reason (`apps/server/src/enterprise/services/identityProvider/disableService.ts:99-165`) and again on failure (`apps/server/src/enterprise/services/identityProvider/disableService.ts:247-268`).
  - Publish and rollback place it in idempotency reservation, terminal-success, and terminal-failure audit rows (`apps/server/src/enterprise/services/identityProvider/publicationIdempotency.ts:409-478`, `apps/server/src/enterprise/services/identityProvider/publicationIdempotency.ts:488-565`). Publish also uses it as the revision comment (`apps/server/src/enterprise/services/identityProvider/publicationService.ts:281-296`).

- **Refutation attempts:**

  - Checked the central audit model for a second-line reason sanitizer. It redacts `beforeDiff` and `afterDiff`, but writes `params.reason` unchanged (`packages/database/src/models/platform/auditLog.ts:115-148`).
  - Checked database constraints and triggers. The audit and revision triggers enforce append-only/immutable storage but do not inspect reason content (`packages/database/migrations/0000_squash_baseline.sql:6805-6839`).
  - Checked read-time redaction. Audit DTO projection returns `row.reason` directly (`apps/server/src/enterprise/services/audit/adminAuditServiceShared.ts:34-53`), and audit endpoints are available under `AUDIT_READ` (`apps/server/src/enterprise/routers/admin/audit.ts:83-92`).
  - Checked the actual UI caller. The reason modal accepts any non-empty free text and performs no secret comparison (`src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:167-216`, `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:254-264`). Delete and disable pass that text directly (`src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:125-183`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:193-224`); publish does likewise (`src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:384-416`).
  - Checked regression tests. Opaque current-secret coverage exercises `update` only (`apps/server/src/enterprise/routers/admin/identityProviders.test.ts:256-391`); delete uses an ordinary reason (`apps/server/src/enterprise/routers/admin/identityProviders.test.ts:535-596`).
  - Checked the baseline commit. The router, contracts, and affected identity-provider services are absent from `4bab1636408e60a7ee17b640490fbf33a310a325`, so this is not an inherited upstream defect.

- **Verdict rationale:** No upstream guard, persistence sanitizer, database constraint, or read-time mask closes the gap. An opaque secret such as the test fixture bypasses pattern detection, and omission of `currentSecretTargetId` makes the raw value flow directly into durable storage.

- **Corrected severity and scope:** HIGH. Exploitation requires an identity administrator who knows and pastes the current secret, accidentally or deliberately. The resulting value becomes visible to principals with `AUDIT_READ`, including the distinct auditor role (`packages/const/src/platform/roles.ts:156-180`). All four mutations are affected; successful publish/disable additionally contaminate immutable revision metadata.

### srv-routers-contracts-D6-1 — CONFIRMED

- **What the original claimed:** Managed-resource publish can commit the policy and success audit, then reject the RPC when post-commit policy resolution or connector-runtime finalization fails.

- **What I actually found:** The router calls `ManagedResourcePolicyService.publish`, sets `publishCommitted = true`, and subsequently performs policy resolution and runtime finalization (`apps/server/src/enterprise/routers/admin/managedResources.ts:80-117`). Any unexpected post-commit exception is rethrown (`apps/server/src/enterprise/routers/admin/managedResources.ts:118-134`), while `finally` deliberately does not cancel the transition after commit (`apps/server/src/enterprise/routers/admin/managedResources.ts:135-147`).

  The service’s underlying publish transaction atomically inserts the revision, updates/materializes the pointer, appends the success audit, and commits before returning (`packages/database/src/models/platform/revision.ts:183-265`). Therefore, once router line 101 executes, the durable policy result cannot be rolled back by later failures.

  Connector finalization can throw on Redis unavailability or a missing/expired/mismatched transition token (`apps/server/src/enterprise/services/connectorCatalog/runtimeEffectiveState.ts:260-290`). The API output can express only `{ auditId, revision }` (`apps/server/src/enterprise/contracts/adminManagedResources.ts:68-73`).

  The client awaits the RPC before refreshing capabilities (`src/enterprise/client/features/admin/managedResources/actions.ts:38-53`). On rejection, the page marks the operation failed and displays a generic failure (`src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:275-290`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:368-413`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:524-535`).

- **Refutation attempts:**

  - Checked whether invalidation could be the alleged post-commit failure. `PlatformPublisherService` already treats invalidation as best-effort and suppresses its errors (`apps/server/src/enterprise/services/platformPublisher.ts:150-163`), but that protection does not cover the router’s later resolver/finalizer.
  - Checked readiness probes. Individual probe errors are converted to `false` (`apps/server/src/enterprise/services/managedResourceReadiness.ts:22-39`), but the policy snapshot database read and runtime finalization remain fallible.
  - Checked for a global client handler or retry. `withAdminReauthRetry` rethrows every non-reauth error and retries only `ADMIN_REAUTH_REQUIRED` (`src/enterprise/client/features/admin/reauth/requestAdminReauth.ts:193-230`).
  - Checked runtime recovery. Capability reads intentionally do not republish runtime state (`apps/server/src/enterprise/routers/platform.ts:74-98`). The only general recovery publisher is a one-shot process bootstrap guarded by `bootstrapStarted` (`apps/server/src/enterprise/services/connectorCatalog/runtimeEffectiveStateBootstrap.ts:15-53`); no recurring recovery worker was found.
  - Checked runtime blast radius. Blocked mode returns a stable connector failure instead of falling back to legacy execution (`apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:539-560`).
  - Checked tests. The router test enables only platform administration and publishes a skills-only policy (`apps/server/src/enterprise/routers/admin/managedResources.test.ts:74-76`, `apps/server/src/enterprise/routers/admin/managedResources.test.ts:119-139`), so the connector-transition branch is not covered. Client tests cover a refresh failure after an RPC success, not an RPC rejection after server commit (`src/enterprise/client/features/admin/managedResources/actions.test.ts:88-113`).
  - Checked the baseline commit. All directly relevant managed-resource router, contract, policy, and runtime-state files are absent from the stated baseline.

- **Verdict rationale:** The commit boundary is demonstrably before two fallible operations, and neither the router contract nor client has a partial-success state. A finalization rejection therefore reports failure for an already-committed publish.

- **Corrected severity and scope:** HIGH when `ENABLE_PLATFORM_MANAGED_CONNECTORS` is enabled and a post-commit database or transition-finalization failure occurs. The original report slightly understates recovery: the transition may remain blocked beyond its 30-second lease because no recurring DB-backed capability republisher was found. Recovery requires another successful authoritative publish, a new process bootstrap, or equivalent external action; meanwhile managed connector execution returns `PLATFORM_CONNECTOR_NOT_PUBLISHED`.
