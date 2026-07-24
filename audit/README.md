<!--
  AIHub Enterprise 二开 — Code Audit
  Generated 2026-07-24 by a Codex fleet orchestrated by Claude Code (commander).
  This folder is an audit deliverable, not application code. Safe to review, commit, or delete.
-->

# 📋 AIHub 二开 代码审计・Enterprise Secondary-Development Audit

> **How this was produced.** 15 independent **Codex `gpt-5.6-sol` (high reasoning, read-only sandbox)** reviewers audited the AIHub 二开 layer in parallel — the reviewers physically could not modify source. Upstream LobeHub code was out of scope. Each reviewer owned one domain-coherent partition (mostly a _vertical slice_: server service + its admin UI + schema) and audited all five requested dimensions: **① code smells · ② test rot · ③ dead code & cruft · ④ missing zh-CN i18n · ⑤ FE/BE functional bugs**. A 16th Codex pass consolidated the 15 reports (dedup + prioritization) into the summary below.
>
> **Scope reviewed:** \~196K lines / \~1,128 files across `src/enterprise/**`, `apps/server/src/enterprise/**`, `packages/{types,const,database}/src/**/platform/**`, `src/business/**`, `packages/business/**`.
>
> **Result:** **177 findings — 4 CRITICAL · 56 HIGH · 74 MEDIUM · 43 LOW.** Every finding carries `file:line`, evidence, a concrete failure scenario, and a fix.
>
> **Detailed per-partition reports** (full evidence for all 177 findings) live in [`audit/partitions/`](./partitions/). The consolidated executive analysis follows.

---

# AIHub Enterprise 二开 — Consolidated Code Audit

_Reviewer fleet: 15 × Codex gpt-5.6-sol (high). Date: 2026-07-24._

## 1. Executive Summary

AIHub’s enterprise layer has solid authorization-registry coverage, transaction discipline in several catalogs, and generally mature secret-redaction and pagination primitives, but it is not release-ready because core policy, identity, evidence-retention, and administrative workflows still fail open or lose state under concurrency. The fleet reported **177 findings: 4 CRITICAL, 56 HIGH, 74 MEDIUM, and 43 LOW** before consolidation. The four critical issues permit deletion of legally held evidence, bypass of connector governance, inability to revoke a compromised identity provider, and cross-user disclosure of local-file/tool-result snapshots. High findings cluster around stale destructive writes, non-atomic commits, incomplete secret rotation, unbounded enterprise queries, misleading frontend mutation state, and tests that preserve unsafe behavior.

- **\[CRITICAL] audit + db:** Serialize legal-hold activation with every retention deletion so newly held evidence cannot be destroyed.
- **\[CRITICAL] connectors:** Make connector-governance resolution fail closed or use a trustworthy last-known-good policy.
- **\[CRITICAL] identity:** Add an operable disable/archive path for published identity providers, including LKG tombstones.
- **\[CRITICAL] routers:** Remove raw message metadata and local-tool snapshots from global statistics responses.
- **\[HIGH] agents-client + agents-server + ai:** Require complete CAS tokens and dependency locks for destructive catalog deletion.
- **\[HIGH] security-guards + routers + ai:** Close policy/revocation bypasses for managed resources, banned users, and disabled providers.
- **\[HIGH] audit + routers:** Make sensitive mutations and their required audit records atomic.
- **\[HIGH] platform-instance + db:** Complete secret rotation and enforce actor ownership and CAS for global credentials.
- **\[HIGH] settings-branding + users-rbac:** Repair whole-snapshot and asynchronous UI flows that overwrite, strand, or misreport committed changes.
- **\[HIGH] shared-infra:** Restore default-off isolation, secure dynamic admin routes, and make the break-glass administrator actually usable.

## 2. Critical & High-Priority Findings

**\[C1] \[CRITICAL] Legal holds can lose a race with destructive retention** — _audit + db · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/retentionWorker.ts:794`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:865`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:928`, `packages/database/src/models/platform/auditRetention.ts:146`, `packages/database/src/models/platform/auditRetention.ts:238`, `packages/database/src/models/platform/auditLegalHold.ts:88`
- Problem: Hold lookup and destructive deletion are separate operations without a shared lock or hold predicate in the final delete.
- Failure scenario: Worker observes no hold → administrator creates a global/user/topic hold → worker permanently deletes the newly protected row or S3 artifact.
- Fix: Serialize hold mutations and retention with a shared transactional/advisory lock and perform the final hold check inside the destructive transaction or durable object-deletion workflow.

**\[C2] \[CRITICAL] Governance read failures bypass organization connector policy** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorGovernance/resolve.ts:10`
- Problem: Every governance read error is converted to inactive governance, restoring per-user behavior.
- Failure scenario: Governance storage fails while a tool is denied or shared OAuth is mandatory → runtime enables the user/default tool or identity instead.
- Fix: Use a signed last-known-good snapshot and otherwise fail closed for authorization-bearing governance fields.

**\[C3] \[CRITICAL] Published identity providers cannot be individually revoked** — _identity · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/identityProvider/adminService.ts:248`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:94`, `apps/server/src/enterprise/services/identityProvider/lkg.ts:295`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:29`
- Problem: Published providers cannot be deleted or disabled, startup always selects them, and LKG convergence rejects their removal.
- Failure scenario: One OIDC provider is compromised → administrators cannot revoke it without disabling the entire database-backed identity-provider system.
- Fix: Publish a reauth-protected disable/archive tombstone, honor it at startup and in LKG convergence, and expose the operation in the admin UI.

**\[C4] \[CRITICAL] Global statistics expose cross-user local-file and tool-result snapshots** — _routers · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/routers/admin/stats.ts:95`
- Problem: Usage procedures return database-model rows directly, including unrestricted `messages.metadata`.
- Failure scenario: A principal with `STATS_READ` requests monthly usage → receives other users’ local-file contents, tool arguments, results, state, or errors.
- Fix: Introduce a strict output schema and whitelist only aggregate/statistical fields, with a canary-secret redaction regression.

**\[H1] \[HIGH] Retained detail data exposes and mutates the wrong agent** — _agents-client · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/agents/useAdminAgents.ts:203`, `src/enterprise/client/features/admin/agents/AgentDetailPage.tsx:33`
- Problem: Identity-changing SWR queries retain the prior agent without verifying that its ID matches the route.
- Failure scenario: Navigate from agent A to B while B is loading or fails → A remains under B’s URL and an action mutates A.
- Fix: Remove retained data for identity changes or expose it only when `data.identity.id === id`, resetting actions and errors during transitions.

**\[H2] \[HIGH] Catalog hard-delete is stale-state and publication-race unsafe** — _agents-client + agents-server + ai · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/agents/AgentListPage.tsx:117`, `src/enterprise/client/features/admin/agents/openDeleteAgentModal.tsx:26`, `apps/server/src/enterprise/services/agentCatalog/adminService.ts:577`, `apps/server/src/enterprise/services/aiCatalog/adminService.ts:602`, `src/enterprise/client/features/admin/ai/providers/openDeleteProviderModal.tsx:24`, `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:145`
- Problem: Agent and provider deletion omit or make optional available revision/draft-token guards; provider deletion also omits the dependency-publication lock.
- Failure scenario: Admin A opens stale data → Admin B edits or publishes → A deletes the newer state, or deletion races with dependency publication and leaves a dangling reference.
- Fix: Require authoritative revision and draft-token CAS values, pass them from clients, lock shared dependency publication, and add two-transaction race tests.

**\[H3] \[HIGH] Agent hard-delete reclassifies managed materializations as editable local agents** — _agents-server · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/agentCatalog/adminService.ts:559`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:158`
- Problem: Deletion removes provenance mappings while preserving local agent rows whose managed classification depends on those mappings.
- Failure scenario: A managed agent is materialized and then hard-deleted → its clone reappears as an ordinary editable/executable assistant containing managed content.
- Fix: Preserve durable tombstone/provenance classification or safely migrate and delete the local rows.

**\[H4] \[HIGH] Published AI connectivity changes bypass fresh connection testing** — _ai · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/aiCatalog/adminService.ts:873`, `apps/server/src/enterprise/services/aiCatalog/publication.ts:137`
- Problem: Every previously published provider receives the stale-test bypass, including secret, endpoint, SDK, and check-model changes.
- Failure scenario: Rotate to an invalid key or unreachable endpoint → immediate publication accepts the stale prior test and breaks organization-wide inference.
- Fix: Permit stale test reuse only for an explicit cosmetic-field allowlist and retest all transport- or credential-affecting changes.

**\[H5] \[HIGH] Disabled managed AI providers fail open to user BYOK** — _ai · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:367`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:425`
- Problem: A known disabled provider returns the same not-found code that authorizes personal-key fallback.
- Failure scenario: Administrator disables OpenAI → a user with a personal OpenAI key continues using it through BYOK.
- Fix: Distinguish true absence from disabled/archived state and return a fail-closed policy error for the latter.

**\[H6] \[HIGH] Published OpenAI request-format settings are discarded** — _ai · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:208`, `apps/server/src/enterprise/services/aiCatalog/connectionTestService.ts:99`, `src/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage.tsx:142`
- Problem: Runtime materialization replaces provider config/settings with empty objects and connection probes ignore `enableResponseApi`.
- Failure scenario: A Responses-only provider is tested or executed as Chat Completions → connection or production requests fail.
- Fix: Project a credential-free config allowlist into runtime and propagate the corresponding `apiMode` to probes.

**\[H7] \[HIGH] AI model batches partially commit before reporting failure** — _ai · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/aiCatalog/adminService.ts:1027`
- Problem: Batch operations loop over independently committed public mutations without an outer transaction.
- Failure scenario: Item six of ten fails → items one through five remain changed even though the API rejects the batch.
- Fix: Execute the entire batch through transaction-aware private primitives in one transaction.

**\[H8] \[HIGH] Retention destroys evidence before its durable checkpoint** — _audit · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/retentionWorker.ts:801`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:814`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:872`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:887`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:934`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:954`
- Problem: Database rows or objects are deleted before counts and cursors are durably recorded.
- Failure scenario: Fifty rows are deleted → checkpoint fails or lease expires → final retention records under-report irreversible destruction.
- Fix: Atomically couple database deletion, counters, and cursor updates, and use a durable deletion journal/outbox for object storage.

**\[H9] \[HIGH] Already-expired legal holds are accepted and displayed as active** — _audit · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/adminAuditService.ts:915`, `src/enterprise/client/features/admin/audit/holds/LegalHoldsPage.tsx:304`
- Problem: Neither server nor UI rejects `expiresAt <= now`, while retention ignores the resulting hold.
- Failure scenario: An administrator selects a past timestamp → UI shows an active hold but the next retention run deletes the evidence.
- Fix: Reject non-future expiry server-side, constrain the picker, and derive an accurate expired status.

**\[H10] \[HIGH] Sensitive mutations can commit without required audit records** — _audit + routers · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/accessLog.ts:115`, `apps/server/src/enterprise/routers/admin/authSettings.ts:36`, `apps/server/src/enterprise/routers/admin/sidebarLayout.ts:36`
- Problem: Audit append failures are swallowed after legal-hold, export, policy, registration, or sidebar operations have succeeded.
- Failure scenario: A hold is released, signed evidence URL issued, or registration opened → audit storage fails → the change remains effective without an authoritative event.
- Fix: Couple database mutations and audits transactionally; for downloads, persist access before returning a signed URL.

**\[H11] \[HIGH] Audit live view retains message bodies after access revocation** — _audit · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/audit/live/LivePage.tsx:198`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:223`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:339`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:346`, `src/enterprise/client/features/admin/audit/live/MessagePane.tsx:200`
- Problem: Cached body-bearing pages survive changes to policy, permission, and `includeBody`.
- Failure scenario: Permission changes to metadata-only → old bodies remain visible until reload or topic change.
- Fix: Purge body-bearing state synchronously on access loss and conceal content independently of cached values.

**\[H12] \[HIGH] Evidence exports are assembled from a mutable dataset** — _audit · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/exportWorker.ts:439`, `apps/server/src/enterprise/services/audit/exportWorker.ts:491`, `apps/server/src/enterprise/services/audit/exportWorker.ts:585`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:801`
- Problem: Export pagination reads live mutable tables without a repeatable snapshot or frozen row inventory.
- Failure scenario: Retention deletes or a topic update reorders later pages → completed evidence export silently omits or duplicates records.
- Fix: Materialize eligible IDs under a consistent snapshot or immutable watermark and protect them from retention until completion.

**\[H13] \[HIGH] Export creation leaves permanently pending orphan rows** — _audit · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/audit/exportService.ts:251`
- Problem: Export creation, job enqueue, and job linking are independent writes without cleanup.
- Failure scenario: Enqueue fails after row creation → a visible `pending` export with no job can never progress.
- Fix: Make the three writes transactional or mark every post-create failure terminally failed.

**\[H14] \[HIGH] Audit exports buffer up to one million evidence rows in memory** — _audit · 1 code smells_

- Location(s): `apps/server/src/enterprise/services/audit/exportWorker.ts:249`
- Problem: All NDJSON lines are retained, joined, and copied again into a `Buffer`.
- Failure scenario: A large body-bearing export allocates multiple gigabytes → worker OOMs and repeatedly retries.
- Fix: Stream through an incremental hashing transform into multipart/private storage.

**\[H15] \[HIGH] Connector redaction misses secret-bearing custom header names** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:216`, `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:546`
- Problem: Runtime taint collection traverses object values but not credential header keys.
- Failure scenario: A remote connector echoes a private header name → response or journal returns it unredacted.
- Fix: Reuse the canonical collector that includes dynamic keys, values, and encoded variants.

**\[H16] \[HIGH] Arbitrary connector secrets can be copied into localStorage** — _connectors · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/connectors/localDraftStorage.ts:86`, `src/enterprise/client/features/admin/connectors/useConnectorEditor.ts:59`, `src/enterprise/client/features/admin/connectors/localDraftStorage.test.ts:61`
- Problem: Local-draft scanning knows patterns but not the exact replacement secret currently being edited.
- Failure scenario: An arbitrary secret is pasted into a description → the plaintext public draft is persisted locally.
- Fix: Compare against current secret leaves or suspend local persistence while a replacement secret is pending.

**\[H17] \[HIGH] Raw deterministic secret hashes provide an offline guessing oracle** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:25`, `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:185`, `apps/server/src/enterprise/services/connectorCatalog/catalogAudit.ts:43`, `apps/server/src/enterprise/services/connectorCatalog/catalogSnapshot.ts:216`
- Problem: Unkeyed SHA-256 fingerprints of predictable credential JSON are exposed in projections and audits.
- Failure scenario: An administrator brute-forces a weak password/client secret offline by comparing candidate hashes.
- Fix: Replace exposed hashes with keyed HMACs or random immutable version identifiers.

**\[H18] \[HIGH] Connector discovery reports success but discards discovered tools** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorCatalog/discoveryService.ts:86`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:91`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:170`, `src/enterprise/client/features/admin/connectors/openCreateConnectorModal.tsx:102`
- Problem: Discovery returns tools without persisting them, while the UI ignores the response and refetches the unchanged draft.
- Failure scenario: Discover succeeds → editor remains empty → publication fails because no enabled tool exists.
- Fix: Persist discovery under CAS or merge it into an explicitly dirty client draft.

**\[H19] \[HIGH] Successful connector tests never unlock Publish** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorCatalog/discoveryService.ts:124`, `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:142`, `src/enterprise/client/features/admin/connectors/controller.ts:159`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:339`
- Problem: Connection-test results are not persisted and every subsequent draft projection returns `connectionTest: null`.
- Failure scenario: Test succeeds → refetch clears the result → primary action remains Test forever.
- Fix: Persist revision-bound test status atomically or retain it in UI state with explicit invalidation rules.

**\[H20] \[HIGH] Governance mutations commit while reporting failure** — _connectors · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/connectorGovernance/adminService.ts:124`
- Problem: Governance commits before audit and invalidation, but later failures trigger a common failure response.
- Failure scenario: Revision 12 commits and invalidation fails → client sees failure and retries stale revision 11.
- Fix: Couple commit and audit through a transaction/outbox and treat post-commit invalidation as genuinely best-effort.

**\[H21] \[HIGH] Audit reasons and revision comments can persist secrets** — _contracts · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/contracts/adminUsers.ts:50`, `apps/server/src/enterprise/contracts/adminBranding.ts:104`, `apps/server/src/enterprise/contracts/adminBranding.ts:165`, `apps/server/src/enterprise/contracts/adminManagedResources.ts:43`, `apps/server/src/enterprise/contracts/adminManagedResources.ts:59`, `apps/server/src/enterprise/contracts/adminSettings.ts:95`
- Problem: Several persisted reason/comment schemas omit the secret-aware validation used elsewhere.
- Failure scenario: An administrator pastes a bearer token into a ban or publication reason → it becomes durable audit/history data.
- Fix: Apply one shared secret-safe schema to every persisted administrative reason and comment.

**\[H22] \[HIGH] Revision and audit immutability is not enforced by PostgreSQL** — _db · 5 FE/BE functional bugs_

- Location(s): `packages/database/src/schemas/platform/revisions.ts:7`, `packages/database/src/models/platform/revision.ts:184`, `packages/database/src/schemas/platform/auditLogs.ts:7`, `packages/database/src/models/platform/auditRetention.ts:146`
- Problem: Tables documented as immutable or append-only have no database mutation triggers.
- Failure scenario: A script updates a revision without recomputing its checksum or deletes audit rows outside retention → authoritative history is corrupted.
- Fix: Add PostgreSQL update/delete rejection triggers and a transaction-scoped retention escape hatch.

**\[H23] \[HIGH] Staged credentials are not bound to their creating administrator** — _db · 5 FE/BE functional bugs_

- Location(s): `packages/database/src/schemas/platform/credentials.ts:131`, `packages/database/src/models/platform/globalCredential.ts:360`, `packages/database/src/models/platform/globalCredential.ts:413`
- Problem: Content hash alone identifies staged uploads and consumption never checks actor ownership.
- Failure scenario: Two admins upload identical plaintext or one knows another upload’s hash → one overwrites or consumes the other’s ciphertext.
- Fix: Use random opaque upload IDs, require non-null owners, and include owner identity in every mutation and lookup.

**\[H24] \[HIGH] Identity-provider secret replacement and clearing fail on active providers** — _identity · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/identityProvider/adminService.ts:175`, `apps/server/src/enterprise/services/identityProvider/secretStore.ts:115`, `apps/server/src/enterprise/services/identityProvider/secretStore.ts:164`, `apps/server/src/enterprise/services/identityProvider/adminService.test.ts:88`
- Problem: Secret-store operations change status to draft before the outer CAS checks the original status.
- Failure scenario: An active provider needs urgent secret rotation → update matches zero rows and rolls back.
- Fix: Perform status, revision, and secret-reference changes in one locked mutation.

**\[H25] \[HIGH] RFC 9207 authorization-response issuer is ignored** — _identity · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/identityProvider/discoveryValidator.ts:61`, `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:322`
- Problem: Discovery drops issuer-response capability and callback processing never verifies `iss`.
- Failure scenario: A missing or mismatched authorization-response issuer proceeds to token exchange.
- Fix: Preserve capability metadata, pass `iss` through the callback, and require an exact match when advertised.

**\[H26] \[HIGH] Safe-login tests approve identity configurations rejected by production** — _identity · 2 test rot_

- Location(s): `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:57`, `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:397`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:922`, `apps/server/src/enterprise/services/identityProvider/testFlowService.test.ts:36`
- Problem: Isolated validation omits required email and domain-allowlist checks but publication treats it as authoritative.
- Failure scenario: Test reports success → configuration is published and restarted → real users cannot log in.
- Fix: Share the production profile validator and test missing, malformed, allowed, and denied email cases.

**\[H27] \[HIGH] Published group-to-role mapping is never enforced** — _identity · 3 dead code & cruft_

- Location(s): `src/enterprise/client/features/admin/identityProviders/steps/PolicyStep.tsx:48`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:226`
- Problem: The UI and publication payload promise group-based authorization, but login/runtime has no group consumer.
- Failure scenario: Administrator maps an IdP group to a role → users retain unrelated default/existing roles.
- Fix: Implement group extraction and transactional role reconciliation with escalation rules, or remove the unsupported field.

**\[H28] \[HIGH] Secret rotation omits platform global credentials** — _platform-instance · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/secretRewrap/contracts.ts:3`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:475`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:448`
- Problem: Global credential secrets and staged uploads use the secret service but are absent from rotation domains.
- Failure scenario: Rotation reports success → historical key is retired → existing global credentials become unreadable.
- Fix: Add active credential envelopes and unexpired uploads as CAS-protected rewrap domains.

**\[H29] \[HIGH] Fixed secret-rewrap leases can repeat slow batches forever** — _platform-instance · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/secretRewrap/worker.ts:34`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:443`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:481`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:546`
- Problem: A 60-second lease is not extended during sequential external key-provider work.
- Failure scenario: Vault latency exceeds the lease → checkpoint fails and transaction rolls back → the same batch repeats indefinitely.
- Fix: Heartbeat through a separate connection or move external crypto outside the long transaction and checkpoint per row with CAS.

**\[H30] \[HIGH] Concurrent partial global-credential updates silently lose secrets** — _platform-instance · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:285`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:310`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:318`
- Problem: Read/decrypt/merge occurs before the row-locked update and has no expected revision.
- Failure scenario: Two admins add different keys to `{A}` → both succeed but the later write silently removes the earlier key.
- Fix: Perform merge under one lock/transaction or use revision CAS with conflict-and-retry semantics.

**\[H31] \[HIGH] Usage and overview paths materialize an unbounded month of message rows** — _platform-instance + routers + db · 1 code smells_

- Location(s): `src/enterprise/client/features/admin/overview/useOverviewStats.ts:49`, `src/enterprise/client/features/admin/overview/utils.ts:29`, `apps/server/src/enterprise/routers/admin/stats.ts:95`, `packages/database/src/models/platform/globalStats.ts:366`, `packages/database/src/models/platform/globalStats.ts:423`
- Problem: Chart endpoints load, group, serialize, and sometimes return every monthly assistant message.
- Failure scenario: A large tenant opens the dashboard or stats page → database sorting, server/browser memory, response size, and sensitive detail exposure grow without bound.
- Fix: Compute bounded daily aggregates in SQL and expose a separate cursor-paginated detail endpoint.

**\[H32] \[HIGH] Managed Skills, AI, and Connector endpoints bypass user revocation** — _routers · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/routers/user/connectors.ts:21`, `apps/server/src/enterprise/routers/platformSkills.ts:27`, `apps/server/src/enterprise/routers/platformSkills.ts:48`, `apps/server/src/enterprise/routers/platform.ts:51`
- Problem: These surfaces omit the active-user guard used by managed Agents.
- Failure scenario: With platform admin disabled but a managed feature enabled, a banned or epoch-invalidated user continues reading catalogs or starting operations.
- Fix: Apply feature-specific active-user middleware before all catalog/service access.

**\[H33] \[HIGH] Remote Skill imports lack a body deadline and streaming size limit** — _routers · 1 code smells_

- Location(s): `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:185`
- Problem: Timeout ends after headers and bodies are fully materialized before size validation.
- Failure scenario: A remote source streams an unlimited or stalled body → request workers and memory are exhausted.
- Fix: Keep abort deadlines active through a byte-counted stream and enforce compressed and expanded ZIP limits.

**\[H34] \[HIGH] Enforced managed-resource policies fail open during catalog outages** — _security-guards · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/guards/managedResource.ts:128`, `apps/server/src/enterprise/guards/managedResource.test.ts:190`
- Problem: Readiness failure permits legacy mutations for managed AI, connectors, and agents; only Skills fail closed.
- Failure scenario: Managed catalog becomes unavailable → ordinary users regain legacy mutation access despite an enforced policy.
- Fix: Deny every governed mutation when an enforced catalog is unavailable and rewrite the fail-open regression.

**\[H35] \[HIGH] Default outbound HTTP policy exposes the private network** — _security-guards · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/security/outboundHttp/policy.ts:53`, `apps/server/src/enterprise/security/outboundHttp/policy.ts:399`, `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:59`
- Problem: Default clients allow loopback, RFC1918, link-local, and most internal addresses.
- Failure scenario: A configurable provider or connector targets an internal service → server-side requests enable SSRF discovery or interaction.
- Fix: Make `public-only` the default and require deployment-scoped exact allowlisting for private access.

**\[H36] \[HIGH] Vault credentials may be sent over remote plaintext HTTP** — _security-guards · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/security/secret/keyProviders/vaultKeyProvider.ts:149`, `apps/server/src/enterprise/security/secret/keyProviders/vaultKeyProvider.ts:572`
- Problem: Remote HTTP Vault addresses are accepted while tokens and AppRole credentials are transmitted.
- Failure scenario: Vault uses `http://vault.internal` → a network observer captures credentials and obtains current/historical encryption keys.
- Fix: Require HTTPS except explicit loopback development addresses behind an unsafe opt-in.

**\[H37] \[HIGH] Settings ownership is violated by whole-table replacement and hidden-row normalization** — _settings-branding · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/settings/adminSettingsService.ts:142`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:334`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:472`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:396`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:575`, `src/enterprise/client/features/admin/settings/settingsPolicyController.ts:59`
- Problem: Policy-editor drafts replace the shared settings table and normalize foreign service-model rows that the editor does not display.
- Failure scenario: A stale or partial save changes one visible setting → foreign model policies are deleted or silently converted to locked/hidden.
- Fix: Define server-owned path scopes, merge only owned changes, and preserve foreign rows byte-for-byte through save, publish, and rollback.

**\[H38] \[HIGH] Sidebar policy remains active while enterprise flags are off** — _shared-infra + routers · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/hooks/useSidebarLayoutPolicy.ts:17`, `apps/server/src/enterprise/routers/platform.ts:108`
- Problem: Client and server apply persisted enterprise sidebar policy without a feature-flag guard.
- Failure scenario: All enterprise flags are disabled but a stale platform-mode row exists → users still receive centrally managed layout behavior.
- Fix: Return and apply the user-controlled default without an RPC when the controlling capability is disabled.

**\[H39] \[HIGH] Audit workers start when all enterprise flags are disabled** — _shared-infra · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/jobs/auditExport.ts:23`, `apps/server/src/enterprise/jobs/auditRetention.ts:23`
- Problem: Worker startup checks runtime/environment but no enterprise feature flag.
- Failure scenario: Importing the unconditional platform router in production starts polling and destructive background work in a nominally non-enterprise deployment.
- Fix: Require an explicit audit/platform-admin flag before initialization and recheck it within each batch.

**\[H40] \[HIGH] Recurring jobs start inside AWS Lambda request processes** — _shared-infra · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/jobs/agentRollout.ts:36`, `apps/server/src/enterprise/jobs/identityProviderTestAttemptCleanup.ts:45`
- Problem: These timer-based workers omit the serverless-runtime guard used by other jobs.
- Failure scenario: Each warm Lambda container starts duplicate recurring rollout or cleanup work.
- Fix: Centralize the persistent-worker predicate and move serverless execution to a durable scheduler or queue.

**\[H41] \[HIGH] Bootstrap break-glass administrator has no login credential** — _shared-infra · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/bootstrap/superAdmin.ts:53`
- Problem: Bootstrap creates a privileged user and role but no Better Auth credential account/password.
- Failure scenario: Identity provider outage occurs → bootstrap reports success → the recovery administrator cannot authenticate.
- Fix: Securely create a one-time credential, account row, user, and role assignment in one transaction and test real authentication.

**\[H42] \[HIGH] Dynamically registered admin routes bypass the gate hierarchy** — _shared-infra · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/routes/index.ts:16`, `src/enterprise/client/registry.ts:7`
- Problem: Extension routes are appended as top-level siblings rather than gated admin children.
- Failure scenario: A module registers `/admin/leak` → a non-admin can render its client component without `AdminRootGate`.
- Fix: Accept only typed relative admin children with permission metadata and inject them beneath the gated root.

**\[H43] \[HIGH] Live admin query procedures are absent from the central registry contract** — _shared-infra · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/services/adminAiInfraAdapter/index.ts:295`, `src/enterprise/client/services/adminConnectors.ts:66`
- Problem: Scoped verification found `admin.aiProviders.getBatch` and `admin.connectors.getBatch` outside the central authorization inventory, despite other partitions reporting complete reconciliation for their enumerated procedure set.
- Failure scenario: Registry-derived security tooling omits these endpoints → a later middleware refactor can weaken them without reconciliation-test failure.
- Fix: Add both queries and generate registry expectations directly from live router paths so inventory counts cannot mask exclusions.

**\[H44] \[HIGH] Business mount points contain substantial implementation logic** — _shared-infra · 1 code smells_

- Location(s): `src/business/client/BusinessGlobalProvider.tsx:9`, `src/business/client/BusinessMobileRoutes.tsx:13`, `src/business/client/DefaultInboxBrandingSync.tsx:13`, `src/business/client/hooks/useHeteroAgentCloudConfig.ts:17`, `src/business/server/bot/featureAccess.ts:25`, `packages/business/config/src/llm.ts:5`, `packages/business/model-bank/src/model-config.ts:20`, `packages/business/model-runtime/src/model-mapping.ts:18`
- Problem: Override mount points contain routing, credentials, policy, providers, effects, and model transformation instead of declarative registrations.
- Failure scenario: Enterprise policy changes become hidden in the upstream override seam → upgrades create conflicts and flag-off behavior becomes difficult to verify.
- Fix: Move implementations into enterprise modules and enforce one-line registration/re-export mount points structurally.

**\[H45] \[HIGH] Skill publication accepts payloads that disable managed runtime** — _skills · 5 FE/BE functional bugs_

- Location(s): `apps/server/src/enterprise/services/skillCatalog/publication.ts:81`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:309`, `apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:84`, `src/enterprise/client/features/admin/skills/openVersionEditorModal.tsx:114`
- Problem: Publication permits opaque `contentRef` values that runtime readiness categorically rejects.
- Failure scenario: Administrator publishes one opaque Skill/resource → the global managed catalog advances but runtime snapshot creation fails.
- Fix: Materialize and verify referenced content or reject non-inline payloads during validation/publication.

**\[H46] \[HIGH] Full role replacement drops protected roles and expiry metadata** — _users-rbac · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/users/UserDetailPage.tsx:171`, `src/enterprise/client/features/admin/users/modals/actions.tsx:385`, `src/enterprise/client/features/admin/users/modals/actions.tsx:451`
- Problem: The modal reduces grants to names, removes inaccessible roles, omits `preserveRoleNames`, and loses per-grant expiry.
- Failure scenario: Editing one role attempts a forbidden protected-role removal or turns a temporary unchanged role into permanent access.
- Fix: Pass complete grants, preserve inaccessible roles explicitly, and retain expiry unless the administrator knowingly changes it.

**\[H47] \[HIGH] Edits made during managed-resource save are overwritten** — _users-rbac · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:141`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:191`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:214`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:288`
- Problem: Controls remain editable during save and success rehydrates the older submitted snapshot while clearing dirty state.
- Failure scenario: Save D1 → edit D2 while reauth/publish is pending → D1 succeeds and silently erases D2.
- Fix: Lock controls or version local drafts and clear dirty state only if it still matches the submitted snapshot.

**\[H48] \[HIGH] Saved managed-resource drafts can become impossible to publish** — _users-rbac · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:131`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:194`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:332`
- Problem: Hydration always clears `dirty`, and production never derives pending changes from draft-versus-published state.
- Failure scenario: Save succeeds but publish or reauth fails → reload shows the changed draft with every action disabled.
- Fix: Derive `hasChanges` from persisted draft/published values and expose an explicit publish/retry state.

**\[H49] \[HIGH] Post-commit refresh errors are reported as mutation failures** — _users-rbac + settings-branding + agents-client · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:89`, `src/enterprise/client/features/admin/managedResources/actions.ts:32`, `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:52`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:399`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:529`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:632`, `src/enterprise/client/features/admin/agents/AgentListPage.tsx:129`, `src/enterprise/client/features/admin/agents/openDeleteAgentModal.tsx:43`
- Problem: Commit and cache refresh share a rejecting promise, conflating mutation outcome with freshness.
- Failure scenario: Delete or publish commits → revalidation fails → UI reports failure and invites an unsafe duplicate mutation.
- Fix: Treat the server response as the commit boundary and expose refresh failure separately as a retryable stale-data state.

**\[H50] \[HIGH] Escape dismisses destructive modals while mutation continues** — _users-rbac · 5 FE/BE functional bugs_

- Location(s): `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:245`, `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:255`, `src/enterprise/client/features/admin/users/modals/CreateUserModal.tsx:169`
- Problem: Escape closes danger modals during an already-issued mutation even though mask dismissal is disabled.
- Failure scenario: Administrator confirms hard delete and presses Escape → progress/error state disappears while irreversible deletion continues.
- Fix: Prevent framework dismissal during mutation or close intentionally and move durable progress to the originating page.

## 3. Cross-Cutting Themes

### Fail-open policy and revocation semantics

- **Affected partitions:** connectors, ai, routers, security-guards, identity
- **Rough count:** 6 critical/high findings
- Governance errors, catalog-readiness outages, disabled providers, banned-user sessions, and provider revocation all have paths that restore access or make revocation ineffective.
- **Systemic remediation:** Define a single enterprise rule that “unknown, unavailable, disabled, or revoked” is distinct from “unmanaged/not configured,” and require fail-closed typed outcomes at every runtime fallback boundary.

### Destructive operations and commit boundaries

- **Affected partitions:** agents-client, agents-server, ai, audit, connectors, db, platform-instance, settings-branding, users-rbac
- **Rough count:** approximately 20 findings
- Optional CAS fields, check-then-delete races, mutations preceding audits/checkpoints, partial batch commits, and refresh errors presented as commit failures recur throughout the system.
- **Systemic remediation:** Standardize a mutation protocol comprising required identity/draft CAS, shared dependency locks, one authoritative transaction/outbox, an explicit committed result, and separate post-commit freshness handling.

### Secret classification, ownership, and redaction

- **Affected partitions:** connectors, contracts, db, ai, audit, routers, security-guards, platform-instance
- **Rough count:** approximately 14 findings
- Secret-bearing header names, local drafts, raw fingerprints, reason fields, staged uploads, error messages, metadata snapshots, and plaintext Vault transport use inconsistent boundaries.
- **Systemic remediation:** Establish one canonical secret-leaf classifier and persistence policy covering values, dynamic keys, audit text, ownership, transport, fingerprints, error projection, and redaction tests with canary secrets.

### Unbounded queries, fan-outs, and in-memory materialization

- **Affected partitions:** agents-client, agents-server, ai, audit, connectors, contracts, db, identity, platform-instance, routers, settings-branding
- **Rough count:** more than 25 findings
- Full catalogs, revision histories, legal-hold inventories, monthly messages, evidence exports, recursive JSON, and connector readiness paths lack pagination, batching, depth limits, or SQL aggregation.
- **Systemic remediation:** Adopt enforceable service budgets for page size, query count, response bytes, recursive depth, and worker memory, with query-plan and boundary tests at 50/100/1,000/10,000-item thresholds.

### Client cache and asynchronous state divergence

- **Affected partitions:** agents-client, ai, audit, connectors, platform-instance, settings-branding, skills, users-rbac
- **Rough count:** approximately 15 findings
- Retained identities, stale provider caches, cached audit bodies, unpersisted test/discovery state, editable in-flight drafts, and indefinite loading states make the UI disagree with committed server state.
- **Systemic remediation:** Introduce a shared client mutation state machine distinguishing editing, committing, committed-refresh-required, stale, and failed-before-commit states, with identity-key validation and versioned local drafts.

### Missing zh-CN i18n and raw server prose

- **Affected partitions:** agents-client, agents-server, ai, audit, connectors, identity, routers, security-guards, shared-infra, skills, users-rbac
- **Rough count:** 13 findings
- Missing action/warning keys, raw exceptions and enum values, English system prompts/reasons, and persisted English role metadata bypass otherwise complete locale catalogs.
- **Systemic remediation:** Return stable message/action/reason codes from services, translate only at presentation boundaries, and reconcile every emitted code against both the English source and hand-authored zh-CN catalog in CI.

### Test suites preserve unsafe behavior

- **Affected partitions:** all 15 partitions
- **Rough count:** 15 findings, exactly one test-rot finding per partition
- Tests explicitly bless fail-open governance, orphan secrets, invalid identity tests, non-executable Skills, insecure route topology, stale AI runtime config, and misleading retry semantics.
- **Systemic remediation:** Replace implementation-preservation assertions with invariant tests for denial, atomicity, rollback, revocation, redaction, and runtime readiness; require named race/failure-injection tests for every P0 item.

### Oversized files and concentrated security logic

- **Affected partitions:** agents-server, ai, audit, connectors, contracts, identity, routers, security-guards, settings-branding, skills
- **Rough count:** 17 files above the approximately 800-line guideline
- Large registries, lifecycle services, workers, and tests combine unrelated transaction and security responsibilities.
- **Systemic remediation:** Split by domain operation and invariant, while retaining generated reconciliation tests over composed registries and shared fixtures.

### Dead APIs and test-maintained scaffolding

- **Affected partitions:** 14 partitions; db reported none
- **Rough count:** 17 findings and dozens of unused symbols/parameters
- Deferred features, compatibility aliases, unused factories, hollow lookups, registry extension points, and controller logic exist primarily to satisfy their own tests.
- **Systemic remediation:** Run a production-entry-point dead-export sweep, delete unsupported surfaces with their tests, and require a concrete production consumer before adding extension APIs.

### Registry reconciliation and default-off isolation

- **Affected partitions:** routers, security-guards, shared-infra
- **Rough count:** approximately 8 findings
- Existing reconciliation reports complete enumerated registries, yet scoped verification found two query procedures outside the inventory; sidebar behavior and workers also escape feature-flag shutdown.
- **Systemic remediation:** Generate procedure inventories from live router objects and couple each entry to permission, mutation policy where applicable, feature flag, active-user guard, and client-route capability metadata.

## 4. Remediation Roadmap

- **P0 — block release / fix now**
  - **Policy, identity, and authorization:** close connector and managed-resource fail-open paths; implement IdP revocation; enforce banned-user guards; distinguish disabled AI providers; secure response issuer, outbound HTTP, Vault transport, and dynamic routes (**C2, C3, H5, H25, H32, H34–H36, H42–H43**).
  - **Evidence confidentiality and integrity:** serialize holds and retention, fix checkpoints and snapshot exports, make audit writes mandatory, purge cached bodies, redact stats metadata, and enforce DB immutability (**C1, C4, H8–H12, H22**).
  - **Secrets and credentials:** close connector redaction/local-storage/fingerprint leaks, reject secret-bearing comments, bind staged uploads to actors, complete rewrap domains, prevent lease livelock and lost concurrent writes (**H15–H17, H21, H23, H28–H30**).
  - **Destructive and cross-owner data loss:** require full CAS/dependency locks, preserve managed-agent provenance, make AI batches atomic, protect settings ownership, and preserve role grant metadata (**H1–H3, H7, H37, H46–H48**).
  - **Operational recovery:** fix active-provider secret rotation, production-equivalent login testing, and bootstrapped administrator authentication (**H24, H26, H41**).

- **P1 — this sprint**
  - Repair AI runtime format propagation and fresh connectivity testing (**H4, H6**).
  - Complete the connector discover → save → test → publish workflow and correct committed-governance outcomes (**H18–H20**).
  - Make audit exports transactional and streaming (**H13–H14**).
  - Replace unbounded stats/import paths with aggregates, pagination, byte-counted streaming, and explicit limits (**H31, H33**).
  - Enforce default-off and runtime isolation for sidebar and background workers (**H38–H40**).
  - Move business logic out of mount points and make published Skills runtime-ready by construction (**H44–H45**).
  - Separate commit results from cache refresh and preserve destructive-operation state through modal lifecycle (**H49–H50**).
  - Address MEDIUM FE/BE contract mismatches: date/scoping validation, pagination truncation, stale filters, hidden errors, cache bounds, restart status, OAuth lease recovery, and legal-hold expiry replacement.

- **P2 — backlog / hygiene**
  - Split oversized services, workers, registries, hooks, and test suites.
  - Replace all 15 test-rot findings with behavioral, concurrency, failure-injection, redaction, and output-boundary tests.
  - Remove unused exports, compatibility shims, deferred features, hollow methods, and test-only controllers.
  - Complete the 13-finding i18n sweep using stable codes and catalog reconciliation.
  - Consolidate duplicated contracts, navigation catalogs, assignment invariants, logging conventions, and cache-key helpers.

## 5. Findings by Dimension

### 1 Code smells — 39 findings

The worst concentration is in contracts, db, and identity at four findings each, followed by audit, connectors, platform-instance, routers, and settings-branding at three each. Unbounded monthly statistics, export buffering, N+1 catalog/readiness queries, recursive JSON, startup history scans, and 17 oversized files are the dominant risks.

### 2 Test rot — 15 findings

Every partition reported one test-rot finding. The most dangerous cases are connectors, ai, identity, security-guards, shared-infra, and skills, where tests explicitly preserve fail-open policy, orphan retention, production-incompatible identity validation, insecure routing, or non-executable publication.

### 3 Dead code & cruft — 17 findings

Fourteen partitions reported dead or misleading production surfaces; db reported none. Agents-client, identity, and shared-infra are the largest offenders, with deferred features, unused factories/registries, hollow service methods, and test-maintained compatibility APIs.

### 4 Missing zh-CN i18n — 13 findings

Audit and agents-client each contributed two findings; nine additional partitions contributed one each. The main pattern is raw backend prose, enum/action identifiers, English defaults/system metadata, and direct exception rendering bypassing otherwise present translations.

### 5 FE/BE functional bugs — 93 findings

This is the dominant dimension. Audit and connectors lead with ten each, followed by ai with nine, users-rbac with eight, and db, platform-instance, and shared-infra with seven each; destructive races, fail-open policy, secret boundaries, state-machine drift, and misleading post-commit UI behavior are the principal failure modes.

## 6. Per-Partition Index

| Partition         |  CRIT |   HIGH |    MED |    LOW | Headline                                                                                                                       |
| ----------------- | ----: | -----: | -----: | -----: | ------------------------------------------------------------------------------------------------------------------------------ |
| agents-client     |     0 |      2 |      5 |      3 | Strong typed admin surface undermined by wrong-identity retention and unsafe destructive concurrency.                          |
| agents-server     |     0 |      2 |      2 |      3 | Catalog foundations are solid, but hard delete breaks concurrency and managed provenance.                                      |
| ai                |     0 |      5 |      6 |      3 | Multiple provider/model lifecycle defects can publish broken state, bypass policy, or partially commit.                        |
| audit             |     1 |      7 |      6 |      3 | Evidence controls are not reliable under concurrency, failure, revocation, or large exports.                                   |
| connectors        |     1 |      6 |      7 |      2 | Governance, secret boundaries, and the core discover/test/publish workflow require immediate repair.                           |
| contracts         |     0 |      1 |      6 |      4 | Schemas are broadly strict but omit several persistence, transition, and bounded-input invariants.                             |
| db                |     0 |      3 |      8 |      1 | Critical invariants remain application conventions, with ownership, retention, and scale weaknesses.                           |
| identity          |     1 |      4 |      4 |      4 | Provider lifecycle cannot safely revoke or rotate active authentication infrastructure.                                        |
| platform-instance |     0 |      4 |      5 |      3 | Secret rotation, credential concurrency, and unbounded dashboard analytics are release risks.                                  |
| routers           |     1 |      4 |      4 |      2 | Admin registry structure is strong, but statistics disclosure and user-revocation gaps are severe.                             |
| security-guards   |     0 |      3 |      3 |      3 | Guard coverage is broad, yet fail-open management, SSRF defaults, and plaintext Vault transport remain.                        |
| settings-branding |     0 |      2 |      5 |      4 | Shared settings ownership is not enforced and ordinary edits can rewrite foreign policies.                                     |
| shared-infra      |     0 |      7 |      4 |      2 | Default-off isolation, recovery access, route gating, and mount-point boundaries are unreliable.                               |
| skills            |     0 |      1 |      4 |      3 | Publication and runtime readiness disagree, while imports and navigation lose state or metadata.                               |
| users-rbac        |     0 |      5 |      5 |      3 | Client mutation state can lose edits, strand drafts, widen grants, or hide destructive progress.                               |
| **TOTAL**         | **4** | **56** | **74** | **43** | **177 findings; release should remain blocked until P0 policy, evidence, identity, secret, and data-loss defects are closed.** |

---

## 7. Detailed Partition Reports

Full evidence for every finding is in [`audit/partitions/`](./partitions/):

| Partition         | Report                                                    | Scope                                       |
| ----------------- | --------------------------------------------------------- | ------------------------------------------- |
| connectors        | [connectors.md](./partitions/connectors.md)               | connector catalog + governance + admin UI   |
| identity          | [identity.md](./partitions/identity.md)                   | IdP (Authentik/OIDC), sign-up guard, reauth |
| agents-server     | [agents-server.md](./partitions/agents-server.md)         | agent catalog service                       |
| agents-client     | [agents-client.md](./partitions/agents-client.md)         | admin agents UI + user agents feature       |
| ai                | [ai.md](./partitions/ai.md)                               | AI providers/models catalog + admin UI      |
| skills            | [skills.md](./partitions/skills.md)                       | skill catalog + admin/user parity           |
| audit             | [audit.md](./partitions/audit.md)                         | audit logs / export / retention + admin UI  |
| settings-branding | [settings-branding.md](./partitions/settings-branding.md) | settings policy editor + branding           |
| platform-instance | [platform-instance.md](./partitions/platform-instance.md) | instance lifecycle, secret rewrap, overview |
| users-rbac        | [users-rbac.md](./partitions/users-rbac.md)               | user/RBAC admin, managed resources          |
| security-guards   | [security-guards.md](./partitions/security-guards.md)     | server security + guards (dual registry)    |
| routers           | [routers.md](./partitions/routers.md)                     | enterprise admin tRPC surface               |
| contracts         | [contracts.md](./partitions/contracts.md)                 | shared zod/type contracts                   |
| db                | [db.md](./partitions/db.md)                               | Drizzle platform schemas/models/migrations  |
| shared-infra      | [shared-infra.md](./partitions/shared-infra.md)           | mount points, flags, scaffolding, providers |

_End of audit._
