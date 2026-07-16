// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SkillListPage from './SkillListPage';

const mocks = vi.hoisted(() => ({
  data: { items: [{ id: 's1' }], nextCursor: 'next-cursor' } as any,
  error: undefined as unknown,
  inputs: [] as unknown[],
  isLoading: false,
  mutate: vi.fn(),
  pageErrorOnCursor: false,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: [PLATFORM_PERMISSIONS.SKILL_READ] }),
}));

vi.mock('./hooks/useAdminSkills', () => ({
  useFetchAdminSkills: (input: unknown) => {
    mocks.inputs.push(structuredClone(input));
    const cursor = (input as { cursor?: string }).cursor;
    return {
      data: mocks.data,
      error: mocks.pageErrorOnCursor && cursor ? new Error('page offline') : mocks.error,
      isLoading: mocks.isLoading,
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
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, toolbar }: { children?: ReactNode; toolbar?: ReactNode }) => (
    <main>
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
    mocks.error = undefined;
    mocks.inputs.length = 0;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
    mocks.pageErrorOnCursor = false;
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
});
