# G2d — round-4 rework after REVIEW_G2_round3.md. Same tree, you are still G2.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G2_round3.md. All three accepted:

1. (BLOCKER 1) `defaultHandleClaimed` must RETURN each handler's result (the connector secret-cleanup `{ stop: true }` signal in
   particular) and the lane must honour it: on `stop` the lane stops claiming more jobs of that type for this tick — exactly the old
   scheduler's behaviour (the job stays requeued for a later poll instead of being re-claimed until the 12-attempt budget is burnt).
   Type the handler return properly (e.g. `Promise<{ stop?: boolean } | void>`). Test through the PRODUCTION wrapper (not an injected
   handler): a connector-secret-cleanup handler that returns `{ stop: true }` results in exactly one claim for that type in the tick.
2. (MAJOR 2) Keep per-type failure/backoff state: a handler exception marks that lane's tick as failed (so a retry/backoff for that type
   applies, as `startPersistentWorkerScheduler` did per worker) while other lanes still run; a rejected follow-up claim must be logged
   (errorClass + type), never silently swallowed. Since the shared scheduler has one backoff, keep a per-type consecutive-failure counter
   inside the dispatcher and skip that type for the next N ticks (N derived from its old retry delay / base interval), documented in a
   comment. Tests: handler throw → other lanes still processed and the failing type backs off; follow-up claim rejection → logged, tick
   continues.
3. (MAJOR 3) Runtime-audit reservation cleanup runs inside its own try/catch as part of that type's readiness/preparation: a failure
   removes only `connectorRuntimeAudit` from this tick and logs; every other lane proceeds. Test with a throwing cleanup.

Rerun your tests + `bunx tsgo --noEmit -p tsconfig.json` once (grep your files). Update phase2/reports/G2.md "Round 4". Final: 5 lines.
