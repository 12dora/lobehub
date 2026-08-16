import { describe, expect, it } from 'vitest';

import {
  getModerationCategoryLabel,
  moderationCategoryKey,
  resolveModerationCategory,
} from './moderationCategory';

describe('resolveModerationCategory', () => {
  it('accepts every known category', () => {
    expect(resolveModerationCategory('sexual_minors')).toBe('sexual_minors');
    expect(resolveModerationCategory('jailbreak')).toBe('jailbreak');
  });

  it('rejects unknown or non-string values', () => {
    expect(resolveModerationCategory('brand_new_category')).toBeUndefined();
    expect(resolveModerationCategory('')).toBeUndefined();
    expect(resolveModerationCategory(undefined)).toBeUndefined();
    expect(resolveModerationCategory(42)).toBeUndefined();
  });
});

describe('moderationCategoryKey', () => {
  it('builds the shared common-namespace key', () => {
    expect(moderationCategoryKey('privacy')).toBe('moderation.category.privacy');
  });
});

describe('getModerationCategoryLabel', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars && 'category' in vars ? `${key}(${String(vars.category)})` : key;

  it('composes the label from the shared common keys', () => {
    expect(getModerationCategoryLabel(t, 'self_harm')).toBe(
      'moderation.categoryLabel(moderation.category.self_harm)',
    );
  });

  it('returns undefined for a missing or unknown category', () => {
    expect(getModerationCategoryLabel(t, undefined)).toBeUndefined();
    expect(getModerationCategoryLabel(t, 'unknown_bucket')).toBeUndefined();
  });
});
