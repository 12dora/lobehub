| Finding | Verified Sev | Fix status | Note                                                                                                                                                                                |
| ------- | -----------: | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      |     CRITICAL | PARTIAL    | Publication is transactional, but no concurrent blocked-audit test proves jobs remain unclaimable.                                                                                  |
| F2      |         HIGH | FIXED\_OK  | Timeline now requires conversation permission and enforces the disabled-content policy.                                                                                             |
| F3      |         HIGH | REGRESSION | All three policy gates exist, but worker failure records include `message`, violating the new strict code-only output schema; disabled-policy regressions are also absent.          |
| F4      |         HIGH | FIXED\_OK  | `rankTopics` now requires both permissions, with positive and negative authorization tests.                                                                                         |
| F5      |       MEDIUM | REGRESSION | State/audit transitions are transactional, but export cancellation returns a stale internal purge payload that fails output validation after cancellation commits.                  |
| F6      |         HIGH | REGRESSION | Terminal paths add outboxes, but worker outbox persistence errors are swallowed, post-upload crash coverage remains incomplete, and internal purge fields break public projections. |
| F7      |       MEDIUM | PARTIAL    | Per-object renewal narrows the race, but the cursor advances first; one slow deletion can still outlive the lease and lose accounting. No two-worker regression exists.             |
| F8      |       MEDIUM | FIXED\_OK  | Page-budget exhaustion now fails explicitly, with a 200-page boundary regression.                                                                                                   |
| F9      |       MEDIUM | PARTIAL    | Error states and pagination catches were added, but retry mutations remain unhandled and one successful poll can advance the shared timestamp while another fails.                  |
| F10     |       MEDIUM | PARTIAL    | A 256 MiB cap was added, but upload, post-upload verification, and download verification still fully buffer artifacts.                                                              |
| F11     |       MEDIUM | FIXED\_OK  | Batch-specific scope queries plus class summaries replace full active-hold inventory loads.                                                                                         |
| F12     |       MEDIUM | PARTIAL    | Timeline and `rankTopics` authorization tests were added; disabled exports, concurrent publication, cleanup retry, and slow-delete lease tests remain missing.                      |

VERDICT: needs-rework

- **F1:** Add a concurrent regression that blocks the required audit append inside the transaction and proves `claimNext` cannot observe the job.
- **F3:** Project stored errors to the strict code-only DTO and add creation, execution, and download tests for disabled conversation access.
- **F5:** Reload or sanitize the export after purge cleanup so cancellation returns a valid success response while preserving transactional audit coupling.
- **F6:** Persist a required cleanup intent before an uploaded object can become orphaned, never swallow its persistence failure, and verify retry after one failed deletion.
- **F7:** Atomically attribute deletion when completing the outbox—or maintain the lease through deletion—and add the slow-storage two-worker regression.
- **F9:** Await and catch every retry mutation, and advance the shared refresh timestamp only when all active feed requests succeed.
- **F10:** Replace full-buffer upload and checksum reads with bounded streaming, including historical-object download verification.
- **F12:** Add the four remaining boundary regressions explicitly required by the finding.
