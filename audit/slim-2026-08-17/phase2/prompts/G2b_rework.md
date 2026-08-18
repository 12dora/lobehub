# G2b — rework after codex review (REVIEW_G2.md). Same tree, you are still G2.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G2.md — read it fully.
Commander verdicts — ALL five findings accepted:

1. (BLOCKER 1) Import `parsePlatformKeyProviderName` from the light `../security/secret/config` module (or wherever the pure parser
   lives), not the `security/secret` barrel. The dispatcher module must not statically link the secret runtime / Vault providers.
2. (BLOCKER 2 — the commander flagged this independently) Preserve per-type semantics exactly like six independent loops:
   - claim per type with that type's own `batchLimit` and ordering (per-type claim inside ONE round-trip is fine — see 4 — but the
     limit must be per type, never a global oldest-100);
   - dispatch types as independent serial lanes running concurrently (`Promise.allSettled` over lanes; sequential inside a lane);
   - a lane must not lease more rows than it can start processing before their lease expires — simplest: claim only its `batchLimit`
     and rely on the lane running immediately; if a handler's own per-job lease renewal existed before, keep it;
   - tests: per-type fairness (deep queue of type A does not starve type B), one lane throwing does not stop the others, and a
     lease-TTL test (a job whose handler runs longer than the queued sibling's lease is not double-claimed on the next tick — with
     independent lanes and per-type caps this holds; prove it).
3. (BLOCKER 3) Readiness gates run BEFORE claiming: for `secretRewrap` (Vault config valid + secret service constructible) and
   `connectorSecretCleanup` (connector secret store present) evaluate the type's runnable predicate once per tick and drop non-runnable
   types from the claim set (no attempts increment, no lease). Propagate the per-type stop/`retry` signal from the cleanup handler:
   when a lane's handler says "stop for this tick", the lane stops processing the rest of its claimed rows and returns them
   (release the lease / reset to pending exactly as the old worker did — read the old code path).
4. (MAJOR 4) `PlatformJobModel.claimBatch` must be set-based: one statement (CTE `WITH picked AS (SELECT … FOR UPDATE SKIP LOCKED
   … ) UPDATE platform_jobs … FROM picked RETURNING *`) with per-type row caps (`ROW_NUMBER() OVER (PARTITION BY type ORDER BY …)
   <= cap`) and per-type lease via a `CASE`/VALUES join. PGlite must run it (test in packages/database). Keep `claimNext` untouched.
5. (MAJOR 5) One tick = one transaction: run the platform-instance heartbeat upsert and the IdP registry heartbeat inside one
   `db.transaction`, passing the tx to the IdP write; keep the fallback-timer takeover; test both (transaction shared; fallback timer
   cleared when the platform ticker starts).

Then rerun your test commands (+ new tests) and `bunx tsgo --noEmit -p tsconfig.json` ONCE (grep your files only). Update
`phase2/reports/G2.md` with a "Round 2" section (per finding what changed, tests). Final message: 8 lines.
