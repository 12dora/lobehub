/**
 * Overview tab: job-title rendering and the 账户操作 block, which now leads with
 * change password.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OverviewTab, { resolveSetPasswordDisabledReason } from './OverviewTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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

vi.mock('../../primitives/StatusBadge', () => ({
  default: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock('../UserSourceTags', () => ({
  default: () => <span data-testid="source-tags" />,
}));

const baseUser = {
  avatar: null,
  banExpires: null,
  banReason: null,
  banned: false,
  createdAt: new Date('2024-01-01'),
  dingtalkTitle: null as string | null,
  email: 'bob@example.com',
  emailVerified: true,
  fullName: 'Bob',
  hasPassword: true,
  id: 'u-bob',
  isSelf: false,
  passkeyCount: 0,
  lastActiveAt: null,
  providers: [] as { providerId: string }[],
  roles: [],
  sessionCount: 0,
  sessions: [],
  status: 'active' as const,
  twoFactorEnabled: false,
  username: 'bob',
};

describe('OverviewTab job title', () => {
  it('shows em dash when dingtalkTitle is null', () => {
    render(<OverviewTab canBan={false} canDelete={false} user={baseUser as never} />);
    expect(screen.getByText('users.overview.jobTitle')).toBeTruthy();
    // Job title dd is the em dash after the jobTitle dt; fullName/status may also use —
    const labels = screen.getAllByText('—');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('renders non-empty job title text', () => {
    render(
      <OverviewTab
        canBan={false}
        canDelete={false}
        user={{ ...baseUser, dingtalkTitle: '高级工程师' } as never}
      />,
    );
    expect(screen.getByText('高级工程师')).toBeTruthy();
  });
});

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

const passwordButton = () => screen.getByRole('button', { name: 'users.security.password.action' });

describe('OverviewTab account actions', () => {
  it('leads the block with change password, before ban and delete', () => {
    render(
      <OverviewTab
        canBan
        canDelete
        canManageCredentials
        user={baseUser as never}
        onBan={vi.fn()}
        onDelete={vi.fn()}
        onSetPassword={vi.fn()}
      />,
    );

    expect(screen.getByText('users.overview.accountActions')).toBeTruthy();
    expect(screen.getAllByRole('button').map((node) => node.textContent)).toEqual([
      'users.security.password.action',
      'users.actions.ban',
      'users.actions.delete',
    ]);
  });

  it('shows the block for an actor who may only manage credentials', () => {
    render(
      <OverviewTab
        canManageCredentials
        canBan={false}
        canDelete={false}
        user={baseUser as never}
        onSetPassword={vi.fn()}
      />,
    );

    expect(screen.getByText('users.overview.accountActions')).toBeTruthy();
    expect(passwordButton().hasAttribute('disabled')).toBe(false);
  });

  it('opens the modal from the account-actions block', () => {
    const onSetPassword = vi.fn();
    render(
      <OverviewTab
        canManageCredentials
        canBan={false}
        canDelete={false}
        user={baseUser as never}
        onSetPassword={onSetPassword}
      />,
    );

    fireEvent.click(passwordButton());
    expect(onSetPassword).toHaveBeenCalledTimes(1);
  });

  it('hides change password without the credential permission', () => {
    render(
      <OverviewTab canBan canDelete user={baseUser as never} onBan={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: 'users.security.password.action' })).toBeNull();
  });

  it('disables change password for an SSO-only target', () => {
    render(
      <OverviewTab
        canManageCredentials
        canBan={false}
        canDelete={false}
        user={{ ...baseUser, hasPassword: false } as never}
        onSetPassword={vi.fn()}
      />,
    );

    expect(passwordButton().hasAttribute('disabled')).toBe(true);
    expect(passwordButton().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.security.password.ssoOnly',
    );
  });

  it('disables change password when the detail is stale', () => {
    render(
      <OverviewTab
        canManageCredentials
        canBan={false}
        canDelete={false}
        user={baseUser as never}
      />,
    );

    expect(passwordButton().hasAttribute('disabled')).toBe(true);
    expect(passwordButton().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.stale.refreshFailed',
    );
  });

  // Ban/delete disappear on your own account; change password stays, disabled, so the
  // rule is visible rather than silently missing.
  it('keeps a disabled change password for the actor themselves', () => {
    render(
      <OverviewTab
        canBan
        canDelete
        canManageCredentials
        user={{ ...baseUser, isSelf: true } as never}
        onBan={vi.fn()}
        onDelete={vi.fn()}
        onSetPassword={vi.fn()}
      />,
    );

    expect(passwordButton().hasAttribute('disabled')).toBe(true);
    expect(passwordButton().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'users.errors.selfAction',
    );
    expect(screen.queryByRole('button', { name: 'users.actions.ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'users.actions.delete' })).toBeNull();
    expect(screen.getByText('users.overview.selfActionsHidden')).toBeTruthy();
  });

  it('drops the ban/delete notice when the actor holds neither permission', () => {
    render(
      <OverviewTab
        canManageCredentials
        canBan={false}
        canDelete={false}
        user={{ ...baseUser, isSelf: true } as never}
        onSetPassword={vi.fn()}
      />,
    );

    expect(screen.queryByText('users.overview.selfActionsHidden')).toBeNull();
    expect(passwordButton()).toBeTruthy();
  });
});
