# Enterprise client extensions (AIHub)

Enterprise UI and client adapters live under `src/enterprise/**`.

- Keep upstream LobeHub files free of business logic; use the stable mount points
  under `src/business/client/*` (one-line registration only).
- All Feature Flags default **off**. Closed flags must not change route trees,
  global config, or user-visible behavior.
- Clients consume **server** capability snapshots only — never authorize from
  `NEXT_PUBLIC_*` env vars.

## Layout

| Path                 | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `client/routes/`     | Enterprise route modules (e.g. `/admin` shell in M03) |
| `client/features/`   | Domain feature UI                                     |
| `client/providers/`  | Global providers (`EnterprisePlatformProvider`)       |
| `client/services/`   | Client services / tRPC adapters                       |
| `client/registry.ts` | Module registration (routes, menus, system checks)    |

Server code: `apps/server/src/enterprise/**`.
Shared types: `packages/types/src/platform/`.
Shared constants: `packages/const/src/platform/`.
