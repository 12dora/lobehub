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

# edit .env: APP_URL, the secrets above, POSTGRES_PASSWORD, RUSTFS_SECRET_KEY,
# S3_ENDPOINT / S3_PUBLIC_DOMAIN and BOOTSTRAP_SUPER_ADMIN_EMAIL
docker compose up -d
```

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
  the same value. Compose refuses to start while either is unset.
- **The bucket name is fixed at `lobe`**, because `bucket.config.json` grants public reads on
  `arn:aws:s3:::lobe/*`. Change both together if you really need a different name.
- **`PLATFORM_MASTER_KEY` is not recoverable.** Back it up. Every stored platform secret is
  encrypted with it. The server still boots without it — it logs a one-line warning and only
  fails when a platform secret is actually saved or read.
- **`AUTH_COOKIE_PREFIX` must be unique per instance** when several instances share a domain.
- The OIDC last-known-good snapshot lives on the `platform-oidc-lkg` volume; keep it. The
  `platform-oidc-lkg-init` service hands that volume to UID 1001 with mode `0700` before the app
  starts — the identity store rejects any directory it does not own. If you ever recreate the volume
  by hand, reapply `chown 1001:1001` + `chmod 0700`.

All variables are documented in [`.env.example`](./.env.example) and in the root
[`.env.example`](../../.env.example).
