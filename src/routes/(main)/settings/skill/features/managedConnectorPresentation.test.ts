import { describe, expect, it } from 'vitest';

import { isConnectorSectionVisible } from './managedConnectorPresentation';

describe('managed Connector presentation', () => {
  it('keeps exact legacy sections when management is off', () => {
    expect(isConnectorSectionVisible('builtinTools', false)).toBe(true);
    expect(isConnectorSectionVisible('communityTools', false)).toBe(true);
    expect(isConnectorSectionVisible('customConnectors', false)).toBe(true);
    expect(isConnectorSectionVisible('communityConnectors', false)).toBe(true);
  });

  it('keeps only personal OAuth connectors when definitions are managed', () => {
    expect(isConnectorSectionVisible('builtinTools', true)).toBe(false);
    expect(isConnectorSectionVisible('communityTools', true)).toBe(false);
    expect(isConnectorSectionVisible('customConnectors', true)).toBe(false);
    expect(isConnectorSectionVisible('communityConnectors', true)).toBe(true);
  });
});
