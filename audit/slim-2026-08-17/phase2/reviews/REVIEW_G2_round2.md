VERDICT: REWORK

FINDINGS:

1. **BLOCKER · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:197-202` · Verified** · Queued lane leases are renewed only immediately before each handler, not continuously while a preceding job runs, and a `null` heartbeat result is ignored. If the first handler exceeds the 30/60-second TTL, another replica can reclaim a sibling during the gap; this dispatcher then still invokes that sibling’s handler despite having lost ownership, risking duplicate external side effects. The new 40 ms test does not run a competing claimant and therefore cannot detect this race. Maintain queued leases throughout the preceding handler, verify renewal succeeded before dispatch, and add a competing-replica test where the first job runs beyond TTL.

2. **BLOCKER · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:250-254` · Verified** · Readiness probes are sequential and unisolated. `PlatformSecretService.tryFromEnv()` throws for an invalid Vault configuration, so one unrunnable `secretRewrap` lane rejects the entire tick before audit, rollout, or connector jobs are claimed. Previously that failure affected only the rewrap scheduler. Catch and log readiness errors per type, exclude only that type from `claimBatch`, continue evaluating other lanes, and test a throwing readiness probe alongside a runnable type.

3. **MAJOR · `packages/database/src/models/platform/job.ts:515-536` · Verified** · Per-type ranking/capping happens before `FOR UPDATE SKIP LOCKED`. Two concurrent dispatchers rank the same oldest rows; after one locks them, the other skips those rows but cannot select rows ranked beyond the cap, so it returns an underfilled or empty batch despite available work. Select and lock up to each type’s cap inside a lateral subquery—or otherwise apply the cap after locked rows are skipped—and add a two-transaction concurrent claim test.

4. **MAJOR · `packages/database/src/models/__tests__/platform.job.test.ts:339` · Verified** · The new batch-claim test does not type-check: `exportJob.leaseUntil` and `rolloutJob.leaseUntil` are nullable (`TS18047`, also line 341). Assert their presence or narrow/non-null them before calling `getTime()`.

METRICS:

- Files reviewed: **21** — 19 modified, 2 untracked.
- Prior findings: lazy import and set-based claim are closed; heartbeat now uses one transaction and has fallback takeover coverage. Per-type lease safety remains open, while readiness-before-claim introduced cross-type failure coupling.
- Upstream files touched:
  - `packages/database/src/models/__tests__/platform.job.test.ts` — **compliant via the explicit package-brief requirement** to add the batch-claim model tests.
- All other scoped files are under rule-2 allowlisted enterprise, platform-model, or enterprise-doc paths.
- `git diff --check`: passed.
- `tsgo --noEmit --tsBuildInfoFile /dev/null -p tsconfig.json`: found the two in-scope errors above and one unrelated out-of-scope error in `src/components/mdx/Image.tsx`.

UNVERIFIED:

- Vitest/PGlite suites were not run, per the read-only review constraint.
- Real PostgreSQL multi-replica lease timing, concurrent `SKIP LOCKED` behavior, transaction-rate measurements, and production bundle/module loading remain unverified.