VERDICT: REWORK

FINDINGS:

1. **BLOCKER · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:8` · Verified** · The always-loaded dispatcher imports `parsePlatformKeyProviderName` from the heavy `security/secret` barrel, which statically links `PlatformSecretService`, envelope crypto, and Vault providers before any enablement gate. This violates lazy-seam rule 6 and keeps the secret graph eager even when no dispatcher type is enabled. Import the lightweight symbol directly from `../security/secret/config`, before loading heavy secret runtime code.

2. **BLOCKER · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:187-203`; `packages/database/src/models/platform/job.ts:487-530` · Verified** · Up to 100 globally oldest rows are leased immediately and then processed serially. A long audit export can block every other type; queued 30/60-second leases may expire before their handlers begin, allowing another replica to reclaim them. The global limit also ignores each type’s declared batch cap, so a deep queue can starve every other job type. Preserve per-type caps and ordering, run independent serial type lanes concurrently, and renew queued leases—or avoid leasing a row until its lane can start. Add multi-replica, over-TTL, and per-type fairness tests.

3. **BLOCKER · `apps/server/src/enterprise/services/connectorCatalog/secretCleanupWorker.ts:78-84`; `apps/server/src/enterprise/jobs/secretRewrap.ts:33-42`; `apps/server/src/enterprise/services/connectorCatalog/secretCleanup.ts:153-186` · Verified** · Secret-runtime readiness is checked only after `claimBatch` has incremented attempts and leased jobs. Missing connector secrets make the handler return without settling the row; invalid Vault configuration throws after claim. Previously both workers validated their secret service before claiming. Also, cleanup’s documented `retry` signal is discarded, so an outage processes/fails every preclaimed cleanup instead of stopping after one. Exclude non-runnable types before claiming, propagate the per-type stop signal, and do not preclaim remainder rows that cannot safely be processed.

4. **MAJOR · `packages/database/src/models/platform/job.ts:505-531` · Verified** · `claimBatch` is not a set-based batch claim: after its selection it performs one `UPDATE … RETURNING` per candidate, yielding N additional database round-trips. This contradicts the one-query brief and undermines the batching objective under load. Replace the loop with a CTE/set-based `UPDATE … FROM … RETURNING`, including per-type lease calculation and attempt handling.

5. **MAJOR · `apps/server/src/enterprise/services/platformInstance/heartbeatRuntime.ts:175-200`; `apps/server/src/enterprise/services/identityProvider/instanceRegistry.ts:250-260` · Verified** · The heartbeats share a timer but not a transaction: `upsertHeartbeat` commits first, then the listener opens a separate IdP transaction. Transaction frequency therefore remains unchanged, and a crash can update only one registry, contrary to the P6 “one timer, one transaction” goal. Run both statements through one `db.transaction` and pass its transaction context to the IdP heartbeat; test transaction sharing and fallback-timer takeover.

METRICS:

- Files reviewed: **21** — 19 modified, 2 untracked.
- Upstream files touched:
  - `packages/database/src/models/__tests__/platform.job.test.ts` — **compliant via specific brief exception**: the G2 brief explicitly requires this exact model test; no production restructuring.
- All other touched paths are within rule-2 allowlisted enterprise, platform-model, or enterprise-doc directories.
- Static verification: `tsgo --noEmit -p tsconfig.json` and `git diff --check` completed without errors.

UNVERIFIED:

- Vitest and PGlite suites were not run, per the read-only review constraint.
- Real PostgreSQL multi-replica lease races, transaction counts/xact/s, and the production bundle/module graph remain unverified.