// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SkillListPage from './SkillListPage';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  data: { items: [{ id: 's1' }], nextCursor: 'next-cursor' } as any,
  error: undefined as unknown,
  filterResultMode: null as 'error' | 'loading' | null,
  inputs: [] as unknown[],
  isLoading: false,
  mutate: vi.fn(),
  openCreate: vi.fn(),
  pageErrorOnCursor: false,
  permissions: [] as string[],
  refreshLists: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: null, permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: { create: mocks.create },
}));

vi.mock('./openCreateSkillModal', () => ({ openCreateSkillModal: mocks.openCreate }));

vi.mock('./hooks/useAdminSkills', () => ({
  refreshAdminSkillLists: mocks.refreshLists,
  useFetchAdminSkills: (input: unknown) => {
    mocks.inputs.push(structuredClone(input));
    const cursor = (input as { cursor?: string }).cursor;
    const filtered = (input as { status?: string }).status === 'draft';
    return {
      data: filtered && mocks.filterResultMode ? undefined : mocks.data,
      error:
        filtered && mocks.filterResultMode === 'error'
          ? new Error('filter offline')
          : mocks.pageErrorOnCursor && cursor
            ? new Error('page offline')
            : mocks.error,
      isLoading: filtered && mocks.filterResultMode === 'loading' ? true : mocks.isLoading,
      mutate: mocks.mutate,
    };
  },
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ extra, message }: { extra?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {extra}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: ({ allowClear: _allowClear, ...props }: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: ({ 'aria-label': ariaLabel, onChange, options, value }: any) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value || undefined)}
    >
      <option value="">all</option>
      {options.map((option: any) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: { success: vi.fn() },
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    toolbar,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <main>
      {actions}
      {toolbar}
      {children}
    </main>
  ),
}));

vi.mock('../primitives/StatusBadge', () => ({ default: () => null }));

vi.mock('../primitives/DataTable', () => ({
  default: ({ cursorPagination, dataSource, emptyDescription, error, loading, onRetry }: any) => {
    if (loading) return <div role="status">loading</div>;
    if (error)
      return (
        <div role="alert">
          error<button onClick={onRetry}>retry</button>
        </div>
      );
    if (!dataSource?.length) return <div>{emptyDescription}</div>;
    return (
      <div>
        <button disabled={!cursorPagination.hasNext} onClick={cursorPagination.onNext}>
          next
        </button>
        <button disabled={!cursorPagination.hasPrevious} onClick={cursorPagination.onPrevious}>
          previous
        </button>
      </div>
    );
  },
}));

const ExternalFilterLink = () => {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/admin/skills?status=draft')}>external-filter</button>;
};

describe('SkillListPage', () => {
  beforeEach(() => {
    mocks.data = { items: [{ id: 's1' }], nextCursor: 'next-cursor' };
    mocks.create.mockReset();
    mocks.error = undefined;
    mocks.filterResultMode = null;
    mocks.inputs.length = 0;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
    mocks.openCreate.mockReset();
    mocks.pageErrorOnCursor = false;
    mocks.permissions = [PLATFORM_PERMISSIONS.SKILL_READ];
    mocks.refreshLists.mockReset();
  });

  it('invalidates an old cursor before an external URL filter navigation can fetch', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/skills']}>
        <ExternalFilterLink />
        <SkillListPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(mocks.inputs.at(-1)).toMatchObject({ cursor: 'next-cursor' }));

    const mark = mocks.inputs.length;
    fireEvent.click(screen.getByText('external-filter'));
    await waitFor(() => expect(mocks.inputs.at(-1)).toMatchObject({ status: 'draft' }));
    const externalCalls = mocks.inputs.slice(mark) as { cursor?: string; status?: string }[];
    expect(externalCalls.some((input) => input.status === 'draft')).toBe(true);
    expect(
      externalCalls
        .filter((input) => input.status === 'draft')
        .every((input) => input.cursor === undefined),
    ).toBe(true);
  });

  it.each(['loading', 'error'] as const)(
    'does not show previous rows while a new external filter is %s',
    async (mode) => {
      mocks.filterResultMode = mode;
      render(
        <MemoryRouter initialEntries={['/admin/skills']}>
          <ExternalFilterLink />
          <SkillListPage />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByText('next'));
      await waitFor(() => expect(mocks.inputs.at(-1)).toMatchObject({ cursor: 'next-cursor' }));
      fireEvent.click(screen.getByText('external-filter'));

      if (mode === 'loading') {
        await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
      } else {
        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        expect(screen.queryByText('skillCatalog.list.error.page')).toBeNull();
      }
      expect(screen.queryByText('next')).toBeNull();
      expect(mocks.inputs.at(-1)).toMatchObject({ cursor: undefined, status: 'draft' });
    },
  );

  it('keeps prior rows and Previous available when a later cursor page fails', async () => {
    mocks.pageErrorOnCursor = true;
    render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('next'));

    await waitFor(() => expect(screen.getByText('skillCatalog.list.error.page')).toBeTruthy());
    expect(screen.getByText('previous')).not.toHaveProperty('disabled', true);
    expect(screen.getByText('next')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByText('skillCatalog.actions.retry'));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('ignores rapid double-clicks on Next so the cursor stack does not duplicate', async () => {
    mocks.isLoading = true;
    render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );
    // Retained page data + in-flight load: Next is disabled.
    const next = screen.getByText('next');
    expect(next).toHaveProperty('disabled', true);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(mocks.inputs.every((input) => !(input as { cursor?: string }).cursor)).toBe(true);

    // When not loading, rapid clicks still only advance once (idempotent stack append).
    mocks.isLoading = false;
    mocks.inputs.length = 0;
    render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );
    const enabledNext = screen.getAllByText('next').at(-1)!;
    fireEvent.click(enabledNext);
    fireEvent.click(enabledNext);
    fireEvent.click(enabledNext);
    await waitFor(() => expect(mocks.inputs.at(-1)).toMatchObject({ cursor: 'next-cursor' }));
    const cursorAdvances = mocks.inputs.filter(
      (input) => (input as { cursor?: string }).cursor === 'next-cursor',
    );
    // SWR may re-render, but the active cursor value stays a single next-cursor (not stacked twice).
    expect(cursorAdvances.length).toBeGreaterThan(0);
    expect(
      mocks.inputs.some((input) => {
        // No deeper nested duplicate path — list only ever requests the first next cursor.
        return (
          (input as { cursor?: string }).cursor &&
          (input as { cursor?: string }).cursor !== 'next-cursor'
        );
      }),
    ).toBe(false);
  });

  it('sends every URL filter and cursor to the server hook', async () => {
    render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.status'), {
      target: { value: 'published' },
    });
    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.source'), {
      target: { value: 'uploaded' },
    });
    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.distribution'), {
      target: { value: 'mandatory' },
    });
    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.enabled'), {
      target: { value: 'true' },
    });

    await waitFor(() =>
      expect(mocks.inputs.at(-1)).toMatchObject({
        distribution: 'mandatory',
        enabled: true,
        source: 'uploaded',
        status: 'published',
      }),
    );

    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(mocks.inputs.at(-1)).toMatchObject({ cursor: 'next-cursor' }));

    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.source'), {
      target: { value: 'builtin' },
    });
    await waitFor(() => expect((mocks.inputs.at(-1) as any).cursor).toBeUndefined());

    fireEvent.change(screen.getByLabelText('skillCatalog.list.filters.query'), {
      target: { value: ' documentation ' },
    });
    await waitFor(() =>
      expect(mocks.inputs.at(-1)).toMatchObject({ cursor: undefined, query: 'documentation' }),
    );
  });

  it('keeps first-load error distinct from empty and wires retry', () => {
    mocks.data = undefined;
    mocks.error = new Error('offline');
    const { unmount } = render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('retry'));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);

    mocks.error = undefined;
    mocks.data = { items: [], nextCursor: null };
    unmount();
    render(
      <MemoryRouter>
        <SkillListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('skillCatalog.list.empty.default')).toBeTruthy();
  });

  it('closes the create operation after commit and exposes independent refresh retry', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.SKILL_READ, PLATFORM_PERMISSIONS.SKILL_CREATE];
    mocks.create.mockResolvedValue({ draft: { id: 'created-1' }, draftToken: 'x'.repeat(64) });
    mocks.refreshLists.mockRejectedValueOnce(new Error('refresh offline'));
    render(
      <MemoryRouter initialEntries={['/admin/skills']}>
        <SkillListPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('skillCatalog.create.submit'));
    const modal = mocks.openCreate.mock.calls[0][0];
    await act(() => modal.onSubmit({}));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText('skillCatalog.create.refreshFailed')).toBeTruthy();
    expect(screen.getByText('skillCatalog.create.submit')).toHaveProperty('disabled', true);

    mocks.refreshLists.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByText('skillCatalog.actions.retry'));
    await waitFor(() => expect(mocks.refreshLists).toHaveBeenCalledTimes(2));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
