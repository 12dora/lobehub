/**
 * Users list: offset pagination, toolbar search, column filters, actions, self-guard.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

const sampleList = {
  items: [
    {
      avatar: null,
      dingtalkTitle: null,
      createdAt: new Date('2024-01-01'),
      email: 'alice@example.com',
      fullName: 'Alice',
      id: 'u1',
      lastActiveAt: null,
      providerIds: ['credential'],
      roles: ['user_admin'],
      status: 'active' as const,
      username: 'alice',
    },
    {
      avatar: null,
      dingtalkTitle: '高级工程师',
      createdAt: new Date('2024-01-02'),
      email: 'carol@example.com',
      fullName: 'Carol',
      id: 'u2',
      lastActiveAt: null,
      providerIds: ['corp-oidc'],
      roles: ['platform_user'],
      status: 'active' as const,
      username: 'carol',
    },
  ],
  nextCursor: null,
  total: 40,
};

const evidence = vi.hoisted(() => ({
  actorPermissions: [] as string[],
  currentUserId: 'admin-self',
  lastSerializedSwrKey: null as string | null,
  listCalls: [] as unknown[],
  listMock: vi.fn(),
  mutateMock: vi.fn(),
  openBan: vi.fn(),
  openBulkBan: vi.fn(),
  openBulkDelete: vi.fn(),
  openBulkRoles: vi.fn(),
  openBulkUnban: vi.fn(),
  openCreateUserModalMock: vi.fn(),
  openDelete: vi.fn(),
  openRoles: vi.fn(),
  openUnban: vi.fn(),
  swrKeys: [] as unknown[],
}));

const { listCalls, swrKeys, mutateMock, listMock } = evidence;

listMock.mockImplementation((input?: unknown) => {
  if (input !== undefined) listCalls.push(structuredClone(input));
  return sampleList;
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { count?: number; defaultValue?: string; name?: string }) => {
      if (opts?.count != null && k === 'users.list.selectedCount') return `selected-${opts.count}`;
      // Interpolated names are appended so per-user labels stay distinguishable.
      if (opts?.name != null) return `${k}:${opts.name}`;
      return opts?.defaultValue ?? k;
    },
  }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher?: () => Promise<unknown>) => {
    if (key != null) {
      const serialized = JSON.stringify(key);
      if (serialized !== evidence.lastSerializedSwrKey) {
        evidence.lastSerializedSwrKey = serialized;
        evidence.swrKeys.push(Array.isArray(key) ? [...key] : key);
        if (fetcher) {
          void Promise.resolve().then(() => fetcher());
        }
      }
    }
    return {
      data: sampleList,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: evidence.mutateMock,
    };
  },
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: {
    list: (input: unknown) => {
      evidence.listMock(input);
      return Promise.resolve(sampleList);
    },
  },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: evidence.actorPermissions,
    roles: [{ name: 'user_admin' }],
  }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: { user?: { id?: string } }) => unknown) =>
    selector({ user: { id: evidence.currentUserId } }),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: {
    userId: (s: { user?: { id?: string } }) => s.user?.id,
  },
}));

vi.mock('./modals/CreateUserModal', () => ({
  openCreateUserModal: (params: unknown) => evidence.openCreateUserModalMock(params),
}));

vi.mock('./modals/actions', () => ({
  openBanUserModal: (params: unknown) => evidence.openBan(params),
  openDeleteUserModal: (params: unknown) => evidence.openDelete(params),
  openReplaceRolesModal: (params: unknown) => evidence.openRoles(params),
  openUnbanUserModal: (params: unknown) => evidence.openUnban(params),
}));

vi.mock('./detail/UserDetailDrawer', () => ({
  default: ({ onClose, open, userId }: any) =>
    open ? (
      <div data-testid="user-detail-drawer" data-user-id={userId}>
        <button type="button" onClick={onClose}>
          close-drawer
        </button>
      </div>
    ) : null,
}));

vi.mock('./modals/bulkActions', () => ({
  openBulkBanModal: (params: unknown) => evidence.openBulkBan(params),
  openBulkDeleteModal: (params: unknown) => evidence.openBulkDelete(params),
  openBulkReplaceRolesModal: (params: unknown) => evidence.openBulkRoles(params),
  openBulkUnbanModal: (params: unknown) => evidence.openBulkUnban(params),
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, children, title }: any) => (
    <div>
      <h1>{title}</h1>
      {actions ? <div data-testid="actions">{actions}</div> : null}
      {children}
    </div>
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({
  default: ({ status }: any) => <span>{status}</span>,
}));

vi.mock('../primitives/columnFilters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dateRangeColumnFilter: ({ onChange }: any) => ({
      filterDropdown: () => (
        <button
          aria-label="users.list.columns.createdAt"
          type="button"
          onClick={() => {
            onChange?.([new Date(2024, 0, 15), new Date(2024, 0, 31)]);
          }}
        >
          date-range
        </button>
      ),
    }),
    enumColumnFilter: ({ value }: any) => ({
      filteredValue: value ? [value] : null,
    }),
  };
});

vi.mock('../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
    emptyDescription,
    error,
    loading,
    onChange,
    onPaginationChange,
    pagination,
    rowSelection,
    toolbar,
  }: any) => {
    if (loading) return <div>loading</div>;
    if (error) return <div role="alert">error</div>;
    return (
      <div>
        {toolbar ? <div data-testid="table-toolbar">{toolbar}</div> : null}
        {!dataSource?.length ? (
          <div>{emptyDescription ?? 'empty'}</div>
        ) : (
          <div data-testid="table-rows">
            {dataSource.map((row: any) => {
              const checkboxProps = rowSelection?.getCheckboxProps?.(row) ?? {};
              return (
                <div data-testid={`row-${row.id}`} key={row.id}>
                  <input
                    aria-label={`select-${row.id}`}
                    checked={Boolean(rowSelection?.selectedRowKeys?.includes(row.id))}
                    disabled={checkboxProps.disabled}
                    title={checkboxProps.title}
                    type="checkbox"
                    onChange={(event) => {
                      const keys = new Set<string>(rowSelection?.selectedRowKeys ?? []);
                      if (event.target.checked) keys.add(row.id);
                      else keys.delete(row.id);
                      const nextKeys = [...keys];
                      const nextRows = dataSource.filter((item: any) => nextKeys.includes(item.id));
                      rowSelection?.onChange?.(nextKeys, nextRows);
                    }}
                  />
                  {(columns as any[] | undefined)?.map((col) => {
                    const value = col.dataIndex != null ? row[col.dataIndex] : undefined;
                    const content = col.render ? col.render(value, row) : value;
                    return (
                      <div
                        data-testid={`cell-${String(col.key ?? col.dataIndex)}`}
                        key={String(col.key ?? col.dataIndex)}
                      >
                        {content}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {(columns as any[] | undefined)
          ?.filter((col) => typeof col.filterDropdown === 'function')
          .map((col) => (
            <div data-testid={`filter-${String(col.key)}`} key={`filter-${String(col.key)}`}>
              {col.filterDropdown({})}
            </div>
          ))}
        {pagination ? (
          <div>
            <span data-testid="page">{pagination.current}</span>
            <span data-testid="page-size">{pagination.pageSize}</span>
            <span data-testid="total">{pagination.total}</span>
            <button
              type="button"
              onClick={() => onPaginationChange?.(pagination.current + 1, pagination.pageSize)}
            >
              next
            </button>
            <button type="button" onClick={() => onPaginationChange?.(1, 20)}>
              page-size-20
            </button>
          </div>
        ) : null}
        <button
          aria-label="filter-status"
          type="button"
          onClick={() =>
            onChange?.({
              filters: { status: ['banned'] },
              pagination: false,
              sorter: {},
            })
          }
        >
          filter-status
        </button>
        <button
          aria-label="filter-role"
          type="button"
          onClick={() =>
            onChange?.({
              filters: { roles: ['user_admin'] },
              pagination: false,
              sorter: {},
            })
          }
        >
          filter-role
        </button>
        <button
          aria-label="filter-source"
          type="button"
          onClick={() =>
            onChange?.({
              filters: { source: ['sso'] },
              pagination: false,
              sorter: {},
            })
          }
        >
          filter-source
        </button>
      </div>
    );
  },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Alert: ({ message, action, ...rest }: any) =>
      React.createElement(
        'div',
        { 'role': 'status', 'data-testid': 'stale-alert', ...rest },
        message,
        action,
      ),
    Avatar: () => null,
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    SearchBar: ({ value, onInputChange, placeholder }: any) =>
      React.createElement('input', {
        'aria-label': placeholder || 'search',
        'value': value ?? '',
        'onChange': (e: any) => onInputChange?.(e.target.value),
      }),
    Tag: ({ children, ...rest }: any) => React.createElement('span', rest, children),
    Text: ({ children }: any) => React.createElement('span', null, children),
    Tooltip: ({ children, title }: any) =>
      React.createElement('div', { 'data-tooltip': title }, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, onClick, disabled, ...rest }: any) =>
      React.createElement('button', { type: 'button', onClick, disabled, ...rest }, children),
  };
});

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

/**
 * buildAdminUsersListKey:
 * [KEY, query, status, role, from, to, offset, limit, source, cursor]
 */
const offsetFromKey = (key: unknown) => (Array.isArray(key) ? key[6] : undefined);
const queryFromKey = (key: unknown) => (Array.isArray(key) ? key[1] : undefined);

describe('UsersListPage offset list + toolbar search', () => {
  beforeEach(() => {
    listMock.mockClear();
    listCalls.length = 0;
    swrKeys.length = 0;
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = [];
    evidence.currentUserId = 'admin-self';
    evidence.openCreateUserModalMock.mockReset();
    evidence.openBan.mockReset();
    evidence.openUnban.mockReset();
    evidence.openDelete.mockReset();
    evidence.openRoles.mockReset();
    evidence.openBulkBan.mockReset();
    evidence.openBulkUnban.mockReset();
    evidence.openBulkDelete.mockReset();
    evidence.openBulkRoles.mockReset();
    mutateMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    sampleList.total = 40;
    vi.useRealTimers();
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

  it('requests offset pagination with default page size 20 and a total', async () => {
    renderPage();
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    expect(listCalls[0]).toMatchObject({ limit: 20, offset: 0 });
    expect((listCalls[0] as { cursor?: string }).cursor).toBeUndefined();
    expect(screen.getByTestId('page-size').textContent).toBe('20');
    expect(screen.getByTestId('total').textContent).toBe('40');
  });

  it('clamps an out-of-range page back to the last page', async () => {
    sampleList.total = 2;
    renderPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      expect(screen.getByTestId('page').textContent).toBe('1');
    });
    sampleList.total = 40;
  });

  it('renders job title column with title text or em dash when empty', () => {
    renderPage();
    const emptyTitle = within(screen.getByTestId('row-u1')).getByTestId('cell-dingtalkTitle');
    expect(emptyTitle.textContent).toBe('—');
    const titled = within(screen.getByTestId('row-u2')).getByTestId('cell-dingtalkTitle');
    expect(titled.textContent).toBe('高级工程师');
  });

  it('from page 2, search edit yields exactly one list call and one SWR key after debounce', async () => {
    renderPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect(listCalls.some((c) => (c as { offset?: number }).offset === 20)).toBe(true),
    );

    listCalls.length = 0;
    swrKeys.length = 0;

    fireEvent.change(screen.getByLabelText('users.list.searchPlaceholder'), {
      target: { value: 'alice' },
    });
    expect(listCalls).toEqual([]);
    expect(swrKeys).toEqual([]);

    await vi.advanceTimersByTimeAsync(350);

    await waitFor(() => {
      expect(listCalls.length).toBe(1);
      expect(swrKeys.length).toBe(1);
    });

    expect(listCalls[0]).toMatchObject({ offset: 0, query: 'alice' });
    expect(queryFromKey(swrKeys[0])).toBe('alice');
    expect(offsetFromKey(swrKeys[0])).toBe(0);
  });

  it('status / role / source / date / page-size each reset to offset 0', async () => {
    renderPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect((listCalls.at(-1) as { offset?: number }).offset).toBe(20));

    fireEvent.click(screen.getByLabelText('filter-status'));
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ offset: 0, status: 'banned' }));

    fireEvent.click(screen.getByText('next'));
    fireEvent.click(screen.getByLabelText('filter-role'));
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ offset: 0, role: 'user_admin' }));

    fireEvent.click(screen.getByText('next'));
    fireEvent.click(screen.getByLabelText('filter-source'));
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ offset: 0, source: 'sso' }));

    fireEvent.click(screen.getByText('next'));
    fireEvent.click(screen.getByLabelText('users.list.columns.createdAt'));
    await waitFor(() => {
      const last = listCalls.at(-1) as { createdFrom?: Date; createdTo?: Date; offset?: number };
      expect(last.offset).toBe(0);
      expect(last.createdFrom).toBeInstanceOf(Date);
      expect(last.createdTo).toBeInstanceOf(Date);
      expect(last.createdFrom!.getHours()).toBe(0);
      expect(last.createdFrom!.getDate()).toBe(15);
      expect(last.createdTo!.getHours()).toBe(23);
      expect(last.createdTo!.getDate()).toBe(31);
    });
  });
});

describe('UsersListPage create-user entry (USER_CREATE gate)', () => {
  beforeEach(() => {
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = [];
    evidence.openCreateUserModalMock.mockReset();
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

  it('hides the create button without USER_CREATE', () => {
    evidence.actorPermissions = ['platform_user:delete:all'];
    renderPage();
    expect(screen.queryByText('users.list.create')).toBeNull();
    expect(screen.queryByTestId('actions')).toBeNull();
  });

  it('shows the create button with USER_CREATE and opens the modal on click', () => {
    evidence.actorPermissions = ['platform_user:create:all'];
    renderPage();

    const button = screen.getByText('users.list.create');
    fireEvent.click(button);
    expect(evidence.openCreateUserModalMock).toHaveBeenCalledTimes(1);
    const params = evidence.openCreateUserModalMock.mock.calls[0][0] as {
      authMethod?: string;
      onSubmit?: unknown;
    };
    expect(params.authMethod).toBe('better-auth');
    expect(typeof params.onSubmit).toBe('function');
  });
});

describe('UsersListPage source tags (local / SSO)', () => {
  beforeEach(() => {
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = [];
    sampleList.items[0].providerIds = ['credential'];
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

  it('shows only Local user for credential-only accounts', () => {
    sampleList.items[0].providerIds = ['credential'];
    renderPage();

    const cell = within(screen.getByTestId('row-u1')).getByTestId('cell-source');
    expect(within(cell).getByTestId('user-source-local')).toBeTruthy();
    expect(within(cell).queryByTestId('user-source-sso')).toBeNull();
  });

  it('shows only SSO user for non-credential provider accounts', () => {
    sampleList.items[0].providerIds = ['authentik'];
    renderPage();

    const cell = within(screen.getByTestId('row-u1')).getByTestId('cell-source');
    expect(within(cell).queryByTestId('user-source-local')).toBeNull();
    expect(within(cell).getByTestId('user-source-sso')).toBeTruthy();
  });

  it('shows both Local and SSO tags when credential and SSO are linked', () => {
    sampleList.items[0].providerIds = ['credential', 'authentik'];
    renderPage();

    const cell = within(screen.getByTestId('row-u1')).getByTestId('cell-source');
    expect(within(cell).getByTestId('user-source-local')).toBeTruthy();
    expect(within(cell).getByTestId('user-source-sso')).toBeTruthy();
  });
});

describe('UsersListPage actions + self protection + bulk', () => {
  const renderPage = () =>
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

  beforeEach(() => {
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = [
      'platform_user:ban:all',
      'platform_user:delete:all',
      'platform_user:role_manage:all',
    ];
    evidence.currentUserId = 'u1';
    evidence.openBan.mockReset();
    evidence.openBulkBan.mockReset();
    evidence.openBulkDelete.mockReset();
    evidence.openRoles.mockReset();
  });

  it('renders the actions column and opens row modals for other users', () => {
    renderPage();
    expect(within(screen.getByTestId('row-u2')).getByTestId('cell-actions')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('row-u2')).getByText('users.list.actions.roles'));
    expect(evidence.openRoles).toHaveBeenCalledTimes(1);
    expect(evidence.openRoles.mock.calls[0][0]).toMatchObject({ userId: 'u2' });

    fireEvent.click(within(screen.getByTestId('row-u2')).getByText('users.list.actions.ban'));
    expect(evidence.openBan).toHaveBeenCalledTimes(1);
    expect(evidence.openBan.mock.calls[0][0]).toMatchObject({ userId: 'u2' });
  });

  it('leads the row actions with Edit, which opens the detail panel', () => {
    renderPage();
    const actionsCell = within(screen.getByTestId('row-u2')).getByTestId('cell-actions');
    const labels = [...actionsCell.querySelectorAll('button')].map((node) => node.textContent);
    expect(labels).toEqual([
      'users.list.actions.edit',
      'users.list.actions.roles',
      'users.list.actions.ban',
      'users.list.actions.delete',
    ]);

    fireEvent.click(within(actionsCell).getByText('users.list.actions.edit'));
    expect(screen.getByTestId('user-detail-drawer').dataset.userId).toBe('u2');
  });

  it('keeps Edit enabled on the row of the signed-in admin', () => {
    renderPage();
    const selfEdit = within(screen.getByTestId('row-u1')).getByText('users.list.actions.edit');
    expect((selfEdit as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the self-row checkbox and self-row actions', () => {
    renderPage();
    const selfCheckbox = screen.getByLabelText('select-u1') as HTMLInputElement;
    expect(selfCheckbox.disabled).toBe(true);
    expect(selfCheckbox.title).toBe('users.list.selfActionDisabled');

    const otherCheckbox = screen.getByLabelText('select-u2') as HTMLInputElement;
    expect(otherCheckbox.disabled).toBe(false);

    const selfBan = within(screen.getByTestId('row-u1')).getByText('users.list.actions.ban');
    expect((selfBan as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(selfBan);
    expect(evidence.openBan).not.toHaveBeenCalled();
  });

  it('opens a bulk reason modal for selected non-self rows', () => {
    renderPage();
    fireEvent.click(screen.getByLabelText('select-u2'));
    expect(screen.getByText('selected-1')).toBeTruthy();

    fireEvent.click(screen.getByText('users.list.bulk.ban'));
    expect(evidence.openBulkBan).toHaveBeenCalledTimes(1);
    const params = evidence.openBulkBan.mock.calls[0][0] as {
      actorUserId?: string;
      targets: { id: string }[];
    };
    expect(params.actorUserId).toBe('u1');
    expect(params.targets.map((item) => item.id)).toEqual(['u2']);
  });
});

describe('UsersListPage detail panel (the row Edit action is the only trigger)', () => {
  const LocationProbe = () => {
    const location = useLocation();
    return <span data-testid="location-search">{location.search}</span>;
  };

  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <UsersListPage />
        <LocationProbe />
      </MemoryRouter>,
    );

  beforeEach(() => {
    evidence.lastSerializedSwrKey = null;
    evidence.actorPermissions = [];
    evidence.currentUserId = 'admin-self';
  });

  const editButton = (rowId: string) =>
    within(screen.getByTestId(`row-${rowId}`)).getByText('users.list.actions.edit');

  it('opens the panel from the row Edit action and writes ?user=', () => {
    renderPage();
    expect(screen.queryByTestId('user-detail-drawer')).toBeNull();

    fireEvent.click(editButton('u1'));

    expect(screen.getByTestId('user-detail-drawer').dataset.userId).toBe('u1');
    expect(screen.getByTestId('location-search').textContent).toBe('?user=u1');
  });

  it('opens the panel for the row the action belongs to', () => {
    renderPage();
    fireEvent.click(editButton('u2'));

    expect(screen.getByTestId('user-detail-drawer').dataset.userId).toBe('u2');
    expect(screen.getByTestId('location-search').textContent).toBe('?user=u2');
  });

  it('offers the Edit action on every row, even without any mutation permission', () => {
    renderPage();
    // Viewing a user needs only the read permission the list itself requires.
    expect((editButton('u1') as HTMLButtonElement).disabled).toBe(false);
    expect((editButton('u2') as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the user on every Edit action so rows are distinguishable to a screen reader', () => {
    renderPage();
    expect(editButton('u1').getAttribute('aria-label')).toBe('users.list.actions.editUser:Alice');
    expect(editButton('u2').getAttribute('aria-label')).toBe('users.list.actions.editUser:Carol');
  });

  it('leaves the identity and email cells inert', () => {
    renderPage();
    const row = screen.getByTestId('row-u2');

    for (const key of ['identity', 'email']) {
      const cell = within(row).getByTestId(`cell-${key}`);
      expect(cell.querySelector('[role="button"]')).toBeNull();
      expect(cell.querySelector('[aria-label]')).toBeNull();
      fireEvent.click(cell);
    }

    expect(screen.queryByTestId('user-detail-drawer')).toBeNull();
    expect(screen.getByTestId('location-search').textContent).toBe('');
  });

  it('does nothing when other cells or the row checkbox are clicked', () => {
    renderPage();
    const row = screen.getByTestId('row-u2');
    fireEvent.click(within(row).getByTestId('cell-status'));
    fireEvent.click(within(row).getByTestId('cell-roles'));
    fireEvent.click(within(row).getByTestId('cell-dingtalkTitle'));
    fireEvent.click(within(row).getByTestId('cell-createdAt'));
    fireEvent.click(screen.getByLabelText('select-u2'));

    expect(screen.queryByTestId('user-detail-drawer')).toBeNull();
    expect(screen.getByTestId('location-search').textContent).toBe('');
  });

  it('closing the panel removes the search param', () => {
    renderPage();
    fireEvent.click(editButton('u2'));
    expect(screen.getByTestId('user-detail-drawer')).toBeTruthy();

    fireEvent.click(screen.getByText('close-drawer'));
    expect(screen.queryByTestId('user-detail-drawer')).toBeNull();
    expect(screen.getByTestId('location-search').textContent).toBe('');
  });

  it('restores the panel from a shared ?user= link', () => {
    render(
      <MemoryRouter initialEntries={['/admin/users?user=u2']}>
        <UsersListPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('user-detail-drawer').dataset.userId).toBe('u2');
  });
});
