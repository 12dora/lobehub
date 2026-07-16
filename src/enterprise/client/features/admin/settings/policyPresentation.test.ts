// @vitest-environment node
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { formatPolicySummary, formatSettingValue } from './policyPresentation';

const t = ((key: string, values?: Record<string, unknown>) => {
  if (key === 'settingsPolicy.preview.summary') {
    return `${values?.mode}|${values?.visibility}|${values?.value}`;
  }
  return key;
}) as TFunction<'admin'>;

const entry = (control: string, path = 'general.fontSize') => ({
  control,
  descriptionKey: `${path}.desc`,
  group: 'general',
  options: [{ labelKey: 'option.compact', value: 'compact' }],
  path,
  schemaVersion: 1,
  titleKey: `${path}.title`,
});

describe('policyPresentation', () => {
  it('formats booleans, select options and numbers with typed labels', () => {
    expect(formatSettingValue({ entry: entry('switch'), t, value: true })).toBe(
      'settingsPolicy.value.enabled',
    );
    expect(formatSettingValue({ entry: entry('select'), t, value: 'compact' })).toBe(
      'option.compact',
    );
    expect(formatSettingValue({ entry: entry('number'), t, value: 12_500 })).toContain('12');
  });

  it('redacts a sensitive-looking path and never serializes a structured value', () => {
    expect(
      formatSettingValue({ entry: entry('text', 'provider.apiKey'), t, value: 'sk-secret' }),
    ).toBe('settingsPolicy.value.redacted');
    expect(formatSettingValue({ entry: entry('text'), t, value: { secret: 'value' } })).toBe(
      'settingsPolicy.value.complex',
    );
  });

  it('uses localized mode and visibility labels in summaries', () => {
    expect(
      formatPolicySummary({
        entry: entry('switch'),
        mode: 'locked',
        t,
        value: false,
        visibility: 'hidden',
      }),
    ).toContain('settingsPolicy.mode.locked');
  });
});
