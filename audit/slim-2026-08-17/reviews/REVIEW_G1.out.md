# VERDICT: REWORK

## FINDINGS

1. **BLOCKER · [verified] · `packages/const/src/platform/modules.ts:301`** · `deviceGateway.lambdaRouterKeys` is empty, although `lambda.device` directly imports and invokes `deviceGateway`. Disabling `deviceGateway` therefore leaves the entire tRPC surface operational, violating rule 2. Add `device` to the mapping, coordinate the corresponding `moduleRouter('deviceGateway', …)` wrapper in the G3-owned lambda router, and add reverse-coverage tests so missing module-owned routes are detected.

2. **BLOCKER · [verified] · `apps/server/src/enterprise/routers/platform.ts:49`** · `platform.aiCatalog.getPublished` lacks `withModule('managedAi')`. A DB-disabled `managedAi` module still returns the published catalog; an env-disabled module returns an empty catalog instead of `PLATFORM_MODULE_DISABLED`. Add the module middleware and test both env- and DB-disabled cases.

3. **MAJOR · [verified] · `apps/server/src/enterprise/routers/admin/modules.ts:93`** · The compliance reauth decision uses the hot cached snapshot, but the subsequent update rereads the authoritative DB row and can successfully CAS against a newer revision. During cross-instance invalidation lag, a stale snapshot can show `audit`/`moderation` already off while the DB has it on, allowing it to be switched off without reauth; the audit `beforeDiff` is also wrong. Load an authoritative row matching `expectedRevision` for the reauth decision, then let CAS reject any intervening change. Add a stale-instance-cache regression test.

4. **MAJOR · [verified] · `apps/server/src/enterprise/routers/admin/modules.ts:121`** · The settings CAS commits and publishes invalidation before the required audit append. If audit persistence fails, the API returns an error even though settings changed, leaving no success audit and causing retries to conflict. Persist the settings change and audit row in one database transaction, then publish invalidation after commit; test audit failure rollback.

5. **BLOCKER · [verified] · `packages/database/migrations/meta/0020_snapshot.json:19846`** · The snapshot is not strictly “0018 plus IDs and the new table”: an unrelated existing Chinese default was re-encoded as Unicode escapes. This is out-of-scope migration-snapshot churn and violates rule 4. Restore the exact 0018 literal and retain only snapshot identity plus `platform_module_settings` changes.

6. **MINOR · [verified] · `apps/server/src/enterprise/routers/admin/modules.ts:59`** · The new security-sensitive router has no sibling test covering get/update, conditional reauth, CAS mapping, audit failure, restart support, or output validation. Add targeted router tests; the current service tests do not exercise these branches.

## METRICS

- **Files reviewed:** 40
- **Upstream files touched:**
  - `packages/types/src/serverConfig.ts` — **obeys rule 4:** targeted optional-field insertion; no restructuring.
  - `packages/database/migrations/0020_platform_module_settings.sql` — **obeys:** explicit G1 migration deliverable, new additive file.
  - `packages/database/migrations/meta/_journal.json` — **obeys:** targeted journal entry.
  - `packages/database/migrations/meta/0020_snapshot.json` — **does not obey:** unrelated literal rewrite; finding 5.
  - `packages/locales/src/default/admin.ts` — **obeys:** targeted additive locale keys; no reorder/reformat.
  - `locales/en-US/admin.json` — **obeys:** targeted additive locale keys; no reorder/reformat.
  - `locales/zh-CN/admin.json` — **obeys:** targeted additive locale keys; no reorder/reformat.
- Locale key parity was statically verified: default/en-US/zh-CN each contain 3,499 matching keys.

## UNVERIFIED

- Vitest/PGlite tests were not run, as required for the read-only sandbox.
- `bunx tsgo --noEmit --incremental false -p tsconfig.json` could not complete cleanly because of out-of-scope errors in S3 lazy imports, tRPC tests, MDX Image, and F2 test files. No scoped G1 error was emitted, but full type correctness remains unverified.
- Migration execution, restart scheduling through Next.js `after()`, and live multi-instance invalidation behavior were not runtime-verified.