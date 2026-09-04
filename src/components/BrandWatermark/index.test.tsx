import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeBrandingProvider } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import BrandWatermark from './index';

const mocks = vi.hoisted(() => ({ isCustomORG: false }));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobechat/business-const')>()),
  ORG_NAME: 'Acme Corp',
}));

vi.mock('@/const/version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/const/version')>()),
  get isCustomORG() {
    return mocks.isCustomORG;
  },
}));

const PUBLISHED_SNAPSHOT: PlatformPublicSnapshot = {
  ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
  branding: {
    defaultAgentDisplayName: null,
    emailFrom: null,
    emailSenderName: null,
    faviconUrl: null,
    homeUrl: null,
    iconUrl: null,
    legalName: null,
    logoUrl: null,
    name: 'AIHub',
    ogImageUrl: null,
    pageTitleTemplate: null,
    privacyUrl: null,
    revision: '9',
    shortName: null,
    supportUrl: null,
    termsUrl: null,
    themeDefaults: { primaryColor: null },
  },
  brandingRevision: '9',
  logoUrl: null,
  platformName: 'AIHub',
};

describe('BrandWatermark', () => {
  beforeEach(() => {
    mocks.isCustomORG = false;
  });

  it('links to the product site when no brand is published', () => {
    render(
      <RuntimeBrandingProvider publicSnapshot={DISABLED_PLATFORM_PUBLIC_SNAPSHOT}>
        <BrandWatermark />
      </RuntimeBrandingProvider>,
    );

    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining('lobehub.com'),
    );
  });

  it('shows the published brand wordmark instead of the product logo', () => {
    render(
      <RuntimeBrandingProvider publicSnapshot={PUBLISHED_SNAPSHOT}>
        <BrandWatermark />
      </RuntimeBrandingProvider>,
    );

    expect(screen.getByText('AIHub')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('prefers the published brand over the compile-time organisation', () => {
    mocks.isCustomORG = true;

    render(
      <RuntimeBrandingProvider publicSnapshot={PUBLISHED_SNAPSHOT}>
        <BrandWatermark />
      </RuntimeBrandingProvider>,
    );

    expect(screen.getByText('AIHub')).toBeInTheDocument();
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });

  it('falls back to the compile-time organisation when no brand is published', () => {
    mocks.isCustomORG = true;

    render(
      <RuntimeBrandingProvider publicSnapshot={DISABLED_PLATFORM_PUBLIC_SNAPSHOT}>
        <BrandWatermark />
      </RuntimeBrandingProvider>,
    );

    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
