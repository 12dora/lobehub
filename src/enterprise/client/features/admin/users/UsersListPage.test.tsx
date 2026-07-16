/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

const listMock = vi.fn();
const mutateMock = vi.fn();
const swrKeys: unknown[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher?: () => Promise<unknown>) => {
    swrKeys.push(key);
    if (key && fetcher) {
      void Promise.resolve().then(() => fetcher());
    }
    return {
      data: listMock(),
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mutateMock,
    };
  },
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: {
    list: (...args: unknown[]) => {
      listMock(...args);
      return listMock();
    },
  },
}));

// Real FilterBar — do not mock (UI-R2-03)
vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, title, toolbar }: any) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
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
                aria-label={`user-row-${row.id}`}
                type="button"
                onClick={() => onRowActivate?.(row)}
              >
                {row.email ?? row.id}
              </button>
              <span data-testid={`providers-${row.id}`}>{row.providerIds?.join(',')}</span>
            </li>
          ))}
        </ul>
        <button
          disabled={!cursorPagination?.hasNext}
          type="button"
          onClick={cursorPagination?.onNext}
        >
          next
        </button>
        <button type="button" onClick={() => cursorPagination?.onPageSizeChange?.(20)}>
          page-size-20
        </button>
      </div>
    );
  },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Avatar: () => null,
    DatePicker: ({ onChange, 'aria-label': aria, placeholder }: any) =>
      React.createElement(
        'button',
        {
          'type': 'button',
          'aria-label': aria || placeholder,
          'onClick': () => {
            const dayjs = require('dayjs');
            onChange?.(dayjs('2024-01-15'));
          },
        },
        aria || placeholder,
      ),
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
    SearchBar: ({ value, onInputChange, placeholder }: any) =>
      React.createElement('input', {
        'aria-label': placeholder || 'search',
        'value': value ?? '',
        'onChange': (e: any) => onInputChange?.(e.target.value),
      }),
    Tag: ({ children }: any) => React.createElement('span', null, children),
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, onClick, ...rest }: any) =>
      React.createElement('button', { type: 'button', onClick, ...rest }, children),
    Select: ({ onChange, placeholder, 'aria-label': aria, value }: any) =>
      React.createElement(
        'select',
        {
          'aria-label': aria || placeholder,
          'value': value ?? '',
          'onChange': (e: any) => onChange?.(e.target.value || undefined),
        },
        React.createElement('option', { value: '' }, 'all'),
        React.createElement('option', { value: 'active' }, 'active'),
        React.createElement('option', { value: 'banned' }, 'banned'),
        React.createElement('option', { value: 'user_admin' }, 'user_admin'),
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

describe('UsersListPage filters', () => {
  beforeEach(() => {
    listMock.mockReset();
    mutateMock.mockReset();
    swrKeys.length = 0;
    listMock.mockReturnValue(sampleList);
  });

  it('renders list and navigates via labeled row', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route element={<UsersListPage />} path="/admin/users" />
          <Route element={<div>detail-u1</div>} path="/admin/users/:id" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'users.list.title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'user-row-u1' }));
    await waitFor(() => expect(screen.getByText('detail-u1')).toBeTruthy());
  });

  it('shows Clear for status-only filter and clear-all resets payload', async () => {
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('users.list.filters.status'), {
      target: { value: 'banned' },
    });

    await waitFor(() => {
      expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('primitives.filterBar.clear'));

    await waitFor(() => {
      const last = [...listMock.mock.calls].reverse().find((c) => c[0]);
      expect(last?.[0]).toMatchObject({
        status: undefined,
      });
    });
  });

  it('createdFrom DatePicker sends ISO createdFrom to list service', async () => {
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText('users.list.filters.createdFrom'));

    await waitFor(() => {
      const withFrom = listMock.mock.calls.find(
        (c) => c[0] && (c[0] as { createdFrom?: Date }).createdFrom instanceof Date,
      );
      expect(withFrom).toBeTruthy();
      const from = (withFrom![0] as { createdFrom: Date }).createdFrom;
      // dayjs startOf('day') is local; assert calendar day in local zone
      expect(from.getFullYear()).toBe(2024);
      expect(from.getMonth()).toBe(0);
      expect(from.getDate()).toBe(15);
    });
  });

  it('second-page then filter change issues request without cursor', async () => {
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      expect(
        listMock.mock.calls.some((c) => (c[0] as { cursor?: string })?.cursor === 'cursor-2'),
      ).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('users.list.filters.role'), {
      target: { value: 'user_admin' },
    });

    await waitFor(() => {
      const after = [...listMock.mock.calls]
        .reverse()
        .find((c) => (c[0] as { role?: string })?.role === 'user_admin');
      expect(after?.[0]).toMatchObject({ role: 'user_admin' });
      expect((after?.[0] as { cursor?: string }).cursor).toBeUndefined();
    });
  });
});
