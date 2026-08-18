/**
 * Security section facts + the disabled-state rules for credential recovery.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SecuritySection, { resolveDisableTwoFactorDisabledReason } from './SecuritySection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'num' in opts ? `${key}:${opts.num}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <div data-tooltip={title}>{children}</div>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const baseUser = {
  hasPassword: true,
  isSelf: false,
  passkeyCount: 0,
  twoFactorEnabled: false,
} as never;

const user = (overrides: Record<string, unknown> = {}) =>
  ({ ...(baseUser as object), ...overrides }) as never;

describe('resolveDisableTwoFactorDisabledReason', () => {
  it('is live unless the detail is stale', () => {
    expect(resolveDisableTwoFactorDisabledReason({ isLive: true })).toBeNull();
    expect(resolveDisableTwoFactorDisabledReason({ isLive: false })).toBe(
      'users.stale.refreshFailed',
    );
  });
});

describe('SecuritySection', () => {
  it('renders the three facts for a credential user with 2FA off', () => {
    render(<SecuritySection canManageCredentials={false} user={user()} />);
    expect(screen.getByText('users.security.password.label')).toBeTruthy();
    expect(screen.getByText('users.security.twoFactor.label')).toBeTruthy();
    expect(screen.getByText('users.security.passkey.label')).toBeTruthy();
    expect(screen.getByText('users.security.password.set')).toBeTruthy();
    expect(screen.getByText('users.security.twoFactor.off')).toBeTruthy();
    expect(screen.getByText('users.security.passkey.none')).toBeTruthy();
  });

  it('reports the password as not set for an SSO-only target', () => {
    render(<SecuritySection canManageCredentials={false} user={user({ hasPassword: false })} />);
    expect(screen.getByText('users.security.password.notSet')).toBeTruthy();
    // The password fact never borrows the two-factor on/off labels.
    expect(screen.queryByText('users.security.twoFactor.on')).toBeNull();
  });

  it('counts passkeys with the interpolated key', () => {
    render(<SecuritySection canManageCredentials={false} user={user({ passkeyCount: 3 })} />);
    expect(screen.getByText('users.security.passkey.count:3')).toBeTruthy();
  });

  it('hides the recovery action without the credential permission', () => {
    render(
      <SecuritySection
        canManageCredentials={false}
        user={user({ twoFactorEnabled: true })}
        onDisableTwoFactor={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'users.security.twoFactor.action' })).toBeNull();
  });

  it('offers no credential-recovery action when there is nothing to clear', () => {
    render(<SecuritySection canManageCredentials user={user()} />);
    expect(screen.queryByRole('button', { name: 'users.security.twoFactor.action' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.security.passkey.action' })).toBeNull();
  });

  // Changing a password is an account action, not a security fact — it lives in 账户操作.
  it('never renders the change-password button', () => {
    render(
      <SecuritySection
        canManageCredentials
        user={user({ twoFactorEnabled: true })}
        onDisableTwoFactor={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'users.security.password.action' })).toBeNull();
    // …while the fact it reports stays.
    expect(screen.getByText('users.security.password.set')).toBeTruthy();
  });

  it('offers the two-factor wording when two-step verification is on', () => {
    render(
      <SecuritySection
        canManageCredentials
        user={user({ twoFactorEnabled: true })}
        onDisableTwoFactor={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'users.security.twoFactor.action' })).toBeTruthy();
  });

  // The lockout-recovery gap: a passkey-only user who lost their device had no
  // action at all, because the gate read `twoFactorEnabled` alone.
  it('offers passkey-only wording for a passkey user with 2FA off', () => {
    render(
      <SecuritySection
        canManageCredentials
        user={user({ passkeyCount: 1 })}
        onDisableTwoFactor={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'users.security.passkey.action' })).toBeTruthy();
    // …and never names a factor the account does not have
    expect(screen.queryByRole('button', { name: 'users.security.twoFactor.action' })).toBeNull();
  });

  it('disables recovery when the detail is stale (no handler passed)', () => {
    render(<SecuritySection canManageCredentials user={user({ twoFactorEnabled: true })} />);
    const twoFactor = screen.getByRole('button', { name: 'users.security.twoFactor.action' });
    expect(twoFactor.hasAttribute('disabled')).toBe(true);
    expect(twoFactor.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.stale.refreshFailed',
    );
  });

  it('fires the recovery handler when the action is live', () => {
    const onDisableTwoFactor = vi.fn();
    render(
      <SecuritySection
        canManageCredentials
        user={user({ passkeyCount: 2, twoFactorEnabled: true })}
        onDisableTwoFactor={onDisableTwoFactor}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'users.security.twoFactor.action' }));
    expect(onDisableTwoFactor).toHaveBeenCalledTimes(1);
  });
});
