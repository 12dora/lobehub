// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentModerationRecord } from '@/types/platform/contentModeration';

import RecordsTab, { DEFAULT_RECORDS_PAGE_SIZE } from './RecordsTab';

const record = (patch: Partial<ContentModerationRecord> = {}): ContentModerationRecord =>
  ({
    autoBanned: false,
    categoryScores: { sexual: 0.8 },
    classifierLatencyMs: 320,
    createdAt: new Date('2026-08-17T01:00:00.000Z'),
    effectiveAction: 'block',
    effectiveModel: null,
    effectiveProvider: null,
    error: null,
    hasFullPrompt: false,
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
    userId: 'user-1',
    userSnapshot: { email: 'alice@example.com', fullName: 'Alice', username: 'alice' },
    violationCount: 2,
    ...patch,
  }) as ContentModerationRecord;

const mocks = vi.hoisted(() => ({
  list: {
    data: undefined as { items: unknown[]; total: number } | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  lastInput: undefined as unknown,
  onChange: undefined as ((meta: { filters: Record<string, unknown> }) => void) | undefined,
  dateRangeChange: undefined as ((range: [Date | null, Date | null] | null) => void) | undefined,
  paginationChange: undefined as ((page: number, pageSize: number) => void) | undefined,
}));

vi.mock('../../primitives/columnFilters', () => ({
  dateRangeColumnFilter: ({
    onChange,
  }: {
    onChange: (range: [Date | null, Date | null] | null) => void;
  }) => {
    mocks.dateRangeChange = onChange;
    return {};
  },
  enumColumnFilter: () => ({}),
  searchColumnFilter: () => ({}),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Avatar: ({ avatar }: { avatar?: ReactNode }) => <span data-testid="avatar">{avatar}</span>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../ManageGuard', () => ({
  default: ({ allowed, children }: { allowed: boolean; children: ReactNode }) => (
    <span data-allowed={String(allowed)} data-testid="manage-guard">
      {children}
    </span>
  ),
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
  Input: (props: Record<string, unknown>) => <input {...(props as object)} />,
  Switch: ({ checked, onChange }: { checked?: boolean; onChange?: (v: boolean) => void }) => (
    <input
      checked={Boolean(checked)}
      data-testid="show-allowed"
      type="checkbox"
      onChange={(event) => onChange?.(event.target.checked)}
    />
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../primitives/DataTable', () => ({
  default: (props: {
    columns: {
      key: string;
      render?: (value: unknown, row: ContentModerationRecord) => ReactNode;
      title: ReactNode;
    }[];
    dataSource?: ContentModerationRecord[];
    emptyDescription?: ReactNode;
    onChange?: (meta: { filters: Record<string, unknown> }) => void;
    onPaginationChange?: (page: number, pageSize: number) => void;
    onRowActivate?: (row: ContentModerationRecord) => void;
    toolbar?: ReactNode;
  }) => {
    mocks.onChange = props.onChange;
    mocks.paginationChange = props.onPaginationChange;
    return (
      <div>
        {props.toolbar}
        <div data-testid="columns">{props.columns.map((column) => column.key).join(',')}</div>
        {(props.dataSource ?? []).map((row) => (
          <div data-testid={`cell-user-${row.id}`} key={`user-${row.id}`}>
            {(
              props.columns.find((column) => column.key === 'userId') as {
                render?: (value: unknown, row: ContentModerationRecord) => ReactNode;
              }
            )?.render?.(row.userId, row)}
          </div>
        ))}
        {(props.dataSource ?? []).length === 0 ? (
          <div data-testid="empty">{props.emptyDescription}</div>
        ) : null}
        {(props.dataSource ?? []).map((row) => (
          <button
            data-testid={`row-${row.id}`}
            key={row.id}
            type="button"
            onClick={() => props.onRowActivate?.(row)}
          >
            {row.promptExcerpt}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('./RecordDetailDrawer', () => ({
  default: ({ open, recordId }: { open: boolean; recordId: string | null }) =>
    open ? <div data-testid="drawer">{recordId}</div> : null,
}));

vi.mock('../hooks', () => ({
  invalidateModerationRecords: vi.fn(),
  useModerationRecords: (_enabled: boolean, input: unknown) => {
    mocks.lastInput = input;
    return mocks.list;
  },
}));

vi.mock('../service', () => ({
  adminContentModerationService: { deleteRecords: vi.fn() },
}));
vi.mock('../../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));
vi.mock('../../primitives/runAdminMutation', () => ({ runAdminMutation: vi.fn() }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const renderAt = (path = '/admin/audit/content-moderation?tab=records', canManage = true) =>
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            element: <RecordsTab canBanUsers enabled canManage={canManage} />,
            path: '/admin/audit/content-moderation',
          },
        ],
        { initialEntries: [path] },
      )}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.data = { items: [record()], total: 1 };
  mocks.list.error = undefined;
  mocks.list.isLoading = false;
});

describe('RecordsTab', () => {
  it('renders the §6.2 columns and the returned rows', () => {
    renderAt();
    expect(screen.getByTestId('columns').textContent).toBe(
      'createdAt,userId,effectiveAction,topCategory,topScore,source,requestKind,model,classifierLatencyMs,promptExcerpt',
    );
    expect(screen.getByTestId('row-rec-1')).toBeTruthy();
  });

  it('asks for hits only on the first page by default', () => {
    renderAt();
    expect(mocks.lastInput).toMatchObject({
      includeNonHits: undefined,
      limit: DEFAULT_RECORDS_PAGE_SIZE,
      offset: 0,
    });
  });

  it('maps column-header filters onto the list input', () => {
    renderAt();
    act(() => {
      mocks.onChange?.({
        filters: {
          effectiveAction: ['block'],
          requestKind: ['chat'],
          source: ['keyword'],
          topCategory: ['sexual'],
          userId: ['alice@example.com'],
        },
      });
    });
    expect(mocks.lastInput).toMatchObject({
      actions: ['block'],
      categories: ['sexual'],
      requestKinds: ['chat'],
      sources: ['keyword'],
      userQuery: 'alice@example.com',
    });
  });

  it('drops filter values the server enum does not know', () => {
    renderAt();
    act(() => {
      mocks.onChange?.({ filters: { effectiveAction: ['not-a-real-action'] } });
    });
    expect((mocks.lastInput as { actions?: string[] }).actions).toBeUndefined();
  });

  it('adds allowed records only when the operator asks for them', () => {
    renderAt();
    fireEvent.click(screen.getByTestId('show-allowed'));
    expect(mocks.lastInput).toMatchObject({ includeNonHits: true });
  });

  it('carries a deep-linked userId into the query and offers to clear it', () => {
    renderAt('/admin/audit/content-moderation?tab=records&userId=user-9');
    expect(mocks.lastInput).toMatchObject({ userId: 'user-9' });
    expect(screen.getByText('contentModeration.records.clearUserFilter')).toBeTruthy();
  });

  it('opens the drawer from a deep-linked recordId and from a row click', () => {
    renderAt('/admin/audit/content-moderation?tab=records&recordId=rec-42');
    expect(screen.getByTestId('drawer').textContent).toBe('rec-42');
  });

  it('names the empty state instead of showing a bare table', () => {
    mocks.list.data = { items: [], total: 0 };
    renderAt();
    expect(screen.getByTestId('empty').textContent).toBe('contentModeration.records.empty');
  });

  it('keeps the current page when onChange fires for pagination with unchanged filters', () => {
    renderAt();
    act(() => {
      mocks.onChange?.({ filters: { effectiveAction: ['block'] } });
    });
    expect((mocks.lastInput as { offset: number }).offset).toBe(0);
    // A second identical filter payload (what pagination emits) must not reset the page.
    act(() => {
      mocks.paginationChange?.(2, DEFAULT_RECORDS_PAGE_SIZE);
    });
    expect((mocks.lastInput as { offset: number }).offset).toBe(DEFAULT_RECORDS_PAGE_SIZE);
    act(() => {
      mocks.onChange?.({ filters: { effectiveAction: ['block'] } });
    });
    expect((mocks.lastInput as { offset: number }).offset).toBe(DEFAULT_RECORDS_PAGE_SIZE);
  });

  it('disables bulk delete without the manage permission and explains why', () => {
    renderAt('/admin/audit/content-moderation?tab=records', false);
    const button = screen.getByText(/deleteSelected/) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Never hidden: the guard is rendered and reports the missing permission.
    expect(screen.getByTestId('manage-guard').dataset.allowed).toBe('false');
  });

  it('renders the user cell with an avatar and a link into 用户管理', () => {
    renderAt();
    const cell = screen.getByTestId('cell-user-rec-1');
    expect(cell.querySelector('[data-testid="avatar"]')?.textContent).toBe('A');
    expect(cell.textContent).toContain('alice@example.com');
    expect(cell.querySelector('a')?.getAttribute('href')).toBe('/admin/users/user-1');
  });

  it('does not link the user cell for a record whose user row is gone', () => {
    mocks.list.data = { items: [record({ id: 'rec-2', userId: null })], total: 1 };
    renderAt();
    expect(screen.getByTestId('cell-user-rec-2').querySelector('a')).toBeNull();
  });

  it('opens the drawer from a row click by writing ?recordId=', () => {
    renderAt();
    expect(screen.queryByTestId('drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('row-rec-1'));
    expect(screen.getByTestId('drawer').textContent).toBe('rec-1');
  });

  it('sends a half-open date window that includes the picked end day', () => {
    renderAt();
    act(() => {
      mocks.dateRangeChange?.([new Date(2026, 7, 1), new Date(2026, 7, 2)]);
    });
    const input = mocks.lastInput as { from?: Date; to?: Date };
    expect(input.from?.getDate()).toBe(1);
    expect(input.to?.getDate()).toBe(3);
    expect(input.to?.getHours()).toBe(0);
  });
});
