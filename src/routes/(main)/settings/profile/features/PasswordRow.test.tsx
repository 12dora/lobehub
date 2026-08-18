import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MouseEvent, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PasswordRow from './PasswordRow';

interface PasskeyQuery {
  data: { id: string }[] | null;
  error: { message: string } | null;
  isPending: boolean;
  refetch: () => Promise<void>;
}

interface SessionQuery {
  data: { user: { twoFactorEnabled: boolean } } | null;
  error: { message: string } | null;
  isPending: boolean;
  refetch: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  hasPasswordAccount: true,
  isLoadedAuthProviders: true,
  passkeys: {} as PasskeyQuery,
  refetchPasskeys: vi.fn(async () => {}),
  refetchSession: vi.fn(async () => {}),
  requestPasswordReset: vi.fn(async () => ({ error: null }) as { error: unknown }),
  session: {} as SessionQuery,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Skeleton: {
    Button: () => <div data-testid="status-skeleton" />,
  },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  // `disabled` is reproduced because the SSO case turns on it: a disabled control takes no
  // focus, which is the whole reason the tooltip trigger has to carry the tab stop.
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/libs/better-auth/auth-client', () => ({
  requestPasswordReset: (...args: unknown[]) => mocks.requestPasswordReset(...(args as [])),
  useListPasskeys: () => mocks.passkeys,
  useSession: () => mocks.session,
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
}));

vi.mock('@/store/user/selectors', () => ({
  authSelectors: {
    hasPasswordAccount: () => mocks.hasPasswordAccount,
    isLoadedAuthProviders: () => mocks.isLoadedAuthProviders,
  },
  userProfileSelectors: {
    userProfile: () => ({ email: 'someone@example.com' }),
  },
}));

vi.mock('./ProfileRow', () => ({
  // Both slots, in the real order: the status line first, the controls after it — the tab
  // order assertions below only mean something if the DOM order is the component's own.
  default: ({
    action,
    children,
    label,
  }: {
    action?: ReactNode;
    children: ReactNode;
    label: string;
  }) => (
    <section aria-label={label}>
      {children}
      {action}
    </section>
  ),
}));

vi.mock('./security/ChangePasswordModal', () => ({ openChangePasswordModal: vi.fn() }));
vi.mock('./security/TwoFactor', () => ({ openTwoFactorModal: vi.fn() }));

beforeEach(() => {
  mocks.hasPasswordAccount = true;
  mocks.isLoadedAuthProviders = true;
  mocks.refetchPasskeys.mockClear();
  mocks.refetchSession.mockClear();
  mocks.toastError.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.requestPasswordReset.mockReset();
  mocks.requestPasswordReset.mockResolvedValue({ error: null });
  mocks.passkeys = {
    data: [],
    error: null,
    isPending: false,
    refetch: mocks.refetchPasskeys,
  };
  mocks.session = {
    data: { user: { twoFactorEnabled: false } },
    error: null,
    isPending: false,
    refetch: mocks.refetchSession,
  };
});

afterEach(() => {
  cleanup();
});

describe('PasswordRow status', () => {
  it('reports two-step verification off when neither factor is enrolled', () => {
    render(<PasswordRow />);

    expect(screen.getByText('profile.security.twoFactor.status.off')).toBeInTheDocument();
  });

  it('reports two-step verification on for TOTP alone', () => {
    mocks.session = { ...mocks.session, data: { user: { twoFactorEnabled: true } } };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.twoFactor.status.on')).toBeInTheDocument();
  });

  it('reports the passkey — never "two-step verification on" — when only a passkey exists', () => {
    mocks.passkeys = { ...mocks.passkeys, data: [{ id: 'pk-1' }] };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.status.passkey')).toBeInTheDocument();
    expect(screen.queryByText('profile.security.twoFactor.status.on')).toBeNull();
  });

  it('reports both factors when TOTP and a passkey are enrolled', () => {
    mocks.session = { ...mocks.session, data: { user: { twoFactorEnabled: true } } };
    mocks.passkeys = { ...mocks.passkeys, data: [{ id: 'pk-1' }] };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.status.both')).toBeInTheDocument();
  });

  it('holds the skeleton until the passkey list has resolved', () => {
    mocks.passkeys = { ...mocks.passkeys, data: null, isPending: true };

    render(<PasswordRow />);

    expect(screen.getByTestId('status-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('profile.security.twoFactor.status.off')).toBeNull();
  });

  it('holds the skeleton until the session has resolved', () => {
    mocks.session = { ...mocks.session, data: null, isPending: true };

    render(<PasswordRow />);

    expect(screen.getByTestId('status-skeleton')).toBeInTheDocument();
  });

  it('never claims "off" when the passkey list fails', async () => {
    mocks.passkeys = { ...mocks.passkeys, data: null, error: { message: 'boom' } };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.status.unavailable')).toBeInTheDocument();
    expect(screen.queryByText('profile.security.twoFactor.status.off')).toBeNull();

    // The neutral state is actionable — the row offers the failed query another go.
    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mocks.refetchPasskeys).toHaveBeenCalledTimes(1);
    expect(mocks.refetchSession).not.toHaveBeenCalled();
  });

  it('never claims "off" when the session fails', async () => {
    mocks.session = { ...mocks.session, data: null, error: { message: 'boom' } };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.status.unavailable')).toBeInTheDocument();
    expect(screen.queryByText('profile.security.twoFactor.status.off')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mocks.refetchSession).toHaveBeenCalledTimes(1);
    expect(mocks.refetchPasskeys).not.toHaveBeenCalled();
  });

  it('still reports TOTP when only the passkey list fails', () => {
    mocks.session = { ...mocks.session, data: { user: { twoFactorEnabled: true } } };
    mocks.passkeys = { ...mocks.passkeys, data: null, error: { message: 'boom' } };

    // A confirmed factor stays confirmed: only the "off" claim needs both answers.
    render(<PasswordRow />);

    expect(screen.getByText('profile.security.twoFactor.status.on')).toBeInTheDocument();
    expect(screen.queryByText('profile.security.status.unavailable')).toBeNull();
  });

  it('still reports the passkey when only the session fails', () => {
    mocks.session = { ...mocks.session, data: null, error: { message: 'boom' } };
    mocks.passkeys = { ...mocks.passkeys, data: [{ id: 'pk-1' }] };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.status.passkey')).toBeInTheDocument();
  });

  it('keeps the unsupported status for SSO-only accounts', () => {
    mocks.hasPasswordAccount = false;
    mocks.passkeys = { ...mocks.passkeys, data: [{ id: 'pk-1' }] };

    render(<PasswordRow />);

    expect(screen.getByText('profile.security.twoFactor.status.unsupported')).toBeInTheDocument();
  });
});

describe('PasswordRow SSO explanation', () => {
  const renderSsoRow = () => {
    mocks.hasPasswordAccount = false;
    render(<PasswordRow />);
    const control = screen.getByRole('button', { name: 'profile.security.twoFactor.action' });
    // The trigger is the wrapper, because the button it wraps is disabled.
    const trigger = control.parentElement as HTMLElement;
    return { control, trigger };
  };

  it('puts the explanation for the disabled control in the tab order', async () => {
    const { control, trigger } = renderSsoRow();

    expect(control).toBeDisabled();
    expect(trigger).toHaveAttribute('tabindex', '0');

    // Tab past the one enabled action in the row and the explanation must take the focus —
    // otherwise the reason the control is dead is pointer-only.
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'profile.setPassword' })).toHaveFocus();
    await userEvent.tab();
    expect(trigger).toHaveFocus();
  });

  it('describes the trigger with the reason rather than leaving it unnamed', () => {
    const { trigger } = renderSsoRow();

    const describedBy = trigger.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      'profile.security.twoFactor.ssoHint',
    );
  });
});

describe('PasswordRow reset-link errors', () => {
  const sendResetLink = async () => {
    mocks.hasPasswordAccount = false;
    render(<PasswordRow />);
    await userEvent.click(screen.getByRole('button', { name: 'profile.setPassword' }));
  };

  it('translates a Better Auth code instead of echoing its message', async () => {
    mocks.requestPasswordReset.mockResolvedValue({
      error: { code: 'INVALID_EMAIL', message: 'Invalid email', status: 400 },
    });

    await sendResetLink();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('profile.emailInvalid'));
    // The raw code and the server's English sentence must never reach the toast.
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining('INVALID_EMAIL'));
    expect(mocks.toastError).not.toHaveBeenCalledWith('Invalid email');
  });

  it('translates a rate-limit answer that carries no code at all', async () => {
    mocks.requestPasswordReset.mockResolvedValue({
      error: { message: 'Too many requests. Please try again later.', status: 429 },
    });

    await sendResetLink();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('profile.security.error.tooManyRequests'),
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('Too many requests. Please try again later.');
  });

  it('falls back to its own copy for a code it does not map', async () => {
    mocks.requestPasswordReset.mockResolvedValue({
      error: {
        code: 'FAILED_TO_CREATE_VERIFICATION',
        message: 'Failed to create verification',
        status: 500,
      },
    });

    await sendResetLink();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('profile.resetPasswordError'),
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('Failed to create verification');
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining('FAILED_TO_CREATE_VERIFICATION'),
    );
  });
});
