# Round-2 Remediation — Accepted Follow-ups

All CRITICAL and HIGH findings, and the runtime-breaking cross-batch regressions, were fixed and cross-model re-verified. The items below were **consciously deferred** — each is either a missing regression test (the core fix is verified working), a performance optimization, a deep edge case gated behind an abnormal precondition, or a larger feature/refactor. None breaks runtime. Tracked here so they aren't lost.

## Deferred — missing regression tests (fix verified FIXED\_OK; test depth pending)

- **audit/F1** — transactional enqueue+audit is in place; add a true two-connection test that blocks the required audit append while another connection attempts `claimNext`.
- **audit/F12** — add disabled-policy export create/execute/download, concurrent-publication, cleanup-retry, and slow-storage two-worker regressions.
- **ai/F1** — add a publish → archive/disable → rejected-hard-delete → runtime-resolution test proving no BYOK fallback.
- **identity/F5** — add success/failure audit regressions with opaque replacement/current secrets.
- **identity/F8** — add a page-2 modal save→test/publish regression using the retained mutation revision.
- **platform-instance/F2, /F8** — add file-credential rotation (expired-stage, rollback, concurrent) and 0145 legacy-replay migration tests.

## Deferred — performance optimizations (correctness fixed; throughput pending)

- **audit/F10** — export upload / checksum / download still buffer the full artifact; move to streaming / multipart I/O (a 256 MiB cap was added as an interim guard).
- **ai/F3** — batch model mutations no longer reload the whole draft per item (quadratic reads removed) but remain sequential per-item DML; convert to bounded bulk DML.
- **platform-instance/F4** — system-health poll no longer loads full catalog payloads; a fully bounded/incremental aggregate catalog token is still worth adding.

## Deferred — deep edge cases (gated behind abnormal preconditions)

- **identity/F10** — LKG can still resurrect a revoked provider on a _total_ database outage in the narrow window immediately after Disable (before any healthy startup). Needs revocation state persisted outside the failable DB read path. (Verified MEDIUM; requires full DB outage at an exact instant.)
- **ai/F4** — the migrated PostgreSQL concurrency test's cleanup uses `DELETE` on now-immutable/append-only tables and can fail at teardown; switch to `TRUNCATE` with guaranteed pool closure. (PG suite only, `TEST_SERVER_DB=1`.)

## Deferred — larger features / refactors

- **contracts/F4** — the secret-rotation _restart_ contract exists, but the restart PATH (coordinator + admin service + router) for `cancelled`/`dead` jobs is not implemented; cancelled/dead rotations remain non-restartable. (MEDIUM feature gap.)
- **Sidebar layout CAS** (contracts/F3 sidebar half) — reverted to its documented **direct-save** design because `platform_sidebar_layout` has no revision column. Two admins racing on the sidebar layout is last-writer-wins (cosmetic). The security-relevant **auth-settings CAS** was fully implemented (migration 0147). Implementing sidebar CAS needs a revision column + model/router/client wiring.
- **users-rbac/F1** — GUC-trust immutability hardening (revoke `DELETE` from the app role + `SECURITY DEFINER` deletion routines) intentionally **not** applied: it can break the app's normal delete paths and is a post-compromise defense-in-depth gap (verified MEDIUM). Needs a careful, separately-tested DB-privilege migration.
- **scripts-tooling/F14** — several tooling files (>800 lines) mix responsibilities; split by concern. (Code smell, not a defect.)

## Note

Production-trust gates in `scripts/enterprise/` (F1/F3/F4/F5) were hardened in this pass; they remain latent until production-trust is enabled — re-verify before turning it on.
