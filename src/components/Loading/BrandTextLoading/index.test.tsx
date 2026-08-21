import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BrandTextLoading from './index';

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
});
