<div align="center">

[简体中文](./README.md) · **English**

# LobeHub Enhanced

</div>

Turns open-source LobeHub into a **ready-to-run enterprise AI platform**: an admin console with user management, **DingTalk QR sign-in** and **Authentik / generic OIDC single sign-on**, extra providers such as **ChatGPT Web, Grok and Cursor** with one account shared by the whole team, your own brand name and colours, and a **full audit trail** of every admin action. Deploy privately with one `docker compose up -d`; the image ships for x86-64 and ARM (Apple Silicon included).

> Unofficial community fork — **not affiliated with, endorsed by, or supported by LobeHub LLC**. It is a derivative work of [lobehub/lobehub](https://github.com/lobehub/lobehub), distributed under the LobeHub Community License (see [LICENSE](./LICENSE)). "LobeHub" is a trademark of LobeHub LLC and is used only to identify the upstream project.

|                 |                                              |               |                                                      |
| --------------- | -------------------------------------------- | ------------- | ---------------------------------------------------- |
| Repository      | `https://github.com/12dora/lobehub-enhanced` | Image         | `ghcr.io/12dora/lobehub-enhanced`                    |
| Current version | `v1.0.0`                                     | Upstream base | `lobehub/lobehub` v2.2.10 (v2.2.13 changes absorbed) |

## What is added

Every enhancement is **on by default**; each can be toggled live in the admin console under **System → Modules**, or switched off with an environment variable (see below).

**Sign-in & accounts**

- DingTalk QR sign-in with an organisation allowlist — only members of allow-listed organisations get in
- Authentik / generic OIDC single sign-on; a login-method wizard walks through configuration, test, publish and rollback
- Two-step verification (TOTP authenticator) and passkey (WebAuthn) sign-in; admins can reset a local account's password or clear its second factor (SSO accounts keep their factors at the IdP)
- Open registration with an email-domain allowlist
- User management — roles, bans, sessions, deletion — all from the admin console (`/admin`)

**AI providers**

- Shared-account providers: **ChatGPT Web, Grok (SuperGrok / X Premium subscription), Grok Build (CLI proxy) and Cursor** — an admin authorises the platform account once and the whole team uses it, no per-user API keys
- 80+ providers and their models managed centrally; model lists sync from upstream in one click
- Platform assistants pushed to everyone, with staged rollout
- Skills and connectors governance, including shared OAuth connector accounts

**Governance & audit**

- Operation logs with live view; session history, evidence export, legal hold, data retention
- Content moderation: keyword rules plus an LLM judge, with block / degrade / log-only policies per content category
- Settings policies (defaults / locks) and sidebar layout control
- Network proxy: a built-in proxy engine with per-scope rules for which outbound traffic goes through it
- Telemetry removed entirely

**Operations & branding**

- Branding — name, logo, primary colour — all the way down to the boot splash screen
- Task template library: manufacturing-oriented home-page task recommendations, editable and drag-sortable

**Deployment & performance**

- 24 feature modules that start only when you want them: `LOBE_MODULE_PRESET=minimal|standard|full` presets, or per-module toggles in the admin console
- Scales from the full stack down to "one container plus one database" — see [Deployment options](#deployment-options) below
- Two optimisation waves, measured: idle CPU from \~1.5% to \~0.1%, boot memory from \~500 MB to \~240 MB, idle database round-trips down \~80%, first-screen JS from 33.8 MB to \~25 MB

## Screenshots

<table>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-overview.png" alt="Admin overview"><br><sub><b>Admin overview</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-task-templates.png" alt="Task templates"><br><sub><b>Task templates</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-login-methods.png" alt="Login methods"><br><sub><b>Login methods (DingTalk allowlist)</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-audit-logs.png" alt="Audit logs"><br><sub><b>Audit logs</b></sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-chatgpt-web.png" alt="ChatGPT Web"><br><sub><b>ChatGPT Web shared account</b></sub></td>
<td width="50%"><img width="100%" src="docs/enhanced/screenshots/admin-branding.png" alt="Branding"><br><sub><b>Branding</b></sub></td>
</tr>
</table>

## Deploy with Docker

You need a machine with Docker + Docker Compose. The database image is `paradedb/paradedb:latest-pg17` (bundles vector and full-text search; a plain postgres image will not pass the migrations); object storage is the bundled rustfs (its address must be reachable **from the browser**); Redis is optional.

```bash
# 1. Get the deploy files (only docker-compose/enhanced is needed)
git clone https://github.com/12dora/lobehub-enhanced.git
cd lobehub-enhanced/docker-compose/enhanced
cp .env.example .env

# 2. Generate three different secrets for AUTH_SECRET / KEY_VAULTS_SECRET / PLATFORM_MASTER_KEY
openssl rand -base64 32

# 3. Edit .env: APP_URL (public address), S3_ENDPOINT / S3_PUBLIC_DOMAIN (object-store address the browser can reach),
#    BOOTSTRAP_SUPER_ADMIN_EMAIL (first admin) + BOOTSTRAP_ALLOW_CREATE=1

# 4. Start, then read the one-time admin password from the log
docker compose up -d
docker compose logs app | grep -i bootstrap

# 5. Open <APP_URL>/admin, sign in, change the password
```

| Required variable             | Meaning                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_URL`                     | Public address, e.g. `https://chat.example.com`                                                                                                        |
| `DATABASE_URL`                | `postgresql://user:pass@host:5432/db` (migrations run at start)                                                                                        |
| `AUTH_SECRET`                 | Session signing secret                                                                                                                                 |
| `KEY_VAULTS_SECRET`           | Encrypts user-level API keys                                                                                                                           |
| `PLATFORM_MASTER_KEY`         | Master key for platform secrets (base64, 32 bytes). **Back it up** — without it stored provider / connector / login-method secrets cannot be decrypted |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | First admin; with `BOOTSTRAP_ALLOW_CREATE=1` the account is created automatically                                                                      |

All enhancements are enabled by default; toggle them live in the admin console under **System → Modules**, or set a variable to `0` to switch one off: `ENABLE_PLATFORM_ADMIN` (admin console), `ENABLE_PLATFORM_MANAGED_AI`, `ENABLE_PLATFORM_MANAGED_SKILLS`, `ENABLE_PLATFORM_MANAGED_CONNECTORS`, `ENABLE_PLATFORM_MANAGED_AGENTS`, `ENABLE_PLATFORM_SETTINGS_POLICY`, `ENABLE_RUNTIME_BRANDING`, `ENABLE_DATABASE_OIDC`. Keep `AUTH_SSO_PROVIDERS` empty when login methods are configured in the database.

### Deployment options

One image, sized to the machine — from the full stack down to one container plus one database:

| Command                                              | Sidecars                        | When                                                      |
| ---------------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `docker compose up -d`                               | ParadeDB + Redis + object store | Default full stack (4+ CPU / 8+ GiB)                      |
| `docker compose --profile search up -d`              | + SearXNG                       | You want the built-in web search                          |
| `docker compose -f docker-compose.minimal.yml up -d` | ParadeDB only                   | Small boxes (1–2 CPU / 2–4 GiB) with the `minimal` preset |

The 24 feature modules default on or off per `LOBE_MODULE_PRESET=minimal|standard|full` (default `full`, i.e. today's behaviour); individual modules can be overridden in the admin console under **System → Modules** or with `LOBE_MODULES_DISABLED`. Compose injects the Node heap cap `LOBE_NODE_HEAP_MB=1536` (a bare `docker run` leaves the heap uncapped). Per-module memory / background-job costs and the measured numbers are in [`docs/enterprise/modules.md`](./docs/enterprise/modules.md).

Upgrade: `docker compose pull && docker compose up -d` (migrations are automatic). Image tags: `latest`, `1.0`, `1.0.0`; platforms `linux/amd64` and `linux/arm64` (Apple Silicon Macs use the arm64 image through Docker Desktop). Full example in [`docker-compose/enhanced/`](./docker-compose/enhanced/).

## One-prompt deployment with an AI assistant

Paste this into your AI assistant (Claude Code, Codex, Cursor, …) and let it do the work:

```text
Deploy LobeHub Enhanced on this machine with Docker:
1. git clone https://github.com/12dora/lobehub-enhanced.git, cd into docker-compose/enhanced, copy .env.example to .env.
2. Generate three different values with `openssl rand -base64 32` and put them into AUTH_SECRET, KEY_VAULTS_SECRET and PLATFORM_MASTER_KEY.
3. Set APP_URL to the public address (use http://localhost:3210 for a local trial); set S3_ENDPOINT and S3_PUBLIC_DOMAIN to http://<this machine's IP or domain>:9000, which the browser must be able to reach;
   set BOOTSTRAP_SUPER_ADMIN_EMAIL=<my email> and BOOTSTRAP_ALLOW_CREATE=1.
4. Run `docker compose up -d`, wait until the app log shows the database migration passed and "Ready", then find the one-time admin password printed by the bootstrap log line and tell it to me (it is printed only once).
5. Finally tell me the URL <APP_URL>/admin and remind me to back up PLATFORM_MASTER_KEY from .env.
If a port is taken or an image cannot be pulled, explain why and propose a fix.
```

## Login methods

Create them in the admin console under **System → Security & auth → Login methods**; the wizard walks through configuration, test and publish:

- **DingTalk** — enter the AppKey / AppSecret of your DingTalk Open Platform app, then click "Add organisation via DingTalk login" and scan: the organisation id is captured automatically and only members of allow-listed organisations can sign in. Callback URL: `<APP_URL>/oauth/identity-provider/dingtalk/<provider-key>`; the app needs the "通讯录个人信息读权限" (Contact.User.Read) permission and the `openid corpid` scopes. See [`docs/enterprise/dingtalk-login.md`](./docs/enterprise/dingtalk-login.md).
- **Authentik / generic OIDC** — discovery URL plus client credentials. Callback URL: `<APP_URL>/api/auth/oauth2/callback/<provider-key>`. See [`docs/enterprise/authentik-setup.md`](./docs/enterprise/authentik-setup.md).
- The test-login callback is always `<APP_URL>/oauth/identity-provider/test/callback`; several login methods can be enabled at once.

## Development

```bash
pnpm install  # install dependencies
bun run dev   # start the dev environment
bun run check # lint + related tests
```

Conventions and structure: [`AGENTS.md`](./AGENTS.md); operations docs: [`docs/enterprise/`](./docs/enterprise/).

## License

Distributed under the **LobeHub Community License** (Apache-2.0 with additional conditions); `LICENSE` is kept unmodified. This repository is a derivative work of lobehub/lobehub: under clause 1(b) of that license, **developing and distributing a derivative work requires a commercial license from LobeHub LLC** (<hello@lobehub.com>), and users are responsible for their own compliance. Upstream copyright remains with LobeHub LLC; all copyright and license notices are retained, and the changes relative to upstream are recorded in the git history and this document.
