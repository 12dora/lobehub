import { describe, expect, it } from 'vitest';

import { CLOUD_SANDBOX_MARKET_AUTH_TOOL, getMarketAuthTools } from './marketAuthTools';

describe('getMarketAuthTools', () => {
  it('includes lobe-cloud-sandbox only when the sandbox provider is market', () => {
    expect(getMarketAuthTools('market')).toEqual([CLOUD_SANDBOX_MARKET_AUTH_TOOL]);
  });

  it('omits lobe-cloud-sandbox for local, onlyboxes, and unset providers', () => {
    expect(getMarketAuthTools('local')).toEqual([]);
    expect(getMarketAuthTools('onlyboxes')).toEqual([]);
    expect(getMarketAuthTools(undefined)).toEqual([]);
  });
});
