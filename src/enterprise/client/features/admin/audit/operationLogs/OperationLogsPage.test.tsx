/**
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OperationLogsPage from './OperationLogsPage';

const sampleList = {
  items: [
    {
      action: 'admin.users.ban',
      actorUserId: 'u-admin',
      configRevision: 1,
      createdAt: new Date('2026-01-02T10:00:00.000Z'),
      id: 'evt-1',
      ipHash: 'h',
      reason: 'policy',
      requestId: 'req-abc',
      result: 'success' as const,
      targetId: 'u1',
      targetType: 'user',
      userAgent: 'test',
    },
  ],
  nextCursor: 'cursor-2',
};

const evidence = vi.hoisted(() => ({
  listCalls: [] as unknown[],
  swrKeys: [] as unknown[],
  lastSerializedSwrKey: null as string | null,
  actorPermissions: [] as string[],
  listMock: vi.fn(),
  statsMock: vi.fn(),
  facetsMock: vi.fn(),
}));

evidence.listMock.mockImplementation((input?: unknown) => {
  if (input !== undefined) evidence.listCalls.push(structuredClone(input));
  return sampleList;
});
evidence.statsMock.mockResolvedValue({ denied: 1, failure: 2, success: 10, total: 13 });
evidence.facetsMock.mockResolvedValue({
  actions: [{ count: 3, value: 'admin.users.ban' }],
  results: [{ count: 10, value: 'success' }],
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher?: () => Promise<unknown>) => {
    if (key != null) {
      const serialized = JSON.stringify(key);
      if (serialized !== evidence.lastSerializedSwrKey) {
        evidence.lastSerializedSwrKey = serialized;
        evidence.swrKeys.push(Array.isArray(key) ? [...key] : key);
        if (fetcher) void Promise.resolve().then(() => fetcher());
      }
    }
    const key0 = Array.isArray(key) ? key[0] : null;
    if (key0 === 'admin.audit.events.stats') {
      return {
        data: { denied: 1, failure: 2, success: 10, total: 13 },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    }
    if (key0 === 'admin.audit.events.facets') {
      return {
        data: {
          actions: [{ count: 3, value: 'admin.users.ban' }],
          results: [{ count: 10, value: 'success' }],
        },
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    }
    return {
      data: sampleList,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
}));

vi.mock('@/enterprise/client/services/adminAudit', () => ({
  adminAuditService: {
    getEventFacets: (input: unknown) => evidence.facetsMock(input),
    getEventStats: (input: unknown) => evidence.statsMock(input),
    listEvents: (input: unknown) => {
      evidence.listMock(input);
      return Promise.resolve(sampleList);
    },
  },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: evidence.actorPermissions,
    roles: [],
  }),
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({ children, title, toolbar }: any) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({ dataSource, emptyDescription, loading }: any) => {
    if (loading) return <div>loading</div>;
    if (!dataSource?.length) return <div>{emptyDescription ?? 'empty'}</div>;
    return (
      <div data-testid="table-rows">
        {dataSource.map((row: any) => (
          <div data-testid={`row-${row.id}`} key={row.id}>
            {row.action}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Popover: ({ children, content }: any) => (
      <div data-testid="more-filters">
        {children}
        <div>{content}</div>
      </div>
    ),
  };
});

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Button: ({ children, ...rest }: any) => <button {...rest}>{children}</button>,
    Select: ({ placeholder }: any) => <div data-testid="select">{placeholder}</div>,
  };
});

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: () => <div data-testid="user-search" />,
}));

vi.mock('./EventDetailDrawer', () => ({
  default: () => null,
}));

describe('OperationLogsPage', () => {
  beforeEach(() => {
    evidence.listCalls.length = 0;
    evidence.swrKeys.length = 0;
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = ['platform_audit:read:all'];
  });

  it('renders stats and list rows when AUDIT_READ is granted', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('audit.logs.page.title')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('row-evt-1')).toBeTruthy();
    });
    expect(screen.getByText('admin.users.ban')).toBeTruthy();
  });

  it('does not put list SWR keys when permission is missing', () => {
    evidence.actorPermissions = [];
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );
    const listKeys = evidence.swrKeys.filter(
      (k) => Array.isArray(k) && k[0] === 'admin.audit.events.list',
    );
    expect(listKeys).toHaveLength(0);
  });
});
