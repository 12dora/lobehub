import { describe, expect, it } from 'vitest';

import { isIdentityProviderTestTerminal, parseIdentityProviderJsonObject } from './controller';

describe('identity provider editor controller', () => {
  it('stops polling only for terminal test states', () => {
    expect(isIdentityProviderTestTerminal('pending')).toBe(false);
    expect(isIdentityProviderTestTerminal('processing')).toBe(false);
    expect(isIdentityProviderTestTerminal('succeeded')).toBe(true);
    expect(isIdentityProviderTestTerminal('failed')).toBe(true);
  });

  it('keeps invalid intermediate JSON outside the canonical draft', () => {
    expect(parseIdentityProviderJsonObject('{"group":')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('[]')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('{"group":"admin"}')).toEqual({
      valid: true,
      value: { group: 'admin' },
    });
  });
});
