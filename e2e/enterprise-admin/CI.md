# Enterprise Admin E2E — CI boundaries

This suite lives under `e2e/enterprise-admin/` and is wired by
`.github/workflows/enterprise-admin-gates.yml` (SCE-04).

## CI layers

| Layer                        | When                                                                           | Command                                         |
| ---------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Unit (support + scripts)     | Every PR/push touching suite or enterprise paths                               | `cd e2e && bun run test:enterprise-admin:unit`  |
| Playwright critical paths    | Schedule, `workflow_dispatch`, canary push, or PR label `enterprise-admin-e2e` | `cd e2e && bun run test:enterprise-admin`       |
| Identity-provider unit       | Same unit job                                                                  | `cd e2e && bun run test:identity-provider:unit` |
| Identity-provider Playwright | Schedule, `workflow_dispatch`, or PR label `identity-provider-e2e`             | `cd e2e && bun run test:identity-provider`      |

The Playwright enterprise-admin lane requires **zero skipped / flaky** results among
the six critical-path cases. Identity-provider real-tenant discovery remains a
separately gated external lane when credentials are present.

## Local vs CI flags

| Env                                    | Meaning                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `E2E_ENTERPRISE_ADMIN_EXTERNAL=1`      | External app mode (requires disposable-db gate)                                          |
| `E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB=1` | Explicit disposable-DB consent — required with external mode; refuses shared DB mutation |
| `E2E_ENTERPRISE_ADMIN_SKIP_BUILD=1`    | Skip production build when using `next start` path and `.next` already exists            |
| `E2E_ENTERPRISE_ADMIN_MODE=dev`        | Prefer full-stack `bun run dev` (default for local)                                      |
| `E2E_ENTERPRISE_ADMIN_MODE=start`      | Production `next start` after build (closer to release)                                  |
| `CI=true`                              | Stricter timeouts; never reuse stray local ports/containers                              |

`BASE_URL` alone never selects external mode.

## Secrets / PII policy

- Test passwords are suite-local constants, not production secrets
- Evidence screenshots must not capture email fields or session tokens
- TRPC error bodies asserted by code name only; never log cookies
- Artifacts stay under gitignored paths (`.records/`, `e2e/enterprise-admin/reports/`)
