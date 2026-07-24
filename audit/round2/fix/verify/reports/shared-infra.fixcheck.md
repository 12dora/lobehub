| Finding | Verified Sev | Fix status | Note                                                                                                                                                                                           |
| ------- | ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | MEDIUM       | PARTIAL    | Epoch guard correctly preserves edits during post-publish refresh, but the added test only exercises the standalone predicate and would pass if the production publish wiring regressed.       |
| F2      | MEDIUM       | FIXED\_OK  | Monotonic generations prevent stale responses after refresh, disable, or unmount; the test exercises the real provider with out-of-order responses.                                            |
| F3      | MEDIUM       | FIXED\_OK  | All three fallback/create paths now accept only mapped `PLATFORM_NOT_FOUND`; other errors rethrow. Tests cover the discriminator and prohibited create path.                                   |
| F4      | MEDIUM       | FIXED\_OK  | `onOpenChange(false)` resets the blocker for close/Escape, mask dismissal is disabled, and once-only resolution prevents a close after proceed from cancelling.                                |
| F5      | MEDIUM       | PARTIAL    | Vault membership now validates the referenced key, but loading and query failure remain collapsed into `isConfigured`; no stale/deleted-reference or credential-list failure tests were added. |
| F6      | MEDIUM       | FIXED\_OK  | Click and keyboard activation now ignore prevented events and nested interactive descendants; the production component is regression-tested with a nested button.                              |
| F7      | LOW          | FIXED\_OK  | The test now imports the exact helper used by the production mutation path and verifies commit success, refresh failure, and mutation failure.                                                 |
| F8      | LOW          | FIXED\_OK  | Both enterprise callback pages select explicit en-US/zh-CN copy from `Accept-Language` while retaining HTML escaping and CSP protections.                                                      |
| F9      | LOW          | FIXED\_OK  | All obsolete commented timeout exports were removed.                                                                                                                                           |

VERDICT: needs-rework

- F1 — Add a component-level publish race test that edits while the post-publish `mutate()` is pending and asserts the newer draft remains after refresh resolves.
- F5 — Expose credential loading and query-error states separately, prevent readiness from being inferred before validation settles, and add tests for deleted credentials, stale references, and list failures.
