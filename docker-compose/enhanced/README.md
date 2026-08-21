# LobeHub Enhanced — Docker Compose

Self-hosting stack for the enterprise fork: the app plus ParadeDB (Postgres + pgvector + BM25),
Redis and an S3-compatible object store.

```bash
cd docker-compose/enhanced
cp .env.example .env

# generate the three secrets
openssl rand -base64 32 # KEY_VAULTS_SECRET
openssl rand -base64 32 # AUTH_SECRET
openssl rand -base64 32 # PLATFORM_MASTER_KEY

# OIDC / official CLI device-code login (`lh login --server <url>`). Without JWKS_KEY
# the app leaves ENABLE_OIDC off: POST /oidc/device/auth is 404 and Oidc-Auth is ignored.
# From the repo root (prints a one-line JWKS JSON; paste as JWKS_KEY, not OIDC_JWKS_KEY):
node scripts/generate-oidc-jwk.mjs

# edit .env: APP_URL, the secrets above, JWKS_KEY, POSTGRES_PASSWORD, RUSTFS_SECRET_KEY,
# S3_ENDPOINT / S3_PUBLIC_DOMAIN and BOOTSTRAP_SUPER_ADMIN_EMAIL
docker compose up -d
```

### Module presets / smaller deployments

`docker compose up -d` is today's stack: app + ParadeDB + Redis + rustfs.
SearXNG is new and opt-in (`--profile search` or `COMPOSE_PROFILES=search`).
A smaller box uses the sibling file:

```bash
docker compose -f docker-compose.minimal.yml up -d
```

| Stack    | How to start                                         | Sidecars             |
| -------- | ---------------------------------------------------- | -------------------- |
| today    | `docker compose up -d`                               | Redis + S3           |
| + search | `docker compose --profile search up -d`              | Redis + S3 + SearXNG |
| minimal  | `docker compose -f docker-compose.minimal.yml up -d` | ParadeDB only        |

Set `LOBE_MODULE_PRESET` to match (`minimal` / `standard` / `full`). Compose
injects `LOBE_NODE_HEAP_MB=1536` (1024 on the minimal file) — a raw
`docker run` without that variable does not cap the heap. See
[docs/enterprise/modules.md](../../docs/enterprise/modules.md).

Database migrations run automatically when the app container starts.

**Every enhancement is on by default** — the admin console, managed AI / skills / connectors /
assistants, settings policy, runtime branding and database-driven identity providers. You only
need an `ENABLE_*` variable to turn something **off** (`0` / `false` / `no` / `off`). A flag
controls whether a feature is mounted; it never grants permissions, and nobody has admin access
until the bootstrap below provisions a super admin.

**First sign-in.** With `BOOTSTRAP_SUPER_ADMIN_EMAIL` set the server promotes that account to
`super_admin` on every boot. If the account does not exist yet and `BOOTSTRAP_ALLOW_CREATE=1`, it
is created and a one-time password is printed **once**:

```bash
docker compose logs lobehub | grep -A6 'Break-glass super admin'
```

Then open `APP_URL`, sign in, change the password, and go to `/admin`.

Notes worth reading before you go to production:

- **Postgres must be ParadeDB** (or another image with `pgvector` + `pg_search`); plain `postgres`
  cannot run the migrations.
- **`S3_ENDPOINT` must work from two places at once.** With `S3_SET_ACL=0` every object read is a
  presigned URL built from `S3_ENDPOINT`, and the same value is used for the server's own SDK calls.
  So it cannot be `http://localhost:9000` (inside the app container that is the app itself) and it
  cannot be `http://rustfs:9000` (the browser cannot resolve it). Use the host address that
  publishes `RUSTFS_PORT` — `http://192.168.1.20:9000`, or a real hostname such as
  `https://files.example.com` if you terminate TLS in front of it — and set `S3_PUBLIC_DOMAIN` to
  the same value. Compose (`docker-compose.yml`) refuses to start while either is unset. The
  minimal file leaves both empty and the app disables server-side uploads.
- **The bucket name is fixed at `lobe`**, because `bucket.config.json` grants public reads on
  `arn:aws:s3:::lobe/*`. Change both together if you really need a different name.
- **`PLATFORM_MASTER_KEY` is not recoverable.** Back it up. Every stored platform secret is
  encrypted with it. The server still boots without it — it logs a one-line warning and only
  fails when a platform secret is actually saved or read.
- **`AUTH_COOKIE_PREFIX` must be unique per instance** when several instances share a domain.
- **Do not rotate `APP_URL` / `INTERNAL_APP_URL` / `AUTH_SECRET` / `AUTH_COOKIE_PREFIX` on a live
  stack.** `APP_URL` must be the exact browser origin (`https://host`, no path). Keep
  `INTERNAL_APP_URL=http://localhost:3210` (compose default) so middleware can reach
  `/api/auth/get-session`. Changing the secret, cookie prefix, or Redis key prefix looks like
  “everyone got logged out”. See [docs/self-hosting/auth.mdx](../../docs/self-hosting/auth.mdx).
- The OIDC last-known-good snapshot lives on the `platform-oidc-lkg` volume; keep it. The
  `platform-oidc-lkg-init` service hands that volume to UID 1001 with mode `0700` before the app
  starts — the identity store rejects any directory it does not own. If you ever recreate the volume
  by hand, reapply `chown 1001:1001` + `chmod 0700`.
- **`JWKS_KEY` enables OIDC**, which the official npm `@lobehub/cli` needs for `lh login`.
  `KEY_VAULTS_SECRET` is also required (OIDC cookies / key vault). Leave `JWKS_KEY` empty only
  if you do not need device-code login; API-key tRPC (`LOBEHUB_CLI_API_KEY`) still works.

## Official CLI (`@lobehub/cli`) / 官方 CLI

Use the **published** package — do not fork `apps/cli`. Point it at this host:

```bash
# Device-code login (requires JWKS_KEY so OIDC is on)
npx -y @lobehub/cli@latest login --server http:// < your-host > :3210

# Or API key (Settings → API keys). Enough for tRPC reads (agent list, topic, file, user).
export LOBEHUB_SERVER=http:// < your-host > :3210
export LOBEHUB_CLI_API_KEY=sk-lh-...
npx -y @lobehub/cli@latest agent list --json
```

Keep `LOBE_MODULE_PRESET=full` (the compose default) on any host that must support the official
CLI. Disabled modules stay mounted but return `FORBIDDEN` / `PLATFORM_MODULE_DISABLED` — never
404\. Module → CLI command map:

| Module          | CLI commands                  |
| --------------- | ----------------------------- |
| `knowledgeBase` | `lh kb *`                     |
| `imageGen`      | `lh generate image/video`     |
| `speech`        | `lh generate asr`             |
| `webSearch`     | `lh search` web/crawl         |
| `market`        | `lh skill import` from market |
| `memory`        | `lh memory *`                 |
| `bots`          | `lh bot *`                    |
| `agentSignal`   | `lh agent-signal`             |

**平台托管 (platform takeover)** is policy, not a missing route. Once an admin publishes
enforced 托管 for agents / AI /skills, `lh agent create|edit|delete`, `lh provider create|update|remove`,
and `lh skill create|update|import*` are denied (`FORBIDDEN`). Use the published platform
catalog instead of personal CRUD.

中文摘要：必须设置 `JWKS_KEY`（`node scripts/generate-oidc-jwk.mjs` 生成，写入 `.env` 的
`JWKS_KEY=`，并保证 `KEY_VAULTS_SECRET` 已转发）官方 CLI 才能 `lh login --server <url>`。
也可用 `LOBEHUB_SERVER` + `LOBEHUB_CLI_API_KEY` 走 API Key。模块关闭会让对应命令
`FORBIDDEN`；发布托管策略后 `agent` / `provider` / `skill` 的个人 CRUD 按设计拒绝。

All variables are documented in [`.env.example`](./.env.example) and in the root
[`.env.example`](../../.env.example).
