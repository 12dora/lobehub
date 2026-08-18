VERDICT: REWORK

## FINDINGS

1. **MAJOR · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:262,286,313,370-373` · Verified** · `retryAt` is anchored to `nowMs` captured at tick start, including for failures occurring after a readiness probe or handler has run for a long time. Time spent before the exception therefore consumes the retry delay; if it exceeds the calculated delay, the lane retries on the next shared tick. The old scheduler began its delay after the failed run completed, so dependency outages can now be retried immediately. Pass the clock into each lane and call `noteTypeFailure(spec, now())` at the actual catch point. Add a test that advances time inside a handler/probe before throwing and then requires the full jittered delay after rejection.

2. **MAJOR · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:339-342,421-435`; `platformJobsDispatcher.test.ts:423,429-485` · Verified** · Absolute `retryAt` does not preserve the effective jittered retry time: pending retries merely keep the scheduler at its fixed base interval. A 4.4-second retry in a 2-second dispatcher is observed at 6 seconds. The test fixes `Math.random` at `0.5`, making every delay an exact tick multiple and masking this drift. Let the tick result request the next delay and schedule `min(baseInterval, earliestRetryAt - now)`, or provide an equivalent single-scheduler wake-up. Test non-midpoint jitter values.

3. **MAJOR · `apps/server/src/enterprise/jobs/platformJobsDispatcher.ts:291-300,421-435` · Verified** · The mixed first-wave `claimBatch` remains outside per-type failure handling. Its rejection escapes the tick and invokes the shared scheduler’s retry using the minimum enabled interval—for example, a former 5-second connector worker retries using the 2-second dispatcher base. This bypasses the per-type `laneFailures` state that now handles readiness, cleanup, handlers, and follow-up claims. Catch the first-wave rejection, call `noteTypeFailure` for each attempted type at failure time, log it, and return with pending-retry state. Add a rejecting-first-claim test covering types with different intervals.

## METRICS

- Files reviewed: **20** — 18 modified, 2 untracked.
- Round 4 status:
  - Absolute retry state: **not fully closed**; findings 1–2.
  - Readiness and reservation-cleanup failures: **closed statically**; both call `noteTypeFailure`.
  - IdP partial commit: **closed statically**; each listener uses a nested Drizzle transaction/savepoint and the IdP listener rethrows.
- Upstream files touched:
  - `packages/database/src/models/__tests__/platform.job.test.ts` — **compliant by explicit brief exception** requiring batch-claim model tests; no production restructuring.
- All remaining scoped files are within the rule-2 enterprise/platform-model allowlists.
- `git diff --check`: passed.

## UNVERIFIED

- Vitest and PGlite were not run because the sandbox is read-only.
- `tsgo --noEmit` could not write `tsconfig.tsbuildinfo`; it reported only the known out-of-scope `src/components/mdx/Image.tsx` error, but a complete type-check remains unverified.
- Real PostgreSQL concurrent `SKIP LOCKED` behavior, savepoint rollback, effective timer timing, transaction rate, and production bundle loading remain unverified.