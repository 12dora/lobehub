# SafeOutboundHttpClient — known residuals

Explicit residual risk surface for M07/M09/M11 consumers. These are **not**
covered by the current primitive; do not assume they are hardened.

| Residual                       | Notes                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **No port allowlist**          | Any port on an otherwise-allowed host is permitted (private MCP often uses non-default ports). Tighten per-caller if needed.      |
| **No content-type validation** | Response `Content-Type` is not restricted; callers that parse JSON/XML should validate themselves.                                |
| **DNS resolver trust**         | Production depends on the host resolver; tests inject `resolve`. Compromised recursive DNS is out of scope for this client alone. |

Enforced today (non-residual):

- Cloud Metadata hostnames + known IMDS IPv4/IPv6 (incl. Alibaba `100.100.100.200`, Tencent `169.254.0.23`, IPv4-mapped and RFC 6052 NAT64/SIIT) permanent deny in every mode
- G-07 default **public-only**; `allow-private` and `allowlist` are explicit opt-in (metadata still permanently denied)
- DNS pin + dynamic versioned policy re-read for every redirect hop
- Secret-bearing cross-origin redirects fail closed; custom credential headers are stripped
- http/https only
- Hard `maxResponseBytes` during stream read (connection destroyed)
- One absolute wall-clock deadline across DNS, redirects, transport, and body + socket idle timeout
