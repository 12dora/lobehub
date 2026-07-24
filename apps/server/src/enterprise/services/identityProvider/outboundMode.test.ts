// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveIdentityProviderOutboundMode } from './outboundMode';

describe('resolveIdentityProviderOutboundMode', () => {
  it('allows private/internal issuers by default (G-07 私网默认放行)', () => {
    expect(resolveIdentityProviderOutboundMode({})).toBe('allow-private');
    expect(resolveIdentityProviderOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '1' })).toBe(
      'allow-private',
    );
  });

  it('tightens to public-only when private IPs are explicitly disabled', () => {
    expect(resolveIdentityProviderOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '0' })).toBe(
      'public-only',
    );
  });

  it('rejects an out-of-contract switch value', () => {
    expect(() =>
      resolveIdentityProviderOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: 'yes' }),
    ).toThrow();
  });
});
