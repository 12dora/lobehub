import { describe, expect, it, vi } from 'vitest';

import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { resolveConnectorCallbackRedirectUri } from './connectorCallbackRedirect';
import {
  type ConnectorOutboundPolicyEnv,
  getConnectorOutboundPolicySnapshot,
} from './connectorOutboundPolicy';

describe('Connector production dependency authority', () => {
  it('derives OAuth callback from the canonical appEnv/Vercel provider seam', () => {
    expect(resolveConnectorCallbackRedirectUri(() => 'https://aihub-production.vercel.app')).toBe(
      'https://aihub-production.vercel.app/oauth/connector/callback',
    );
    expect(() => resolveConnectorCallbackRedirectUri(() => undefined)).toThrow(
      'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED',
    );
  });

  it('keeps G-07 allow-private by default and tightens only on explicit zero', () => {
    const env: ConnectorOutboundPolicyEnv = {};
    const config = { SSRF_ALLOW_IP_ADDRESS_LIST: 'allowed.example, 10.0.0.8,allowed.example' };
    const source = { env: () => env, getConfig: () => config };
    const defaultSnapshot = getConnectorOutboundPolicySnapshot(source);
    expect(defaultSnapshot.policy).toEqual({
      allowlist: ['10.0.0.8', 'allowed.example'],
      mode: 'allow-private',
    });
    env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';
    expect(getConnectorOutboundPolicySnapshot(source).policy.mode).toBe('allow-private');
    env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '0';
    const tightened = getConnectorOutboundPolicySnapshot(source);
    expect(tightened.policy.mode).toBe('allowlist');
    expect(tightened.version).not.toBe(defaultSnapshot.version);
  });

  it('applies a live policy tightening to the very next outbound preflight', async () => {
    const env: ConnectorOutboundPolicyEnv = {};
    const config = { SSRF_ALLOW_IP_ADDRESS_LIST: 'allowed.example' };
    const source = { env: () => env, getConfig: () => config };
    const resolve = vi.fn(async () => [{ address: '1.1.1.1', family: 4 as const }]);
    const client = new SafeOutboundHttpClient({
      policyProvider: () => getConnectorOutboundPolicySnapshot(source),
      resolve,
      transport: vi.fn(),
    });
    await expect(client.preflight('https://blocked.example/mcp')).resolves.toMatch(
      /^connector-ssrf-v1:/,
    );
    env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '0';
    await expect(client.preflight('https://blocked.example/mcp')).rejects.toMatchObject({
      code: 'PLATFORM_SSRF_BLOCKED',
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('fails closed instead of silently accepting malformed explicit policy values', () => {
    expect(() =>
      getConnectorOutboundPolicySnapshot({
        env: () => ({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: 'yes' }),
        getConfig: () => ({ SSRF_ALLOW_IP_ADDRESS_LIST: undefined }),
      }),
    ).toThrow('invalid Connector outbound policy mode');
  });
});
