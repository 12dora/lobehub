<div align="center">

**English** · [简体中文](./README.zh-CN.md)

</div>

# LobeHub Enhanced

An enterprise admin console, audit trail and platform-governance layer built on top of LobeHub.

> **Unofficial community fork.** LobeHub Enhanced is **not affiliated with, endorsed by, or supported by LobeHub LLC**.
> It is a derivative work of [`lobehub/lobehub`](https://github.com/lobehub/lobehub), distributed under the **LobeHub Community License** (see [`LICENSE`](./LICENSE)).
> "LobeHub" is a trademark of LobeHub LLC, used here only to identify the upstream project.

|                 |                                              |
| --------------- | -------------------------------------------- |
| Repository      | `https://github.com/12dora/lobehub-enhanced` |
| Container image | `ghcr.io/12dora/lobehub-enhanced`            |
| First release   | `v1.0.0`                                     |
| Upstream base   | `lobehub/lobehub` v2.2.10                    |

---

## What is added

Everything below is additive: the upstream chat product is unchanged for end users unless an
administrator turns a governance feature on. All enterprise features are behind env flags that
default to **off**.

| Area             | Feature                       | Notes                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin console    | Overview & statistics         | `/admin` and `/admin/stats`: totals, per-user totals, agent/model/topic rankings, 52-week activity heatmap, hourly strip, token/cost views; time-range and per-user filters.                                                                                                                              |
| Admin console    | Users management              | List + detail, role assignment, source labels, session revoke, and hard delete with cascade (self-delete refused).                                                                                                                                                                                        |
| Admin console    | Managed resources             | `/admin/unified`: platform takes over AI / skills / connectors / assistants; per-resource enable, override and visibility.                                                                                                                                                                                |
| Admin console    | Settings policies             | Resolution order `builtin default → platform default → user override → platform lock`, with `mode` (user / default / locked) independent of visibility.                                                                                                                                                   |
| Admin console    | AI providers & models         | Platform-owned provider and model catalog, connection test, secret `keep\|replace\|clear`, hard delete. A **takeover gate** means platform AI only replaces user AI when the managed AI catalog is actually published.                                                                                    |
| Admin console    | Platform assistants           | Global assistants with versions, assignments, staged rollouts (start / retry / rollback / cancel), forced non-hideable assistants, default inbox.                                                                                                                                                         |
| Admin console    | Skills & connectors           | Platform catalogs with the same lifecycle, a builtin-tool permission matrix, and **platform-hosted shared OAuth** accounts with per-user bindings and bulk revoke.                                                                                                                                        |
| Admin console    | Sidebar layout                | Platform-controlled sidebar ordering and visibility; the per-user layout menu disappears while managed.                                                                                                                                                                                                   |
| Admin console    | Task templates                | Admin CRUD plus enable / disable for the recommended task templates shown on the home page; one-click import of the current recommendations. Once any template exists, the platform list replaces the market feed.                                                                                        |
| Admin console    | Branding                      | Name, logos, favicon, OG image, legal name, email sender, page-title template and **primary colour** — saved once and live site-wide, seeded synchronously so there is no first-paint flash.                                                                                                              |
| Security & auth  | Login methods                 | Authentik, generic OIDC and DingTalk (钉钉) configured in the database through a wizard: live discovery, network validation, safe-login test, enable or disable, rollback. Several login methods can coexist. DingTalk adds an organisation allowlist whose corp ids are captured by scanning, not typed. |
| Security & auth  | Activation control            | `PLATFORM_OIDC_RESTART_MODE=supervisor` enables the "restart to activate" button; a last-known-good snapshot on disk keeps sign-in working if a new config fails to load. Break-glass local admin retained.                                                                                               |
| Security & auth  | Registration policy           | Open registration toggle gated on an email-domain allowlist, enforced inside the sign-up path.                                                                                                                                                                                                            |
| Audit            | Operation logs & live view    | Append-only admin action log with searchable, translated action and target names; a live view of in-flight conversations.                                                                                                                                                                                 |
| Audit            | Session evidence              | Browse and search conversation evidence per user and per topic, behind dedicated permissions (topic titles are treated as evidence).                                                                                                                                                                      |
| Audit            | Export, legal hold, retention | Asynchronous evidence exports, legal holds, and retention runs — an active hold blocks retention deletion.                                                                                                                                                                                                |
| Providers        | ChatGPT Web (`chatgptweb`)    | A web-session provider: browser-fingerprinted transport via a bundled `curl-impersonate` binary, paste-your-web-session connection, automatic session-cookie renewal, shared managed account, and a status panel that reports when the connection expired and an operator must reconnect.                 |
| Platform secrets | Envelope encryption           | AES-256-GCM envelope encryption for every platform-stored secret, keyed by `PLATFORM_MASTER_KEY` or a HashiCorp Vault KEK, with a versioned key id and an async rewrap job for rotation.                                                                                                                  |
| Runtime & ops    | Jobs, instances, status       | A lease-based job queue that survives across HTTP workers, a service-instance registry with a reaper, and `/admin/system/status` for live instance and job monitoring.                                                                                                                                    |

Server-side authorization is a single gate: every admin procedure declares its permission, and a
registry test asserts the declared count so a new endpoint cannot ship ungated.

## Screenshots

<table>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-overview.png" alt="Admin overview"><br><sub><b>Admin overview</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-task-templates.png" alt="Task templates"><br><sub><b>Task templates</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-login-methods.png" alt="Login methods"><br><sub><b>Login methods</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-audit-logs.png" alt="Audit logs"><br><sub><b>Audit logs</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-chatgpt-web.png" alt="ChatGPT Web shared account"><br><sub><b>ChatGPT Web shared account</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-branding.png" alt="Branding"><br><sub><b>Branding</b></sub></td>
</tr>
</table>

## Changes vs upstream

| Change                         | Detail                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry disabled             | Chat telemetry is driven off the Langfuse setting only; PostHog / Umami / Sentry remain unset build args.                          |
| EasyAuth removed               | The EasyAuth IAM integration was removed in favour of database-configured identity providers.                                      |
| Provider draft/publish removed | The AI provider draft → publish flow was dismantled: a change made in the admin console is live immediately.                       |
| Migration chain squashed       | Fresh databases start from `0000_squash_baseline`; an existing upstream 2.2.10 database is upgraded by `0001_upgrade_from_2_2_10`. |
| Release pipeline reduced       | Desktop and upstream release workflows are removed. The only published artifact is the multi-arch Docker image.                    |
| Docs rewritten                 | READMEs rewritten; fork documentation lives in [`docs/enterprise/`](./docs/enterprise/).                                           |
| Upstream sync is manual        | There is no automatic upstream sync. Upstream changes are reviewed and cherry-picked deliberately.                                 |

Changes are recorded in git history and in this file, satisfying the Apache-2.0 §4 change notice.

## Deploy with Docker

### Requirements

| Component      | Requirement                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime        | Docker Engine + Docker Compose                                                                                                                                                                   |
| Database       | **`paradedb/paradedb:latest-pg17`** — ParadeDB bundles `pgvector` and BM25 search; a plain `postgres` image will not satisfy the migrations.                                                     |
| Object storage | S3-compatible storage (the bundled compose runs `rustfs`). The public S3 endpoint must be reachable **from the browser**, not just from the container — presigned URLs are handed to the client. |
| Cache          | Redis is optional but recommended.                                                                                                                                                               |

### Quick start

1. Clone the repository, or download just the [`docker-compose/enhanced/`](./docker-compose/enhanced/) directory.

   ```bash
   git clone https://github.com/12dora/lobehub-enhanced.git
   cd lobehub-enhanced/docker-compose/enhanced
   ```

2. Create your env file.

   ```bash
   cp .env.example .env
   ```

3. Generate three independent secrets and put them in `.env`.

   ```bash
   openssl rand -base64 32 # AUTH_SECRET
   openssl rand -base64 32 # KEY_VAULTS_SECRET
   openssl rand -base64 32 # PLATFORM_MASTER_KEY
   ```

4. Set `APP_URL` to the public origin, and set `BOOTSTRAP_SUPER_ADMIN_EMAIL` (plus
   `BOOTSTRAP_ALLOW_CREATE=1` if that account does not exist yet). The one-time admin password is
   printed **once** in the application log on the first boot:

   ```bash
   docker compose up -d
   docker compose logs app | grep -i bootstrap
   ```

5. Open `<APP_URL>/admin` and sign in with that account. Change the password immediately.

### Environment variables

Required:

| Variable                | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `APP_URL`               | Public origin, e.g. `https://chat.example.com`. Used for OAuth callbacks and presigned URLs. |
| `DATABASE_URL`          | `postgresql://user:pass@host:5432/dbname`. Migrations run automatically at container start.  |
| `AUTH_SECRET`           | Session signing secret. `openssl rand -base64 32`.                                           |
| `KEY_VAULTS_SECRET`     | Encrypts user-level API keys. `openssl rand -base64 32`.                                     |
| `PLATFORM_MASTER_KEY`   | Base64 of exactly 32 bytes — the KEK for every platform-stored secret.                       |
| `ENABLE_PLATFORM_ADMIN` | `1` mounts `/admin`, the `admin.*` API surface and the admin entry in the user menu.         |

> **Back up `PLATFORM_MASTER_KEY`.** Losing or changing it without running the rewrap job makes every
> stored platform secret — provider keys, connector credentials, identity-provider client secrets —
> permanently unreadable.

Feature flags (all default to off; accepted truthy values are `1`, `true`, `yes`, `on`):

| Variable                             | Meaning                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `ENABLE_PLATFORM_MANAGED_AI`         | Platform takes over AI providers and models.                       |
| `ENABLE_PLATFORM_MANAGED_SKILLS`     | Platform-managed skill catalog replaces user-owned skills.         |
| `ENABLE_PLATFORM_MANAGED_CONNECTORS` | Platform-managed connectors and shared OAuth accounts.             |
| `ENABLE_PLATFORM_MANAGED_AGENTS`     | Platform assistants are pushed to users.                           |
| `ENABLE_PLATFORM_SETTINGS_POLICY`    | Settings default / lock policy resolution.                         |
| `ENABLE_RUNTIME_BRANDING`            | Database-driven branding overrides the compile-time name and logo. |
| `ENABLE_DATABASE_OIDC`               | Database-configured login methods (otherwise only env-based SSO).  |

`ENABLE_ENTERPRISE_ADMIN` is accepted as an alias of `ENABLE_PLATFORM_ADMIN`.

Other settings:

| Variable                                                                                                                                      | Meaning                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_OIDC_RESTART_MODE`                                                                                                                  | `supervisor` enables the "restart to activate" button for login methods; any other value marks restart unsupported.                               |
| `PLATFORM_OIDC_LKG_PATH`                                                                                                                      | File path for the last-known-good login-method snapshot. Point it at a persistent volume.                                                         |
| `AUTH_COOKIE_PREFIX`                                                                                                                          | Namespaces session cookies. **Set a distinct value per instance** if several instances share a host or domain, otherwise they log each other out. |
| `AUTH_SSO_PROVIDERS`                                                                                                                          | Leave **blank** when using database-configured login methods, so env providers do not shadow them.                                                |
| `S3_ENDPOINT`, `S3_PUBLIC_DOMAIN`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_ENABLE_PATH_STYLE`, `S3_SET_ACL` | S3-compatible storage. `S3_PUBLIC_DOMAIN` is the host baked into presigned URLs and must resolve from the browser.                                |
| `REDIS_URL`                                                                                                                                   | Optional cache / rate-limit backend.                                                                                                              |
| `PLATFORM_KEY_PROVIDER`, `VAULT_*`                                                                                                            | Set `PLATFORM_KEY_PROVIDER=vault` to source the KEK from HashiCorp Vault instead of `PLATFORM_MASTER_KEY`.                                        |
| `SSRF_ALLOW_PRIVATE_IP_ADDRESS`                                                                                                               | `1` permits private / loopback outbound targets, needed on single-box installs. Cloud metadata `169.254.169.254` stays blocked regardless.        |

### Upgrade

```bash
docker compose pull && docker compose up -d
```

Migrations run automatically when the container starts; no separate migrate step is needed.

### Image

`ghcr.io/12dora/lobehub-enhanced` — tags `latest`, `<major>.<minor>` and `<semver>` (e.g. `1.0.0`; the git tag is `v1.0.0`), built for
`linux/amd64` and `linux/arm64`. Apple Silicon Macs pull the `arm64` image through Docker Desktop.

Reference compose files live in [`docker-compose/enhanced/`](./docker-compose/enhanced/); operational
documentation, references and runbooks live in [`docs/enterprise/`](./docs/enterprise/).

## Login methods

- **Authentik** — configure in 系统 → 安全与认证 → 登录方式. The wizard performs live discovery against the issuer's `.well-known/openid-configuration`. See [`docs/enterprise/authentik-setup.md`](./docs/enterprise/authentik-setup.md).
- **Generic OIDC** — any standards-compliant OpenID Connect provider; discovery URL, client id/secret, scopes and claim mapping are configured in the same wizard.
- **DingTalk (钉钉)** — its own login-method kind (AppKey / AppSecret from the DingTalk Open Platform), `unionId` as the stable subject. Sign-in is restricted to an organisation allowlist: the admin clicks "Add organisation via DingTalk login", scans, and the corp id is captured automatically. See [`docs/enterprise/dingtalk-login.md`](./docs/enterprise/dingtalk-login.md).

All database-configured login methods use the same callback URL pattern — register it verbatim on
the identity-provider side:

```text
<APP_URL>/api/auth/oauth2/callback/<providerId>
```

## Development

```bash
pnpm install  # install dependencies
bun run dev   # Next.js + Vite SPA
bun run check # lint + related tests in one pass
```

Conventions, project structure and the quality checklist are in [`AGENTS.md`](./AGENTS.md);
architecture and operations notes for the fork are in [`docs/enterprise/`](./docs/enterprise/).

## License

This repository is distributed under the **LobeHub Community License** — see [`LICENSE`](./LICENSE),
which is retained unmodified. That license is Apache-2.0 **plus additional conditions**.

- **Commercial licensing.** Per clause 1(b) of the LobeHub Community License, a commercial license
  must be obtained from LobeHub LLC in order to develop and distribute a derivative work based on
  the upstream project. LobeHub Enhanced **is** such a derivative work. Contact
  `hello@lobehub.com`. Anyone deploying, modifying or redistributing this repository is responsible
  for their own compliance.
- **Change notice.** Per Apache-2.0 §4, the changes made relative to `lobehub/lobehub` v2.2.10 are
  stated in the "Changes vs upstream" section above and recorded in full in the git history.
- **Copyright.** Copyright of the upstream code remains with LobeHub LLC. All upstream copyright,
  license and attribution notices are retained.
- **Trademark.** No trademark rights are granted by the license. "LobeHub" is a trademark of
  LobeHub LLC and is used in this repository only to describe the upstream project this fork is
  derived from.
