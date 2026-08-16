import { primaryColors } from '@lobehub/ui';
import { act, render, screen } from '@testing-library/react';
import { useTheme } from 'antd-style';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppTheme from './AppTheme';
import { setPlatformDefaultPrimaryColor } from './platformThemeDefaults';

const mocks = vi.hoisted(() => ({
  isDark: false,
  neutralColor: undefined as string | undefined,
  primaryColor: undefined as string | undefined,
}));

vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => mocks.isDark }));
vi.mock('@/store/global', () => ({ useGlobalStore: () => 'en-US' }));
vi.mock('@/store/global/selectors', () => ({ systemStatusSelectors: { language: () => 'en-US' } }));
vi.mock('@/store/user', () => ({
  useUserStore: () => [mocks.primaryColor, mocks.neutralColor, 'default'],
}));
vi.mock('@/store/user/selectors', () => ({ userGeneralSettingsSelectors: {} }));
vi.mock('@/libs/getUILocaleAndResources', () => ({
  getUILocaleAndResources: async () => ({ locale: undefined, resources: undefined }),
}));
vi.mock('@/libs/getUILocaleAndResources.utils', () => ({
  resolveUILocale: () => ({ uiLocale: undefined }),
}));
vi.mock('@/components/AntdStaticMethods', () => ({ default: () => null }));
vi.mock('@/styles', () => ({ GlobalStyle: () => null }));
vi.mock('@/utils/client/cookie', () => ({ setCookie: vi.fn() }));

const TokenProbe = () => {
  const theme = useTheme();

  return (
    <div
      data-layout-bg={theme.colorBgLayout}
      data-primary={theme.colorPrimary}
      data-primary-hover={theme.colorPrimaryHover}
      data-testid="tokens"
    />
  );
};

const renderTheme = () => {
  const { unmount } = render(
    <AppTheme>
      <TokenProbe />
    </AppTheme>,
  );
  const node = screen.getByTestId('tokens');
  const tokens = {
    layoutBg: node.dataset.layoutBg,
    primary: node.dataset.primary,
    primaryHover: node.dataset.primaryHover,
  };
  unmount();

  return tokens;
};

beforeEach(() => {
  mocks.isDark = false;
  mocks.neutralColor = undefined;
  mocks.primaryColor = undefined;
  setPlatformDefaultPrimaryColor(null);
});

describe('AppTheme platform primary colour', () => {
  it('keeps the product palette when no platform colour is configured', () => {
    const { layoutBg, primary } = renderTheme();

    expect(primary).toBe('#222222');
    expect(layoutBg).toBe('#f8f8f8');
  });

  it('applies a platform colour that matches a shipped scale as that scale', () => {
    setPlatformDefaultPrimaryColor(primaryColors.red);
    const platform = renderTheme();

    mocks.primaryColor = 'red';
    setPlatformDefaultPrimaryColor(null);
    const personal = renderTheme();

    // Identical to picking the same colour in personal appearance settings.
    expect(platform.primary).toBe(personal.primary);
    expect(platform.primaryHover).toBe(personal.primaryHover);
    expect(platform.primary).not.toBe('#222222');
  });

  it('applies an arbitrary brand hex without losing the design-system palette', () => {
    setPlatformDefaultPrimaryColor('#E4002B');
    const { layoutBg, primary, primaryHover } = renderTheme();

    expect(primary).toBe('#e4002b');
    // A derived hover shade, not the product default one.
    expect(primaryHover).not.toBe('#333333');
    // Neutral tokens still come from the design system, not from antd's defaults.
    expect(layoutBg).toBe('#f8f8f8');
  });

  it('applies an arbitrary brand hex in dark appearance too', () => {
    setPlatformDefaultPrimaryColor('#E4002B');
    const lightBrandPrimary = renderTheme().primary;

    mocks.isDark = true;
    const dark = renderTheme();

    mocks.isDark = true;
    setPlatformDefaultPrimaryColor(null);
    const darkDefault = renderTheme();

    // Dark appearance shifts the brand hue for contrast, exactly like the shipped scales do.
    expect(dark.primary).not.toBe(darkDefault.primary);
    expect(dark.primary).not.toBe(lightBrandPrimary);
    // The dark design-system palette is kept, not swapped for antd's dark defaults.
    expect(dark.layoutBg).toBe(darkDefault.layoutBg);
  });

  it('lets a personal primary colour override the platform default', () => {
    mocks.primaryColor = 'blue';
    const personalOnly = renderTheme();

    setPlatformDefaultPrimaryColor('#E4002B');
    const withPlatformDefault = renderTheme();

    expect(withPlatformDefault.primary).toBe(personalOnly.primary);
    expect(withPlatformDefault.primary).not.toBe('#e4002b');
  });

  it('repaints when the platform colour is published after mount', () => {
    render(
      <AppTheme>
        <TokenProbe />
      </AppTheme>,
    );
    expect(screen.getByTestId('tokens').dataset.primary).toBe('#222222');

    act(() => {
      setPlatformDefaultPrimaryColor('#E4002B');
    });

    expect(screen.getByTestId('tokens').dataset.primary).toBe('#e4002b');
  });

  it('ignores a value that is not a plain 6-digit hex', () => {
    setPlatformDefaultPrimaryColor('rgb(228, 0, 43)');

    expect(renderTheme().primary).toBe('#222222');
  });
});
