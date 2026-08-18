# G2f — round-6, LAST round (commander closes G2 after this). Same tree, you are still G2.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G2_round5.md. Commander verdicts:

1. **Finding 1 — ACCEPTED.** `retryAt` must be anchored at the moment of failure, not at tick start: pass a clock (`() => Date.now()`,
   injectable for tests) into the lanes and call `noteTypeFailure(spec, nowAtCatch)` inside each catch (handler, follow-up claim,
   readiness probe, reservation cleanup). Test: a handler that advances fake time well past its own interval before throwing still gets
   the full jittered delay measured from the throw.

2. **Finding 2 — REJECTED, document it.** Quantising the retry to the dispatcher's base tick (a 4.4 s retry firing at the 6 s tick) is
   accepted behaviour: the retry is never EARLIER than intended, at most one base interval (2 s) late, and the merged dispatcher
   deliberately has one timer. Do NOT add a variable next-delay hook to the shared scheduler. Instead: (a) add a comment above
   `noteTypeFailure` stating that retries are rounded up to the next dispatcher tick, why that is safe, and that per-replica phase
   differences (process start time) still decorrelate replicas; (b) make the existing tests honest — use a non-midpoint
   `Math.random` (e.g. 0.9) in at least one test and assert the retry happens at the FIRST tick at or after `retryAt` (not an exact
   equality that only holds at 0.5).

3. **Finding 3 — ACCEPTED.** Wrap the first-wave mixed `claimBatch` in its own try/catch: on rejection, log once (errorClass + the
   attempted types) and call `noteTypeFailure` for every type that was in that claim (at failure time, per finding 1), then return
   `{ didWork: false }`-with-pending-retry instead of letting the rejection escape into the shared scheduler's generic backoff. Test: a
   rejecting first-wave claim with two types of different intervals → each type's next attempt honours its own delay, other behaviour
   unchanged.

Then rerun: `bunx vitest run --silent='passed-only' apps/server/src/enterprise/jobs apps/server/src/enterprise/bootstrap
apps/server/src/enterprise/services/platformInstance apps/server/src/enterprise/services/identityProvider
apps/server/src/enterprise/services/connectorCatalog`, `cd packages/database && bunx vitest run src/models/__tests__/platform.job.test.ts`,
`bun run check --lint <your files>`, `bunx tsgo --noEmit -p tsconfig.json` once. Append "Round 6" to `phase2/reports/G2.md`.
Final message: 4 lines. Do not start any other work afterwards.
