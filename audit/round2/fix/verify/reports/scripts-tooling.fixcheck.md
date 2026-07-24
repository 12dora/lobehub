| Finding |      Verified Sev | Fix status | Note                                                                                                                                                                                  |
| ------- | ----------------: | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      |              HIGH | PARTIAL    | Common cases are rejected, but valid variants such as `ALTER TABLE ONLY`, optional `COLUMN`, and destructive changes outside the small protected-table list still bypass the scanner. |
| F2      |               LOW | FIXED\_OK  | Mutation detection is tri-state and both callers fail closed on `unknown`; a failing-status regression exists.                                                                        |
| F3      |            MEDIUM | PARTIAL    | CLI and adapter now fail closed, but required missing-root and unreadable-root regressions were not added.                                                                            |
| F4      |            MEDIUM | FIXED\_OK  | Passed evidence requires positive all-pass assertions, and signed/submitted summaries are compared.                                                                                   |
| F5      |            MEDIUM | REGRESSION | Raw bytes are rehashed, but raw outcomes/manifest commit binding are not verified; additionally the workflow omits the newly required `--reports-dir`, so it now fails.               |
| F6      |            MEDIUM | PARTIAL    | Code and report contracts use `migration-upgrade-rerun`, but the Q05 operating guide still requires the obsolete rollback ID.                                                         |
| F7      |            MEDIUM | NOT\_FIXED | Only an unavailable marker and revised test wording were added; the required gate remains permanently incapable of passing.                                                           |
| F8      |            MEDIUM | PARTIAL    | Hashing and publication queries improved, but dumps still become whole-file buffers and table digests still retain and sort every row in memory.                                      |
| F9      | — (report MEDIUM) | PARTIAL    | Images are service-scoped, but volume validation uses substring matching and does not enforce exact targets or read-only mode.                                                        |
| F10     | — (report MEDIUM) | PARTIAL    | Streams are ignored and escalation is scheduled, but timeout rejects before the child closes, allowing it to outlive cleanup.                                                         |
| F11     | — (report MEDIUM) | PARTIAL    | Docker cases moved to an opt-in integration suite, but the invalid-PromQL regression was deleted instead of moved.                                                                    |
| F12     |    — (report LOW) | FIXED\_OK  | The test no longer depends on `Date.now()` or a five-millisecond deadline.                                                                                                            |
| F13     |    — (report LOW) | FIXED\_OK  | Confirmed orphan exports, aliases, barrels, and compatibility-only tests were removed.                                                                                                |
| F14     |    — (report LOW) | N/A        | Explicitly deferred as a large mechanical refactor; the oversized files remain.                                                                                                       |

VERDICT: needs-rework

- F1: Use token-aware parsing that covers all contract tables and valid PostgreSQL variants such as `ONLY`, optional `COLUMN`, schema spacing, and multi-table drops, with bypass regressions.
- F3: Add missing-root and unreadable-root CLI regressions, including assertions for per-root coverage.
- F5: Pass the raw-report directory from the workflow and verify parsed raw outcomes plus manifest candidate/digest bindings against each aggregate.
- F6: Replace the stale `migration-upgrade-rollback` identifier in the Q05 operating guide.
- F7: Implement a successful baseline-application compatibility path or remove `app-rollback` from the required gate set until implementation.
- F8: Pipe backup files directly through `pg_restore` and compute table digests incrementally with a stable cursor without retaining all rows.
- F9: Validate exact volume source, target, and read-only mode for both short and long Compose syntax, with negative tests.
- F10: Wait for child closure after SIGTERM/SIGKILL before rejecting, handle stdin errors, and add a timeout lifecycle regression.
- F11: Restore the invalid-PromQL failure case in the opt-in integration suite.
