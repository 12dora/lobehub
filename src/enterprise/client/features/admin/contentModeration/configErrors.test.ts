import { describe, expect, it, vi } from 'vitest';

import { resolveConfigValidationMessage } from './configErrors';

/** i18n stub: returns the key, plus the interpolated params so `{{n}}` binding is observable. */
const t = vi.fn((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key,
) as unknown as Parameters<typeof resolveConfigValidationMessage>[1];

const rejection = (details: Record<string, unknown>) => ({
  data: { errorData: { code: 'PLATFORM_CONFIG_VALIDATION_FAILED', details } },
  message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
});

describe('resolveConfigValidationMessage', () => {
  it('returns null for failures that are not config validation, so the caller keeps its own copy', () => {
    expect(resolveConfigValidationMessage(new Error('network down'), t, 'fallback.key')).toBeNull();
  });

  it('maps an unsafe regex to a 1-based, row-scoped message', () => {
    const result = resolveConfigValidationMessage(
      rejection({ field: 'keywords', index: 41, reason: 'regex_unsafe' }),
      t,
      'fallback.key',
    );
    expect(result?.field).toBe('keywords');
    expect(result?.ruleIndex).toBe(41);
    // Copy is 1-based for humans; the index stays 0-based for the table.
    expect(result?.message).toBe('contentModeration.errors.reason.regexUnsafe:{"n":42}');
  });

  it('maps a slow regex the same way', () => {
    const result = resolveConfigValidationMessage(
      rejection({ field: 'keywords', index: 0, reason: 'regex_slow' }),
      t,
      'fallback.key',
    );
    expect(result?.ruleIndex).toBe(0);
    expect(result?.message).toBe('contentModeration.errors.reason.regexSlow:{"n":1}');
  });

  it('leaves the batch-limit rejection unscoped — it names no single rule', () => {
    const result = resolveConfigValidationMessage(
      rejection({ field: 'keywords', reason: 'too_many_regex_changes' }),
      t,
      'fallback.key',
    );
    expect(result?.ruleIndex).toBeUndefined();
    expect(result?.message).toBe('contentModeration.errors.reason.tooManyRegexChanges');
  });

  it('ignores a nonsensical index rather than highlighting the wrong row', () => {
    for (const index of [-1, 1.5, 'seven']) {
      const result = resolveConfigValidationMessage(
        rejection({ field: 'keywords', index, reason: 'regex_unsafe' }),
        t,
        'fallback.key',
      );
      expect(result?.ruleIndex).toBeUndefined();
    }
  });

  it('does not scope a non-keyword field to a row even when an index is present', () => {
    const result = resolveConfigValidationMessage(
      rejection({ field: 'downgrade', index: 3, reason: 'model_not_published' }),
      t,
      'fallback.key',
    );
    expect(result?.ruleIndex).toBeUndefined();
    expect(result?.message).toBe('contentModeration.errors.reason.modelNotPublished');
  });

  it('falls back to the field message, then to the caller key, for unknown reasons', () => {
    expect(
      resolveConfigValidationMessage(
        rejection({ field: 'keywords', reason: 'brand_new_reason' }),
        t,
        'fallback.key',
      )?.message,
    ).toBe('contentModeration.errors.field.keywords');

    expect(
      resolveConfigValidationMessage(rejection({ field: 'mystery.path' }), t, 'fallback.key')
        ?.message,
    ).toBe('fallback.key');
  });
});
