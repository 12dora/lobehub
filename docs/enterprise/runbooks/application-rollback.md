# Runbook: Application rollback (expand-only DB compatibility)

**Owner role:** `platform-sre`\
**Package command:** `bun run enterprise:recovery-drill app-rollback`

## Principles

- Roll the **application** back to the declared compatibility baseline (`4bab1636408e60a7ee17b640490fbf33a310a325` / LobeHub 2.2.10 design baseline unless a reviewed replacement is recorded).
- **Retain** all newly added enterprise tables in the same window. **Never** `DROP TABLE` / destructive down migrations during this window.
- Migration journal-only checks or current-app queries are **not** substitutes for a real baseline probe. If the baseline probe is unavailable → `unverified`, never `passed`.

## Prerequisites

1. Upgraded database snapshot identity known (digest only in evidence).
2. Candidate SHA and baseline SHA differ.
3. Preflight report for the candidate available (may be unverified overall).

## Procedure

| Step | Action                             | Command                                                                                                                                | Success                                                                                    | Stop                                    |
| ---- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| 1    | Run rollback drill (local harness) | `bun run enterprise:recovery-drill app-rollback --candidate-sha <sha> --scope local-harness --output <evidence.json>`                  | structured evidence written; destructive SQL rejected                                      | tool failure → do not claim pass        |
| 2    | Production-authorized drill        | same with `--scope production-authorized` and real baseline probe marker under `.records/enterprise-app-rollback/baseline-probe.ready` | `status=passed`, `baselineExecutable=true`, `newTablesRetained=true`, `rollForwardOk=true` | any mismatch → abort cutover            |
| 3    | Deploy previous app version        | environment-specific (not invented here)                                                                                               | startup read contract healthy                                                              | re-deploy candidate; do not drop tables |
| 4    | Verify retain + roll-forward       | re-run step 2 after app rollback                                                                                                       | tables present; candidate can start again later                                            | escalate                                |

## Rollback verification

- `destructiveCommandsRejected=true`
- Enterprise tables still present (`platform_*` retention set)
- Legacy required reads succeed
- Evidence redaction scan clean

## Escalation

`platform-sre` → `release-manager`. Retain redacted evidence only; never attach dumps, connection strings, or raw rows.
