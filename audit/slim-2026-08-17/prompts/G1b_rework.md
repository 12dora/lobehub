# G1b — Rework after review (module core backend)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still G1. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/G1_module_core.md, …/scratchpad/slim/reports/G1.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_G1.out.md

Adjudication (do exactly this):
1. F1 (deviceGateway ↔ `lambda.device`): G3 verified `lambda.device` is the shared desktop/workspace device-enrollment router (core), so
   do NOT gate the whole router. Instead: read `apps/server/src/routers/lambda/device.ts`; if the procedures that call the remote
   device-gateway service are a small identifiable subset, add `.use(withModule('deviceGateway'))` to exactly those (one line each,
   import from `@/server/enterprise/guards/moduleGuard`) and record them in `modules.ts` as a comment (keep `lambdaRouterKeys: []`);
   if not separable, leave it and write in the report that deviceGateway gating is UI + tool-runtime only (G3b adds the tool gate).
2. ACCEPT F2 (BLOCKER): `platform.aiCatalog.getPublished` (and any other `platform.*` procedure that serves managed-AI / managed
   catalog data — check `platform.ts` for `resolvePublishedManagedResourcePolicies`, `AiCatalogReadService` users) gets
   `withModule('managedAi')`. Test env-off and DB-off ⇒ `PLATFORM_MODULE_DISABLED`.
   Careful: `platform.getCapabilities` and `platform.getPublicSnapshot` must stay ungated (they carry the module map itself).
3. ACCEPT F3+F4 (MAJOR): `admin.modules.update` — decide reauth on the AUTHORITATIVE row (read the DB row inside the same transaction
   / with `expectedRevision`), and persist the settings CAS + the audit row in ONE transaction; publish invalidation after commit.
   Tests: stale hot snapshot cannot skip reauth; audit failure rolls back the settings change.
4. RENUMBER FIRST: a parallel session on main took `0020` (`0020_platform_network_proxy_subscription_issue`, when 1787450000000). Rename ours to
   `0021_platform_module_settings.sql`, journal idx 21 / tag `0021_platform_module_settings` / keep when 1787500000000, snapshot file
   `meta/0021_snapshot.json`. Then ACCEPT F5 (BLOCKER): the snapshot must be byte-identical to the 0018 snapshot except for
   the snapshot ids and the new table (restore the re-encoded Chinese literal). Verify with `diff <(jq -S . 0018) <(jq -S . 0020)`.
5. ACCEPT F6 (MINOR): add `apps/server/src/enterprise/routers/admin/modules.test.ts` covering get/update/reauth/CAS conflict mapping/
   audit failure/restart unsupported/output schema.
6. Also from the measurement run (G0b_measure.md §E1): `aiCatalogReadiness` worker spec `failed to start { errorClass: 'ReferenceError' }`
   on every boot where managedAi is on — that spec lives in G2's `bootstrap/workersBootstrap.ts` and calls your readiness registration
   (`services/aiCatalog/*readiness*` / what was `admin.ts:48-50`). Reproduce with a unit test that calls the spec's `start()` for real
   (no mocks) and fix the ReferenceError (probably a TDZ / wrong import order created when the readiness calls moved). Coordinate:
   you may edit the aiCatalog readiness module; if the fix is in `workersBootstrap.ts` itself, make it minimal and note it (G2 is also
   reworking that file — keep to the aiCatalog spec lines).
7. Re-run: registry parity tests (expected 218/102/116 on this branch — peer main will be +1 → 219/102/117 after rebase, the
   commander handles that), guards tests, moduleSettings tests, `cd packages/database && bunx vitest run src/models/platform/moduleSettings.test.ts`,
   `bun run .agents/scripts/check/cli.ts --lint <files>`. Append "Round 2" to …/scratchpad/slim/reports/G1.md. Final message: 10 lines.
