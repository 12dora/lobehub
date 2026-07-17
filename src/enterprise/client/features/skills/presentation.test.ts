import { describe, expect, it } from 'vitest';

import { getPublishedSkillToggleMode, isPublishedSkillEnabled } from './presentation';

describe('published Skill distribution presentation', () => {
  it('keeps mandatory Skills enabled and immutable', () => {
    expect(isPublishedSkillEnabled('mandatory', 'disabled')).toBe(true);
    expect(getPublishedSkillToggleMode('mandatory', false)).toBeNull();
  });

  it('enables default Skills unless explicitly disabled', () => {
    expect(isPublishedSkillEnabled('default', 'auto')).toBe(true);
    expect(isPublishedSkillEnabled('default', 'pinned')).toBe(true);
    expect(isPublishedSkillEnabled('default', 'disabled')).toBe(false);
    expect(getPublishedSkillToggleMode('default', true)).toBe('auto');
    expect(getPublishedSkillToggleMode('default', false)).toBe('disabled');
  });

  it('requires an explicit selection for optional Skills', () => {
    expect(isPublishedSkillEnabled('optional', 'auto')).toBe(false);
    expect(isPublishedSkillEnabled('optional', 'pinned')).toBe(true);
    expect(getPublishedSkillToggleMode('optional', true)).toBe('pinned');
    expect(getPublishedSkillToggleMode('optional', false)).toBe('disabled');
  });
});
