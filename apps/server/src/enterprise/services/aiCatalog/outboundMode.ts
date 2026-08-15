import type { OutboundPolicyMode } from '../../security/outboundHttp';

/**
 * Outbound SSRF mode for platform AI-provider connectivity probes.
 *
 * G-07 "private network allowed by default" (on-prem deployments): an unset switch — or an
 * explicit `1` — allows a platform provider whose endpoint resolves to a private/reserved
 * address (an intranet Ollama/vLLM gateway, or a host whose DNS is answered by a fake-IP
 * proxy resolver such as 198.18.0.0/15) to be probed. An explicit `0` tightens to public-only.
 *
 * Cloud Metadata endpoints (IMDS) stay permanently blocked in every mode. Mirrors the
 * connector and identity-provider outbound policies so an operator who allowed internal
 * targets there gets the same behavior for AI providers — the endpoints are admin-authored
 * platform configuration, not user-influenced URLs.
 */
export const resolveAiCatalogOutboundMode = (
  env: Record<string, string | undefined> = process.env,
): OutboundPolicyMode => {
  const raw = env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
  if (raw !== undefined && raw !== '0' && raw !== '1') {
    throw new Error('invalid AI catalog outbound policy mode');
  }
  return raw === '0' ? 'public-only' : 'allow-private';
};
