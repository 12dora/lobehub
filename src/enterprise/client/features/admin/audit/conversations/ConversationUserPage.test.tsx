/**
 * Conversation-only actors must retain evidence; AUDIT_READ summary is optional.
 * Timeline error must not look empty; nextCursor is reachable.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationUserPage from './ConversationUserPage';

const evidence = vi.hoisted(() => ({
  actorPermissions: [] as string[],
  listEnabled: [] as boolean[],
  summaryEnabled: [] as boolean[],
  timelineEnabled: [] as boolean[],
  timelineInputs: [] as unknown[],
  listData: {
    items: [
      {
        id: 'topic-1',
        model: 'gpt',
        provider: 'openai',
        status: 'active',
        title: 'Hello',
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
    nextCursor: null as string | null,
  },
  listError: undefined as unknown,
  summaryData: undefined as unknown,
  summaryError: undefined as unknown,
  summaryMutate: vi.fn(),
  timelineData: {
    items: [
      {
        id: 'tl-1',
        kind: 'topic' as const,
        title: 'Event 1',
        topicId: 'topic-1',
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
    nextCursor: 'cursor-tl-2' as string | null,
  },
  timelineError: undefined as unknown,
  timelineMutate: vi.fn(),
  isLoadingTimeline: false,
  isValidatingTimeline: false,
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: React.ReactNode; message?: React.ReactNode }) => (
    <div role="alert">
      {message}
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    loading,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button
      data-loading={loading ? '1' : undefined}
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  ),
  toast: { error: (...args: unknown[]) => evidence.toastError(...args) },
}));

vi.mock('antd', () => ({
  DatePicker: {
    RangePicker: () => <div data-testid="range-picker" />,
  },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: evidence.actorPermissions,
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  useFetchAuditConversationsList: (_params: unknown, enabled: boolean) => {
    evidence.listEnabled.push(enabled);
    return {
      data: enabled ? evidence.listData : undefined,
      error: evidence.listError,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
  useFetchAuditUserSummary: (_userId: string, enabled: boolean) => {
    evidence.summaryEnabled.push(enabled);
    return {
      data: enabled ? evidence.summaryData : undefined,
      error: evidence.summaryError,
      isLoading: false,
      isValidating: false,
      mutate: evidence.summaryMutate,
    };
  },
  useFetchAuditUserTimeline: (params: unknown, enabled: boolean) => {
    evidence.timelineEnabled.push(enabled);
    if (enabled) evidence.timelineInputs.push(params);
    return {
      data: enabled ? evidence.timelineData : undefined,
      error: evidence.timelineError,
      isLoading: evidence.isLoadingTimeline,
      isValidating: evidence.isValidatingTimeline,
      mutate: evidence.timelineMutate,
    };
  },
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({ dataSource }: { dataSource?: { id: string; title?: string }[] }) => (
    <div data-testid="topics-table">
      {(dataSource ?? []).map((row) => (
        <div data-testid={`topic-${row.id}`} key={row.id}>
          {row.title}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('./ContentAccessDisabledState', () => ({
  default: () => <div data-testid="content-disabled">disabled</div>,
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/audit/conversations/user-1']}>
      <Routes>
        <Route element={<ConversationUserPage />} path="/admin/audit/conversations/:userId" />
      </Routes>
    </MemoryRouter>,
  );

describe('ConversationUserPage', () => {
  beforeEach(() => {
    evidence.actorPermissions = ['platform_audit:conversation_read:all'];
    evidence.listEnabled.length = 0;
    evidence.summaryEnabled.length = 0;
    evidence.timelineEnabled.length = 0;
    evidence.timelineInputs.length = 0;
    evidence.listError = undefined;
    evidence.summaryError = undefined;
    evidence.timelineError = undefined;
    evidence.summaryData = undefined;
    evidence.summaryMutate.mockReset();
    evidence.timelineData = {
      items: [
        {
          id: 'tl-1',
          kind: 'topic' as const,
          title: 'Event 1',
          topicId: 'topic-1',
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
      nextCursor: 'cursor-tl-2',
    };
    evidence.listData = {
      items: [
        {
          id: 'topic-1',
          model: 'gpt',
          provider: 'openai',
          status: 'active',
          title: 'Hello',
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
    };
    evidence.timelineMutate.mockReset();
    evidence.toastError.mockReset();
    evidence.isLoadingTimeline = false;
    evidence.isValidatingTimeline = false;
  });

  it('conversation-only actor keeps evidence and does not enable AUDIT_READ summary', () => {
    evidence.summaryError = { data: { code: 'FORBIDDEN' } };
    renderPage();

    // Page stays up with topics + timeline.
    expect(screen.queryByTestId('content-disabled')).toBeNull();
    expect(screen.getByTestId('topic-topic-1')).toBeTruthy();
    expect(screen.getByText('Event 1')).toBeTruthy();

    // Summary was never enabled; list + timeline were.
    expect(evidence.summaryEnabled.every((e) => e === false)).toBe(true);
    expect(evidence.listEnabled.some(Boolean)).toBe(true);
    expect(evidence.timelineEnabled.some(Boolean)).toBe(true);
  });

  it('shows timeline retry on hard error instead of emptyTimeline', () => {
    evidence.timelineData = undefined as never;
    evidence.timelineError = new Error('network');
    renderPage();

    expect(screen.getByText('audit.conversations.user.timelineError')).toBeTruthy();
    expect(screen.queryByText('audit.conversations.user.emptyTimeline')).toBeNull();

    fireEvent.click(screen.getByText('audit.conversations.user.timelineRetry'));
    expect(evidence.timelineMutate).toHaveBeenCalled();
  });

  it('shows and retries an unavailable user summary without hiding conversation evidence', () => {
    evidence.actorPermissions = ['platform_audit:conversation_read:all', 'platform_audit:read:all'];
    evidence.summaryError = new Error('summary unavailable');

    renderPage();

    expect(screen.getByText('audit.conversations.user.summaryUnavailable')).toBeTruthy();
    expect(screen.getByTestId('topic-topic-1')).toBeTruthy();
    expect(evidence.toastError).toHaveBeenCalledWith('audit.shared.summaryLoadFailed');

    fireEvent.click(screen.getByText('audit.shared.retryMissingSections'));
    expect(evidence.summaryMutate).toHaveBeenCalledTimes(1);
  });

  it('exposes next/previous page controls and walks the cursor stack both ways', () => {
    renderPage();

    expect(
      (screen.getByText('audit.conversations.user.timelinePrevious') as HTMLButtonElement).disabled,
    ).toBe(true);

    // Initial request has no cursor.
    const first = evidence.timelineInputs[0] as { cursor?: string | null };
    expect(first.cursor == null || first.cursor === null).toBe(true);

    fireEvent.click(screen.getByText('audit.conversations.user.timelineNext'));

    const afterNext = evidence.timelineInputs.at(-1) as { cursor?: string | null };
    expect(afterNext.cursor).toBe('cursor-tl-2');
    expect(
      (screen.getByText('audit.conversations.user.timelinePrevious') as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByText('audit.conversations.user.timelinePrevious'));

    const afterPrev = evidence.timelineInputs.at(-1) as { cursor?: string | null };
    expect(afterPrev.cursor == null || afterPrev.cursor === null).toBe(true);
  });

  it('shows emptyTimeline only after a successful empty response', () => {
    evidence.timelineData = { items: [], nextCursor: null };
    evidence.timelineError = undefined;
    renderPage();
    expect(screen.getByText('audit.conversations.user.emptyTimeline')).toBeTruthy();
  });
});
