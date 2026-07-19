import { describe, expect, it } from 'vitest';

import { resolveDefaultInboxDisplayName } from './useDefaultInboxDisplayName';

describe('resolveDefaultInboxDisplayName', () => {
  it('preserves every explicit nonblank inbox title, including the legacy literal', () => {
    expect(resolveDefaultInboxDisplayName('Lobe AI', { defaultAgentDisplayName: 'AIHub AI' })).toBe(
      'Lobe AI',
    );
    expect(
      resolveDefaultInboxDisplayName('Workspace Assistant', {
        defaultAgentDisplayName: 'AIHub AI',
      }),
    ).toBe('Workspace Assistant');
  });

  it('uses the resolved runtime branding name when the configured title is blank', () => {
    expect(resolveDefaultInboxDisplayName(null, { defaultAgentDisplayName: 'AIHub AI' })).toBe(
      'AIHub AI',
    );
    expect(
      resolveDefaultInboxDisplayName('  ', { defaultAgentDisplayName: 'Custom Assistant' }),
    ).toBe('Custom Assistant');
  });

  it('fails closed to the immutable product fallback', () => {
    expect(resolveDefaultInboxDisplayName(undefined, { defaultAgentDisplayName: null })).toBe(
      'Lobe AI',
    );
  });
});
