import { describe, expect, it } from 'vitest';

import { getPlatformSkillToggleMode, resolvePlatformSkillSelection } from './skills';

describe('platform Skill distribution selection', () => {
  it.each([
    ['mandatory', 'auto', true, false, false],
    ['mandatory', 'disabled', true, false, false],
    ['default', 'auto', true, false, true],
    ['default', 'pinned', true, true, true],
    ['default', 'disabled', false, false, true],
    ['optional', 'auto', false, false, true],
    ['optional', 'pinned', true, true, true],
    ['optional', 'disabled', false, false, true],
  ] as const)(
    '%s + %s -> available=%s activated=%s mutable=%s',
    (distribution, mode, available, activated, mutable) => {
      expect(resolvePlatformSkillSelection(distribution, mode)).toEqual({
        activated,
        available,
        mutable,
      });
    },
  );

  it('maps only mutable controls to persisted tri-state modes', () => {
    expect(getPlatformSkillToggleMode('mandatory', false)).toBeNull();
    expect(getPlatformSkillToggleMode('default', true)).toBe('auto');
    expect(getPlatformSkillToggleMode('default', false)).toBe('disabled');
    expect(getPlatformSkillToggleMode('optional', true)).toBe('pinned');
    expect(getPlatformSkillToggleMode('optional', false)).toBe('disabled');
  });
});
