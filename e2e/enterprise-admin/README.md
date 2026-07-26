# Enterprise Admin E2E (M15 PR-Q04)

Executable end-to-end foundation for the platform Admin Shell and critical
access / fail-closed paths. Real isolated PostgreSQL + Redis, real app process,
official better-auth credential login, randomized user namespace, exact cleanup.

## Layout

```text
e2e/enterprise-admin/
├── playwright.config.ts   # suite-local config used by enterprise-admin-gates.yml
├── tsconfig.json
├── README.md
├── CI.md                  # authoritative CI schedule, labels, and gate contract
├── scripts/
│   └── preflight.ts       # hard-fail missing Docker / browser / env
├── support/
│   ├── infrastructure.ts  # postgres, redis, migrate, app process, teardown
│   ├── seed.ts            # random-namespace users + platform / workspace roles
│   ├── auth.ts            # official /api/auth/sign-in/email
│   ├── trpc.ts            # batch GET/POST against /trpc/lambda
│   ├── evidence.ts        # light/dark + desktop/mobile screenshots (no PII)
│   └── selectors.ts       # stable role/text waits (no brittle DOM dumps)
└── specs/
    └── critical-paths.spec.ts
```

## Prerequisites

- Docker Desktop (ParadeDB + Redis containers)
- Playwright Chromium (`cd e2e && bunx playwright install chromium`)
- Workspace dependencies installed at the monorepo root

Missing browser / auth / env **fails the suite** (never soft-passes).

## Run

From the monorepo root (preferred):

```bash
# Install browsers once
cd e2e && bunx playwright install chromium && cd ..

# Full isolated suite (starts DB + app, tears them down)
cd e2e && bun run test:enterprise-admin
```

Or with an already-running app (you own lifecycle):

```bash
export BASE_URL=http://localhost:3010
export DATABASE_URL=postgresql://...
export ENABLE_PLATFORM_ADMIN=1
export ENABLE_PLATFORM_MANAGED_SKILLS=1
# …other enterprise flags as needed
cd e2e && bun run test:enterprise-admin:external
```

## Artifacts

- Screenshots / JSON results: `.records/enterprise-admin-e2e/` (gitignored via `.records/`)
- Playwright output: `e2e/enterprise-admin/reports/` (gitignored)
- Never commit cookies, session tokens, or user emails from a run

## First suite coverage

| Case                            | Assertion                                                           |
| ------------------------------- | ------------------------------------------------------------------- |
| Ordinary user + workspace owner | Denied `/admin` UI and `admin.*` APIs                               |
| Super admin                     | Admin Shell + System page, safe status projection (no secrets)      |
| Auditor                         | Shell read-only: dangerous job actions absent; operate APIs denied  |
| Skill catalog managed/outage    | Legacy skill mutation fails closed (`RESOURCE_MANAGED_BY_PLATFORM`) |
| Confirmation                    | Managed Resources reason + cancel path (no accidental publish)      |
| Evidence matrix                 | light/dark × desktop/mobile screenshots with stable waits           |

## Non-goals (later waves)

User admin CRUD journeys, OIDC, Branding screenshots, Agent Inbox, and full
permission matrix expansion. See `CI.md` for the active dedicated workflow.
