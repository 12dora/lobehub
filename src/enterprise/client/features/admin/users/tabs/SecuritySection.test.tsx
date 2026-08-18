/**
 * Security section facts + the disabled-state rules for the two credential actions.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SecuritySection, {
  resolveDisableTwoFactorDisabledReason,
  resolveSetPasswordDisabledReason,
} from './SecuritySection';

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

describe('resolveSetPasswordDisabledReason', () => {
  it('is live for a credential target that is not the actor', () => {
    expect(
      resolveSetPasswordDisabledReason({ hasPassword: true, isLive: true, isSelf: false }),
    ).toBeNull();
  });

  it('reports SSO-only before self — the account shape outranks the actor', () => {
    expect(
      resolveSetPasswordDisabledReason({ hasPassword: false, isLive: true, isSelf: true }),
    ).toBe('users.security.password.ssoOnly');
  });

  it('reports self for a credential target that is the actor', () => {
    expect(
      resolveSetPasswordDisabledReason({ hasPassword: true, isLive: true, isSelf: true }),
    ).toBe('users.errors.selfAction');
  });

  it('reports stale data last', () => {
    expect(
      resolveSetPasswordDisabledReason({ hasPassword: true, isLive: false, isSelf: false }),
    ).toBe('users.stale.refreshFailed');
  });
});

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

  it('hides both actions without the credential permission', () => {
    render(
      <SecuritySection
        canManageCredentials={false}
        user={user({ twoFactorEnabled: true })}
        onDisableTwoFactor={vi.fn()}
        onSetPassword={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'users.security.password.action' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.security.twoFactor.action' })).toBeNull();
  });

  it('only offers the two-factor action when two-step verification is on', () => {
    const { rerender } = render(
      <SecuritySection canManageCredentials user={user()} onSetPassword={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'users.security.twoFactor.action' })).toBeNull();

    rerender(
      <SecuritySection
        canManageCredentials
        user={user({ twoFactorEnabled: true })}
        onDisableTwoFactor={vi.fn()}
        onSetPassword={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'users.security.twoFactor.action' })).toBeTruthy();
  });

  it('disables change-password with an explanatory tooltip for SSO-only targets', () => {
    render(
      <SecuritySection
        canManageCredentials
        user={user({ hasPassword: false })}
        onSetPassword={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'users.security.password.action' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.security.password.ssoOnly',
    );
  });

  it('disables change-password for the actor themselves', () => {
    render(
      <SecuritySection
        canManageCredentials
        user={user({ isSelf: true })}
        onSetPassword={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'users.security.password.action' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.errors.selfAction',
    );
  });

  it('disables both actions when the detail is stale (no handler passed)', () => {
    render(<SecuritySection canManageCredentials user={user({ twoFactorEnabled: true })} />);
    const password = screen.getByRole('button', { name: 'users.security.password.action' });
    const twoFactor = screen.getByRole('button', { name: 'users.security.twoFactor.action' });
    expect(password.hasAttribute('disabled')).toBe(true);
    expect(twoFactor.hasAttribute('disabled')).toBe(true);
    expect(password.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.stale.refreshFailed',
    );
  });

  it('fires the handlers when both actions are live', () => {
    const onSetPassword = vi.fn();
    const onDisableTwoFactor = vi.fn();
    render(
      <SecuritySection
        canManageCredentials
        user={user({ passkeyCount: 2, twoFactorEnabled: true })}
        onDisableTwoFactor={onDisableTwoFactor}
        onSetPassword={onSetPassword}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'users.security.password.action' }));
    fireEvent.click(screen.getByRole('button', { name: 'users.security.twoFactor.action' }));
    expect(onSetPassword).toHaveBeenCalledTimes(1);
    expect(onDisableTwoFactor).toHaveBeenCalledTimes(1);
  });
});
