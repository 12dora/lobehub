/**
 * Real FilterBar + list filter/cursor tests (UI-R3-03).
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

const listCalls: unknown[] = [];
const listMock = vi.fn((input?: unknown) => {
  if (input !== undefined) listCalls.push(input);
  return sampleList;
});
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
    list: (input: unknown) => {
      listMock(input);
      return Promise.resolve(listMock());
    },
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

vi.mock('../primitives/StatusBadge', () => ({
  default: ({ status }: any) => <span>{status}</span>,
}));

vi.mock('../primitives/DataTable', () => ({
  default: ({ dataSource, cursorPagination, emptyDescription, loading, error }: any) => {
    if (loading) return <div>loading</div>;
    if (error) return <div role="alert">error</div>;
    if (!dataSource?.length) return <div>{emptyDescription ?? 'empty'}</div>;
    return (
      <div>
        <button type="button" onClick={cursorPagination?.onNext}>
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
            // createdFrom → 15th, createdTo → 31st via aria label
            const day = String(aria || '').includes('createdTo') ? 31 : 15;
            onChange?.(dayjs(`2024-01-${day}`));
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
      providerIds: ['credential'],
      roles: ['user_admin'],
      status: 'active' as const,
      username: 'alice',
    },
  ],
  nextCursor: 'cursor-2',
};

const lastListArg = () => listCalls.at(-1) as Record<string, unknown> | undefined;

describe('UsersListPage real FilterBar filters (R3-03)', () => {
  beforeEach(() => {
    listMock.mockClear();
    listCalls.length = 0;
    swrKeys.length = 0;
    mutateMock.mockReset();
    listMock.mockImplementation((input?: unknown) => {
      if (input !== undefined) listCalls.push(input);
      return sampleList;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <UsersListPage />
      </MemoryRouter>,
    );

  it('Clear is visible for status-only and clears status from list payload', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('users.list.filters.status'), {
      target: { value: 'banned' },
    });
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());
    expect(lastListArg()?.status).toBe('banned');

    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => {
      expect(lastListArg()?.status).toBeUndefined();
    });
  });

  it('Clear is visible for role-only and clears role', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('users.list.filters.role'), {
      target: { value: 'user_admin' },
    });
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());
    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => expect(lastListArg()?.role).toBeUndefined());
  });

  it('Clear is visible for created-range-only and clears both dates', async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText('users.list.filters.createdFrom'));
    fireEvent.click(screen.getByLabelText('users.list.filters.createdTo'));
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());

    const withBoth = [...listCalls]
      .reverse()
      .find(
        (c) =>
          (c as { createdFrom?: Date }).createdFrom instanceof Date &&
          (c as { createdTo?: Date }).createdTo instanceof Date,
      ) as { createdFrom: Date; createdTo: Date };
    expect(withBoth).toBeTruthy();
    expect(withBoth.createdFrom.getFullYear()).toBe(2024);
    expect(withBoth.createdFrom.getMonth()).toBe(0);
    expect(withBoth.createdFrom.getDate()).toBe(15);
    expect(withBoth.createdTo.getDate()).toBe(31);

    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => {
      const last = lastListArg();
      expect(last?.createdFrom).toBeUndefined();
      expect(last?.createdTo).toBeUndefined();
    });
  });

  it('second-page then page-size change issues one request without cursor', async () => {
    renderPage();
    const before = listCalls.length;
    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect(listCalls.some((c) => (c as { cursor?: string }).cursor === 'cursor-2')).toBe(true),
    );

    const afterNext = listCalls.length;
    fireEvent.click(screen.getByText('page-size-20'));
    await waitFor(() => {
      const pageSizeCalls = listCalls.slice(afterNext);
      expect(pageSizeCalls.length).toBeGreaterThanOrEqual(1);
      const last = pageSizeCalls.at(-1) as { cursor?: string; limit?: number };
      expect(last.cursor).toBeUndefined();
      expect(last.limit).toBe(20);
      // Exactly one new list invocation for the page-size change (no old-cursor duplicate)
      expect(pageSizeCalls.filter((c) => (c as { limit?: number }).limit === 20)).toHaveLength(1);
    });
    expect(listCalls.length).toBeGreaterThan(before);
  });

  it('debounced query does not keep old cursor', async () => {
    renderPage();
    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect(listCalls.some((c) => (c as { cursor?: string }).cursor === 'cursor-2')).toBe(true),
    );

    fireEvent.change(screen.getByLabelText('users.list.searchPlaceholder'), {
      target: { value: 'alice' },
    });
    await vi.advanceTimersByTimeAsync(350);

    await waitFor(() => {
      const withQuery = [...listCalls]
        .reverse()
        .find((c) => (c as { query?: string }).query === 'alice') as {
        cursor?: string;
        query?: string;
      };
      expect(withQuery?.query).toBe('alice');
      expect(withQuery?.cursor).toBeUndefined();
    });
  });
});
