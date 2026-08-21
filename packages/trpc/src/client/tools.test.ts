import { describe, expect, it } from 'vitest';

import { shouldEmitMarketUnauthorized } from './tools';

describe('shouldEmitMarketUnauthorized', () => {
  it('emits for sandbox paths only when the provider is market', () => {
    expect(shouldEmitMarketUnauthorized('market.execInSandbox', 'market')).toBe(true);
    expect(shouldEmitMarketUnauthorized('market.exportAndUploadFile', 'market')).toBe(true);
    expect(shouldEmitMarketUnauthorized('market.callCodeInterpreterTool', 'market')).toBe(true);
  });

  it('does not emit for sandbox paths when the provider is local or onlyboxes', () => {
    expect(shouldEmitMarketUnauthorized('market.execInSandbox', 'local')).toBe(false);
    expect(shouldEmitMarketUnauthorized('market.exportAndUploadFile', 'onlyboxes')).toBe(false);
    expect(shouldEmitMarketUnauthorized('market.execInSandbox', undefined)).toBe(false);
  });

  it('still emits for other market procedures regardless of sandbox provider', () => {
    expect(shouldEmitMarketUnauthorized('market.connectGetStatus', 'local')).toBe(true);
    expect(shouldEmitMarketUnauthorized('market.connectGetStatus', 'market')).toBe(true);
  });

  it('ignores non-market paths', () => {
    expect(shouldEmitMarketUnauthorized('lambda.user.getUserState', 'market')).toBe(false);
  });
});
