import { render } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getPlatformDefaultPrimaryColor,
  setPlatformDefaultPrimaryColor,
} from '@/layout/GlobalProvider/platformThemeDefaults';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import { getRuntimeBranding, RuntimeBrandingProvider } from './RuntimeBrandingProvider';

const snapshotWithPrimaryColor = (primaryColor: string | null): PlatformPublicSnapshot => ({
  ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  branding: {
    defaultAgentDisplayName: null,
    emailFrom: null,
    emailSenderName: null,
    faviconUrl: null,
    homeUrl: null,
    iconUrl: null,
    legalName: null,
    logoUrl: '/aihub.png',
    name: 'AIHub',
    ogImageUrl: null,
    pageTitleTemplate: null,
    privacyUrl: null,
    revision: '9',
    shortName: null,
    supportUrl: null,
    termsUrl: null,
    themeDefaults: { primaryColor },
  },
  brandingRevision: '9',
  logoUrl: '/aihub.png',
  platformName: 'AIHub',
});

afterEach(() => {
  setPlatformDefaultPrimaryColor(null);
  if (i18n.options.interpolation) {
    delete i18n.options.interpolation.defaultVariables;
  }
});

describe('RuntimeBrandingProvider', () => {
  it('publishes the platform primary colour to the app shell theme', () => {
    const { rerender } = render(
      <RuntimeBrandingProvider publicSnapshot={snapshotWithPrimaryColor('#E4002B')}>
        <div />
      </RuntimeBrandingProvider>,
    );

    expect(getPlatformDefaultPrimaryColor()).toBe('#E4002B');

    rerender(
      <RuntimeBrandingProvider publicSnapshot={snapshotWithPrimaryColor(null)}>
        <div />
      </RuntimeBrandingProvider>,
    );

    expect(getPlatformDefaultPrimaryColor()).toBeNull();
  });

  it('clears the shell colour when no branding is published', () => {
    setPlatformDefaultPrimaryColor('#E4002B');

    render(
      <RuntimeBrandingProvider publicSnapshot={DISABLED_PLATFORM_PUBLIC_SNAPSHOT}>
        <div />
      </RuntimeBrandingProvider>,
    );

    expect(getPlatformDefaultPrimaryColor()).toBeNull();
  });

  it('publishes the resolved name to i18n defaultVariables and the non-hook snapshot', () => {
    render(
      <RuntimeBrandingProvider publicSnapshot={snapshotWithPrimaryColor('#E4002B')}>
        <div />
      </RuntimeBrandingProvider>,
    );

    expect(getRuntimeBranding().name).toBe('AIHub');
    expect(i18n.options.interpolation?.defaultVariables).toEqual({
      appName: 'AIHub',
      platformName: 'AIHub',
    });
  });
});
