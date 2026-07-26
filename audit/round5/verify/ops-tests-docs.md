# Verification — ops-tests-docs

## Verdicts

| Finding ID            | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                                                               |
| --------------------- | ----------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ops-tests-docs-D5-001 | HIGH              | CONFIRMED  | HIGH               | The verifier still assumes 117 unchanged migrations; the current three-entry squashed journal makes its static gate fail before database verification.                                                        |
| ops-tests-docs-D2-001 | HIGH              | DOWNGRADED | MEDIUM             | The assertions are stale and the opt-in integration test is unwired, but an automated rebase gate separately invokes the real verifier; the defect is test decay, not a permanently dormant integration path. |
| ops-tests-docs-D5-002 | HIGH              | DOWNGRADED | MEDIUM             | The snapshots are empty and have colliding ancestry, but Drizzle detects the collision and aborts before generating schema-recreation SQL.                                                                    |
| ops-tests-docs-D5-003 | HIGH              | CONFIRMED  | HIGH               | The embedded commit ends Drizzle’s transaction thousands of lines before the single squashed migration journal row is inserted.                                                                               |
| ops-tests-docs-D1-001 | HIGH              | CONFIRMED  | HIGH               | Migration `0011` drops a concurrently prebuilt index and rebuilds it non-concurrently; two additional indexes lack any online predeploy path.                                                                 |

## Details

### ops-tests-docs-D5-001 — CONFIRMED

- **What the original claimed:** The migration compatibility verifier still expects the upstream 117-file chain and therefore cannot operate on the current squashed baseline plus two follow-ups.

- **What I actually found:** `BASELINE_MIGRATION_LAST_IDX` remains 116 and the expected count remains 117 in `scripts/enterprise/verify-migration/constants.ts:5-11`. `verifyBaselineMigrationsMatch` compares all baseline-range paths to the pinned commit and indexes the current journal as though it still contained entries 0–116 at `scripts/enterprise/verify-migration/baseline.ts:104-208`. The actual journal contains only indices 0, 2, and 11 at `packages/database/migrations/meta/_journal.json:4-25`.

  Post-baseline classification is still `idx > 116` at `scripts/enterprise/verify-migration/migrations.ts:223-227`, and the expand-only verifier treats an empty entry set as passing at `scripts/enterprise/verify-migration/migrations.ts:343-358`.

  A read-only evaluation returned:

  - baseline `match: "failed"`
  - `fileMatchCount: 6`
  - journal `match: false`, `totalEntries: 3`
  - expand-only `match: true`, `scannedMigrations: 0`
  - official migration count `3`

  Running the actual CLI read-only exited with status 1.

- **Refutation attempts:** I checked whether the runner translated the squashed chain before applying the static checks; it does not. It requires baseline, journal, and expand-only checks to pass at `scripts/enterprise/verify-migration/runner.ts:127-165`, otherwise database provisioning is skipped. I also checked the upstream-rebase caller: it invokes this exact CLI at `scripts/enterprise/upstream-rebase-ci/migrationGate.ts:209-240`, so there is no alternate compatibility implementation. The verifier and squashed chain are fork changes, so the baseline exclusion does not apply.

- **Verdict rationale:** The defect is independently reproduced. The command cannot reach either its synthetic upgrade exercise or official migrator rerun with the checked-in journal.

- **Corrected severity and scope:** HIGH. Migration/schema changes select this gate through `scripts/enterprise/rebase-report.ts:501-514`, so the fork’s migration compatibility gate fails closed whenever selected.

### ops-tests-docs-D2-001 — DOWNGRADED

- **What the original claimed:** Unit tests assert the deleted 117-migration layout, while the real Docker integration proof is permanently skipped.

- **What I actually found:** The three assertions at `scripts/enterprise/verify-migration.test.ts:104-125` require a passing 117-entry baseline, at least 117 journal entries, and at least one post-baseline migration. Direct evaluation of those helpers produced `failed`, `3`, and `0`, respectively. Another assertion requires at least 117 official migrations at `scripts/enterprise/verify-migration.test.ts:173-181`, while the real count is 3.

  The integration suite requires both `MIGRATION_COMPAT_INTEGRATION=1` and Docker at `scripts/enterprise/verify-migration.integration.test.ts:39-50`. Repo-wide search found the variable only in that file.

- **Refutation attempts:** I checked for package scripts, workflows, and indirect environment setup enabling the integration test; none do. However, I found a separate automated integration path omitted by the report: migration/schema changes select `migration-upgrade-rerun` at `scripts/enterprise/rebase-report.ts:501-514`, and that gate directly runs `scripts/enterprise/verify-migration.ts` at `scripts/enterprise/upstream-rebase-ci/migrationGate.ts:209-215`. That CLI performs the owned-Postgres integration itself. It currently fails because of D5-001, but it is not dormant because the test environment variable is unset.

- **Verdict rationale:** The stale unit expectations and unwired optional test are real. The broader claim that the integration proof is never exercised is overstated: an automated command gate invokes the same full verifier outside Vitest.

- **Corrected severity and scope:** MEDIUM. This is genuine test decay and duplicated stale assumptions. The unusable release proof is already captured by D5-001 rather than constituting a separate HIGH defect.

### ops-tests-docs-D5-002 — DOWNGRADED

- **What the original claimed:** Empty, incorrectly chained Drizzle snapshots will cause the next generation command to emit a migration recreating the entire schema.

- **What I actually found:** All three current snapshots have empty `tables`, `enums`, `schemas`, and `sequences` maps at:

  - `packages/database/migrations/meta/0000_snapshot.json:1-10`
  - `packages/database/migrations/meta/0002_snapshot.json:1-10`
  - `packages/database/migrations/meta/0011_snapshot.json:1-10`

  Both follow-ups point to the root ID rather than their immediate predecessor. In fact, all three snapshots share the same `prevId`, creating a three-way ancestry collision.

  A read-only `drizzle-kit check` reproduced:

  > `[0000_snapshot.json, 0002_snapshot.json, 0011_snapshot.json] are pointing to a parent snapshot ... which is a collision.`

  It exited nonzero.

- **Refutation attempts:** I inspected Drizzle’s installed generator path. It collects snapshots and rejects multiple children of one `prevId` at `node_modules/drizzle-kit/bin.cjs:8155-8229`; generation calls that validator before snapshot diffing or writing output at `node_modules/drizzle-kit/bin.cjs:32159-32214`. Therefore the current chain does not reach the empty-snapshot diff that would emit schema-recreation SQL.

  I also checked the repository guard. `packages/database/src/models/__tests__/migrationJournal.meta.test.ts:21-38` verifies only journal-to-filename mapping, sorted indices, tag uniqueness, and prefixes. It does not validate snapshot contents or ancestry, so it does not prevent this defect.

- **Verdict rationale:** The metadata is unquestionably invalid, but the claimed immediate failure mode is wrong: Drizzle fails closed on the ancestry collision rather than emitting duplicate `CREATE TABLE` statements.

- **Corrected severity and scope:** MEDIUM. Runtime migration application reads SQL and journal metadata, not snapshots, so existing deployment is not directly corrupted. Normal `db:generate` development is blocked until the snapshot chain is repaired; after repairing ancestry, the empty state must also be replaced to avoid full-schema diff generation.

### ops-tests-docs-D5-003 — CONFIRMED

- **What the original claimed:** The squashed baseline contains an embedded `BEGIN`/`COMMIT`, allowing later DDL to commit without a baseline journal row if a subsequent statement fails.

- **What I actually found:** The current baseline starts the inner transaction at `packages/database/migrations/0000_squash_baseline.sql:1168-1174`, commits at `packages/database/migrations/0000_squash_baseline.sql:1388-1395`, and then continues through line 7586.

  Drizzle wraps all pending migrations in one transaction, executes every statement, and inserts the migration journal row only after that migration’s statements finish at `node_modules/drizzle-orm/pg-core/dialect.js:44-71`. Its node-postgres session implements that wrapper with `BEGIN`, `COMMIT`, and rollback at `node_modules/drizzle-orm/node-postgres/session.js:180-194`.

  The fork itself documents the resulting failure at `scripts/migrateServerDB/preflightBaseline.ts:1-12` and warns that a partial schema can exist without a journal row at `scripts/migrateServerDB/preflightBaseline.ts:30-44`.

- **Refutation attempts:** I checked the pinned baseline and found that upstream migration `0017_add_user_id_to_tables.sql` also had `BEGIN` at line 4 and `COMMIT` at line 225. This does not make the fork defect identical: upstream’s `COMMIT` ended migration `0017`, after which Drizzle immediately inserted its journal row before advancing to migration `0018`. The fork concatenates thousands of later statements into the same `0000` migration, delaying the only journal row until the entire 7,586-line file succeeds.

  I also checked the preflight guard. It verifies extension availability and detects an already-partial install at `scripts/migrateServerDB/preflightBaseline.ts:57-73`; it does not restore transaction atomicity. The production caller may continue after preflight connection errors at `scripts/migrateServerDB/index.ts:99-113`.

- **Verdict rationale:** The upstream chain contained the transaction-control statement, but squashing removed the intervening journal checkpoints and materially enlarged the unjournaled failure window. The fork therefore introduced a distinct, larger defect.

- **Corrected severity and scope:** HIGH. It affects fresh application of the squashed baseline. Failure after line 1393 can require destructive database/schema recovery, exactly as the fork’s recovery hint acknowledges.

### ops-tests-docs-D1-001 — CONFIRMED

- **What the original claimed:** The documented online index predeploy is defeated by the migrations, including an unconditional drop-and-recreate of a prebuilt index.

- **What I actually found:** Migration `0002` creates two ordinary indexes and drops/recreates one name at `packages/database/migrations/0002_r4_w1_evidence.sql:5-25`. Migration `0011` creates three ordinary indexes at `packages/database/migrations/0011_r4_w2_db.sql:6-36`.

  The runbook prebuilds the three `0011` indexes with `CREATE INDEX CONCURRENTLY` at `docs/self-hosting/advanced/database-retention-indexes-predeploy.md:7-33`, then incorrectly says the migration is a no-op at line 35. In reality, `0011` unconditionally drops `platform_audit_exports_purge_outbox_updated_at_id_idx` at `packages/database/migrations/0011_r4_w2_db.sql:24-29` before recreating it non-concurrently.

- **Refutation attempts:** I searched for another predeploy utility covering these five names. The only index predeploy script found covers unrelated M10 `platform_jobs` indexes at `scripts/migrateServerDB/predeployM10RolloutIndexes.ts:10-23`. I found no validity gate, alternate-name cutover, or concurrent path for the two `0002` indexes.

  `IF NOT EXISTS` cannot protect the prebuilt purge-outbox index because the immediately preceding `DROP INDEX IF EXISTS` removes it. These migrations and their runbook are fork-only relative to the pinned baseline.

- **Verdict rationale:** Following the documented procedure still forces one non-concurrent rebuild, and two additional hot-path indexes have no documented online build path. Regular index creation can block writes for the duration of the build on populated tables.

- **Corrected severity and scope:** HIGH for populated upgrades involving `topics` or `platform_audit_exports`. Fresh or small installations have a much smaller operational impact, but the runbook explicitly targets populated production tables and fails in that intended scope.
