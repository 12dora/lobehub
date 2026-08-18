# G2e — round-5 (final) rework after REVIEW_G2_round4.md. Same tree, you are still G2.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G2_round4.md — three MAJORs, all accepted.
This is the last round; keep the diff tight and do not restructure anything that already passed.

1. Replace the "skip N ticks" counter with an absolute per-type `retryAt` timestamp: on failure set
   `retryAt = now + calculatePersistentWorkerRetryDelay(spec.intervalMs, consecutiveFailures)` (same jitter as before), and a type is
   claimed on a tick only when `now >= retryAt`. This makes the retry moment independent of the shared scheduler's idle backoff and of the
   dispatcher tick length. Additionally: when some type has a pending `retryAt` earlier than the next scheduled tick, the tick must not be
   pushed out by the shared idle backoff — the simplest correct approach is to report `didWork: true`-style wake-up only if the scheduler
   supports it; if it does not, cap the scheduler's effective interval while any `retryAt` is pending (e.g. keep the loop at `baseIntervalMs`
   whenever `laneFailures` is non-empty) and document that in a comment. Test: consecutive failures retry at ~1×, ~2×, ~4× the type's own
   interval (fake timers, tolerance ok), not later.
2. Route readiness-probe and runtime-audit reservation-cleanup exceptions through the SAME per-type failure state (`noteTypeFailure`), so a
   throwing Vault readiness or a failing cleanup backs off exponentially instead of retrying at the base cadence. Tests (multi-tick):
   throwing Vault readiness → second attempt only after the backoff; throwing reservation cleanup → same, and other lanes unaffected.
3. `heartbeatRuntime.ts` + `instanceRegistry.ts`: the IdP listener must not leave a partial write when it fails inside the shared
   transaction. Wrap the listener's work in a nested transaction (drizzle `tx.transaction(...)` = SAVEPOINT) and catch OUTSIDE that nested
   unit, so its failure rolls back only the IdP mutations while the platform-instance heartbeat still commits. If drizzle's nested
   transaction is unavailable on this driver, fall back to giving the IdP heartbeat its own transaction (one timer, two transactions) and
   say so in the report. Add a database test: a listener that throws after `lastHeartbeat` was updated leaves no partial IdP write, while
   the platform heartbeat row is written.

Then rerun: `bunx vitest run --silent='passed-only' apps/server/src/enterprise/jobs apps/server/src/enterprise/bootstrap
apps/server/src/enterprise/services/platformInstance apps/server/src/enterprise/services/identityProvider
apps/server/src/enterprise/services/connectorCatalog`, `cd packages/database && bunx vitest run src/models/__tests__/platform.job.test.ts`,
`bun run check --lint <your files>`, and `bunx tsgo --noEmit -p tsconfig.json` once (grep your files). Update
`phase2/reports/G2.md` with "Round 5". Final message: 5 lines.
