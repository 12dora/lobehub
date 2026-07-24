| Finding | Verified Sev | Fix status | Note                                                                                                                                                                                   |
| ------- | -----------: | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      |         HIGH | PARTIAL    | Legacy values are backfilled, but migration is piecemeal from caller-provided slices, lacks a migrated marker, and legacy stripping occurs outside the insert/revision transaction.    |
| F2      |         HIGH | FIXED\_OK  | Cache keys now include a stable legacy-input checksum; changed-input and absolute-TTL tests cover the corrected semantics.                                                             |
| F3      |       MEDIUM | PARTIAL    | Conflict and committed-refresh states exist, but retry refresh can reject unhandled, and tests cover save conflict rather than publish conflict or post-commit refresh failure.        |
| F4      |       MEDIUM | FIXED\_OK  | Dirty drafts survive server-data changes, enter a stale state, and require explicit discard; focused decision tests cover the behavior.                                                |
| F5      |       MEDIUM | PARTIAL    | Desktop and theme controls are reachable, but `branding.fields.theme` is missing from locales and falls back to hardcoded English; no interaction test covers the new controls/upload. |
| F6      |       MEDIUM | PARTIAL    | Canonical action names and bounded categories were added, but availability failures remain classified as `internal`, and audit tests do not assert `afterDiff.error`.                  |
| F7      |          LOW | FIXED\_OK  | The stale-cache expectation was removed; changed input is immediate and TTL is tested independently with identical input.                                                              |
| F8      |          LOW | FIXED\_OK  | Retry now uses a transient error, while CAS conflict separately asserts locked conflict state.                                                                                         |
| F9      |          LOW | FIXED\_OK  | Sweep is inside the compensated boundary, with a regression test proving reservation orphaning and no upload.                                                                          |
| F10     |          LOW | N/A        | Explicitly deferred size-only refactor per the fix-pass instructions.                                                                                                                  |

VERDICT: needs-rework

- **F1** — Load and migrate the complete durable legacy row before cache admission, atomically insert validated overrides, bump revision, strip/mark migration completion, and test the durable second read plus failure/concurrency boundaries.
- **F3** — Handle retry-refresh rejection while preserving the committed-refresh lock/error, and add publish-CAS and committed-refresh-failure/retry interaction tests.
- **F5** — Add `branding.fields.theme` to default, en-US, and zh-CN locales and add interaction coverage for product name, primary color, and desktop-icon upload.
- **F6** — Add a bounded availability category and assert canonical actions plus exact secret-safe `afterDiff.error` values in branding and settings audit tests.
