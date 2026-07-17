import { createHash } from 'node:crypto';

import { getAppConfig } from '@/envs/app';

import type { OutboundPolicySnapshot } from '../../security/outboundHttp';

export type ConnectorOutboundPolicyEnv = Record<string, string | undefined>;

export interface ConnectorOutboundPolicySource {
  env?: () => ConnectorOutboundPolicyEnv;
  getConfig?: () => Pick<ReturnType<typeof getAppConfig>, 'SSRF_ALLOW_IP_ADDRESS_LIST'>;
}

const parseAllowlist = (value: string | undefined): string[] =>
  [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();

/**
 * Authoritative M09 outbound policy snapshot.
 *
 * G-07 deliberately differs from the upstream SSRF default: an unset switch
 * allows private/local MCP targets. Only an explicit `0` tightens to the
 * allowlist. The provider re-reads the canonical env config on every access,
 * and its content-derived version changes with the policy.
 */
export const getConnectorOutboundPolicySnapshot = (
  source: ConnectorOutboundPolicySource = {},
): OutboundPolicySnapshot => {
  const env = (source.env ?? (() => process.env))();
  const rawMode = env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
  if (rawMode !== undefined && rawMode !== '0' && rawMode !== '1') {
    throw new Error('invalid Connector outbound policy mode');
  }
  const allowlist = parseAllowlist((source.getConfig ?? getAppConfig)().SSRF_ALLOW_IP_ADDRESS_LIST);
  const policy = {
    allowlist,
    mode: rawMode === '0' ? ('allowlist' as const) : ('allow-private' as const),
  };
  const digest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  return { policy, version: `connector-ssrf-v1:${digest}` };
};

/** Shared production provider for Admin, OAuth, Runtime, and legacy MCP connector traffic. */
export const connectorOutboundPolicyProvider = (): OutboundPolicySnapshot =>
  getConnectorOutboundPolicySnapshot();
