# SafeOutboundHttpClient — known residuals

Explicit residual risk surface for M07/M09/M11 consumers. These are **not**
covered by the current primitive; do not assume they are hardened.

| Residual                                      | Notes                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NAT64 / SIIT IMDS encodings**               | Addresses like `64:ff9b::a9fe:a9fe` or SIIT forms are not decoded to IPv4 IMDS. IPv4-mapped `::ffff:…` **is** blocked. Expand if deployment uses NAT64 toward cloud metadata. |
| **No port allowlist**                         | Any port on an otherwise-allowed host is permitted (private MCP often uses non-default ports). Tighten per-caller if needed.                                                  |
| **No content-type validation**                | Response `Content-Type` is not restricted; callers that parse JSON/XML should validate themselves.                                                                            |
| **Redirect credential strip is origin-based** | Cross-origin 30x drops `Authorization` / `Cookie` / `Cookie2` / `Proxy-Authorization`. Same-origin redirects keep them. Custom secret headers are not auto-stripped.          |
| **DNS resolver trust**                        | Production depends on the host resolver; tests inject `resolve`. Compromised recursive DNS is out of scope for this client alone.                                             |

Enforced today (non-residual):

- Cloud Metadata hostnames + known IMDS IPv4/IPv6 (incl. IPv4-mapped) permanent deny
- G-07 default allow-private; optional allowlist mode
- DNS pin + per-redirect revalidation
- http/https only
- Hard `maxResponseBytes` during stream read (connection destroyed)
- Absolute wall-clock deadline + socket idle timeout
