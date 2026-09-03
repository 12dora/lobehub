import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConstVersion from '@/const/version';
import { DISABLED_PLATFORM_PUBLIC_SNAPSHOT } from '@/types/platform/publicSnapshot';

import BootSplashOverlay from '../BootSplashOverlay';
import BootBrandMark from './index';

const buildFlags = vi.hoisted(() => ({ isCustomBranding: false }));

vi.mock('@/const/version', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstVersion>();

  return {
    ...actual,
    get isCustomBranding() {
      return buildFlags.isCustomBranding;
    },
  };
});

interface PublishedBrandOverrides {
  logoUrl?: string | null;
  name?: string;
  revision?: string;
}

/** Injects the server snapshot exactly as the SPA HTML template does, before the bundle runs. */
const injectPublishedBranding = ({
  logoUrl = null,
  name = 'AIHub',
  revision = '7',
}: PublishedBrandOverrides = {}) => {
  window.__SERVER_CONFIG__ = {
    platformPublicSnapshot: {
      ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT,
      branding: {
        defaultAgentDisplayName: null,
        emailFrom: null,
        emailSenderName: null,
        faviconUrl: null,
        homeUrl: null,
        iconUrl: null,
        legalName: null,
        logoUrl,
        name,
        ogImageUrl: null,
        pageTitleTemplate: null,
        privacyUrl: null,
        revision,
        shortName: null,
        supportUrl: null,
        termsUrl: null,
      },
      brandingRevision: revision,
      logoUrl,
      platformName: name,
    },
  } as never;
};

const logo = () => document.querySelector('img');

beforeEach(() => {
  window.__SERVER_CONFIG__ = undefined;
});

afterEach(() => {
  window.__SERVER_CONFIG__ = undefined;
  buildFlags.isCustomBranding = false;
});

describe('BootBrandMark', () => {
  it('paints the published logo, cache-keyed by the published revision', () => {
    injectPublishedBranding({ logoUrl: '/brand/aihub.png', revision: '7' });

    render(<BootBrandMark />);

    expect(logo()).toHaveAttribute('src', '/brand/aihub.png?runtime_branding_revision=7');
    expect(screen.queryByText('AIHub')).not.toBeInTheDocument();
  });

  it('paints the published name when no logo is published', () => {
    injectPublishedBranding({ name: 'Acme Workspace' });

    render(<BootBrandMark />);

    expect(screen.getByText('Acme Workspace')).toBeInTheDocument();
    expect(logo()).toBeNull();
  });

  it('keeps the built-in wordmark when nothing is published', () => {
    render(<BootBrandMark />);

    expect(screen.getByTitle('LobeHub')).toBeInTheDocument();
    expect(logo()).toBeNull();
  });

  it('fails closed to the built-in wordmark for an inconsistent snapshot', () => {
    injectPublishedBranding({ name: 'Attacker' });
    (
      window.__SERVER_CONFIG__ as never as { platformPublicSnapshot: { platformName: string } }
    ).platformPublicSnapshot.platformName = 'Different';

    render(<BootBrandMark />);

    expect(screen.getByTitle('LobeHub')).toBeInTheDocument();
    expect(screen.queryByText('Attacker')).not.toBeInTheDocument();
  });
});

describe('BootSplashOverlay', () => {
  it('announces itself and shows the published brand', () => {
    injectPublishedBranding({ logoUrl: 'https://cdn.example.com/aihub.png' });

    render(<BootSplashOverlay />);

    expect(screen.getByRole('status')).toHaveAccessibleName();
    expect(logo()).toHaveAttribute(
      'src',
      'https://cdn.example.com/aihub.png?runtime_branding_revision=7',
    );
  });

  it('falls back to the built-in wordmark without a server snapshot', () => {
    render(<BootSplashOverlay />);

    expect(screen.getByTitle('LobeHub')).toBeInTheDocument();
  });

  /**
   * The static server splash paints the published brand whatever the build flag says, so a
   * custom-branded build that drops to the spinner here swaps the brand out on React mount.
   */
  it('keeps the published brand on a custom-branded build', () => {
    buildFlags.isCustomBranding = true;
    injectPublishedBranding({ name: 'Acme Workspace' });

    const { container } = render(<BootSplashOverlay />);

    expect(screen.getByText('Acme Workspace')).toBeInTheDocument();
    expect(container.querySelector('[class*="spinner"]')).toBeNull();
  });

  it('shows the spinner on a custom-branded build with nothing published', () => {
    buildFlags.isCustomBranding = true;

    const { container } = render(<BootSplashOverlay />);

    expect(container.querySelector('[class*="spinner"]')).toBeInTheDocument();
    expect(screen.queryByTitle('LobeHub')).not.toBeInTheDocument();
  });
});
