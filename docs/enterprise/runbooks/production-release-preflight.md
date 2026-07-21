# Runbook: Production release preflight and Milestone A–F rollout

**Owner role:** `release-manager` (activation), `platform-sre` (monitoring)  
**Package commands:** `bun run enterprise:preflight`, `bun run enterprise:recovery-drill`

## Prerequisites

1. Release candidate is clean (`dirty=false`) with exact full git SHA and latest migration tag.
2. Evidence directory contains strict JSON for all seven gates (see Q06 overview doc).
3. Default or reviewed release plan defines Milestone A–F windows with stop conditions and allowlisted command ids only.
4. Production Vault rotation/alerting, protected release signing, and real IdP tenants remain **external** — do not mark complete without their own evidence.

## Procedure

| Step | Action                 | Command                                                                                                                                  | Success                                                          | Stop / rollback                                            |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | Emit plan if missing   | `bun run enterprise:preflight emit-default-plan --candidate-sha <sha> --release-id <id> --output <plan.json>`                            | plan schema valid                                                | Fix plan; do not invent windows                            |
| 2    | Preflight evaluate     | `bun run enterprise:preflight production-authorized --candidate <c.json> --plan <plan.json> --evidence-dir <dir> --output <report.json>` | exit 0, `overall=passed`, classification `production-authorized` | exit ≠0 → **stop release**                                 |
| 3    | Activate window N      | `bun run enterprise:preflight dispatch --command-id release-window-activate --execute --confirm-execute`                                 | dry-run argv resolved; execute only after human approval         | `release-window-rollback`                                  |
| 4    | Monitor                | `dispatch --command-id monitor-release-window` for the window's `monitorDurationMinutes`                                                 | metrics under stop thresholds                                    | trip stop condition → rollback command ids for that window |
| 5    | High-risk first enable | Only one of OIDC / connector-shared-credentials / default-inbox / branding-cutover per window via its flag-enable command id             | dedicated window only                                            | matching flag-disable + `release-window-verify-rollback`   |

## Milestone windows (default plan)

| Window      | Order | First-enable high risk       | Monitor (min) | Owner role      |
| ----------- | ----- | ---------------------------- | ------------- | --------------- |
| milestone-a | 1     | none                         | 60            | platform-sre    |
| milestone-b | 2     | none                         | 60            | platform-admin  |
| milestone-c | 3     | connector-shared-credentials | 120           | security-admin  |
| milestone-d | 4     | default-inbox                | 120           | product-ops     |
| milestone-e | 5     | oidc                         | 180           | identity-admin  |
| milestone-f | 6     | branding-cutover             | 240           | release-manager |

## Escalation

If preflight fails or a stop condition trips: freeze further enablement, run the window's `rollbackCommandIds`, then `release-window-verify-rollback`. Escalate to `release-manager` + `security-admin` with redacted report only (`.records/enterprise-production-readiness/`).
