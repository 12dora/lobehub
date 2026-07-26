# Verification — srv-connector

## Verdicts

| Finding ID         | Original severity | Verdict   | Corrected severity | One-line reason                                                                                                                                                               |
| ------------------ | ----------------- | --------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-connector-D5-1 | HIGH              | CONFIRMED | HIGH               | Runtime substitutes the shared owner without checking effective-ban state, and banning revokes sessions but leaves that owner’s connector binding intact.                     |
| srv-connector-D5-2 | HIGH              | CONFIRMED | HIGH               | Secret resolution occurs before either emergency mutation; archive additionally decrypts the published revision’s credential even though archival does not require plaintext. |

## Details

### srv-connector-D5-1 — CONFIRMED

- **What the original claimed:** A permanently or temporarily banned shared-OAuth owner remains usable as the organization-wide connector identity.

- **What I actually found:** Assignment checks only `users.id` at `apps/server/src/enterprise/services/connectorGovernance/adminService.ts:106-112`. Effective-ban fields exist at `packages/database/src/schemas/user.ts:37-41`, with active temporary bans defined by `packages/database/src/utils/userBan.ts:17-32`. Governance copies the stored owner directly into the resolved result at `apps/server/src/enterprise/services/connectorGovernance/service.ts:92-96`. Runtime then substitutes that ID at `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:618-628`, loads its binding at `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:678-704`, and validates only binding properties at `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:467-493`. No owner-status check occurs.

- **Refutation attempts:**
  - Checked the ban transaction for implicit credential revocation. It sets the ban/auth epoch and revokes sessions and OIDC artifacts at `apps/server/src/enterprise/services/adminUser/lifecycleService.ts:65-111`; it does not revoke connector bindings.
  - Checked database constraints and cascades. Bindings reference their owner with `ON DELETE CASCADE` at `packages/database/src/schemas/platform/connectors.ts:388-393`, so hard deletion removes the platform binding. This refutes the deleted-owner variant for that binding path, but not permanent or active temporary bans.
  - Checked invoking-user middleware. The active-user guard validates the authenticated caller at `apps/server/src/enterprise/guards/activeUser.ts:52-95`; it never receives the substituted owner ID.
  - Checked UI restrictions. The ordinary UI shares only the current administrator’s own identity at `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:180-188`. That makes initial assignment of an already-banned third party less likely, but an owner can be banned after assignment.
  - Checked tests. The resolver happy path merely exposes the owner at `apps/server/src/enterprise/services/connectorGovernance/service.test.ts:109-116`; runtime tests affirm loading and refreshing that owner at `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.test.ts:561-581`. Neither test supplies ban state.
  - Checked other shared-identity consumers. LobeHub Skill and Composio execution also substitutes the owner without a liveness check at `apps/server/src/services/toolExecution/builtin.ts:75-91` and `apps/server/src/services/aiAgent/index.ts:2630-2639`.
  - Checked the baseline commit. The affected governance and managed-runtime files are absent from `4bab1636408e60a7ee17b640490fbf33a310a325`; this is fork-specific.

- **Verdict rationale:** An active user can reach an existing connected binding owned by an effectively banned shared owner. Neither middleware, governance resolution, binding validation, the ban transaction, nor a database constraint prevents it. Expired temporary bans are correctly considered active again; permanent and unexpired temporary bans reproduce the defect.

- **Corrected severity and scope:** HIGH. Scope is enterprise deployments with enforced managed connectors, a designated shared owner, and surviving owner authorization data. The banned user cannot directly invoke calls; other active users invoke them under that identity. Hard deletion removes platform connector bindings through the foreign-key cascade.

### srv-connector-D5-2 — CONFIRMED

- **What the original claimed:** Archive and bulk binding revocation cannot execute when connector secret decryption is unavailable; archive also resolves published credentials unnecessarily.

- **What I actually found:** `sanitizeConnectorReason` loads current secret sources before validating the reason at `apps/server/src/enterprise/services/connectorCatalog/catalogAudit.ts:32-41`. The production store follows current refs at `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:311-336` and decrypts them at `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:470-483`.

  Archive performs that sanitization before its `try` block at `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:702-705`. Its archive preflight then unconditionally resolves the published payload’s credential at `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:349-397`. The actual archival publication does not begin until `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:719-731`.

  Bulk revocation likewise sanitizes before entering its revocation transaction at `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:750-765`.

- **Refutation attempts:**
  - Checked whether input validation makes live-secret comparison unnecessary. The schema blocks recognizable credential patterns at `apps/server/src/enterprise/contracts/platformConnectors/common.ts:32-37`, but arbitrary secret values still require comparison against known plaintext.
  - Checked whether decryption was metadata-only. It is not: `resolveRow` calls the key provider and parses plaintext at `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:470-479`.
  - Checked whether archive needs plaintext to verify the revision. Revision checksum, connector ID, and fingerprint are already validated before secret resolution at `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:357-374`. Only rollback conditionally needs outbound credential viability; archive nevertheless resolves the secret at line 394.
  - Checked for an alternative emergency route. The only production archive and revoke entrypoints delegate to these service methods at `apps/server/src/enterprise/routers/admin/connectors.ts:189-214` and `apps/server/src/enterprise/routers/admin/connectors.ts:393-418`.
  - Checked for a fallback when secret-service construction fails. Mutation runtime construction requires a configured platform secret provider at `apps/server/src/enterprise/routers/admin/connectorsSupport.ts:93-120`; no secret-free emergency runtime exists.
  - Checked tests. Archive tests use a healthy in-memory secret store at `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:625-655`; bulk revocation does likewise at `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:684-742`. The resolver-failure test only exercises the read service at `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:657-681`.
  - Checked scope limitations. If the connector has no current secret ref, reason sanitization performs no decryption. A missing current row alone therefore does not block bulk revocation. Archive still fails when its published revision declares a configured credential whose version cannot be resolved, as enforced at `apps/server/src/enterprise/services/connectorCatalog/catalogSnapshot.ts:169-192`.
  - Checked the baseline commit. These connector-catalog services are absent from the specified baseline; the behavior is fork-specific.

- **Verdict rationale:** The state-changing transaction is never reached after a current-secret decryption failure, and archive has a second unconditional published-secret dependency. No alternate route, fallback audit reason, transaction guard, or database mechanism performs the emergency mutation.

- **Corrected severity and scope:** HIGH. The failure affects connectors with configured secret references, not credential-free connectors or every missing-row scenario. Runtime itself fails closed while the key service is unavailable, but because archive/revocation never commits, the connector and bindings automatically become usable again when decryption recovers.
