import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_REAUTH_MESSAGE_TYPE } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { createAdminRouteTree } from './createAdminRouteTree';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));

const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalOpener = Object.getOwnPropertyDescriptor(window, 'opener');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  if (originalOpener) Object.defineProperty(window, 'opener', originalOpener);
  else delete (window as Window & { opener?: Window | null }).opener;
});

describe('admin reauth completion route', () => {
  it('mounts outside the mobile admin gate, posts its one-time state, and closes', async () => {
    const state = 'ab'.repeat(32);
    const opener = { postMessage: vi.fn() };
    Object.defineProperty(window, 'opener', { configurable: true, value: opener });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    const router = createMemoryRouter(createAdminRouteTree(), {
      initialEntries: [`/admin/reauth-complete?state=${state}`],
    });

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(opener.postMessage).toHaveBeenCalledWith(
        { state, status: 'success', type: ADMIN_REAUTH_MESSAGE_TYPE },
        window.location.origin,
      );
    });
    expect(screen.queryByText('Desktop required')).not.toBeInTheDocument();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
