import type { OutboundPolicyMode } from '../../security/outboundHttp';

/**
 * Outbound SSRF mode for identity-provider discovery, safe-login test, and login traffic.
 *
 * G-07 "private network allowed by default" (on-prem deployments): an unset switch — or an
 * explicit `1` — allows private/internal issuer addresses, so an internal-network IdP whose
 * issuer resolves to a private IP (e.g. `https://10.0.0.5/...`) can be discovered, tested, and
 * used for login. An explicit `0` tightens to public-only (public Internet issuers only).
 *
 * Cloud Metadata endpoints (IMDS) stay permanently blocked in every mode, so relaxing to
 * allow-private never exposes instance credentials. Mirrors the connector outbound policy so
 * an operator who allowed internal connector targets gets the same behavior for their IdP.
 */
export const resolveIdentityProviderOutboundMode = (
  env: Record<string, string | undefined> = process.env,
): OutboundPolicyMode => {
  const raw = env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
  if (raw !== undefined && raw !== '0' && raw !== '1') {
    throw new Error('invalid identity provider outbound policy mode');
  }
  return raw === '0' ? 'public-only' : 'allow-private';
};
