/**
 * Real FilterBar + list filter/cursor tests with SWR key evidence (UI-R4).
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

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

/** Hoisted so vi.mock factories share evidence without TDZ. */
const evidence = vi.hoisted(() => ({
  listCalls: [] as unknown[],
  swrKeys: [] as unknown[],
  mutateMock: vi.fn(),
  /** Real SWR only re-fetches when the key changes. */
  lastSerializedSwrKey: null as string | null,
  listMock: vi.fn(),
}));

const { listCalls, swrKeys, mutateMock, listMock } = evidence;

listMock.mockImplementation((input?: unknown) => {
  if (input !== undefined) listCalls.push(structuredClone(input));
  return sampleList;
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
      // Record + fetch only when key actually changes (SWR semantics).
      // Keys array is therefore a causal fetch-key sequence, not re-render noise.
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
            const isTo = String(aria || '').includes('createdTo');
            const d = dayjs(isTo ? '2024-01-31' : '2024-01-15');
            onChange?.(isTo ? d.endOf('day') : d.startOf('day'));
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

/**
 * buildAdminUsersListKey: [KEY, query, status, role, from, to, cursor, limit]
 * cursor slot is '' when undefined (see UsersListPage).
 */
const cursorFromKey = (key: unknown) => (Array.isArray(key) ? key[6] : undefined);
const isNoCursorKey = (key: unknown) =>
  Array.isArray(key) && (key[6] === '' || key[6] === undefined || key[6] === null);

describe('UsersListPage real FilterBar filters (R4)', () => {
  beforeEach(() => {
    listMock.mockClear();
    listCalls.length = 0;
    swrKeys.length = 0;
    evidence.lastSerializedSwrKey = null;
    mutateMock.mockReset();
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

  const goToSecondPage = async () => {
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      expect(listCalls.some((c) => (c as { cursor?: string }).cursor === 'cursor-2')).toBe(true);
      expect(swrKeys.some((k) => cursorFromKey(k) === 'cursor-2')).toBe(true);
    });
  };

  /**
   * From marks, the entire observation window must contain exactly one list call
   * matching pred (and nothing else), with cursor undefined, and exactly one SWR key
   * (no cursor). Hides neither transient old-query requests nor extra keys.
   */
  const assertExactlyOneNoCursor = (
    listMark: number,
    keyMark: number,
    pred: (c: unknown) => boolean,
  ) => {
    const slice = listCalls.slice(listMark);
    expect(slice.length).toBe(1);
    expect(pred(slice[0])).toBe(true);
    expect((slice[0] as { cursor?: string }).cursor).toBeUndefined();

    const keySlice = swrKeys.slice(keyMark);
    expect(keySlice.length).toBe(1);
    expect(isNoCursorKey(keySlice[0])).toBe(true);
  };

  /** Clear observation arrays without resetting lastSerializedSwrKey (avoids re-fetch of current key). */
  const clearObservationWindow = () => {
    listCalls.length = 0;
    swrKeys.length = 0;
  };

  it('Clear for status-only / role-only / date-only resets payload', async () => {
    renderPage();

    // status-only
    fireEvent.change(screen.getByLabelText('users.list.filters.status'), {
      target: { value: 'banned' },
    });
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());
    expect(listCalls.at(-1)).toMatchObject({ status: 'banned' });
    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => expect((listCalls.at(-1) as { status?: string }).status).toBeUndefined());

    // role-only
    fireEvent.change(screen.getByLabelText('users.list.filters.role'), {
      target: { value: 'user_admin' },
    });
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());
    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => expect((listCalls.at(-1) as { role?: string }).role).toBeUndefined());

    // date-only
    fireEvent.click(screen.getByLabelText('users.list.filters.createdFrom'));
    fireEvent.click(screen.getByLabelText('users.list.filters.createdTo'));
    await waitFor(() => expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy());
    fireEvent.click(screen.getByText('primitives.filterBar.clear'));
    await waitFor(() => {
      const last = listCalls.at(-1) as { createdFrom?: Date; createdTo?: Date };
      expect(last.createdFrom).toBeUndefined();
      expect(last.createdTo).toBeUndefined();
    });
  });

  it('createdFrom/createdTo use complete start/end of day Date and ISO boundaries', async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText('users.list.filters.createdFrom'));
    fireEvent.click(screen.getByLabelText('users.list.filters.createdTo'));

    await waitFor(() => {
      const withBoth = [...listCalls]
        .reverse()
        .find(
          (c) =>
            (c as { createdFrom?: Date }).createdFrom instanceof Date &&
            (c as { createdTo?: Date }).createdTo instanceof Date,
        ) as { createdFrom: Date; createdTo: Date };
      expect(withBoth).toBeTruthy();

      // Local start-of-day / end-of-day complete boundaries
      expect(withBoth.createdFrom.getHours()).toBe(0);
      expect(withBoth.createdFrom.getMinutes()).toBe(0);
      expect(withBoth.createdFrom.getSeconds()).toBe(0);
      expect(withBoth.createdFrom.getMilliseconds()).toBe(0);
      expect(withBoth.createdFrom.getDate()).toBe(15);
      expect(withBoth.createdFrom.getMonth()).toBe(0); // January
      expect(withBoth.createdFrom.getFullYear()).toBe(2024);

      expect(withBoth.createdTo.getHours()).toBe(23);
      expect(withBoth.createdTo.getMinutes()).toBe(59);
      expect(withBoth.createdTo.getSeconds()).toBe(59);
      expect(withBoth.createdTo.getDate()).toBe(31);
      expect(withBoth.createdTo.getMonth()).toBe(0);
      expect(withBoth.createdTo.getFullYear()).toBe(2024);

      // ISO round-trip
      const fromIso = withBoth.createdFrom.toISOString();
      const toIso = withBoth.createdTo.toISOString();
      expect(Number.isNaN(Date.parse(fromIso))).toBe(false);
      expect(Number.isNaN(Date.parse(toIso))).toBe(false);
      expect(new Date(fromIso).getTime()).toBe(withBoth.createdFrom.getTime());
      expect(new Date(toIso).getTime()).toBe(withBoth.createdTo.getTime());
      expect(withBoth.createdFrom.getTime()).toBeLessThan(withBoth.createdTo.getTime());
    });
  });

  it('from second page, status/role/date/page-size/query each yield exactly one no-cursor request', async () => {
    renderPage();
    await goToSecondPage();

    // status
    let listMark = listCalls.length;
    let keyMark = swrKeys.length;
    fireEvent.change(screen.getByLabelText('users.list.filters.status'), {
      target: { value: 'banned' },
    });
    await waitFor(() => {
      assertExactlyOneNoCursor(
        listMark,
        keyMark,
        (c) => (c as { status?: string }).status === 'banned',
      );
    });

    // back to page 2
    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect(
        listCalls.some((c, i) => i >= listMark && (c as { cursor?: string }).cursor === 'cursor-2'),
      ).toBe(true),
    );
    await waitFor(() => expect(swrKeys.some((k) => cursorFromKey(k) === 'cursor-2')).toBe(true));

    // role
    listMark = listCalls.length;
    keyMark = swrKeys.length;
    fireEvent.change(screen.getByLabelText('users.list.filters.role'), {
      target: { value: 'user_admin' },
    });
    await waitFor(() => {
      assertExactlyOneNoCursor(
        listMark,
        keyMark,
        (c) => (c as { role?: string }).role === 'user_admin',
      );
    });

    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect((listCalls.at(-1) as { cursor?: string }).cursor === 'cursor-2').toBe(true),
    );

    // date range
    listMark = listCalls.length;
    keyMark = swrKeys.length;
    fireEvent.click(screen.getByLabelText('users.list.filters.createdFrom'));
    await waitFor(() => {
      assertExactlyOneNoCursor(
        listMark,
        keyMark,
        (c) => (c as { createdFrom?: Date }).createdFrom instanceof Date,
      );
    });

    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect((listCalls.at(-1) as { cursor?: string }).cursor === 'cursor-2').toBe(true),
    );

    // page-size
    listMark = listCalls.length;
    keyMark = swrKeys.length;
    fireEvent.click(screen.getByText('page-size-20'));
    await waitFor(() => {
      assertExactlyOneNoCursor(listMark, keyMark, (c) => (c as { limit?: number }).limit === 20);
    });

    // debounced query from page 2 (also covered by dedicated atomic search test)
    fireEvent.click(screen.getByText('next'));
    await waitFor(() =>
      expect((listCalls.at(-1) as { cursor?: string }).cursor === 'cursor-2').toBe(true),
    );
    listMark = listCalls.length;
    keyMark = swrKeys.length;
    fireEvent.change(screen.getByLabelText('users.list.searchPlaceholder'), {
      target: { value: 'alice' },
    });
    // Keystrokes must not fetch before debounce
    expect(listCalls.slice(listMark)).toEqual([]);
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => {
      assertExactlyOneNoCursor(
        listMark,
        keyMark,
        (c) => (c as { query?: string }).query === 'alice',
      );
    });
  });

  it('from page 2, search edit yields exactly one list call and one SWR key after debounce', async () => {
    renderPage();
    await goToSecondPage();

    // Clear observation window after landing on page 2
    clearObservationWindow();
    expect(listCalls).toEqual([]);
    expect(swrKeys).toEqual([]);

    fireEvent.change(screen.getByLabelText('users.list.searchPlaceholder'), {
      target: { value: 'alice' },
    });

    // Draft-only: no list request / SWR key until debounce commits query + clears cursor
    expect(listCalls).toEqual([]);
    expect(swrKeys).toEqual([]);

    await vi.advanceTimersByTimeAsync(350);

    await waitFor(() => {
      expect(listCalls.length).toBe(1);
      expect(swrKeys.length).toBe(1);
    });

    // Entire window: sole request has new query, no cursor
    expect(listCalls).toHaveLength(1);
    const sole = listCalls[0] as { cursor?: string; query?: string };
    expect(sole.query).toBe('alice');
    expect(sole.cursor).toBeUndefined();

    // Sole SWR key: query slot 'alice', cursor slot empty
    expect(swrKeys).toHaveLength(1);
    const soleKey = swrKeys[0];
    expect(Array.isArray(soleKey)).toBe(true);
    expect((soleKey as unknown[])[1]).toBe('alice');
    expect(isNoCursorKey(soleKey)).toBe(true);
    expect(cursorFromKey(soleKey)).toBe('');
  });
});
