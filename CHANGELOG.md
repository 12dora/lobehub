<a name="readme-top"></a>

# Changelog

All notable changes to **LobeHub Enhanced** are documented here.
Upstream LobeHub release notes live in the [lobehub/lobehub](https://github.com/lobehub/lobehub) repository.

## 1.0.0 (2026-08-16)

First public release of LobeHub Enhanced — an enterprise-enhanced fork of LobeHub.
Based on upstream lobehub/lobehub v2.2.10.

#### ✨ Features

- **Admin console** — a dedicated `/admin` application (37 routes) driven by a single navigation manifest: overview, statistics, users, AI, skills, connectors, assistants, security & authentication, branding, audit and system status.
- **Platform RBAC** — 66 platform permissions and 6 system roles (`super_admin`, `user_admin`, `ai_admin`, `identity_admin`, `auditor`, `platform_user`); every admin API passes a single server-side permission gate backed by an asserted procedure registry.
- **Managed resources & settings policy** — the platform can take over AI, skills, connectors and assistants; user settings resolve `builtin default → platform default → user override → platform lock`, with independent visibility control.
- **AI provider & model catalog** — platform-owned providers and models with immutable revisions, instant apply, rollback, connection tests and `keep | replace | clear` secret handling, behind an explicit platform-AI takeover gate.
- **Skills & connectors governance** — platform catalogs with the same revision lifecycle, a builtin-tool permission matrix, and platform-hosted **shared OAuth accounts** with per-user bindings and bulk revocation.
- **Platform assistants** — global assistants with versions, assignments, staged rollouts (start / retry / rollback / cancel), non-hideable assistants and a configurable default inbox.
- **Audit subsystem** — append-only audit logs with an operation log UI, live view, conversation evidence search, exports, legal holds and retention runs; holds block retention deletion.
- **Database-driven identity providers** — OIDC/Authentik configuration stored in the database with live discovery, SSRF-checked network validation, publish / rollback / disable, controlled restart activation and a last-known-good snapshot on disk. Break-glass local admin retained.
- **Login methods & open registration** — toggle open registration behind an email-domain allowlist, enforced in the sign-up path.
- **Runtime branding** — name, logos, favicon, OG image, legal name, email sender, page-title template and primary colour applied site-wide the moment they are saved, with no first-paint flash.
- **ChatGPT Web provider (`chatgptweb`)** — the ChatGPT web session as a first-class provider: browser-fingerprinted transport, paste-a-web-session connection, session auto-renewal, chat / search / attachments / reasoning / images and resumable streaming.
- **Platform secret encryption** — AES-256-GCM envelope encryption for every stored platform secret behind a pluggable key provider (`env` or HashiCorp Vault AppRole), plus an asynchronous rewrap job for key rotation.
- **Platform jobs, instances & system page** — a lease-based job queue that survives across HTTP workers, live service instance tracking with a reaper, restart request/prepare flow and job cancel/retry.
- **Sidebar layout management** — platform-controlled sidebar ordering and visibility.
- **Admin analytics** — server-side totals, per-user usage, agent/model/topic rankings, 52-week activity calendars, hourly strips and token/cost heatmaps with time-range and user filters.
- **In-image super admin bootstrap** — `BOOTSTRAP_SUPER_ADMIN_*` provisions the first super admin at server startup, so a Docker-only deployment never needs a repository checkout.

#### 🔧 Deployment

- Multi-arch (`linux/amd64`, `linux/arm64`) images published to `ghcr.io/12dora/lobehub-enhanced` on every `v*.*.*` tag.
- Reference stack in `docker-compose/enhanced/` — ParadeDB (Postgres + pgvector + BM25), Redis and an S3-compatible object store.
- Enterprise configuration documented in `.env.example` and `docs/enterprise/`.

#### ♻️ Changes from upstream

- The upstream automatic sync workflow is removed; upstream updates are reviewed and applied explicitly.
- The upstream migration chain is squashed to a single baseline plus deltas.
- The provider draft/publish flow is replaced by direct instant-apply semantics.
- Telemetry and analytics are disabled by default; the npm version check is off because this fork's version line is independent of upstream.
