# Round 5 remediation ledger

Target: every finding kept by `TRIAGE.md` (113 total). Dropped/refuted findings are reviewed by
independent verifiers and require no code change unless their triage rationale is disproved.

Finalization requirement: after every bundle passes independent verification, run a consolidated
repository check and write `audit/round5/HANDOFF.md` with finding dispositions, changed subsystems,
validation evidence, generated migration notes, residual risks, and clean continuation steps.

## Implementation wave

| Bundle | Domains                                                          | Implementer                       | Status                         | Verifier                            | Verification                                                                              |
| ------ | ---------------------------------------------------------------- | --------------------------------- | ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| A      | ops-tests-docs, pkg-shared, srv-fork-seams                       | `/root/impl_a_ops_shared`         | rework interrupted for handoff | `/root/verify_a_ops_shared`         | failed pass 1: migration catalog parity, unwired intervention outcome, UTC regression gap |
| B      | srv-audit, srv-security-guards                                   | `/root/impl_b_audit_security`     | rework pass 2 completed        | `/root/verify_b_audit_security`     | PASS (pass 3, real-PG CI evidence enforced)                                               |
| C      | srv-identity, srv-routers-contracts, srv-platform-core           | `/root/impl_c_identity_platform`  | rework completed               | `/root/verify_c_identity_platform`  | PASS (pass 2, 138 tests)                                                                  |
| D      | srv-connector, srv-agent-skill-catalog, srv-ai-settings-branding | `/root/impl_d_connector_catalog`  | rework interrupted for handoff | `/root/verify_d_connector_catalog`  | failed pass 2: three real presentation consumers unwired                                  |
| E1     | adm-agents-skills, fe-user-surface                               | `/root/impl_e_admin_frontend`     | rework pass 5 completed        | `/root/verify_e1_pass4`             | failed pass 6: reset refresh-failure queue and UI error feedback                          |
| E2     | adm-audit, adm-users-identity                                    | `/root/impl_e2_admin_audit_users` | completed                      | `/root/verify_e2_admin_audit_users` | verification interrupted for handoff                                                      |
| E3     | adm-connectors-shell, locale normalization                       | not started                       | not started                    | pending                             | pending                                                                                   |
| E4     | adm-settings-system, adm-ai                                      | not started                       | not started                    | pending                             | pending                                                                                   |

## Verification contract

Each implementer must:

1. Read the assigned reports and `TRIAGE.md`.
2. Address every kept finding, combining fixes where they share a root cause.
3. Add or correct focused behavior tests after source fixes.
4. Run `bun run check` once against the complete changed-file set for the bundle.
5. Report finding-by-finding disposition and changed files.

Each independent verifier must:

1. Re-read the original audit evidence and applicable verification reports.
2. Adversarially inspect the implementation with high reasoning effort.
3. Run focused tests/checks and identify omissions or regressions.
4. Confirm dropped/refuted findings need no code change.
5. Return PASS only when every assigned kept finding is fixed or convincingly shown inapplicable.
