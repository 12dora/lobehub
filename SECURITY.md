# Security Policy

LobeHub Enhanced is a community fork of [lobehub/lobehub](https://github.com/lobehub/lobehub). It is
not affiliated with, endorsed by, or supported by LobeHub LLC.

## Supported Versions

Only the latest released version receives security fixes.

## Reporting a Vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/12dora/lobehub-enhanced/security/advisories/new)
on this repository. **Do not open a public issue for a security problem.**

A good report includes:

- a clear description of the issue and its impact;
- the affected version and deployment mode;
- reproduction steps or a working proof of concept;
- relevant logs, screenshots or code references.

We aim to acknowledge reports within 7 days and to ship a fix for confirmed issues as soon as
practical. Please allow reasonable time to address the issue before public disclosure; reporters are
credited in the advisory unless they prefer to stay anonymous.

## Scope

**In scope** — issues in this fork's server-side deployment that are exploitable without
administrative access, including the enterprise additions: the `/admin` console, platform RBAC,
managed resources, shared OAuth, audit, database-driven identity providers, and platform secret
encryption.

**Out of scope**

- Issues that require super-admin or host access; the platform administrator is a trusted party.
- Vulnerabilities in upstream LobeHub that also affect the unmodified upstream project — report those
  to [lobehub/lobehub](https://github.com/lobehub/lobehub/security/advisories/new). We will pick up
  the fix when the change is merged upstream.
- The file proxy endpoint `/f/:id`, which intentionally uses non-enumerable capability URLs.
- User-existence signals on login endpoints, which are part of the standard sign-in UX.
- Client-side API keys stored in the browser in self-hosted client mode.
- Theoretical attacks without a working proof of concept against a realistic deployment.
