# G4b — Rework after review (hot-path caches)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still G4. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/G4_hot_paths.md, …/scratchpad/slim/reports/G4.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_G4.out.md
Commander already: fixed the moderation `snapshot` typing (runtime/types.ts keeps `unknown`; defaults.ts casts at the composition
root; decisionService accepts `ModerationSnapshot | null`) — keep it. Deleted `packages/business/model-bank/src/lib/model-config.test.ts`
(no vitest config there; the root-side `src/business/model-config.test.ts` covers it) — do not re-add.

Adjudication (do exactly this):
1. ACCEPT F1 (BLOCKER) regexWorker: clear `compiledDigests` in EVERY worker-death path (timeout kill, error, exit) so a fresh worker
   receives patterns again; regression test: same digest after a crash still matches.
2. ACCEPT F2 (BLOCKER) userActiveCache: capture the epoch at flight start; only `remember()` when the epoch is unchanged; race test.
3. ACCEPT F3 (BLOCKER) runtimeSettingsAdapter: NO process-wide 2s cache. Replace with a request-scope dedupe (per `execAgent`
   invocation / per AsyncLocalStorage request context if one exists in this path — else pass a per-call memo object through the
   two call sites) so semantics after `user.updateSettings` are unchanged. Test: update between two separate calls is visible.
4. REJECT F4 (loadModels memo TTL): the memo is keyed by input identity/version (pure derivation) — no TTL needed. Just make sure the
   fork version key changes whenever the loaders/config change (document in a comment).
5. REJECT F5 (catalog checksum memo TTL): content-addressed by providerId:revision + LRU bound — fine. But ACCEPT F6 (MAJOR): do not
   swallow `peekGeneration()` errors — a real DB failure must propagate (fail-closed) instead of returning generation 0 / a stale slot.
   Test: peekGeneration throwing ⇒ load rejects.
6. ACCEPT F7 (MAJOR→BLOCKER): `apps/server/src/enterprise/services/networkProxy/engine/bindEgress.ts` must not use `createRequire`
   (untraceable by Turbopack ⇒ in the standalone image the egress hook may silently never bind ⇒ proxy/SSRF bypass). Use
   `await import('../egress/scope')` (bundler-traceable) at boot in the worker registry / ModelRuntime init path; surface (log at error
   level) failures instead of fail-soft. Coordinate: this file is G2's — you may edit it (G2 finished); keep `bindEgress` export names.
   Test that the binder registers the hook and that an import failure is logged (mock).
7. ACCEPT F8 (MAJOR) networkProxy egress fast path: the projected view must be produced WITHOUT `structuredClone` of the full snapshot
   on the warm path (add a `peek`/raw accessor to `DomainConfigCache` if needed — that file is yours — or cache the projection alongside
   the snapshot keyed by revision), and return a frozen/cloned small view (no shared mutable slot). Test: warm call does not clone the
   subscriptions; returned view is not the cached object.
8. ACCEPT F9 (MINOR): scope-version memo: only store the read result if no `publish` happened for that scope since the read started
   (per-scope generation counter). Small test.
9. Re-run your test list + `bun run .agents/scripts/check/cli.ts --lint <files>`. Append "Round 2" to …/scratchpad/slim/reports/G4.md.
   Final message: 10 lines.
