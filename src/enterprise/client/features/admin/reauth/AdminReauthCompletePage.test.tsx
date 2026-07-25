// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminReauthCompletePage, { isSafeReauthState } from './AdminReauthCompletePage';
import { ADMIN_REAUTH_MESSAGE_TYPE } from './requestAdminReauth';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: new URLSearchParams(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ description, message }: { description?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      <div>{message}</div>
      <div>{description}</div>
    </div>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [mocks.params],
}));

describe('isSafeReauthState', () => {
  it('accepts hex states of required length', () => {
    expect(isSafeReauthState('a'.repeat(32))).toBe(true);
    expect(isSafeReauthState('not-hex')).toBe(false);
    expect(isSafeReauthState(null)).toBe(false);
  });
});

describe('AdminReauthCompletePage', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.params = new URLSearchParams();
    vi.stubGlobal('opener', null);
  });

  it('renders invalid state without auto-claiming success', async () => {
    mocks.params = new URLSearchParams('state=bad');
    render(<AdminReauthCompletePage />);
    expect(await screen.findByTestId('reauth-complete-error')).toHaveTextContent(
      'users.reauth.complete.invalid.title',
    );
    expect(screen.queryByText('users.reauth.complete')).toBeNull();
  });

  it('renders noOpener when opened as a normal tab', async () => {
    mocks.params = new URLSearchParams(`state=${'a'.repeat(32)}`);
    Object.defineProperty(window, 'opener', { configurable: true, value: null });
    render(<AdminReauthCompletePage />);
    expect(await screen.findByTestId('reauth-complete-error')).toHaveTextContent(
      'users.reauth.complete.noOpener.title',
    );
  });

  it('delivers success to opener and shows complete copy', async () => {
    const postMessage = vi.fn();
    const opener = { postMessage };
    Object.defineProperty(window, 'opener', { configurable: true, value: opener });
    mocks.params = new URLSearchParams(`state=${'b'.repeat(40)}`);

    render(<AdminReauthCompletePage />);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        {
          status: 'success',
          state: 'b'.repeat(40),
          type: ADMIN_REAUTH_MESSAGE_TYPE,
        },
        window.location.origin,
      );
    });
    expect(await screen.findByRole('status')).toHaveTextContent('users.reauth.complete');
  });

  it('surfaces deliveryFailed when postMessage throws', async () => {
    const opener = {
      postMessage: () => {
        throw new Error('blocked');
      },
    };
    Object.defineProperty(window, 'opener', { configurable: true, value: opener });
    mocks.params = new URLSearchParams(`state=${'c'.repeat(32)}`);

    render(<AdminReauthCompletePage />);
    expect(await screen.findByTestId('reauth-complete-error')).toHaveTextContent(
      'users.reauth.complete.deliveryFailed.title',
    );
  });
});
