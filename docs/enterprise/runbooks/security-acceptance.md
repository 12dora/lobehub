# Runbook: Enterprise security acceptance (M13 PR-S05)

**Owner role:** `security-admin` (policy), `platform-sre` (CI evidence)\
**Package command:** `bun run enterprise:security-acceptance`\
**Harness:** `scripts/enterprise/security-acceptance/**`\
**Workflow:** `.github/workflows/enterprise-security-acceptance.yml`

## What this is (and is not)

| This harness **is**                                                                 | This harness **is not**                                                            |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Repository-owned, deterministic, fail-closed **automation**                         | A completed external / human **production penetration test**                       |
| Evidence for dependency advisories, leakage regression, and adversarial unit suites | Authorization to mark production “security accepted” without residual human review |
| A machine-readable report with integrity digest + explicit evidence class           | A self-asserted boolean or planted fixture pass                                    |

Reports always set:

- `evidenceClass: "repository-automation"`
- `externalPenetrationTest.status: "not-executed"`

Do **not** reclassify those fields after the fact. External production pen-testing remains residual work with its own signed engagement record outside this repository.

## Prerequisites

1. Clean checkout of the candidate revision (full git SHA).
2. `pnpm` + `bun` available locally or in CI (no production credentials).
3. For dependency scan: a `pnpm-lock.yaml` (repo `.npmrc` uses `lockfile=false`; generate locally with `pnpm install --lockfile-only --config.lockfile=true` — gitignored, never commit secrets).
4. Network access only for `pnpm audit` registry queries. Offline/unavailable network must surface as `unavailable`, never `passed`.

## Local use

```bash
# Contract / falsifying unit tests (no production services)
bunx vitest run --config vitest.config.mts --silent='passed-only' \
  scripts/enterprise/security-acceptance/security-acceptance.test.ts

# Full fail-closed run (writes under .records/; gitignored)
mkdir -p .records/enterprise-security-acceptance/local
bun run enterprise:security-acceptance run \
  --output-dir .records/enterprise-security-acceptance/local \
  --git-sha "$(git rev-parse HEAD)"

# Re-evaluate pre-collected check artifacts
bun run enterprise:security-acceptance evaluate \
  --checks-dir .records/enterprise-security-acceptance/local/checks \
  --output-dir .records/enterprise-security-acceptance/local-eval \
  --git-sha "$(git rev-parse HEAD)"

# Verify report schema + core digest
bun run enterprise:security-acceptance verify \
  --report .records/enterprise-security-acceptance/local/security-acceptance.report.json
```

Exit codes:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | `overall=passed` (all required checks passed under policy)            |
| 1    | `overall=failed` (policy hit, leakage, missing/failed pen adapter, …) |
| 2    | `overall=unavailable` or CLI/tool failure before a trustworthy result |

## Evidence semantics

### Required checks

1. **dependency-scan** — `pnpm audit --prod --json --audit-level high` against the lockfile/production graph. Policy fails on **high** or **critical** counts. Evidence retains tool id/version, target path, lockfile/package.json digests, and severity counts. No registry credentials or advisory prose blobs.
2. **leakage-scan** — Scans enterprise source/tests/config/report surfaces for secret-shaped material via the unified enterprise detector. Findings report **path / category / line / lineDigest only** — never matched secret text. Narrow reviewed fixture allowlist in `leakageAllowlist.ts`.
3. **pen-regression** — Invokes real vitest targets from `penManifest.ts` (SSRF, auth/RBAC/IDOR, reauth, replay/CAS, admin rate-limit). Records actual exit codes and assertion summaries. **Does not** rename unit tests as an external penetration test.

### Admin rate-limit adapter (S06)

`admin-rate-limit` is a **required** manifest entry pointing at:

`apps/server/src/enterprise/security/rateLimit/adminMutationRateLimit.test.ts`

Until S06 lands that file, the adapter status is `not-executed` / reason `missing-test-target`, and pen-regression (and overall) **fail closed**. Integration is a path land — no harness redesign required.

### Integrity

- Report **core** (no wall-clock) is digested as `integrity.reportCoreSha256`.
- `generatedAt` is envelope metadata only.
- Tampered overall/check disagreement or digest mismatch fails `verify`.
- Redaction scan must pass; forbidden keys/values reject the report.

## Residual external human penetration testing

Still required outside this harness for production certification:

- Scoped engagement against a production-like deployment with real IdP/Vault/network posture
- Business-logic abuse beyond unit-level adversarial suites
- Social / physical / multi-tenant isolation reviews as applicable

Record those engagements in the operator security program — **not** by flipping fields on this report.

## Remediation and waiver policy

| Finding class                       | Remediation                                                                                    | Waiver                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| High/critical dependency advisory   | Upgrade/replace dependency; re-run `dependency-scan`                                           | Exception only with security-admin written risk acceptance **outside** this report (do not plant pass) |
| Leakage finding (non-allowlisted)   | Remove secret, rotate if real, or add **reviewed** allowlist entry for synthetic fixtures only | Never waive real credentials by allowlisting production paths                                          |
| Missing pen target / failed adapter | Land tests (S06 rate-limit) or fix regressions                                                 | Not waivable via report edit                                                                           |
| Scanner/network `unavailable`       | Restore tool/lockfile/network; re-run                                                          | Cannot treat as pass                                                                                   |

Waivers must never be implemented by:

- Editing `overall` to `passed` while checks failed
- Dropping required adapters from the manifest without replacement
- Embedding secrets in artifacts
- Claiming `externalPenetrationTest.status` other than `not-executed` from this harness

## No production credentials rule

- CI and local harness runs use **no** production Vault, IdP, DB, or cloud credentials.
- Artifacts under `.records/enterprise-security-acceptance/` must stay free of connection strings, tokens, private keys, and registry basic-auth URLs.
- Workflow permissions are `contents: read` only; the job does not push, tag, or mutate protected branches.

## Escalation

If CI security acceptance fails: open a security-admin review with the uploaded artifact (redacted report only). Do not bypass the workflow with `--no-verify` or planted evidence.
