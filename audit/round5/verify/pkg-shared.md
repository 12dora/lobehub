# Verification — pkg-shared

## Verdicts

| Finding ID        | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                 |
| ----------------- | ----------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| pkg-shared-D5-001 | CRITICAL          | DOWNGRADED | HIGH               | The flag-off OIDC revocation regression is real, but requires an already-issued valid token and affects tRPC rather than every API surface.     |
| pkg-shared-D1-001 | HIGH              | DOWNGRADED | MEDIUM             | SQL result cardinality is uncapped, but the path is privileged, restricted to one month, and pre-aggregates rather than returning raw messages. |
| pkg-shared-D2-001 | HIGH              | DOWNGRADED | MEDIUM             | The exact flag-off OIDC regression lacks coverage, but missing coverage is not independently a production-impacting HIGH defect.                |

## Details

### pkg-shared-D5-001 — DOWNGRADED

- **What the original claimed:** Default-off enterprise flags suppress the pre-existing OIDC subject existence/ban check, allowing banned, deleted, or invalidated users to keep using unexpired JWTs.

- **What I actually found:** `isPlatformAdminSecurityOn` returns false when both environment flags are unset or false-like, and the OIDC path calls `assertUserActive` only when that result is true (`packages/trpc/src/lambda/context.ts:27-30`, `packages/trpc/src/lambda/context.ts:289-296`). Unset flags are false by definition (`packages/const/src/platform/featureFlags.ts:49-55`), and the canonical enterprise defaults are off (`packages/const/src/platform/featureFlags.ts:37-46`).

  Baseline `4bab163…` unconditionally called `assertOIDCUserActive` after JWT verification (`4bab163…:packages/trpc/src/lambda/context.ts:189-200`). The current helper still rejects missing or effectively banned users and invalidated credentials (`src/libs/oidc-provider/access-control.ts:116-170`), so gating the whole call removes the baseline existence/ban invariant.

- **Refutation attempts:**

  - `validateOIDCJWT` verifies the signature and token claims but performs no user-table lookup (`src/libs/oidc-provider/jwt.ts:103-146`).
  - Generic tRPC authentication does not compensate: `oidcAuth` copies the token subject into context (`packages/trpc/src/lambda/middleware/oidcAuth.ts:5-25`), while `userAuth` checks only that `ctx.userId` is truthy (`packages/trpc/src/middleware/userAuth.ts:5-16`).
  - Backend proxy middleware explicitly excludes `/trpc` (`src/proxy.ts:7-15`), so there is no upstream request-level activity check.
  - Ordinary tRPC procedures remain reachable. For example, `userProcedure` uses `authedProcedure` and database middleware without an active-user guard (`apps/server/src/routers/lambda/user.ts:93-105`) and exposes authenticated reads and mutations (`apps/server/src/routers/lambda/user.ts:107-122`, `apps/server/src/routers/lambda/user.ts:204-205`).
  - Some other API families are protected independently: web API OIDC authentication always calls `assertOIDCUserActive` (`src/app/(backend)/middleware/auth/index.ts:86-103`), as does OpenAPI authentication (`packages/openapi/src/middleware/auth.ts:180-194`). Enterprise routes may also add their own active-user guard, such as `platformAgents` (`apps/server/src/enterprise/routers/platformAgents.ts:15-21`). These narrow the affected surface but do not protect ordinary tRPC routes.
  - The exposure window is material: built-in OIDC access tokens have a seven-day TTL (`src/libs/oidc-provider/provider.ts:22-38`).

- **Verdict rationale:** The defect is independently reproduced and is fork-introduced. The `context.ts:27` comment claiming flag-off “upstream parity” is contradicted by the specified baseline. However, this is revocation failure for an already-authenticated principal, not arbitrary authentication or privilege escalation. It also does not affect web API/OpenAPI paths that perform their own check.

- **Corrected severity and scope:** **HIGH.** A holder of a still-valid built-in OIDC token can retain access to ordinary Lambda/mobile/tools tRPC endpoints for up to seven days after the subject is banned, deleted, or invalidated when both admin flags are off.

### pkg-shared-D1-001 — DOWNGRADED

- **What the original claimed:** `findAndGroupByDay` applies user/model/provider caps only after PostgreSQL returns every distinct day × user × model × provider row, leaving database, transport, and Node memory usage unbounded.

- **What I actually found:** The dimension query groups on all four dimensions and has no SQL `LIMIT`, ranking CTE, or SQL-side “other” bucket (`packages/database/src/models/platform/globalStats.ts:893-910`). Drizzle materializes the complete `dimRows` result before it is placed into per-day arrays (`packages/database/src/models/platform/globalStats.ts:912-918`) and passed to the application-level cap (`packages/database/src/models/platform/globalStats.ts:920-923`). The top-N calculation itself is entirely in memory (`packages/database/src/models/platform/globalStats.ts:130-217`).

- **Refutation attempts:**

  - The query is not raw-message materialization: PostgreSQL first aggregates identical dimension tuples. It is also constrained to assistant messages within one resolved calendar month (`packages/database/src/models/platform/globalStats.ts:849-878`, `packages/database/src/models/platform/globalStats.ts:962-972`).
  - The schema has a supporting `(role, created_at)` index (`packages/database/src/schemas/message.ts:176-177`), which helps range scanning but cannot bound the grouped result.
  - `messages.userId` has a user foreign key, but `model` and `provider` are unrestricted text fields; none limits distinct tuples (`packages/database/src/schemas/message.ts:116-132`).
  - A database statement timeout can abort expensive queries, but it is optional and defaults to PostgreSQL’s no-timeout behavior (`packages/app-config/src/db.ts:18-22`, `packages/database/src/core/web-server.ts:31-40`). It also does not bound a successfully returned result.
  - The caller is guarded by active-user, rate-limit, and `STATS_READ` permission middleware (`apps/server/src/enterprise/routers/admin/stats.ts:32-37`) and exposes only a validated month input (`apps/server/src/enterprise/routers/admin/stats.ts:60-69`, `apps/server/src/enterprise/routers/admin/stats.ts:312-325`). This prevents an unprivileged remote DoS and arbitrary multi-year queries.
  - Existing model tests exercise only a two-user, single-model/provider case (`packages/database/src/models/__tests__/platform.globalStats.test.ts:168-239`); no test asserts the SQL result itself is bounded.

- **Verdict rationale:** The late cap is real and the grouped result can approach the number of assistant messages when dimension combinations are highly diverse. Nevertheless, the report’s HIGH availability impact assumes both extreme cardinality and an administrator invoking the affected one-month chart. The implementation is materially safer than an unrestricted raw-row query.

- **Corrected severity and scope:** **MEDIUM.** This is a privileged administrative analytics scalability defect. Large, diverse monthly datasets can cause excessive query work, result transfer, and Node memory pressure, but process termination was not independently demonstrated and is not reachable by ordinary users.

### pkg-shared-D2-001 — DOWNGRADED

- **What the original claimed:** Authentication tests enable platform administration for every OIDC activity-check case, leaving the regressed flag-off baseline invariant untested.

- **What I actually found:** `createLambdaContext` tests enable `ENABLE_PLATFORM_ADMIN=1` in `beforeEach` (`packages/trpc/src/lambda/context.test.ts:168-190`). The only test setting it to `0` exercises API-key authentication and explicitly expects no activity check (`packages/trpc/src/lambda/context.test.ts:262-286`). Both active and inactive OIDC cases therefore inherit the enabled flag (`packages/trpc/src/lambda/context.test.ts:337-388`).

- **Refutation attempts:**

  - A repository-wide search found no other test invoking `createLambdaContext`; all direct invocations are in this test file.
  - There is a flag-off test for an OIDC-shaped, epoch-invalid caller in managed-agent routing (`apps/server/src/routers/lambda/__tests__/managedAgentActiveUser.guard.test.ts:137-154`), but it constructs a tRPC caller context directly and enables `ENABLE_PLATFORM_MANAGED_AGENTS`. It validates the downstream managed-surface guard, not Lambda context behavior.
  - The managed-agent result depends on an explicit route guard (`apps/server/src/enterprise/routers/platformAgents.ts:19-21`) and therefore would continue passing even while ordinary tRPC authentication remains vulnerable.
  - Tests for web and OpenAPI middleware exercise different, unconditional OIDC checks and cannot detect the flag gate in `createLambdaContext`.

- **Verdict rationale:** The coverage gap is real, fork-specific, and directly explains why the baseline security regression passes the suite. Its original HIGH rating double-counts the runtime impact already represented by D5-001: missing coverage is a prevention failure, not a second production authorization bypass.

- **Corrected severity and scope:** **MEDIUM.** The missing case is security-sensitive and should cover unset, `0`, and false-like flags, but its direct consequence is regression-detection weakness rather than independent runtime harm.
