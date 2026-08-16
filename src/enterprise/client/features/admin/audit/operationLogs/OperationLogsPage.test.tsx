/**
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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

const defaultFacets = {
  actions: [{ count: 3, value: 'admin.users.ban' }],
  results: [{ count: 10, value: 'success' }],
};

const evidence = vi.hoisted(() => ({
  listCalls: [] as unknown[],
  swrKeys: [] as unknown[],
  lastSerializedSwrKey: null as string | null,
  actorPermissions: [] as string[],
  listMock: vi.fn(),
  statsMock: vi.fn(),
  facetsMock: vi.fn(),
  facetsData: {
    actions: [{ count: 3, value: 'admin.users.ban' }],
    results: [{ count: 10, value: 'success' }],
  } as {
    actions: Array<{ count: number; value: string }>;
    results: Array<{ count: number; value: string }>;
  },
  facetsError: undefined as unknown,
  facetsMutate: vi.fn(),
  statsError: undefined as unknown,
  statsMutate: vi.fn(),
  toastError: vi.fn(),
  tableProps: null as null | {
    columns?: Array<{
      dataIndex?: string;
      filterDropdown?: unknown;
      filteredValue?: unknown;
      filters?: Array<{ text: unknown; value: unknown }>;
      key?: string;
    }>;
    cursorPagination?: { onNext: () => void };
    onChange?: (meta: {
      filters: Record<string, unknown>;
      pagination: false;
      sorter: Record<string, never>;
    }) => void;
    toolbar?: unknown;
  },
}));

evidence.listMock.mockImplementation((input?: unknown) => {
  if (input !== undefined) evidence.listCalls.push(structuredClone(input));
  return sampleList;
});
evidence.statsMock.mockResolvedValue({ denied: 1, failure: 2, success: 10, total: 13 });
evidence.facetsMock.mockResolvedValue(defaultFacets);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  m: {
    div: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
  useReducedMotion: () => false,
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
        error: evidence.statsError,
        isLoading: false,
        isValidating: false,
        mutate: evidence.statsMutate,
      };
    }
    if (key0 === 'admin.audit.events.facets') {
      return {
        data: evidence.facetsData,
        error: evidence.facetsError,
        isLoading: false,
        isValidating: false,
        mutate: evidence.facetsMutate,
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

vi.mock('../../primitives/DataTable', async () => {
  const { useState } = await import('react');

  const FilterDropdownHost = ({ col }: { col: any }) => {
    const [selectedKeys, setSelectedKeys] = useState<Array<string | number>>(
      Array.isArray(col.filteredValue) ? [...col.filteredValue] : [],
    );
    if (typeof col.filterDropdown !== 'function') return null;
    return (
      <div data-testid={`dropdown-${col.key ?? col.dataIndex}`}>
        {col.filterDropdown({
          clearFilters: vi.fn(),
          close: vi.fn(),
          confirm: vi.fn(),
          prefixCls: 'test',
          selectedKeys,
          setSelectedKeys,
          visible: true,
        })}
      </div>
    );
  };

  return {
    default: (props: any) => {
      evidence.tableProps = props;
      const { dataSource, emptyDescription, loading, toolbar, columns } = props;
      if (loading) return <div>loading</div>;
      return (
        <div>
          {toolbar ? <div data-testid="table-toolbar">{toolbar}</div> : null}
          <div data-testid="table-columns">
            {(columns ?? []).map((col: any) => {
              const key = String(col.key ?? col.dataIndex);
              return (
                <div
                  data-filtered={JSON.stringify(col.filteredValue ?? null)}
                  data-testid={`col-${key}`}
                  key={key}
                >
                  {col.filters?.map((filter: { text: unknown; value: unknown }) => (
                    <button key={String(filter.value)} type="button">
                      {String(filter.text)}
                    </button>
                  ))}
                  <FilterDropdownHost col={col} />
                </div>
              );
            })}
          </div>
          {!dataSource?.length ? (
            <div>{emptyDescription ?? 'empty'}</div>
          ) : (
            <div data-testid="table-rows">
              {dataSource.map((row: any) => (
                <div data-testid={`row-${row.id}`} key={row.id}>
                  {row.action}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    },
  };
});

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Button: ({ children, ...rest }: any) => <button {...rest}>{children}</button>,
    Input: ({ placeholder, value, onChange, onKeyDown }: any) => (
      <input
        placeholder={placeholder}
        value={value ?? ''}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    ),
    Select: ({ onChange, options, placeholder }: any) => (
      <div data-testid="select">
        <span>{placeholder}</span>
        {(options ?? []).map((option: { label: unknown; value: string }) => (
          <button
            data-testid={`select-opt-${option.value}`}
            key={option.value}
            type="button"
            onClick={() => onChange?.(option.value)}
          >
            {String(option.label)}
          </button>
        ))}
      </div>
    ),
    toast: { error: (...args: unknown[]) => evidence.toastError(...args) },
  };
});

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: ({ onChange, value }: { onChange?: (id?: string) => void; value?: string }) => (
    <button data-testid="user-search" type="button" onClick={() => onChange?.('u-picked')}>
      {value ?? 'none'}
    </button>
  ),
}));

vi.mock('./EventDetailDrawer', () => ({
  default: () => null,
}));

const lastListKey = () => {
  const listKeys = evidence.swrKeys.filter(
    (key) => Array.isArray(key) && key[0] === 'admin.audit.events.list',
  );
  return listKeys.at(-1) as unknown[] | undefined;
};

const emptyColumnFilters = {
  action: null,
  actorUserId: null,
  requestId: null,
  result: null,
  target: null,
};

describe('OperationLogsPage', () => {
  beforeEach(() => {
    evidence.listCalls.length = 0;
    evidence.swrKeys.length = 0;
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = ['platform_audit:read:all'];
    evidence.facetsData = {
      actions: [{ count: 3, value: 'admin.users.ban' }],
      results: [{ count: 10, value: 'success' }],
    };
    evidence.facetsError = undefined;
    evidence.facetsMutate.mockReset();
    evidence.statsError = undefined;
    evidence.statsMutate.mockReset();
    evidence.toastError.mockReset();
    evidence.tableProps = null;
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
    expect(screen.getByTestId('table-toolbar')).toBeTruthy();
    expect(screen.queryByTestId('more-filters')).toBeNull();
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

  it('surfaces partial stats/facet failures and retries both missing sections', async () => {
    evidence.statsError = new Error('stats unavailable');
    evidence.facetsError = new Error('facets unavailable');

    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('audit.logs.summaryUnavailable')).toBeTruthy();
    expect(evidence.toastError).toHaveBeenCalledWith('audit.shared.summaryLoadFailed');

    fireEvent.click(screen.getByText('audit.shared.retryMissingSections'));
    expect(evidence.statsMutate).toHaveBeenCalledTimes(1);
    expect(evidence.facetsMutate).toHaveBeenCalledTimes(1);
  });

  it('drives the list SWR key from column filters and resets the cursor', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(lastListKey()?.[2]).toBe('');
    });

    act(() => {
      evidence.tableProps?.cursorPagination?.onNext();
    });

    await waitFor(() => {
      expect(lastListKey()?.[11]).toBe('cursor-2');
    });

    act(() => {
      evidence.tableProps?.onChange?.({
        filters: { ...emptyColumnFilters, action: ['admin.users.ban'] },
        pagination: false,
        sorter: {},
      });
    });

    await waitFor(() => {
      const key = lastListKey();
      expect(key?.[2]).toBe('admin.users.ban');
      expect(key?.[11]).toBe('');
    });
  });

  it('keeps result stat cards and the result column filter on one source of truth', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('stat-total').getAttribute('data-active')).toBe('true');
    });

    fireEvent.click(screen.getByTestId('stat-failure'));

    await waitFor(() => {
      expect(screen.getByTestId('stat-failure').getAttribute('data-active')).toBe('true');
      expect(screen.getByTestId('stat-total').getAttribute('data-active')).toBe('false');
      expect(screen.getByTestId('col-result').dataset.filtered).toBe(JSON.stringify(['failure']));
      expect(lastListKey()?.[8]).toBe('failure');
    });
    expect(screen.getByTestId('stat-failure-label').style.color).toContain('primary');
    expect(screen.getByTestId('stat-failure-value').style.color).toContain('primary');
    expect(screen.getByTestId('stat-success-value').style.color).toContain('success');

    act(() => {
      evidence.tableProps?.onChange?.({
        filters: { ...emptyColumnFilters, result: ['denied'] },
        pagination: false,
        sorter: {},
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('stat-denied').getAttribute('data-active')).toBe('true');
      expect(screen.getByTestId('col-result').dataset.filtered).toBe(JSON.stringify(['denied']));
      expect(lastListKey()?.[8]).toBe('denied');
    });
  });

  it('shows the top 8 action chips and reveals the rest behind a toggle', async () => {
    evidence.facetsData = {
      actions: Array.from({ length: 12 }, (_, index) => ({
        count: 12 - index,
        value: `action.${index}`,
      })),
      results: [{ count: 10, value: 'success' }],
    };

    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('facet-action.0')).toBeTruthy();
    });

    expect(screen.getByTestId('facet-action.7')).toBeTruthy();
    expect(screen.queryByTestId('facet-action.8')).toBeNull();
    expect(screen.getByText('audit.logs.facets.expand')).toBeTruthy();

    fireEvent.click(screen.getByText('audit.logs.facets.expand'));

    expect(screen.getByTestId('facet-action.8')).toBeTruthy();
    expect(screen.getByTestId('facet-action.11')).toBeTruthy();
    expect(screen.getByText('audit.logs.facets.collapse')).toBeTruthy();

    fireEvent.click(screen.getByText('audit.logs.facets.collapse'));
    expect(screen.queryByTestId('facet-action.8')).toBeNull();
  });

  const goToSecondPage = async () => {
    act(() => {
      evidence.tableProps?.cursorPagination?.onNext();
    });
    await waitFor(() => {
      expect(lastListKey()?.[11]).toBe('cursor-2');
    });
  };

  it('wires the actor search dropdown into the list query and resets the cursor', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('user-search')).toBeTruthy();
    });
    await goToSecondPage();

    fireEvent.click(screen.getByTestId('user-search'));

    await waitFor(() => {
      const key = lastListKey();
      expect(key?.[3]).toBe('u-picked');
      expect(key?.[11]).toBe('');
      expect(screen.getByTestId('col-actorUserId').dataset.filtered).toBe(
        JSON.stringify(['u-picked']),
      );
    });
  });

  it('wires the target type/id dropdown into both list params and resets the cursor', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('select-opt-user')).toBeTruthy();
    });
    await goToSecondPage();

    fireEvent.click(screen.getByTestId('select-opt-user'));
    fireEvent.change(screen.getByPlaceholderText('audit.logs.filters.targetId'), {
      target: { value: 'target-99' },
    });
    fireEvent.click(screen.getByText('primitives.columnFilter.apply'));

    await waitFor(() => {
      const key = lastListKey();
      expect(key?.[9]).toBe('target-99');
      expect(key?.[10]).toBe('user');
      expect(key?.[11]).toBe('');
      expect(screen.getByTestId('col-target').dataset.filtered).toBe(
        JSON.stringify(['user', 'target-99']),
      );
    });
  });

  it('wires request-id search into the list query and resets the cursor', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('audit.logs.filters.requestId')).toBeTruthy();
    });
    await goToSecondPage();

    fireEvent.change(screen.getByPlaceholderText('audit.logs.filters.requestId'), {
      target: { value: 'req-xyz' },
    });
    fireEvent.click(screen.getByText('primitives.columnFilter.search'));

    await waitFor(() => {
      const key = lastListKey();
      expect(key?.[6]).toBe('req-xyz');
      expect(key?.[11]).toBe('');
      expect(screen.getByTestId('col-requestId').dataset.filtered).toBe(
        JSON.stringify(['req-xyz']),
      );
    });
  });

  it('toggles a chip into the action column filter and the list query', async () => {
    render(
      <MemoryRouter>
        <OperationLogsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('facet-admin.users.ban')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('facet-admin.users.ban'));

    await waitFor(() => {
      expect(screen.getByTestId('col-action').dataset.filtered).toBe(
        JSON.stringify(['admin.users.ban']),
      );
      expect(lastListKey()?.[2]).toBe('admin.users.ban');
    });
  });
});
