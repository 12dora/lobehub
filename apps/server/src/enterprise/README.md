# Enterprise server extensions (AIHub)

Server-side enterprise code lives under `apps/server/src/enterprise/**`.

- Mount into lambda root only via a single import key (see patch ledger).
- Feature Flags default **off**; disabled mode must match upstream behavior.
- Capability snapshots must not leak roles, secrets, or internal config values.
- Do not create platform DB schemas here — M01 owns `packages/database/src/schemas/platform/`.

## Layout

| Path            | Purpose                                       |
| --------------- | --------------------------------------------- |
| `featureFlags/` | Env parsing for enterprise flags (PR-002)     |
| `routers/`      | tRPC routers (`platform`, later `admin.*`)    |
| `services/`     | Capability snapshot, policies, business logic |
| `repositories/` | DB access (M01+)                              |
| `guards/`       | Managed / permission middleware (M02/M06)     |
