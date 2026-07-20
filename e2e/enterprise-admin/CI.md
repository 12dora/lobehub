# Enterprise Admin E2E — CI boundaries

This suite is **opt-in** and lives entirely under `e2e/enterprise-admin/`.

## Explicit non-wiring (this batch)

- Does **not** modify `.github/workflows/*`
- Does **not** add root `package.json` scripts
- Does **not** change the default Cucumber `e2e` CI job (`bun run e2e`)
- Artifacts stay under gitignored paths (`.records/`, `e2e/enterprise-admin/reports/`)

## How to run in CI later (follow-up PR)

Suggested independent job (draft only — not applied here):

```yaml
enterprise-admin-e2e:
  runs-on: ubuntu-latest
  timeout-minutes: 45
  steps:
    - uses: actions/checkout@v4
    -  # install deps, docker, playwright chromium
    - run: cd e2e && bun run test:enterprise-admin
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: enterprise-admin-e2e
        path: |
          e2e/enterprise-admin/reports
          .records/enterprise-admin-e2e
```

## Local vs CI flags

| Env                                 | Meaning                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `E2E_ENTERPRISE_ADMIN_EXTERNAL=1`   | Reuse existing `BASE_URL` + `DATABASE_URL` (no Docker/app bootstrap)          |
| `E2E_ENTERPRISE_ADMIN_SKIP_BUILD=1` | Skip production build when using `next start` path and `.next` already exists |
| `E2E_ENTERPRISE_ADMIN_MODE=dev`     | Prefer full-stack `bun run dev` (default for local)                           |
| `E2E_ENTERPRISE_ADMIN_MODE=start`   | Production `next start` after build (closer to release)                       |
| `CI=true`                           | Stricter timeouts; never reuse stray local ports/containers                   |

## Secrets / PII policy

- Test passwords are suite-local constants, not production secrets
- Evidence screenshots must not capture email fields or session tokens
- TRPC error bodies asserted by code name only; never log cookies
