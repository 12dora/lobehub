import { primaryColors } from '@lobehub/ui';
import { describe, expect, it } from 'vitest';

import { brandPrimaryTokens, resolveBrandPrimaryTheme } from './brandPrimaryTheme';

describe('resolveBrandPrimaryTheme', () => {
  it.each([null, undefined, '', '#fff', 'red', '#12345g'])(
    'resolves to no override for %o',
    (value) => {
      expect(resolveBrandPrimaryTheme(value, false)).toEqual({});
    },
  );

  it('hands a shipped scale colour over by name', () => {
    expect(resolveBrandPrimaryTheme(primaryColors.magenta, false)).toEqual({
      primaryColor: 'magenta',
    });
    // Casing is a storage detail, not a different colour.
    expect(resolveBrandPrimaryTheme(primaryColors.magenta.toUpperCase(), false)).toEqual({
      primaryColor: 'magenta',
    });
  });

  it('composes the design-system algorithm with a patch for a scale-less brand hex', () => {
    const resolved = resolveBrandPrimaryTheme('#E4002B', false);

    expect(resolved.primaryColor).toBeUndefined();
    expect(resolved.algorithm).toHaveLength(2);
  });
});

describe('brandPrimaryTokens', () => {
  it('rewrites the whole primary family so no shade stays behind', () => {
    const tokens = brandPrimaryTokens('#e4002b', false);

    expect(tokens.colorPrimary).toBe('#e4002b');
    expect(Object.keys(tokens).toSorted()).toEqual([
      'colorPrimary',
      'colorPrimaryActive',
      'colorPrimaryBg',
      'colorPrimaryBgHover',
      'colorPrimaryBorder',
      'colorPrimaryBorderHover',
      'colorPrimaryFill',
      'colorPrimaryFillQuaternary',
      'colorPrimaryFillSecondary',
      'colorPrimaryFillTertiary',
      'colorPrimaryHover',
      'colorPrimaryText',
      'colorPrimaryTextActive',
      'colorPrimaryTextHover',
    ]);
    expect(tokens.colorPrimaryFill).toBe('rgba(228, 0, 43, 0.12)');
  });
});
