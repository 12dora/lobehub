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
| A machine-readable report with artifact-bound integrity digest                      | A self-asserted boolean or planted fixture pass                                    |

Reports always set:

- `evidenceClass: "repository-automation"`
- `externalPenetrationTest.status: "not-executed"`

Do **not** reclassify those fields after the fact. External production pen-testing remains residual work with its own signed engagement record outside this repository.

## Prerequisites

1. Clean checkout of the candidate revision (full git SHA).
2. `pnpm` + `bun` available locally or in CI (no production credentials).
3. Reviewed `leakage-baseline.json` present (exact path+category+lineDigest fingerprints).
4. For dependency scan: a `pnpm-lock.yaml` (repo `.npmrc` uses `lockfile=false`; generate locally with `pnpm install --lockfile-only --config.lockfile=true` — gitignored).
5. Network access only for `pnpm audit` registry queries. Offline/unavailable network must surface as `unavailable`, never `passed`.

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

# Verify report schema + artifact-bound core digest + recomputed semantics
bun run enterprise:security-acceptance verify \
  --report .records/enterprise-security-acceptance/local/security-acceptance.report.json

# Regenerate leakage baseline after reviewed synthetic findings change
bun run enterprise:security-acceptance generate-leakage-baseline
# Then: human review of scripts/enterprise/security-acceptance/leakage-baseline.json
```

Exit codes:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | `overall=passed` (all required checks passed under policy)            |
| 1    | `overall=failed` (policy hit, leakage, missing/failed pen adapter, …) |
| 2    | `overall=unavailable` or CLI/tool failure before a trustworthy result |

## Evidence semantics

### Required checks

1. **dependency-scan** — `pnpm audit --prod --json --audit-level high`. Policy fails on **high** or **critical**. Exit matrix: `0`+zero hits → pass; `1`+hits → fail; unexpected nonzero (e.g. `99`) or `1` with zero hits → **unavailable**. Tool id/version, target path, digests, severity counts bound into integrity core.
2. **leakage-scan** — Scans required enterprise roots. Missing roots, symlinks (file/dir), oversized skips, unreadable/walk errors → unavailable/failed (never silent pass). Findings are path/category/line/`lineDigest` only. Known findings matched by **exact** baseline fingerprint; fixture lines may use exact allowlist digests (not path wildcards).
3. **pen-regression** — Exact required adapter set from `penManifest.ts`. S06 rate-limit adapters require both:
   - `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.test.ts`
   - `apps/server/src/enterprise/guards/adminMutationRateLimit.test.ts`
     Missing targets fail closed. SSRF package suite allows only the reviewed GC skip title when `gc` is unavailable.

### Integrity

- Report **core** includes full artifacts + derived checks/overall (no wall-clock).
- `integrity.reportCoreSha256` digests that core.
- `verify` **recomputes** cross-field semantics and overall from artifacts; author-controlled summaries alone never pass.
- Tampering severity counts, planted overall, fake adapters, or mismatched digests fail verify.

### Leakage baseline policy

| Action                             | Rule                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| Accept known finding               | Exact `path` + `category` + `lineDigest` in `leakage-baseline.json` |
| New or changed line content        | Fails until reviewed baseline update                                |
| Path wildcard / whole-file allow   | **Forbidden**                                                       |
| Raw secret text in baseline/report | **Forbidden**                                                       |
| Regenerate                         | `generate-leakage-baseline` then human review of the diff           |

## Residual external human penetration testing

Still required outside this harness for production certification. Record engagements in the operator security program — **not** by flipping fields on this report.

## Remediation and waiver policy

| Finding class                       | Remediation                                                               | Waiver                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| High/critical dependency advisory   | Upgrade/replace dependency; re-run `dependency-scan`                      | Exception only with security-admin written risk acceptance **outside** this report |
| New leakage finding                 | Remove secret / rotate if real / baseline only after review for synthetic | Never waive real credentials by baseline                                           |
| Missing pen target / failed adapter | Land S06 tests or fix regressions                                         | Not waivable via report edit                                                       |
| Scanner/network `unavailable`       | Restore tool/lockfile/network; re-run                                     | Cannot treat as pass                                                               |

## No production credentials rule

- CI and local harness runs use **no** production Vault, IdP, DB, or cloud credentials.
- Artifacts under `.records/enterprise-security-acceptance/` must stay free of connection strings, tokens, private keys, and registry basic-auth URLs.
- Workflow permissions are `contents: read` only; third-party actions are **full SHA pinned**.

## Escalation

If CI security acceptance fails: open a security-admin review with the uploaded artifact (redacted report only). Do not bypass the workflow with `--no-verify` or planted evidence.
