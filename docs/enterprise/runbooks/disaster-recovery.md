# Runbook: Disaster recovery (backup selection → isolated restore → decision)

**Owner role:** `platform-sre` (+ `security-admin` for secret-reference review)  
**Package commands:** `bun run enterprise:recovery-drill`

## Prerequisites

1. Explicit production backup ownership and restore-target isolation acknowledgement.
2. Source and target database identities are **different** (tool refuses same identity).
3. **Never** restore over the live source. Source must remain preserved.

## Procedure

| Step | Action | Command | Success | Stop |
| ---- | ------ | ------- | ------- | ---- |
| 1 | Select backup | `bun run enterprise:recovery-drill select-backup --scope production-authorized` | operator provides authorized backup evidence (tool exits not-executed until provided) | missing authorization → stop |
| 2 | Isolated restore drill | `bun run enterprise:recovery-drill backup-restore --candidate-sha <sha> --schema-tag <tag> --scope production-authorized --production-ack --output <evidence.json>` | `status=passed`, invariants all passed, `sourcePreserved=true` | any invariant fail → fail closed |
| 3 | Verify invariants | covered by step 2 evidence (`resource-revisions`, `audit-logs`, `secret-references`, tables, publication pointers) | assertion totals > 0, zero skipped/failed | drift/dangling refs → stop traffic decision |
| 4 | Traffic decision | human gate after evidence | only after production-authorized pass | keep traffic on healthy region |
| 5 | Credential / secret-ref validation | evidence digests only | reference cardinalities + fingerprint digests match | ciphertext/history swap → security-admin |
| 6 | Roll-forward or app rollback | `app-rollback` drill + release runbook | chosen path evidence recorded | escalate |

## Success criteria

- Source backup digest bound in evidence
- Candidate SHA + schema tag bound
- Scope correctly labeled (`local-harness` vs `production-authorized`)
- Cleanup of owned temp resources `passed`
- No secrets in artifacts

## Evidence retention

Store only under `.records/enterprise-production-readiness/` (or operator-controlled vault for production artifacts). Upload redacted JSON + sha256 only. Never upload raw `pg_dump` files to CI.

## Explicit external / unexecuted

- Production Vault credential rotation and alerting
- Real protected release environment, signing, private assets, S3
- Real Authentik / DingTalk tenant recovery paths
- Live production credentials

## Escalation

`platform-sre` → `security-admin` → `release-manager`. Fail closed; do not improvise shell against production.
