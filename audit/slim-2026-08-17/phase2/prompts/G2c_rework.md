# G2c — round-3 rework after REVIEW_G2_round2.md. Same tree, you are still G2.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G2_round2.md — read it. Verdicts:

1. (BLOCKER 1, accepted — with THIS design, do not build lease renewal for queued jobs) The old workers claimed ONE job at a time
   (`claimNext`), so a job was never leased while waiting behind another. Reproduce that: the per-tick batch claim caps each type at
   **1** row (one CTE / lateral round-trip claims at most one job per enabled type); each lane processes its job, then continues with
   per-type `claimNext` (or the same batch claim restricted to its type, cap 1) until no job is returned or the lane's per-tick budget
   (the old batchLimit) is spent. Idle cost stays one query per tick; busy behaviour equals the old per-type loops. Remove the queued-lease
   renewal code and the 40 ms test; add a test that a lane processes k queued jobs sequentially, one claim each, and that a job is never
   in `running` state while another job of the same lane is being handled (i.e. no queued leases).
2. (BLOCKER 2, accepted) Readiness probes: evaluate each type's probe in its own try/catch; a throwing/failed probe only excludes that
   type (log once per tick, not per job); other lanes proceed. Test: throwing rewrap probe + runnable audit type → audit still claimed.
3. (MAJOR 3, accepted) `claimBatch`: apply the per-type cap AFTER `SKIP LOCKED` — use a LATERAL subquery per type
   (`FROM (VALUES …) AS t(type, cap, lease_ms) CROSS JOIN LATERAL (SELECT id FROM platform_jobs WHERE type = t.type AND <backlog predicate>
   ORDER BY … LIMIT t.cap FOR UPDATE SKIP LOCKED) picked`) then one `UPDATE … FROM picked RETURNING *`. Add a two-transaction concurrent
   claim test in PGlite (two claimants, same type, each gets a distinct row) — if PGlite cannot express two concurrent transactions,
   emulate with two sequential claims and assert distinct rows, and note the limit.
4. (MAJOR 4) already fixed by the commander (`leaseUntil!` in platform.job.test.ts) — keep it.

Then rerun your tests + `bunx tsgo --noEmit -p tsconfig.json` once (grep your files). Update phase2/reports/G2.md "Round 3". Final: 6 lines.
