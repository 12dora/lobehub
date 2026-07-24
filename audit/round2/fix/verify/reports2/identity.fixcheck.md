| Finding | Verified Sev | Fix status | Note                                                                                                                                                                                                 |
| ------- | -----------: | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      |     CRITICAL | REGRESSION | Runtime tombstone convergence is fixed, but `loadPublishedIdentityTarget` now infers a non-null identity while `domainTargets.test.ts` still supplies nullable loaders, leaving TypeScript errors.   |
| F2      |         HIGH | FIXED\_OK  | Reconciliation now propagates failures through `session.create.before`; returning `false` aborts session persistence, with allow/deny hook regressions.                                              |
| F3      |       MEDIUM | FIXED\_OK  | Validated tombstones survive live-provider materialization failure and remove revoked providers from pre-tombstone LKG fallback.                                                                     |
| F4      |         HIGH | PARTIAL    | Published drafts can be disabled, but history lookup failure is incorrectly recorded as `false`, hiding Disable and offering backend-rejected Delete; no requested page regression exists.           |
| F5      |       MEDIUM | PARTIAL    | Mutation reasons are sanitized against replacement/current secrets and fail closed when the current secret is unreadable, but success/failure audit regressions with opaque secrets are absent.      |
| F6      |       MEDIUM | REGRESSION | CAS, client revision retention, conflict handling, and two-writer coverage exist, but `authSettings.ts` passes `Record<string, unknown>` as enterprise error details and currently fails TypeScript. |
| F7      |       MEDIUM | FIXED\_OK  | Shared validation, model validation, and the database constraint all reject enabled empty allowlists; migration normalizes legacy invalid rows.                                                      |
| F8      |       MEDIUM | PARTIAL    | Mutation responses now retain the canonical revision for providers outside page 1, but no modal-level save→test/publish regression verifies it.                                                      |
| F9      |       MEDIUM | PARTIAL    | The hard cap prevents unbounded growth, but expiry remains activity-triggered and the exported terminal-failure discard has no production caller.                                                    |
| F10     |       MEDIUM | NOT\_FIXED | The new test covers a readable database with a broken co-provider, not a total database outage immediately after disable; stale LKG can still resurrect the provider.                                |
| F11     |       MEDIUM | FIXED\_OK  | Secret CAS coverage was merged into the mandatory multi-connection suite, its expected count was updated, and verification now receives the raw reports directory.                                   |
| F12     |          LOW | FIXED\_OK  | All eight keys exist in the default, en-US, and zh-CN catalogs; redundant inline fallbacks do not prevent localization.                                                                              |
| F13     |          LOW | FIXED\_OK  | The comment now accurately describes login-time enforcement and the deferred editor surface.                                                                                                         |

VERDICT: needs-rework

- **F1:** Update nullable identity-target consumers/tests to use the real empty-set digest and restore a type-clean target-loader contract.
- **F4:** Use a tri-state or server-projected published-history flag, never treat lookup failure as “never published,” and add the publish→edit/clear→revoke page regression.
- **F5:** Add success- and failure-audit regressions proving opaque replacement/current secrets and unreadable-secret cases never persist secret material.
- **F6:** Pass correctly typed conflict details—such as `error.details` directly—to `throwEnterpriseError` and restore type-checking.
- **F8:** Add a modal-level page-2 regression asserting the mutation response revision is used by the immediately following test or publish.
- **F9:** Actively expire untouched entries and invoke discard from every terminal login-abort path, with tests that do not trigger cleanup through the inspection helper.
- **F10:** Persist revocation state outside the unavailable database read path and test a genuine database outage immediately after disable without a healthy intervening startup.
