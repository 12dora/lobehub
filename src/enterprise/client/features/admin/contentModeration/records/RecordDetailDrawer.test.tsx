// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModerationRecordDetail } from '../types';
import RecordDetailDrawer from './RecordDetailDrawer';

const detail = (patch: Partial<ModerationRecordDetail> = {}): ModerationRecordDetail =>
  ({
    autoBanned: false,
    categoryScores: { sexual: 0.8 },
    classifierLatencyMs: 320,
    createdAt: new Date('2026-08-17T01:00:00.000Z'),
    effectiveAction: 'block',
    effectiveModel: null,
    effectiveProvider: null,
    error: null,
    hasFullPrompt: true,
    id: 'rec-1',
    matchedRule: null,
    messageId: null,
    model: 'gpt-4o',
    notified: false,
    policyAction: 'block',
    promptExcerpt: 'redacted excerpt',
    promptHash: 'hash',
    provider: 'openai',
    requestId: 'req-1',
    requestKind: 'chat',
    revealedAt: null,
    revealedBy: null,
    source: 'keyword',
    thresholdSnapshot: { sexual: { action: 'block', threshold: 0.65 } },
    topCategory: 'sexual',
    topScore: 0.8,
    topicId: null,
    user: {
      avatar: null,
      email: 'renamed@example.com',
      fullName: 'Renamed Person',
      username: 'renamed',
    },
    userId: 'user-1',
    userSnapshot: { email: 'stale@example.com', fullName: 'Stale Name', username: 'stale' },
    violationCount: 2,
    ...patch,
  }) as ModerationRecordDetail;

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteRecords: vi.fn(),
  fetch: {
    data: undefined as ModerationRecordDetail | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  reveal: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('antd', () => ({
  Drawer: ({
    children,
    extra,
    open,
  }: {
    children?: ReactNode;
    extra?: ReactNode;
    open: boolean;
  }) =>
    open ? (
      <div>
        {extra}
        {children}
      </div>
    ) : null,
  Spin: () => <div data-testid="spin" />,
}));
vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: { Block: () => <div data-testid="skeleton" /> },
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../ManageGuard', () => ({
  default: ({ allowed, children }: { allowed: boolean; children: ReactNode }) => (
    <span data-allowed={String(allowed)}>{children}</span>
  ),
}));
vi.mock('./ActionTag', () => ({ default: () => <span data-testid="action-tag" /> }));
vi.mock('./CategoryScoreBars', () => ({ default: () => <div data-testid="score-bars" /> }));

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

vi.mock('../hooks', () => ({
  invalidateModerationRecords: vi.fn(),
  useModerationRecord: () => mocks.fetch,
}));
vi.mock('../service', () => ({
  adminContentModerationService: {
    deleteRecords: (...args: unknown[]) => mocks.deleteRecords(...args),
    revealRecordPrompt: (...args: unknown[]) => mocks.reveal(...args),
  },
}));
vi.mock('../../primitives/DangerConfirm', () => ({
  // Confirm immediately so the test asserts the guarded call, not the modal implementation.
  openDangerConfirm: (options: { onConfirm: () => Promise<void> | void }) => {
    mocks.confirm(options);
    return options.onConfirm();
  },
}));
vi.mock('../../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({ run }: { run: () => Promise<void> }) => {
    await run();
    return true;
  },
}));
vi.mock('../../users/hooks/useAdminUsers', () => ({
  useAdminUserMutations: () => ({ banUser: vi.fn(), unbanUser: vi.fn() }),
}));
vi.mock('../../users/modals/actions', () => ({
  openBanUserModal: vi.fn(),
  openUnbanUserModal: vi.fn(),
}));
vi.mock('../../users/utils', () => ({ formatAdminDateTime: () => '2026-08-17 01:00' }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const renderDrawer = (canManage = true, canBanUsers = true) =>
  render(
    <RecordDetailDrawer
      open
      canBanUsers={canBanUsers}
      canManage={canManage}
      recordId="rec-1"
      onClose={vi.fn()}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.data = detail();
  mocks.fetch.error = undefined;
  mocks.fetch.isLoading = false;
});

describe('RecordDetailDrawer', () => {
  it('prefers the live user row over the stored snapshot', () => {
    renderDrawer();
    expect(screen.getByText('Renamed Person')).toBeTruthy();
    expect(screen.queryByText('Stale Name')).toBeNull();
  });

  it('falls back to the snapshot and flags a deleted user', () => {
    mocks.fetch.data = detail({ user: null });
    renderDrawer();
    const label = screen.getByTestId('record-user-label');
    expect(label.textContent).toContain('Stale Name');
    expect(label.textContent).toContain('contentModeration.records.userDeleted');
  });

  it('reveals the original prompt only behind a confirmation', async () => {
    mocks.reveal.mockResolvedValue({ prompt: 'the original text' });
    renderDrawer();
    fireEvent.click(screen.getByText('contentModeration.records.reveal'));
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith({ id: 'rec-1' }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('the original text')).toBeTruthy());
  });

  it('shows the delete and reveal controls disabled for a read-only admin', () => {
    renderDrawer(false);
    const del = screen.getByText('contentModeration.records.deleteRecord') as HTMLButtonElement;
    const reveal = screen.getByText('contentModeration.records.reveal') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(reveal.disabled).toBe(true);
    // Never hidden — the guard explains the missing permission.
    expect(del.parentElement?.dataset.allowed).toBe('false');
  });

  it('deletes the record through a confirmation', async () => {
    mocks.deleteRecords.mockResolvedValue({ deleted: 1 });
    renderDrawer();
    fireEvent.click(screen.getByText('contentModeration.records.deleteRecord'));
    await waitFor(() => expect(mocks.deleteRecords).toHaveBeenCalledWith({ ids: ['rec-1'] }));
  });

  it('uses the project skeleton while loading, not antd Spin', () => {
    mocks.fetch.data = undefined;
    mocks.fetch.isLoading = true;
    renderDrawer();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('antd-spin')).toBeNull();
  });

  it('offers a retry when the record could not be loaded', () => {
    mocks.fetch.data = undefined;
    mocks.fetch.error = new Error('boom');
    renderDrawer();
    fireEvent.click(screen.getByText('contentModeration.charts.retry'));
    expect(mocks.fetch.mutate).toHaveBeenCalledTimes(1);
  });

  it('disables ban / unban without the user-ban permission', () => {
    renderDrawer(true, false);
    const ban = screen.getByText('contentModeration.records.banUser') as HTMLButtonElement;
    expect(ban.disabled).toBe(true);
    expect(ban.parentElement?.dataset.allowed).toBe('false');
  });
});
