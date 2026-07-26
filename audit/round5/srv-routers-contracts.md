# Round 5 Audit — srv-routers-contracts

## Scope

Audited all fork-owned files under:

- `apps/server/src/enterprise/routers`
- `apps/server/src/enterprise/contracts`

The baseline diff contains 126 added files and 30,906 added LOC:

- Routers: 64 files, 18,392 LOC
- Contracts: 62 files, 12,514 LOC

All 126 files are fork additions relative to `4bab1636408e60a7ee17b640490fbf33a310a325`; no byte-identical upstream files were included or excluded. Callers outside these paths were read only where needed to verify behavior and impact. No files were modified and no write-capable checks were run.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        2 | MEDIUM           |
| D2 Test decay                                         |        2 | MEDIUM           |
| D3 Dead code and development debris                   |        0 | —                |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        1 | HIGH             |
| D6 Warnings and errors not surfaced via toast         |        1 | HIGH             |
| D7 Overly technical/internal-state-leaking UI strings |        0 | —                |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-routers-contracts-D5-1 — Four identity-provider mutations can persist the current client secret in append-only audit reasons

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/routers/admin/identityProviders.ts:143-215`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:275-315`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:358-411`, `apps/server/src/enterprise/contracts/identityProviders.ts:158-166`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:297-350`, `apps/server/src/enterprise/services/identityProvider/disableService.ts:40-46`, `apps/server/src/enterprise/services/identityProvider/disableService.ts:148-165`, `apps/server/src/enterprise/services/identityProvider/disableService.ts:247-268`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:182-205`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:323-360`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:368-403`
- **Confidence:** HIGH
- **What:** The sanitizer only loads and redacts the stored client secret when `currentSecretTargetId` is supplied. `delete`, `disable`, `publish`, and `rollback` omit that field both for denied-reauth auditing and for the reason passed to their services.
- **Evidence:** `sanitizeIdentityReason` adds the stored secret to `credentialValues` only inside `if (input.currentSecretTargetId)`. The update path correctly supplies `input.id`, but all four affected mutations pass only `reason`, `serverDB`, and `targetId`. The contract’s `reasonSchema` only performs pattern-based `containsEnterpriseSecretMaterial` detection, so opaque values such as the existing test fixture `opaque-current-value-7319` are accepted. The downstream services persist `input.reason` as revision comments, idempotency payload data, and audit-log `reason` fields. Round 4 changed the reauth-helper call shape but left these four missing arguments intact.
- **Impact:** If an administrator pastes the current opaque OIDC client secret into a reason, the secret is retained in append-only audit/revision data and becomes visible to audit readers. The leak can occur on both denied reauthentication and successful or failed mutation paths.
- **Fix:** Route every existing-provider mutation through a helper that requires a provider ID and always supplies `currentSecretTargetId: input.id` to both reauth and success-path sanitization. Make omission impossible in the type signature. Add table-driven coverage for all existing-provider mutations and for denied, success, and failure audit paths.

### srv-routers-contracts-D6-1 — Managed-resource publish reports total failure after the policy has already committed

- **Severity:** HIGH
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `apps/server/src/enterprise/routers/admin/managedResources.ts:80-147`, `apps/server/src/enterprise/contracts/adminManagedResources.ts:68-73`, `src/enterprise/client/features/admin/managedResources/actions.ts:38-53`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:368-413`
- **Confidence:** HIGH
- **What:** The router commits the policy, marks `publishCommitted = true`, and only then resolves effective policies and finalizes the connector runtime transition. Failure in either post-commit step is rethrown as a rejected RPC even though the database policy and success audit are already durable.
- **Evidence:** `ManagedResourcePolicyService.publish()` completes at lines 94-100; line 101 records the commit. Lines 102-115 perform fallible post-commit work, while the catch at lines 118-134 rethrows unrecognized errors. The `finally` block deliberately leaves the transition blocked after a confirmed commit. The output contract can express only `{ auditId, revision }`, with no partial-success state. The client awaits the RPC before refreshing capabilities; rejection goes to `mapActionError`, marks the operation failed, and skips both capability and SWR refreshes.
- **Impact:** During runtime-authority or policy-resolution failures, administrators are told the publish failed even though it succeeded. The page remains stale, retries can produce CAS conflicts, and connector execution can remain temporarily blocked while recovery runs.
- **Fix:** Separate the commit result from runtime convergence. Extend the output contract with a status such as `runtimeTransition: 'finalized' | 'pending_recovery'`, return the committed revision after post-commit failure, and schedule or retain the safe self-heal path. The client should revalidate and show `toast.warning` from `@lobehub/ui/base-ui`, for example: “Published, but connector activation is still recovering. Reload in a moment.”

### srv-routers-contracts-D1-1 — The credential router has no output contract at its plaintext-sensitive boundary

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/routers/admin/creds.ts:1-5`, `apps/server/src/enterprise/routers/admin/creds.ts:31-279`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:64-72`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:548-578`
- **Confidence:** HIGH
- **What:** Every `admin.creds` procedure defines inputs inline and none declares `.output(...)`, including `get` and `getByKey`, despite the router’s explicit guarantee that plaintext must never be returned.
- **Evidence:** `get` accepts `decrypt` and directly returns the service DTO without output validation. That DTO deliberately retains a property named `plaintext?: Record<string,string>` and currently fills it with masks. Because there is no strict router output schema or whitelist, any future service regression that returns a decrypted value would be serialized unchanged.
- **Impact:** A security-critical invariant exists only as a service implementation convention and one behavioral test, rather than at the public TRPC boundary. Refactors, compatibility work, or alternate service implementations can silently expand the response or disclose credential material.
- **Fix:** Add centralized `contracts/adminCreds.ts` input and strict output schemas and attach `.output(...)` to every procedure. Prefer a DTO such as `configuredKeys` over `plaintext`; if compatibility requires the existing field, constrain every returned value to the fixed mask/status literals.

### srv-routers-contracts-D1-2 — Connector “contracts” own service orchestration and runtime secret state

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/contracts/platformConnectors/common.ts:8-15`, `apps/server/src/enterprise/contracts/platformConnectors/normalize.ts:38-248`, `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:35-129`, `apps/server/src/enterprise/contracts/platformConnectors.ts:55-99`
- **Confidence:** HIGH
- **What:** The contract layer is not limited to schemas and DTOs. It imports a connector service validator, owns a private `WeakMap` of trusted secret contexts, loads current secrets asynchronously, and performs create/update orchestration.
- **Evidence:** `common.ts` imports `toolDefinitionValidator` from `services/connectorCatalog`. `secrets.ts` mints and stores trusted runtime contexts, and `normalize.ts` applies mode switching, derived IDs, secret-slot reconciliation, and persistent-field policy. The actual service imports these operations back from the public contract barrel at `services/connectorCatalog/draftService.ts:20-36` and calls them at lines 408-428 and 557-562. A browser-side feature also runtime-imports the same barrel for one error-code schema at `src/features/PlatformConnectorAuthorization/enterpriseAdapter.ts:15-16`.
- **Impact:** Schema consumers become coupled to connector-service implementation details, service changes ripple through the public contract dependency graph, and server-only secret orchestration is exposed through a barrel also used by client code. This makes the boundary harder to reuse, test, and evolve safely.
- **Fix:** Keep the contract package to pure Zod schemas, constants, and types. Move trusted-secret context creation and create/update normalization into the connector service layer. Move reusable tool-schema validation into a dependency-neutral security/validation module that both contracts and services may import.

### srv-routers-contracts-D2-1 — Identity secret-redaction regression tests cover only create and update

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/routers/admin/identityProviders.test.ts:256-391`, `apps/server/src/enterprise/routers/admin/identityProviders.test.ts:543-596`
- **Confidence:** HIGH
- **What:** The regression suite proves opaque current-secret redaction only for `update` and success/failure audit redaction only for `create` and `update`. It does not exercise the equivalent reason path for `delete`, `disable`, `publish`, or `rollback`.
- **Evidence:** The opaque-secret tests at lines 256-391 invoke only `update`, while their success/failure audit filter explicitly accepts only create/update actions. Delete tests later use the ordinary reason “delete unused identity provider draft”; there are no opaque-current-secret calls for the other mutations. Consequently, the missing `currentSecretTargetId` arguments pass unnoticed.
- **Impact:** The central Round-4 secret-audit invariant can regress or remain partially implemented while the suite stays green.
- **Fix:** Add a table-driven router test for every mutation accepting a reason. Seed an opaque stored client secret, include it in the reason, exercise stale and fresh reauth plus service failure where applicable, and assert the serialized audit/revision state never contains the secret.

### srv-routers-contracts-D2-2 — Managed-resource tests never enter the connector transition branch

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/routers/admin/managedResources.test.ts:74-139`, `apps/server/src/enterprise/routers/admin/managedResources.ts:80-147`
- **Confidence:** HIGH
- **What:** The only successful publish test publishes a skills-only UI policy while the managed-connectors flag remains disabled. No test covers transition acquisition, cancellation, finalization, or post-commit failure.
- **Evidence:** Test setup stubs only `ENABLE_PLATFORM_ADMIN`. The happy-path draft changes `skills`, and the test file contains no references to `beginConnectorRuntimeEffectiveStateTransition`, `finalizeConnectorRuntimeEffectiveStateTransition`, cancellation, or transition tokens. Thus lines 85-115 of the router are not exercised with managed connectors enabled.
- **Impact:** The router can conflate a committed publish with a failed one, strand safe-blocked runtime state, or mishandle cleanup without any regression failure.
- **Fix:** Mock the transition authority and add separate tests for acquisition failure, pre-commit publish failure, successful finalization, and finalization failure after commit. The last case must assert that the published revision remains authoritative and that the API returns an explicit recovery status rather than rejecting as an uncommitted failure.

## Dimensions with no findings

- **D3 Dead code and development debris:** Repo-wide searches found no skipped/todo/only tests, backup artifacts, debug `console.log`, or export that could be proven unused. Documented compatibility aliases were not classified as dead without evidence that external clients have also migrated.
- **D4 Missing Simplified Chinese i18n coverage:** Hardcoded strings in this server scope are validation diagnostics or stable machine codes; verified UI consumers map relevant enterprise and connector failures to locale keys with populated zh-CN translations.
- **D7 Overly technical/internal-state-leaking UI strings:** Raw server exceptions traced in this scope are converted by current UI consumers to localized generic or code-specific copy rather than rendered directly. The managed-resource defect above reports the wrong outcome, but does not expose its internal transition string in the current page.
- **D8 Missing animations/motion:** These backend contracts expose pending/running/progress states for long-running system, identity-test, connector-authorization, and rotation operations. No missing state field in this scope was found that prevents the UI from using upstream loading or transition components.

## Cross-scope notes

The frontend credentials auditor should verify platform-global credential wiring. `src/routes/(main)/settings/creds/features/useCredsApi.ts:15-17` documents a platform mode backed by `admin.creds`, but a repo-wide production-code search found no construction using `lambdaClient.admin.creds` or `lambdaQuery.admin.creds`; current references are router tests, policy registries, audit labels, and documentation.
