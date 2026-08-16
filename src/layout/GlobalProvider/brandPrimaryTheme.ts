import { findCustomThemeName, type PrimaryColors } from '@lobehub/ui';
import { darkAlgorithm } from '@lobehub/ui/es/styles/theme/algorithms/darkAlgorithm';
import { lightAlgorithm } from '@lobehub/ui/es/styles/theme/algorithms/lightAlgorithm';
import type { MappingAlgorithm } from 'antd';
import { theme as antdTheme } from 'antd';

/**
 * Applies the admin-configured platform primary colour to the runtime theme.
 *
 * `@lobehub/ui` derives its primary palette from a *named* colour scale, so a hex that
 * matches one of the shipped scales is handed over as that name — the platform default
 * then looks exactly like the same colour picked in personal appearance settings.
 * Any other brand hex has no scale, so the design-system algorithm is composed with a
 * patch that rewrites the primary token family from antd's own derivation of that hex.
 */

const HEX_PATTERN = /^#[\dA-F]{6}$/i;

/** Alpha fills exist in the lobe palette only; antd derives no equivalent. */
const FILL_ALPHA = {
  dark: { fill: 0.2, quaternary: 0.05, secondary: 0.14, tertiary: 0.09 },
  light: { fill: 0.12, quaternary: 0.03, secondary: 0.08, tertiary: 0.05 },
} as const;

const withAlpha = (hex: string, alpha: number): string => {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

/** The full primary token family, so no component keeps a stale shade of the old colour. */
export const brandPrimaryTokens = (hex: string, isDark: boolean) => {
  const derived = (isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm)({
    ...antdTheme.defaultSeed,
    colorPrimary: hex,
  });
  const alpha = isDark ? FILL_ALPHA.dark : FILL_ALPHA.light;

  return {
    colorPrimary: derived.colorPrimary,
    colorPrimaryActive: derived.colorPrimaryActive,
    colorPrimaryBg: derived.colorPrimaryBg,
    colorPrimaryBgHover: derived.colorPrimaryBgHover,
    colorPrimaryBorder: derived.colorPrimaryBorder,
    colorPrimaryBorderHover: derived.colorPrimaryBorderHover,
    colorPrimaryFill: withAlpha(hex, alpha.fill),
    colorPrimaryFillQuaternary: withAlpha(hex, alpha.quaternary),
    colorPrimaryFillSecondary: withAlpha(hex, alpha.secondary),
    colorPrimaryFillTertiary: withAlpha(hex, alpha.tertiary),
    colorPrimaryHover: derived.colorPrimaryHover,
    colorPrimaryText: derived.colorPrimaryText,
    colorPrimaryTextActive: derived.colorPrimaryTextActive,
    colorPrimaryTextHover: derived.colorPrimaryTextHover,
  };
};

export interface BrandPrimaryTheme {
  /** Design-system algorithm plus the brand patch; only set for a scale-less hex. */
  algorithm?: MappingAlgorithm[];
  /** A shipped colour scale name, applied through `customTheme.primaryColor`. */
  primaryColor?: PrimaryColors;
}

const NO_BRAND_PRIMARY: BrandPrimaryTheme = {};

/** Resolves the stored branding hex into the theme inputs `ThemeProvider` understands. */
export const resolveBrandPrimaryTheme = (
  hex: string | null | undefined,
  isDark: boolean,
): BrandPrimaryTheme => {
  const value = hex?.trim().toLowerCase();
  if (!value || !HEX_PATTERN.test(value)) return NO_BRAND_PRIMARY;

  const named = findCustomThemeName('primary', value) as PrimaryColors | undefined;
  if (named) return { primaryColor: named };

  const patch: MappingAlgorithm = (_seed, mapToken) =>
    ({ ...mapToken, ...brandPrimaryTokens(value, isDark) }) as ReturnType<MappingAlgorithm>;

  return { algorithm: [isDark ? darkAlgorithm : lightAlgorithm, patch] };
};
