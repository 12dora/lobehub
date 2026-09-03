import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ConstVersion from '@/const/version';

import BrandTextLoading from './index';

const publishedBrand = vi.hoisted(() => ({
  current: null as { logoSrc: string | null; name: string } | null,
}));

const buildFlags = vi.hoisted(() => ({ isCustomBranding: false }));

vi.mock('../BootBrandMark/bootBranding', () => ({
  readPublishedBootBrand: () => publishedBrand.current,
}));

vi.mock('@/const/version', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstVersion>();

  return {
    ...actual,
    get isCustomBranding() {
      return buildFlags.isCustomBranding;
    },
  };
});

afterEach(() => {
  publishedBrand.current = null;
  buildFlags.isCustomBranding = false;
});

/**
 * Both variants must announce themselves. Regression guard: the inline variant
 * (used by every route / Suspense fallback) renders `CircleLoading`, which for a
 * while carried no role at all while the branded fullscreen variant did.
 */
describe('BrandTextLoading', () => {
  it('exposes the inline loader as a named status', () => {
    render(<BrandTextLoading debugId="inline-test" variant={'inline'} />);

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAccessibleName();
  });

  it('exposes the fullscreen loader as a named status', () => {
    render(<BrandTextLoading debugId="fullscreen-test" />);

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAccessibleName();
  });

  it('shows the published brand instead of the built-in wordmark', () => {
    publishedBrand.current = { logoSrc: null, name: 'Acme Workspace' };

    render(<BrandTextLoading debugId="branded-test" />);

    expect(screen.getByText('Acme Workspace')).toBeInTheDocument();
    expect(screen.queryByTitle('LobeHub')).not.toBeInTheDocument();
  });

  /**
   * The static server splash paints the published brand whatever the build flag says, so a
   * custom-branded build that drops to the spinner here swaps the brand out on React mount.
   */
  it('keeps the published brand on a custom-branded build', () => {
    buildFlags.isCustomBranding = true;
    publishedBrand.current = { logoSrc: null, name: 'Acme Workspace' };

    const { container } = render(<BrandTextLoading debugId="custom-branded-test" />);

    expect(screen.getByText('Acme Workspace')).toBeInTheDocument();
    // `CircleLoading` is the only spinner in this tree, and it is the only source of an `svg`.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the spinner on a custom-branded build with nothing published', () => {
    buildFlags.isCustomBranding = true;

    const { container } = render(<BrandTextLoading debugId="custom-branded-test" />);

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByTitle('LobeHub')).not.toBeInTheDocument();
  });
});
