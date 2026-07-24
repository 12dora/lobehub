| Finding | Verified Sev | Fix status | Note                                                                                                                                                |
| ------- | ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | MEDIUM       | NOT\_FIXED | Both triggers still trust caller-controlled GUCs; no privilege revocation, trusted deletion routine, or bypass integration test was added.          |
| F2      | MEDIUM       | FIXED\_OK  | User-scoped mutations independently invalidate list, detail, and audit caches via `Promise.allSettled`, emitting one warning on partial failure.    |
| F3      | MEDIUM       | FIXED\_OK  | Cached-data failures now show retryable warnings on all three views, and the detail page blocks ban, delete, role, and session actions while stale. |
| F4      | LOW          | FIXED\_OK  | All `ctx as never` casts were removed; the router now calls the shared typed reauthentication-and-audit helper.                                     |
| F5      | LOW          | FIXED\_OK  | The regression test makes list invalidation fail, verifies detail and audit are still attempted exactly once, and asserts one warning.              |

VERDICT: needs-rework

- **F1:** Add an idempotent follow-up migration that privilege-separates authorized deletion, then integration-test that arbitrary `SET` and session-scoped `set_config(..., false)` cannot bypass either trigger while legitimate cleanup still succeeds.
