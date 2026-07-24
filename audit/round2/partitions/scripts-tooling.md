# Partition: scripts-tooling

## Summary

The tooling contains several fail-open gates: migration compatibility, rebase mutation detection, and path-boundary coverage can all report success without proving their stated guarantees. Recovery and failure-drill evidence also has important trust and scalability weaknesses. CRITICAL: 3 · HIGH: 5 · MEDIUM: 3 · LOW: 3.

## Findings

### F1 \[CRITICAL]\[D5] The expand-only migration gate permits destructive schema changes

- **Location:** `scripts/enterprise/verify-migration/migrations.ts:232`, `scripts/enterprise/verify-migration/migrations.ts:243`, `scripts/enterprise/verify-migration/runner.ts:145`
- **Evidence:** `verifyExpandOnlyPostBaselineSql` rejects only `DROP TABLE ... <protected table>` and `ALTER TABLE <protected table> RENAME TO ...`. It does not reject destructive operations such as `ALTER TABLE "users" DROP COLUMN "avatar"`, narrowing type changes, dropping constraints, or schema-qualified forms such as `DROP TABLE public.users`. The runner treats this narrow check as the expand-only verdict.
- **Impact / failure scenario:** A post-baseline migration drops a column used by the previous application version. The SQL check passes, the fixture still inserts its limited set of columns, row-count and foreign-key probes pass, and the migration gate reports success despite breaking backward compatibility.
- **Fix:** Parse migration SQL using an AST or conservative tokenizer and reject all destructive contract changes, including `DROP COLUMN`, `DROP TABLE`, `DROP CONSTRAINT`, renames, narrowing type/nullability changes, and schema-qualified identifiers. Add negative regression fixtures for each form.
- **Confidence:** HIGH

### F2 \[CRITICAL]\[D5] Rebase gates treat failure to inspect the worktree as “no mutation”

- **Location:** `scripts/enterprise/upstream-rebase-ci/gates.ts:233`, `scripts/enterprise/upstream-rebase-ci/gates.ts:286`, `scripts/enterprise/upstream-rebase-ci/gates.ts:403`
- **Evidence:** The mutation detector returns `status.code === 0 && status.stdout.length > 0`. Therefore any nonzero `git status` result becomes `false`, indistinguishable from a successfully inspected clean worktree. Both command-gate paths fail only when the returned value is `true`.
- **Impact / failure scenario:** A gate command corrupts repository metadata, changes permissions, or otherwise makes `git status` fail. If the command itself exits successfully, the rebase gate records a pass without verifying that the command left the repository unchanged.
- **Fix:** Return a tri-state result or throw whenever `git status` exits nonzero. Require callers to fail the gate unless worktree inspection completes successfully. Add a regression test with a failing status subprocess.
- **Confidence:** HIGH

### F3 \[CRITICAL]\[D5] Path-boundary validation can pass after scanning no files

- **Location:** `scripts/enterprise/check-path-boundaries.ts:39`, `scripts/enterprise/check-path-boundaries.ts:65`, `scripts/enterprise/check-path-boundaries.ts:89`, `scripts/enterprise/production-readiness/adapters/pathBoundaries.ts:87`
- **Evidence:** Directory traversal catches `readdir` failures and returns the accumulated files; each root is treated as optional. The command exits successfully whenever `violations.length === 0`, including when zero files were scanned. The readiness adapter then fabricates coverage with `filesScanned > 0 ? filesScanned : code === 0 ? 1 : 0`.
- **Impact / failure scenario:** Running from the wrong working directory, with missing roots, or with unreadable directories scans zero or only a subset of files and exits zero. The adapter changes the reported count from zero to one, allowing the production-readiness boundary gate to pass without meaningful coverage.
- **Fix:** Resolve and verify the repository root, require every mandatory scan root to exist and be readable, propagate traversal errors, and record per-root coverage. Never synthesize a positive scan count. Add wrong-CWD, missing-root, and unreadable-root tests.
- **Confidence:** HIGH

### F4 \[HIGH]\[D5] Production-readiness evidence can pass without assertions and is not bound to signed assertions

- **Location:** `scripts/enterprise/production-readiness/evaluate.ts:230`, `scripts/enterprise/production-readiness/trust/provenance.ts:82`, `scripts/enterprise/production-readiness/trust/provenance.ts:164`, `scripts/enterprise/production-readiness/trust/provenance.ts:224`, `scripts/enterprise/production-readiness/recovery/evidenceEnvelope.ts:34`
- **Evidence:** The evaluator rejects zero assertions only when `input.assertions` exists: `input.status === 'passed' && input.assertions && ...`. Omitting the field bypasses the check. The signed provenance schema also makes assertions optional, and verification compares the signed and submitted `status` but not their assertion summaries.
- **Impact / failure scenario:** Once production trust is enabled, correctly signed envelopes marked `passed` but containing no assertions—or containing assertions different from those signed—can satisfy the production verdict without evidence of what was checked.
- **Fix:** Require assertions for every passed gate, require a positive count with all assertions passing, and make assertions mandatory in signed passed payloads. Compare the complete signed evidence payload with the submitted envelope.
- **Confidence:** HIGH

### F5 \[HIGH]\[D5] Failure-drill verification accepts forged aggregate reports

- **Location:** `scripts/enterprise/failure-drills/runner.ts:123`, `scripts/enterprise/failure-drills/runner.ts:173`, `scripts/enterprise/failure-drills/contract.ts:154`, `scripts/enterprise/upstream-rebase-ci/failureDrillGate.ts:60`, `scripts/enterprise/upstream-rebase-ci/upstream-rebase-ci.test.ts:619`
- **Evidence:** Collection hashes raw reports, but verification later only parses stored aggregate JSON and applies pass/cleanup/redaction predicates. It never rereads raw reports or recomputes their digests. The rebase adapter creates passing fixtures with an arbitrary `artifact.sha256 = 'b'.repeat(64)`, and the test confirms that these hand-authored aggregates pass.
- **Impact / failure scenario:** Four fabricated aggregate files with passing booleans and syntactically valid fake hashes satisfy the verifier without any failure drill having run.
- **Fix:** Emit a manifest binding the candidate commit and exact raw-report digests, then verify those digests against supplied raw reports or a trusted signature/attestation. Replace the fabricated passing fixture with tests proving forged or missing raw evidence is rejected.
- **Confidence:** HIGH

### F6 \[HIGH]\[D5] The required “migration-upgrade-rollback” gate performs no rollback check

- **Location:** `scripts/enterprise/upstream-rebase-ci/migrationGate.ts:178`, `scripts/enterprise/upstream-rebase-ci/migrationGate.ts:260`, `scripts/enterprise/upstream-rebase-ci/gates.ts:93`, `scripts/enterprise/rebase-report.ts:493`, `scripts/enterprise/upstream-rebase-ci/upstream-rebase-ci.test.ts:567`
- **Evidence:** The implementation explicitly states that it “Does NOT claim application-version rollback,” yet returns a passed gate named `migration-upgrade-rollback` after apply/probe/rerun checks. Rebase reporting requires that misleadingly named gate for migration changes, and the test locks in the upgrade-only behavior.
- **Impact / failure scenario:** A forward migration works with the new application but breaks the previous application version. The required rollback gate still reports passed, giving reviewers false evidence that rollback compatibility was exercised.
- **Fix:** Implement an actual previous-version application compatibility stage, or rename the gate and report contract to `migration-upgrade-rerun`. If rollback remains required, upgrade-only execution must not return a passing rollback verdict.
- **Confidence:** HIGH

### F7 \[HIGH]\[D5] The required application-rollback gate is permanently implemented as unavailable

- **Location:** `scripts/enterprise/production-readiness/recovery/baselineMaterialize.ts:169`, `scripts/enterprise/production-readiness/recovery/baselineMaterialize.ts:225`, `scripts/enterprise/production-readiness/recovery/appRollback.ts:166`, `scripts/enterprise/production-readiness/constants.ts:31`, `scripts/enterprise/production-readiness/recovery.integration.test.ts:74`
- **Evidence:** The baseline loader imports the model and PostgreSQL client, then unconditionally emits `ok: false` with `baseline-orm-runtime-unavailable` and exits with code 1. No branch produces a usable baseline runtime. The integration test explicitly expects this failure, while `app-rollback` remains a required production gate.
- **Impact / failure scenario:** Production readiness can never demonstrate application rollback, even in a valid environment. The test preserves a permanent stub instead of testing the promised recovery capability.
- **Fix:** Implement installation and execution of the baseline application ORM against the upgraded database. Alternatively, remove the gate from the required set until implemented. **Test action: FIX** the integration test to exercise a successful rollback-compatibility path.
- **Confidence:** HIGH

### F8 \[HIGH]\[D1] Backup verification loads entire databases into memory and performs N+1 queries

- **Location:** `scripts/enterprise/production-readiness/recovery/backupRestore.ts:384`, `scripts/enterprise/production-readiness/recovery/backupRestore.ts:444`, `scripts/enterprise/production-readiness/recovery/ownedPostgres.ts:193`, `scripts/enterprise/production-readiness/recovery/invariants.ts:191`, `scripts/enterprise/production-readiness/recovery/invariants.ts:917`
- **Evidence:** Backup files are read wholly into memory more than once; owned PostgreSQL capture buffers `pg_dump` with a 64 MiB ceiling. Invariant calculation selects every column and row from each enterprise table, materializes and sorts them in JavaScript, and duplicates them into digest payloads. Publication-pointer verification then issues separate version queries inside a per-row loop.
- **Impact / failure scenario:** A realistic production backup or large enterprise table exceeds the subprocess buffer or heap, causing the recovery gate to fail or be killed before validating restore correctness. Many publication holders also cause avoidable query amplification.
- **Fix:** Stream dump data through hashing and `pg_restore`; avoid the fixed 64 MiB buffered subprocess. Compute deterministic table digests with ordered cursor/chunked reads and incremental hashes. Batch publication-pointer joins and cache schema metadata.
- **Confidence:** HIGH

### F9 \[MEDIUM]\[D5] Prometheus compose validation accepts pins placed in unrelated services or comments

- **Location:** `scripts/enterprise/prometheus-alerts/composeWiring.ts:56`, `scripts/enterprise/prometheus-alerts/composeWiring.ts:82`, `scripts/enterprise/prometheus-alerts/composeWiring.ts:114`
- **Evidence:** Image and mount validation uses whole-file checks such as `compose.includes(ENTERPRISE_PROMETHEUS_IMAGE)`. Only later command-flag checks extract the Prometheus service block. The required image or mount text can therefore appear in a comment or unrelated service while the actual service uses an unpinned image or wrong configuration.
- **Impact / failure scenario:** A compose file retains the expected pinned string in documentation or another service but changes `services.prometheus.image` to `latest`. The static gate passes, while runtime checks launch separately defined constant images rather than validating the deployed compose definition.
- **Fix:** Parse the compose YAML and validate the exact Prometheus and OpenTelemetry service image, command, and volume fields. Add negative tests with expected strings in comments or unrelated services.
- **Confidence:** HIGH

### F10 \[MEDIUM]\[D1] Restore subprocess handling can deadlock and leak timed-out processes

- **Location:** `scripts/enterprise/production-readiness/recovery/ownedPostgres.ts:212`
- **Evidence:** `pg_restore` is spawned with piped stdout and stderr, but neither stream is consumed. The parent simultaneously writes the full dump to stdin. On timeout it sends `SIGTERM` and rejects immediately without waiting for process closure or escalating termination.
- **Impact / failure scenario:** Sufficient subprocess output fills an unread pipe and blocks `pg_restore`, eventually triggering the timeout. The unresolved child can remain alive while recovery cleanup proceeds, causing flaky failures and resource leakage.
- **Fix:** Consume and cap stdout/stderr or set unused streams to `ignore`; stream the dump with backpressure. On timeout, terminate, escalate to `SIGKILL` if needed, await `close`, and ensure the promise settles once.
- **Confidence:** MEDIUM

### F11 \[MEDIUM]\[D2] Ordinary unit tests depend on Docker, network availability, and long runtime probes

- **Location:** `scripts/enterprise/prometheus-alerts/checkRules.test.ts:54`, `scripts/enterprise/prometheus-alerts/checkRules.test.ts:319`, `scripts/enterprise/prometheus-alerts/checkRules.test.ts:356`
- **Evidence:** The standard `.test.ts` file invokes real Docker commands, starts Prometheus and OpenTelemetry containers, may pull images, and runs an OTLP probe with a 180-second timeout.
- **Impact / failure scenario:** Routine test runs fail or stall on machines without Docker, without cached images, or with restricted networking. Failures conflate pure rule-validation regressions with environmental infrastructure failures.
- **Fix:** **Test action: FIX.** Move Docker-dependent cases into an explicitly selected `.integration.test.ts` suite with an opt-in environment contract and owned lifecycle. Keep parser and reconciliation tests hermetic in the unit suite.
- **Confidence:** HIGH

### F12 \[LOW]\[D2] Backoff test is coupled to a five-millisecond wall-clock deadline

- **Location:** `scripts/enterprise/prometheus-alerts/checkRules.test.ts:380`
- **Evidence:** The test calculates `Date.now() + 5` and expects a fixed sleep sequence. A process pause longer than five milliseconds before the loop changes the observed sleep duration, while the injected sleep resolves immediately and does not test actual scheduling.
- **Impact / failure scenario:** CI load, debugger pauses, or timer granularity cause intermittent assertion failures unrelated to backoff correctness.
- **Fix:** **Test action: FIX.** Inject a deterministic clock or use fake timers and assert the attempt/backoff sequence independently of elapsed real time.
- **Confidence:** HIGH

### F13 \[LOW]\[D3] Private tooling retains orphaned and deprecated compatibility exports

- **Location:** `scripts/enterprise/verify-migration/runner.ts:401`, `scripts/enterprise/verify-migration/contract.ts:387`, `scripts/enterprise/prometheus-alerts/emissionContract.ts:152`, `scripts/enterprise/production-readiness/recovery/backupRestore.ts:606`, `scripts/enterprise/production-readiness/commands.ts:435`, `scripts/enterprise/production-readiness/commands.ts:463`, `scripts/enterprise/upstream-rebase-ci/fetchUpstream.ts:484`, `scripts/enterprise/production-readiness/fsUtils.ts:199`
- **Evidence:** Repository-wide caller checks found no functional callers for `peekResourceTokenShape`, deprecated contract aliases, `isUnsafeBackupPath`, `runArgv`, the duplicate `removeDirectoryExact`, and deprecated temp-path helpers. `resolveAllowlistedArgv` is retained only by its compatibility test.
- **Impact / failure scenario:** Dead alternatives enlarge the trusted tooling surface, obscure which execution path is authoritative, and require maintainers to preserve behavior that no production gate consumes.
- **Fix:** Delete the unused exports, their barrel exports/imports, duplicate implementation, and tests whose only purpose is preserving unconsumed compatibility behavior.
- **Confidence:** HIGH

### F14 \[LOW]\[D1] Several tooling files mix too many responsibilities

- **Location:** `scripts/enterprise/security-acceptance/security-acceptance.test.ts:1`, `scripts/enterprise/production-readiness/recovery/invariants.ts:1`, `scripts/enterprise/production-readiness/schemas.ts:1`, `scripts/enterprise/pathBoundaries.ts:1`
- **Evidence:** These files are approximately 1,732, 1,093, 868, and 808 lines respectively. For example, `invariants.ts` combines row canonicalization, full-table hashing, secret-domain validation, publication-pointer checks, and schema inventory logic.
- **Impact / failure scenario:** Changes to one gate concern require navigating unrelated security and recovery logic, increasing review difficulty and the chance that a broad fixture or helper change silently affects multiple guarantees.
- **Fix:** Split files by gate/domain responsibility, with separate modules for row digests, secret invariants, publication pointers, schema inventory, and security-acceptance scenarios.
- **Confidence:** HIGH

## Dimension coverage

① Checked process lifecycle, database/file scanning, query patterns, duplication, complexity, and file size; issues cluster in recovery invariants, restore subprocesses, and oversized mixed-responsibility modules.

② Checked `skip`/`todo`/`only`, meaningful assertions, environmental dependencies, wall-clock coupling, and tests that preserve incomplete behavior; F7, F11, and F12 require FIX actions.

③ Checked exports and callers, deprecated compatibility paths, fixtures, debug remnants, and stale scaffolding; F13 identifies confirmed orphaned code, while F7 contains a required but permanently unavailable implementation.

④ These scripts do not present localized end-user UI and contain no relevant `admin` namespace usage; no missing zh-CN i18n issue was found.

⑤ Traced migration, rebase, path-boundary, failure-drill, recovery, provenance, and Prometheus gates end-to-end; the most serious defects are the fail-open migration, mutation-detection, and scan-coverage gates in F1–F3.
