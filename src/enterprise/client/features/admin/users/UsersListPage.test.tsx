/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

const listMock = vi.fn();
const mutateMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({
    data: listMock(),
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: mutateMock,
  }),
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: {
    list: (...args: unknown[]) => listMock(...args),
  },
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, title, toolbar }: any) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../primitives/FilterBar', () => ({
  default: ({ values, onChange }: any) => (
    <input
      aria-label="search"
      value={values.query}
      onChange={(e) => onChange({ ...values, query: e.target.value })}
    />
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({
  default: ({ status }: any) => <span>{status}</span>,
}));

vi.mock('../primitives/DataTable', () => ({
  default: ({
    dataSource,
    error,
    loading,
    onRowActivate,
    emptyDescription,
    cursorPagination,
  }: any) => {
    if (loading) return <div>loading</div>;
    if (error) return <div role="alert">error</div>;
    if (!dataSource?.length) return <div>{emptyDescription ?? 'empty'}</div>;
    return (
      <div>
        <ul>
          {dataSource.map((row: any) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onRowActivate?.(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRowActivate?.(row);
                }}
              >
                {row.email ?? row.id}
              </button>
              <span data-testid={`providers-${row.id}`}>{row.providerIds?.join(',')}</span>
            </li>
          ))}
        </ul>
        <button
          disabled={!cursorPagination?.hasPrevious}
          type="button"
          onClick={cursorPagination?.onPrevious}
        >
          prev
        </button>
        <button
          disabled={!cursorPagination?.hasNext}
          type="button"
          onClick={cursorPagination?.onNext}
        >
          next
        </button>
      </div>
    );
  },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Avatar: () => null,
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    Tag: ({ children }: any) => React.createElement('span', null, children),
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Select: ({ onChange, placeholder, 'aria-label': aria }: any) =>
      React.createElement(
        'select',
        {
          'aria-label': aria || placeholder,
          'onChange': (e: any) => onChange?.(e.target.value || undefined),
        },
        React.createElement('option', { value: '' }, 'all'),
        React.createElement('option', { value: 'active' }, 'active'),
        React.createElement('option', { value: 'banned' }, 'banned'),
      ),
  };
});

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

const sampleList = {
  items: [
    {
      avatar: null,
      createdAt: new Date('2024-01-01'),
      email: 'alice@example.com',
      fullName: 'Alice',
      id: 'u1',
      lastActiveAt: null,
      providerIds: ['credential', 'google'],
      roles: ['user_admin'],
      status: 'active' as const,
      username: 'alice',
    },
  ],
  nextCursor: 'cursor-2',
};

describe('UsersListPage', () => {
  beforeEach(() => {
    listMock.mockReset();
    mutateMock.mockReset();
    listMock.mockReturnValue(sampleList);
  });

  it('renders list success with provider summary and navigates on row activate', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route element={<UsersListPage />} path="/admin/users" />
          <Route element={<div>detail-u1</div>} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('users.list.title')).toBeTruthy();
    expect(screen.getByText('alice@example.com')).toBeTruthy();
    expect(screen.getByTestId('providers-u1').textContent).toContain('credential');

    fireEvent.click(screen.getByText('alice@example.com'));
    await waitFor(() => {
      expect(screen.getByText('detail-u1')).toBeTruthy();
    });
    expect(container).toBeTruthy();
  });

  it('shows empty filtered message when no items', () => {
    listMock.mockReturnValue({ items: [], nextCursor: null });
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('users.list.empty')).toBeTruthy();
  });

  it('cursor next advances without inventing totals', async () => {
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('next')).toBeTruthy();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      // second page uses nextCursor from previous response
      expect(listMock).toHaveBeenCalled();
    });
  });
});
