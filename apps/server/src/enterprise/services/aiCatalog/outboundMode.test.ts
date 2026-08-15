// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveAiCatalogOutboundMode } from './outboundMode';

describe('resolveAiCatalogOutboundMode', () => {
  it('allows private/reserved provider endpoints by default (G-07 私网默认放行)', () => {
    expect(resolveAiCatalogOutboundMode({})).toBe('allow-private');
    expect(resolveAiCatalogOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '1' })).toBe(
      'allow-private',
    );
  });

  it('tightens to public-only when private IPs are explicitly disabled', () => {
    expect(resolveAiCatalogOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: '0' })).toBe(
      'public-only',
    );
  });

  it('rejects an out-of-contract switch value', () => {
    expect(() => resolveAiCatalogOutboundMode({ SSRF_ALLOW_PRIVATE_IP_ADDRESS: 'yes' })).toThrow();
  });
});
