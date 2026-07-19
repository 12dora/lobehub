# Enterprise administration threat model

Status: W8 baseline. This document describes the code at the repository revision that contains it;
it is not a production certification. The machine-readable companion is
`apps/server/src/enterprise/security/policy/adminMutationRegistry.ts`.

## Scope and security objectives

This model covers the enterprise `admin` tRPC tree, platform configuration publication, managed
agents and skills, connector and AI catalogs, identity providers, branding, users, global roles,
EasyAuth synchronization, and controlled restart. It also covers the shared platform audit,
envelope-encryption, redaction, and outbound-request primitives used by those routes.

The primary assets are:

- administrator identity, session freshness, global roles, and the last-super-admin invariant;
- unpublished drafts, immutable revisions, publication pointers, rollout state, and restart intent;
- encrypted integration material and the key-encryption key used to protect it;
- identity-provider configuration and the signed last-known-good (LKG) startup snapshot;
- platform audit records, correlation identifiers, and security-relevant failure categories;
- availability of login, model, connector, skill, agent, and settings runtime paths.

The objectives are authorization before access, explicit intent for risky changes, replay and stale
write resistance, no sensitive material in responses or telemetry, guarded remote access, and
fail-closed behavior when a security dependency cannot establish a trustworthy result.

## Trust boundaries and actors

1. **Browser or API client → tRPC server.** Input, timestamps, headers, role claims, and reauth
   assertions from the client are untrusted. The server derives the user, session, authentication
   method, and authentication time.
2. **tRPC server → PostgreSQL/Redis/object storage.** The application trusts configured service
   identities, but treats availability, stale reads, conflicts, and partial failure as expected
   failure modes. Transaction and compare-and-set boundaries remain security controls.
3. **Server → remote identity, connector, and model endpoints.** Remote names, DNS answers,
   redirects, response sizes, and response bodies are attacker controlled. A successful TLS or HTTP
   response is not proof that the endpoint is safe or semantically valid.
4. **Server → key provider.** Key material and signing operations are highly trusted. The current
   environment provider is suitable only for controlled deployments; the Vault provider is a
   fail-closed stub, not a completed production integration.
5. **Published database state → process startup/runtime cache.** Database revisions are authoritative.
   Local caches and LKG files are derived data and must be authenticated, bounded, and rejected when
   stale or inconsistent.
6. **Application → logs, traces, audit readers, and operators.** Operators are trusted to administer
   the system, but are not entitled to plaintext integration material. Observability systems are a
   separate disclosure boundary.

Relevant attackers include an unauthenticated network client, an authenticated ordinary user, an
administrator with only a subset of platform permissions, a compromised administrator session, a
malicious remote endpoint/DNS answer, a tenant able to induce concurrency or replay, and an operator
or telemetry consumer without a need to access plaintext material.

## Threats and current controls

| STRIDE class           | Representative threat                                                              | Controls implemented now                                                                                                                             | Residual risk / required work                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Client supplies a fake role or recent-auth timestamp                               | Authenticated tRPC context, active-user middleware, permission middleware, server-derived authentication metadata                                    | Reauth is wired only to the dangerous procedures identified as `enforced` or `conditional` in the registry; gaps remain explicit              |
| Tampering              | Stale admin overwrites a newer draft or publication                                | Draft tokens/revisions, compare-and-set updates, immutable revisions, transactional publication in the implemented catalogs                          | Reconciliation does not prove every service transaction is atomic; real PostgreSQL failure and rollback coverage remains a W8 acceptance item |
| Repudiation            | Administrator denies a destructive change                                          | Bounded reason fields and sanitized platform audit records on the procedures marked `enforced`                                                       | Some validation and restart-preparation paths lack a complete success/failure audit; denied-audit writes are sometimes best effort            |
| Information disclosure | Integration material appears in API output, logs, or audit diffs                   | Server-side encrypted storage boundaries, redaction helpers, public projections, fingerprint removal on audit reads                                  | Environment-held master key remains available to the process; distributed trace/error-sink verification is incomplete                         |
| Denial of service      | Repeated tests, syncs, publications, or restart requests consume resources         | Permission gates, bounded schemas, response/deadline limits on the shared outbound client, idempotency/CAS in selected services                      | There is no shared rate limiter for enterprise admin mutations; registry entries therefore mark rate limiting as `planned`                    |
| Elevation of privilege | Role replacement, protected-value change, publication, or managed-resource bypass  | Fine-grained platform permissions, active-user checks, recent reauth on a subset, last-super-admin protection, managed-resource guards               | Settings publication, EasyAuth sync, identity-provider deletion, agent assignments, and AI/identity protected-value draft changes lack reauth |
| SSRF / confused deputy | Remote catalog or identity address reaches metadata or pivots through redirect/DNS | Shared outbound client blocks metadata, pins DNS per hop, re-reads policy per redirect, bounds bytes/time, and strips sensitive cross-origin headers | No port allowlist or generic content-type enforcement; AI provider tests and EasyAuth synchronization still use direct remote fetches         |
| Replay / split brain   | A captured request, stale restart intent, or stale cache re-applies state          | Request identifiers on selected flows, revision checks, bounded restart intents, shared state for selected transitions, signed identity LKG          | These controls are not a single global mutation protocol; cache convergence and multi-instance chaos evidence remain incomplete               |

## Admin mutation policy registry

Every mutation reachable below the enterprise `admin` router has one registry entry. Each entry
records its route, risk, dangerous-operation classification, and the observed state of six controls:
reason, recent reauthentication, audit, rate limiting, outbound access, and LKG behavior.

The states have deliberately narrow meanings:

- `enforced`: code on the current path enforces the control;
- `conditional`: code enforces it only for the described input/path and records that limitation;
- `gap`: the control is applicable but missing;
- `planned`: the control is missing and explicitly scheduled for W8;
- `not-applicable`: the entry gives a resource-specific rationale.

`high` and `critical` risks can only be represented by entries marked `dangerous`; regular entries
are limited to `low` and `medium`. Dangerous entries cannot type-check with reason, reauth, audit, or
rate limit marked not applicable. A gap is still allowed so the registry remains truthful while
providing an executable backlog. The registry does not itself add guards or change business behavior.

An AST-based reachability test starts at the real lambda root mount, resolves the imported
`adminRouter`, and follows import aliases, local aliases (including router-constructor aliases),
shorthand properties, object spreads with JavaScript's later-key override semantics, and nested
router composition. It derives paths from the actual mount keys rather than a prefix table. It fails
for an added, renamed, duplicated, stale, unmapped, removed, or remounted mutation, validates
dangerous-operation invariants, and scans registry data for sensitive material and remote addresses.
It does not replace runtime authorization or penetration testing.

## LKG and fail-closed rules

The default rule is fail closed when authorization, decryption, integrity verification, publication
preconditions, or remote-policy evaluation cannot produce a trustworthy decision. Feature-disabled
enterprise paths do not silently fall back to unmanaged behavior when that would bypass an enforced
policy.

The identity-provider LKG is a narrow startup recovery mechanism, not a general stale-cache license.
It must be signed with a domain-separated key, have restrictive ownership/permissions, be bounded in
size and age, match its embedded identity, and pass semantic validation. Invalid, stale, changed,
symlinked, or unverifiable files are rejected. Publication and rollback update database revisions;
they do not atomically refresh a local LKG file on every instance. More importantly, failure to write
the local LKG records a degraded startup state but does not reject an otherwise valid database
candidate. The registry therefore records LKG as conditional rather than an activation gate.

LKG applicability is decided per procedure. Database-backed drafts and direct user/role state use the
authoritative database record; validation and bounded probes create no runtime state to recover;
branding asset recovery uses its object-storage operation records. Catalogs that expose immutable
revisions may offer explicit rollback, but the registry does not label that mechanism as an LKG.
Serving a previous value after an uncertain write is not permitted unless that resource defines a
separate authenticated, bounded recovery rule. Vault unavailability, sealing, authorization denial,
timeout, or malformed key data must not trigger a production fallback to an environment key. The
current Vault adapter is still a rejecting stub, so real Vault authentication, leases, rotation, and
historical-key reads remain W8 work.

## Audit and data minimization

- Audit records contain actor/target identifiers, action, result, bounded reason, request/correlation
  identifiers where implemented, and allowlisted summaries. They must not contain request bodies or
  plaintext integration material.
- Secret changes are represented by configured/operation state or a non-reversible administrative
  summary. Public audit reads remove fingerprint fields as an additional disclosure boundary.
- Error mapping exposes stable categories instead of database, remote, cryptographic, or storage
  details. Logs should record only the category and error class required to operate the service.
- The platform audit service is append-only at its public interface and list queries are bounded.
  Best-effort failure-audit handling must never turn a denied reauth into an allowed operation.
- Administrative EasyAuth synchronization trims and bounds its reason, rejects values matched by the
  centralized sensitive-material detector, and records minimized outcomes for bypass, skipped,
  unchanged, degraded-cache, failure-without-cache, applied, and unexpected failure paths. Snapshot,
  managed-role, and applied/degraded outcome-audit writes commit in one database transaction; an
  outcome-audit failure rolls them all back and is not reclassified as a business failure. Remote
  failure text is not copied into audit data.
- Trace, error-reporting, and log-sink integration still require an end-to-end leakage check; the
  presence of a redaction helper alone is not proof that every sink invokes it.

## Verification and release evidence

Repository verification for this baseline consists of the registry reconciliation test, existing
focused router/service security tests, TypeScript checking, linting, and diff checks. Subsequent W8
acceptance must add shared admin rate-limit tests, complete reauth/audit coverage for registry gaps,
real Vault integration and rotation tests, real PostgreSQL migration/rollback evidence,
multi-instance cache and failure drills, dependency/penetration scanning, and enterprise browser E2E
evidence. External identity tenants and signed production release/rollback drills must be reported as
unexecuted unless real credentials and release authority were used.

## Review triggers

Review this model and the registry whenever an admin mutation is added or renamed; a risk level or
permission changes; a new remote call, key provider, audit sink, cache, worker, or recovery fallback
is introduced; or an incident shows that a stated trust boundary or fail-closed assumption was wrong.
