// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemInstancesState } from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

import { InstancesTable } from './InstancesTable';

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: ReactNode }) => <div role="alert">{message}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Switch: ({ checked, onChange, ...props }: any) => (
    <input {...props} checked={checked} type="checkbox" onChange={() => onChange?.(!checked)} />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/enterprise/client/features/admin/primitives/DataTable', () => ({
  default: ({ columns, dataSource, emptyDescription, pagination }: any) => (
    <div>
      <div data-testid="pagination">
        {pagination ? `page ${pagination.current} of ${pagination.total}` : 'unpaginated'}
      </div>
      {dataSource?.length ? (
        dataSource.map((row: any) => (
          <div data-testid="row" key={row.instanceId}>
            {columns.map((column: any, index: number) => (
              <div key={column.key ?? index}>
                {column.render
                  ? column.render(column.dataIndex ? row[column.dataIndex] : undefined, row, 0)
                  : null}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div data-testid="empty">{emptyDescription}</div>
      )}
    </div>
  ),
}));

type Instance = AdminSystemInstanceRevisions['items'][number];

const instance = (overrides: Partial<Instance> & { instanceId: string }): Instance => ({
  domains: [],
  fresh: true,
  instanceKind: 'identity_startup',
  lagging: false,
  lastHeartbeatAt: new Date('2026-08-16T04:23:16.000Z'),
  pendingRestart: false,
  startedAt: new Date('2026-08-16T04:00:00.000Z'),
  ...overrides,
});

const buildState = (
  items: Instance[],
  counts: { live: number; offline: number } | null = { live: 1, offline: 37 },
): AdminSystemInstancesState => ({
  backgroundError: undefined,
  data: {
    counts,
    domains: [],
    items,
    nextCursor: null,
    snapshotAt: new Date('2026-08-16T04:23:20.000Z'),
    targetRevision: 'a'.repeat(32),
  },
  hasMore: false,
  initialError: undefined,
  isLoadingInitial: false,
  isLoadingMore: false,
  loadMore: vi.fn(),
  loadMoreError: false,
  refresh: vi.fn(),
  retryLoadMore: vi.fn(),
});

describe('InstancesTable', () => {
  it('identifies each row and hides the restart badge on offline processes', () => {
    render(
      <InstancesTable
        showOffline
        state={buildState([
          instance({ instanceId: `oidci_${'ab12cd34'}${'0'.repeat(40)}`, pendingRestart: true }),
          instance({
            fresh: false,
            instanceId: `oidci_${'ff99'}${'0'.repeat(44)}`,
            pendingRestart: true,
          }),
        ])}
        onShowOfflineChange={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId('row');
    expect(rows[0].textContent).toContain('ab12cd34');
    expect(rows[0].textContent).toContain('system.instances.fresh');
    expect(rows[0].textContent).toContain('system.instances.pendingRestart');
    expect(rows[1].textContent).toContain('system.instances.stale');
    // A dead process can never act on a restart request.
    expect(rows[1].textContent).not.toContain('system.instances.pendingRestart');
  });

  it('shows registry totals and reports the offline toggle', () => {
    const onShowOfflineChange = vi.fn();
    render(
      <InstancesTable
        showOffline={false}
        state={buildState([instance({ instanceId: `oidci_${'0'.repeat(48)}` })])}
        onShowOfflineChange={onShowOfflineChange}
      />,
    );

    expect(screen.getByText(/system\.instances\.counts/)).toHaveTextContent('"live":1');
    expect(screen.getByText(/system\.instances\.counts/)).toHaveTextContent('"offline":37');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onShowOfflineChange).toHaveBeenCalledWith(true);
  });

  it('paginates loaded rows and keeps short lists unpaginated', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      instance({ instanceId: `pinst_${index.toString(16).padStart(48, '0')}` }),
    );
    const { rerender } = render(
      <InstancesTable showOffline state={buildState(many)} onShowOfflineChange={vi.fn()} />,
    );

    expect(screen.getAllByTestId('row')).toHaveLength(10);
    expect(screen.getByTestId('pagination')).toHaveTextContent('page 1 of 12');

    rerender(
      <InstancesTable
        showOffline
        state={buildState(many.slice(0, 3))}
        onShowOfflineChange={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('row')).toHaveLength(3);
    expect(screen.getByTestId('pagination')).toHaveTextContent('unpaginated');
  });

  it('explains an empty live view differently from an empty registry', () => {
    const { rerender } = render(
      <InstancesTable showOffline={false} state={buildState([])} onShowOfflineChange={vi.fn()} />,
    );
    expect(screen.getByTestId('empty')).toHaveTextContent('system.instances.empty');

    rerender(<InstancesTable showOffline state={buildState([])} onShowOfflineChange={vi.fn()} />);
    expect(screen.getByTestId('empty')).toHaveTextContent('system.instances.emptyAll');
  });
});
