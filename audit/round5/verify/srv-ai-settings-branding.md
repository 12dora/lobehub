# Verification — srv-ai-settings-branding

## Verdicts

| Finding ID                     | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                                                 |
| ------------------------------ | ----------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-ai-settings-branding-D1-01 | HIGH              | DOWNGRADED | MEDIUM             | The `2N` query pattern is real, but it is restricted to privileged control-plane mutations and uses one pinned transaction connection, so the claimed pool-flooding blast radius is overstated. |

## Details

### srv-ai-settings-branding-D1-01 — DOWNGRADED

- **What the original claimed:** Publishing, archiving, or rolling back a provider checks every removed model separately, producing approximately two database queries per model and potentially flooding the connection pool while publication locks are held.

- **What I actually found:** `assertRemovedModelsUnused` computes all removed enabled models and maps each one to `resolveAiCatalogDependents` at `apps/server/src/enterprise/services/aiCatalog/publication.ts:84-104`. That single-model helper passes a one-element array to the batch resolver at `apps/server/src/enterprise/services/aiCatalog/dependencies.ts:34-50`. Each invocation performs one agent query and one published-settings query at `dependencies.ts:53-78`, then scans those settings at `dependencies.ts:80-90`. Therefore removing (N) models really does issue (2N) SQL statements and fetch/scan the published settings (N) times.

  The checks occur during archive at `publication.ts:245-263`, rollback at `publication.ts:270-290`, and ordinary publish at `publication.ts:342-355`. They run inside the publication transaction established at `packages/database/src/models/platform/revision.ts:183-207`, after acquiring the global dependency-publication advisory lock at `publication.ts:245-247`.

- **Refutation attempts:**

  - **Existing batching:** The repository already batches the same dependency lookup for hard deletion at `apps/server/src/enterprise/services/aiCatalog/adminService.ts:444-450`, batch toggles at `adminService.models.ts:462-472`, and clearing a provider’s models at `adminService.models.ts:684-698`. No equivalent batching guard exists in publication.
  - **Cardinality bounds:** The provider draft schema uses an unbounded model array at `apps/server/src/enterprise/contracts/aiCatalog.ts:287-299`, and the database schema only enforces per-provider model-key uniqueness at `packages/database/src/schemas/platform/ai.ts:184-223`. Batch mutation inputs are capped at 500 per request at `contracts/aiCatalog.ts:758-793`, but repeated batches and individual creates can exceed that total. Thus no durable provider-level bound refutes the scaling issue.
  - **Connection-pool behavior:** The publication passes one transaction handle through every lookup. Drizzle acquires one pooled client for the complete transaction and releases it afterward at `node_modules/drizzle-orm/node-postgres/session.js:180-194` and `node_modules/drizzle-orm/neon-serverless/session.js:178-192`. Consequently, one bulk publication does not acquire (2N) pool connections. It occupies one connection longer and may indirectly delay other transactions, but the report’s direct “flood the connection pool” characterization is unsupported.
  - **Authorization and exposure:** These operations are not public request-path work. They require authentication, active-user and mutation-rate guards at `apps/server/src/enterprise/routers/admin/aiCatalog.ts:62-65`, explicit publish/delete permissions, and dangerous-action reauthentication at `aiCatalog.ts:137-155` and `aiCatalog.ts:250-289`.
  - **Tests:** Functional tests verify single-model publish/rollback removal checks at `apps/server/src/enterprise/services/aiCatalog/publication.test.ts:439-563` and archive race protection at `publication.test.ts:566-615`. The PostgreSQL concurrency test verifies the advisory-lock invariant at `publication.pgConcurrency.test.ts:56-220`. None asserts query count for multi-model removal, so the N+1 remains unguarded.
  - **Upstream baseline:** Both cited files are additions relative to baseline `4bab1636408e60a7ee17b640490fbf33a310a325`; this is not an identical upstream-mainline defect.

- **Verdict rationale:** The inefficient query structure is independently reproduced and should be fixed by passing the removed model keys to `resolveAiCatalogDependentsForModels` once. However, HIGH severity is not established: there is no correctness failure, data loss, security exposure, or ordinary user-triggered hot path, and a single operation consumes one database connection rather than (2N). The meaningful risk is elevated latency and prolonged global publication-lock occupancy for unusually large provider catalogs.

- **Corrected severity and scope:** **MEDIUM.** Scope is privileged AI-provider publish, archive, and rollback operations that remove multiple enabled models. Other batch model-removal paths already use the bounded two-query resolver.
