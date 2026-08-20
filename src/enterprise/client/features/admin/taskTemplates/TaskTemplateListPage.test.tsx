// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Table } from 'antd';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import TaskTemplateListPage from './TaskTemplateListPage';

const item = {
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Daily digest',
  enabled: true,
  icon: null,
  id: 'tpl-1',
  identifier: 'daily-digest',
  instruction: 'Summarize',
  interests: [],
  revision: 3,
  sortOrder: 0,
  source: 'manual',
  title: 'Engineering digest',
  updatedAt: new Date('2026-08-16T00:00:00Z'),
};

/**
 * What the list answers with while the catalog is still empty: read-only PREVIEW rows of the
 * bundled recommendations users are being served right now (`preview:<identifier>`, revision 0).
 */
const preview = {
  ...item,
  id: 'preview:daily-briefing',
  identifier: 'daily-briefing',
  revision: 0,
  source: 'market',
  title: 'Daily briefing',
};

const secondPreview = {
  ...preview,
  id: 'preview:weekly-report',
  identifier: 'weekly-report',
  title: 'Weekly report',
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  data: undefined as unknown,
  /** Server-side filtering stand-in: the rows the list returns for the current query. */
  dataFor: undefined as ((input: { query?: string }) => unknown) | undefined,
  createTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  importRecommendations: vi.fn(),
  mutate: vi.fn(),
  listInput: undefined as unknown,
  openEditor: vi.fn(),
  permissions: [] as string[],
  refreshLists: vi.fn(),
  reloadTemplate: vi.fn(),
  reorder: vi.fn(),
  reorderProps: undefined as { ids: string[]; onReorder: (ids: string[]) => void } | undefined,
  sortableDisabled: undefined as boolean | undefined,
  setEnabled: vi.fn(),
  updateTemplate: vi.fn(),
  tableColumns: undefined as { key?: string }[] | undefined,
  tableOnChange: undefined as ((meta: { filters: Record<string, unknown> }) => void) | undefined,
  tablePagination: undefined as { current?: number; pageSize?: number; total?: number } | undefined,
  tableRowSelection: undefined as
    { columnWidth?: number; onChange: (keys: string[], rows: unknown[]) => void } | undefined,
  tableScroll: undefined as { x?: number } | undefined,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    // Interpolation is kept so the assertions below cover what the operator actually
    // reads — the count and the per-row reason — not just the key that was looked up.
    t: (key: string, options?: { count?: number; reason?: string }) => {
      if (options?.count !== undefined) return `${key}:${options.count}`;
      if (options?.reason !== undefined) return `${key}:${options.reason}`;
      return key;
    },
  }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: null, permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/services/adminTaskTemplates', () => ({
  adminTaskTemplatesService: {
    create: (...args: unknown[]) => mocks.createTemplate(...args),
    delete: (...args: unknown[]) => mocks.deleteTemplate(...args),
    importRecommendations: (...args: unknown[]) => mocks.importRecommendations(...args),
    reorder: (...args: unknown[]) => mocks.reorder(...args),
    setEnabled: (...args: unknown[]) => mocks.setEnabled(...args),
    update: (...args: unknown[]) => mocks.updateTemplate(...args),
  },
}));

vi.mock('./openTaskTemplateEditorModal', () => ({
  openTaskTemplateEditorModal: (...args: unknown[]) => mocks.openEditor(...args),
}));

vi.mock('./useAdminTaskTemplates', () => ({
  refreshAdminTaskTemplateLists: () => mocks.refreshLists(),
  useFetchAdminTaskTemplates: (input: { query?: string }) => {
    mocks.listInput = input;
    return {
      data: mocks.dataFor ? mocks.dataFor(input) : mocks.data,
      error: undefined,
      isLoading: false,
      mutate: mocks.mutate,
    };
  },
}));

vi.mock('./reloadTaskTemplate', () => ({
  reloadTaskTemplate: (...args: unknown[]) => mocks.reloadTemplate(...args),
}));

vi.mock('./SortableRow', () => ({
  createSortableRow: (disabled: boolean) => {
    mocks.sortableDisabled = disabled;
    return (props: Record<string, unknown>) => <tr {...props} />;
  },
  SortableTable: ({ children, ids, onReorder }: any) => {
    mocks.reorderProps = { ids, onReorder };
    return <div>{children}</div>;
  },
  TaskTemplateDragHandle: ({ label }: { label: string }) => (
    <button aria-label={label} type="button" />
  ),
}));

vi.mock('../primitives/DangerConfirm', () => ({
  openDangerConfirm: (options: { onConfirm: () => Promise<void> }) => mocks.confirm(options),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: ReactNode }) => <div role="alert">{message}</div>,
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
  Switch: ({ 'aria-label': ariaLabel, checked, disabled, onChange }: any) => (
    <input
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange?.(event.target.checked)}
    />
  ),
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  },
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    hideTitle,
    toolbar,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    hideTitle?: boolean;
    toolbar?: ReactNode;
  }) => (
    <main data-hide-title={String(Boolean(hideTitle))}>
      {actions}
      {toolbar}
      {children}
    </main>
  ),
}));

vi.mock('../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
    emptyDescription,
    onChange,
    pagination,
    rowSelection,
    scroll,
    toolbar,
  }: any) => {
    mocks.tableColumns = columns;
    mocks.tableOnChange = onChange;
    mocks.tablePagination = pagination;
    mocks.tableRowSelection = rowSelection;
    mocks.tableScroll = scroll;
    if (!dataSource?.length) {
      return (
        <div>
          {toolbar}
          <div>{emptyDescription}</div>
        </div>
      );
    }
    const selectedKeys: string[] = rowSelection?.selectedRowKeys ?? [];
    // Stand-in for antd's own selection column: the real Table swaps the placeholder for a
    // checkbox cell in place, which is exactly what the column order under test relies on.
    const renderCell = (column: any, row: any) => {
      if (column === Table.SELECTION_COLUMN) {
        return (
          <input
            aria-label={`select-${row.id}`}
            checked={selectedKeys.includes(row.id)}
            type="checkbox"
            onChange={(event) => {
              const next = event.target.checked
                ? [...selectedKeys, row.id]
                : selectedKeys.filter((key) => key !== row.id);
              rowSelection.onChange(
                next,
                dataSource.filter((item: any) => next.includes(item.id)),
              );
            }}
          />
        );
      }
      return column.render
        ? column.render(column.dataIndex ? row[column.dataIndex] : undefined, row)
        : String(row[column.dataIndex]);
    };
    return (
      <div>
        {toolbar}
        <table>
          <tbody>
            {dataSource.map((row: any) => (
              <tr key={row.id}>
                {columns.map((column: any, index: number) => (
                  <td key={column.key ?? `column-${index}`}>{renderCell(column, row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
}));

const renderPage = (props: { embedded?: boolean } = {}) =>
  render(
    <MemoryRouter>
      <TaskTemplateListPage {...props} />
    </MemoryRouter>,
  );

/**
 * A rejection shaped the way the tRPC client hands one back, so the production
 * `mapEnterpriseError` (never a stub) decides whether the UI reports a conflict.
 */
const trpcError = (code: string) =>
  Object.assign(new Error(code), { data: { errorData: { code } } });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = { items: [item], origin: 'managed', totalAll: 1, totalFiltered: 1 };
  mocks.dataFor = undefined;
  mocks.listInput = undefined;
  mocks.refreshLists.mockResolvedValue([item]);
  mocks.reorderProps = undefined;
  mocks.sortableDisabled = undefined;
  mocks.tableColumns = undefined;
  mocks.tableOnChange = undefined;
  mocks.tablePagination = undefined;
  mocks.tableRowSelection = undefined;
  mocks.tableScroll = undefined;
  mocks.permissions = [
    PLATFORM_PERMISSIONS.AGENT_READ,
    PLATFORM_PERMISSIONS.AGENT_CREATE,
    PLATFORM_PERMISSIONS.AGENT_UPDATE,
    PLATFORM_PERMISSIONS.AGENT_DELETE,
  ];
});

describe('TaskTemplateListPage', () => {
  it('renders the empty state with both entry points when the module was never used', () => {
    mocks.data = { items: [], totalAll: 0, totalFiltered: 0 };
    renderPage();

    expect(screen.getByText('taskTemplateCatalog.list.empty.default')).toBeTruthy();
    expect(screen.getByText('taskTemplateCatalog.actions.create')).toBeTruthy();
    expect(screen.getByText('taskTemplateCatalog.actions.import')).toBeTruthy();
  });

  it('flips the switch optimistically and refreshes after a successful toggle', async () => {
    mocks.setEnabled.mockResolvedValue({ ...item, enabled: false });
    renderPage();

    const toggle = screen.getByLabelText(
      'taskTemplateCatalog.list.columns.enabled',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    expect(mocks.setEnabled).toHaveBeenCalledWith({
      enabled: false,
      expectedRevision: 3,
      id: 'tpl-1',
    });
    await waitFor(() => expect(mocks.refreshLists).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.disabled');
  });

  it('rolls the switch back and toasts when the toggle fails', async () => {
    mocks.setEnabled.mockRejectedValue(new Error('offline'));
    renderPage();

    const toggle = screen.getByLabelText(
      'taskTemplateCatalog.list.columns.enabled',
    ) as HTMLInputElement;
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('taskTemplateCatalog.toast.error'),
    );
    // Generic toggle failures keep the current page: only a revision conflict reloads.
    expect(mocks.refreshLists).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText('taskTemplateCatalog.list.columns.enabled') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('confirms before deleting', async () => {
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl-1' });
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.delete'));
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.deleteTemplate).not.toHaveBeenCalled();

    await mocks.confirm.mock.calls[0][0].onConfirm();
    expect(mocks.deleteTemplate).toHaveBeenCalledWith({ expectedRevision: 3, id: 'tpl-1' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.deleted');
  });

  it('persists a drag with each row CAS token and confirms it', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    mocks.reorder.mockResolvedValue({ items: [] });
    renderPage();

    expect(mocks.reorderProps?.ids).toEqual(['tpl-1', 'tpl-2']);
    mocks.reorderProps!.onReorder(['tpl-2', 'tpl-1']);

    await waitFor(() => expect(mocks.reorder).toHaveBeenCalled());
    expect(mocks.reorder).toHaveBeenCalledWith({
      items: [
        { expectedRevision: 5, id: 'tpl-2' },
        { expectedRevision: 3, id: 'tpl-1' },
      ],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.reordered');
  });

  it('rolls the order back and reports a conflict when the drag was stale', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    mocks.reorder.mockRejectedValue(trpcError('PLATFORM_REVISION_CONFLICT'));
    renderPage();

    mocks.reorderProps!.onReorder(['tpl-2', 'tpl-1']);

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('taskTemplateCatalog.toast.conflict'),
    );
    // Rollback is a refetch: the server order is authoritative again.
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('hides import from a create-only operator (it also overwrites existing rows)', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_CREATE];
    renderPage();

    expect(screen.getByText('taskTemplateCatalog.actions.create')).toBeTruthy();
    expect(screen.queryByText('taskTemplateCatalog.actions.import')).toBeNull();
  });

  it('reports a stale toggle as a conflict and refreshes instead of a generic failure', async () => {
    mocks.setEnabled.mockRejectedValue(trpcError('PLATFORM_REVISION_CONFLICT'));
    renderPage();

    fireEvent.click(screen.getByLabelText('taskTemplateCatalog.list.columns.enabled'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('taskTemplateCatalog.toast.conflict'),
    );
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('hides every write action for a read-only operator', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
    renderPage();

    expect(screen.queryByText('taskTemplateCatalog.actions.create')).toBeNull();
    expect(screen.queryByText('taskTemplateCatalog.actions.import')).toBeNull();
    expect(screen.queryByText('taskTemplateCatalog.actions.edit')).toBeNull();
    expect(screen.queryByText('taskTemplateCatalog.actions.delete')).toBeNull();
    expect(
      (screen.getByLabelText('taskTemplateCatalog.list.columns.enabled') as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it('confirms the market import and reports what changed', async () => {
    mocks.importRecommendations.mockResolvedValue({ created: 2, skipped: 0, updated: 1 });
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.import'));
    await mocks.confirm.mock.calls[0][0].onConfirm();

    expect(mocks.importRecommendations).toHaveBeenCalledWith({ locale: 'en-US' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.imported');
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('keeps search in the table toolbar and applies the enabled header filter', async () => {
    renderPage();

    expect(screen.getByLabelText('taskTemplateCatalog.list.filters.query')).toBeTruthy();
    expect(screen.queryByLabelText('taskTemplateCatalog.list.filters.enabled')).toBeNull();
    expect(mocks.tablePagination).toEqual({
      current: 1,
      pageSize: 20,
      total: 1,
    });
    expect(mocks.listInput).toEqual(
      expect.objectContaining({ enabled: undefined, limit: 20, locale: 'en-US', offset: 0 }),
    );

    mocks.tableOnChange?.({ filters: { enabled: ['false'] } });

    await waitFor(() => {
      expect(mocks.listInput).toEqual(expect.objectContaining({ enabled: false, offset: 0 }));
    });
  });

  it('places the bulk-selection checkbox right after the order column', () => {
    renderPage();

    expect(mocks.tableColumns?.[0]?.key).toBe('order');
    // antd would prepend its selection column; the placeholder pins it behind the grip.
    expect(mocks.tableColumns?.[1]).toBe(Table.SELECTION_COLUMN);
    expect(mocks.tableColumns?.[2]?.key).toBe('template');
    expect(mocks.tableRowSelection?.columnWidth).toBe(40);
    // The checkbox column widens the fixed table layout instead of squeezing the others.
    expect(mocks.tableScroll?.x).toBe(1166);
  });

  it('offers no selection column to an operator who cannot delete', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_UPDATE];
    renderPage();

    expect(mocks.tableColumns?.includes(Table.SELECTION_COLUMN as never)).toBe(false);
    expect(mocks.tableRowSelection).toBeUndefined();
  });

  it('shows the selected count and a delete action once rows are picked', () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    renderPage();

    expect(screen.queryByText(/taskTemplateCatalog\.list\.selectedCount/)).toBeNull();

    fireEvent.click(screen.getByLabelText('select-tpl-1'));
    expect(screen.getByText('taskTemplateCatalog.list.selectedCount:1')).toBeTruthy();
    expect(screen.getByText('taskTemplateCatalog.list.bulk.delete')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('select-tpl-2'));
    expect(screen.getByText('taskTemplateCatalog.list.selectedCount:2')).toBeTruthy();
  });

  it('confirms once, deletes every selected row with its own CAS token, then clears', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl-1' });
    renderPage();

    fireEvent.click(screen.getByLabelText('select-tpl-1'));
    fireEvent.click(screen.getByLabelText('select-tpl-2'));
    fireEvent.click(screen.getByText('taskTemplateCatalog.list.bulk.delete'));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    // The confirmation names the size of the selection, not just its copy key.
    expect(mocks.confirm.mock.calls[0][0].content).toBe('taskTemplateCatalog.bulkDelete.content:2');
    expect(mocks.deleteTemplate).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.confirm.mock.calls[0][0].onConfirm();
    });

    expect(mocks.deleteTemplate).toHaveBeenCalledTimes(2);
    expect(mocks.deleteTemplate).toHaveBeenNthCalledWith(1, { expectedRevision: 3, id: 'tpl-1' });
    expect(mocks.deleteTemplate).toHaveBeenNthCalledWith(2, { expectedRevision: 5, id: 'tpl-2' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.bulkDeleted:2');
    expect(mocks.refreshLists).toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByText(/taskTemplateCatalog\.list\.selectedCount/)).toBeNull(),
    );
  });

  it('deletes the selected rows one at a time, not in parallel', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    const first = deferred<unknown>();
    const rest = deferred<unknown>();
    mocks.deleteTemplate.mockReturnValueOnce(first.promise).mockReturnValueOnce(rest.promise);
    renderPage();

    fireEvent.click(screen.getByLabelText('select-tpl-1'));
    fireEvent.click(screen.getByLabelText('select-tpl-2'));
    fireEvent.click(screen.getByText('taskTemplateCatalog.list.bulk.delete'));

    let finished = false;
    const run = mocks.confirm.mock.calls[0][0].onConfirm().then(() => {
      finished = true;
    });

    // The loop awaits each row: while the first delete is in flight the second must not start.
    await Promise.resolve();
    expect(mocks.deleteTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTemplate).toHaveBeenCalledWith({ expectedRevision: 3, id: 'tpl-1' });

    await act(async () => {
      first.resolve({ id: 'tpl-1' });
    });
    await waitFor(() => expect(mocks.deleteTemplate).toHaveBeenCalledTimes(2));
    expect(mocks.deleteTemplate).toHaveBeenLastCalledWith({ expectedRevision: 5, id: 'tpl-2' });
    // No summary toast until the whole run settles.
    expect(finished).toBe(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await act(async () => {
      rest.resolve({ id: 'tpl-2' });
      await run;
    });
    expect(finished).toBe(true);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.bulkDeleted:2');
  });

  it('keeps a row selected after a search drops it from the current page', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.dataFor = (input) => {
      const items = [item, second].filter(
        (row) => !input.query || row.title.toLowerCase().includes(input.query.toLowerCase()),
      );
      return { items, totalAll: 2, totalFiltered: items.length };
    };
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl-1' });
    vi.useFakeTimers();
    try {
      renderPage();

      fireEvent.click(screen.getByLabelText('select-tpl-1'));
      expect(screen.getByText('taskTemplateCatalog.list.selectedCount:1')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('taskTemplateCatalog.list.filters.query'), {
        target: { value: 'Second' },
      });
      // Search is debounced; let it land so the row genuinely leaves the dataSource.
      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByLabelText('select-tpl-1')).toBeNull();
      expect(screen.getByLabelText('select-tpl-2')).toBeTruthy();
      // The selection outlives the page it was made on — count and target both survive.
      expect(screen.getByText('taskTemplateCatalog.list.selectedCount:1')).toBeTruthy();

      // Picking a row on the new result must not drop the off-page row: the table only ever
      // hands back the rows it can see, so the remembered one has to be merged back in.
      fireEvent.click(screen.getByLabelText('select-tpl-2'));
      expect(screen.getByText('taskTemplateCatalog.list.selectedCount:2')).toBeTruthy();

      fireEvent.click(screen.getByText('taskTemplateCatalog.list.bulk.delete'));
      expect(mocks.confirm.mock.calls[0][0].content).toBe(
        'taskTemplateCatalog.bulkDelete.content:2',
      );

      await act(async () => {
        await mocks.confirm.mock.calls[0][0].onConfirm();
      });
      expect(mocks.deleteTemplate).toHaveBeenCalledTimes(2);
      // Each row keeps its own CAS token, including the one that is no longer rendered.
      expect(mocks.deleteTemplate).toHaveBeenNthCalledWith(1, { expectedRevision: 3, id: 'tpl-1' });
      expect(mocks.deleteTemplate).toHaveBeenNthCalledWith(2, { expectedRevision: 5, id: 'tpl-2' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a partial bulk delete instead of claiming success', async () => {
    const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second' };
    mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
    mocks.deleteTemplate
      .mockResolvedValueOnce({ id: 'tpl-1' })
      .mockRejectedValueOnce(trpcError('PLATFORM_REVISION_CONFLICT'));
    renderPage();

    fireEvent.click(screen.getByLabelText('select-tpl-1'));
    fireEvent.click(screen.getByLabelText('select-tpl-2'));
    fireEvent.click(screen.getByText('taskTemplateCatalog.list.bulk.delete'));
    await act(async () => {
      await mocks.confirm.mock.calls[0][0].onConfirm();
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // The failed row is named with the reason the production error mapper derived from the
    // tRPC payload — a translated string, never a raw error code.
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'taskTemplateCatalog.toast.bulkSummary — taskTemplateCatalog.toast.bulkFailureDetail:taskTemplateCatalog.bulkDelete.reason.conflict',
    );
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('warns instead of claiming success when upstream rows were discarded', async () => {
    mocks.importRecommendations.mockResolvedValue({ created: 2, skipped: 3, updated: 0 });
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.import'));
    await mocks.confirm.mock.calls[0][0].onConfirm();

    // Silently dropping invalid market rows would misreport a partial import as a full one.
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'taskTemplateCatalog.toast.importedWithSkipped',
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
  it('keeps its own <h1> on the standalone route and drops it inside the tabbed shell', () => {
    // Two headings would stack under 模板管理: the tab label already names this page.
    const { unmount } = renderPage();
    expect(screen.getByRole('main').dataset.hideTitle).toBe('false');
    unmount();

    renderPage({ embedded: true });
    expect(screen.getByRole('main').dataset.hideTitle).toBe('true');
  });
  it('saves an edit against the row the editor is bound to, not a captured revision', async () => {
    // Regression: after a conflict reload the editor is reopened against the refreshed row, so
    // saving must use *that* revision — replaying the original one conflicted forever.
    mocks.updateTemplate.mockResolvedValue({ ...item, revision: 10 });
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.edit'));
    const props = mocks.openEditor.mock.calls[0]![0];
    expect(props.item).toEqual(item);

    await props.onSubmit({ title: 'Renamed' }, { ...item, revision: 9 });

    expect(mocks.updateTemplate).toHaveBeenCalledWith({
      expectedRevision: 9,
      id: 'tpl-1',
      title: 'Renamed',
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.updated');
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('creates instead of updating when the editor is bound to no row', async () => {
    mocks.createTemplate.mockResolvedValue(item);
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.create'));
    const props = mocks.openEditor.mock.calls[0]![0];
    expect(props.item).toBeUndefined();

    await props.onSubmit({ title: 'Brand new' }, undefined);

    expect(mocks.createTemplate).toHaveBeenCalledWith({ title: 'Brand new' });
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('taskTemplateCatalog.toast.created');
  });
  it('recovers a conflict from an authoritative row read, not from the cache refresh', async () => {
    // The refreshed admin page is filtered and paginated and comes back through SWR, so it can
    // omit a row that still exists — recovering from it reopened the dead revision or claimed a
    // deletion. The editor must be handed a row read straight from the server instead.
    const fresh = { ...item, revision: 9 };
    mocks.reloadTemplate.mockResolvedValue({ item: fresh, status: 'found' });
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.edit'));
    const result = await mocks.openEditor.mock.calls[0]![0].onReload(item);

    expect(mocks.reloadTemplate).toHaveBeenCalledWith(item);
    expect(result).toEqual({ item: fresh, status: 'found' });
    // The table still catches up — that is a side effect, not the source of the recovered row.
    expect(mocks.refreshLists).toHaveBeenCalled();
  });

  it('keeps a verified row read even when the cache refresh fails', async () => {
    mocks.reloadTemplate.mockResolvedValue({ item, status: 'found' });
    mocks.refreshLists.mockRejectedValue(new Error('offline'));
    renderPage();

    fireEvent.click(screen.getByText('taskTemplateCatalog.actions.edit'));

    // A failed refresh must not downgrade a successful read into "could not verify".
    await expect(mocks.openEditor.mock.calls[0]![0].onReload(item)).resolves.toEqual({
      item,
      status: 'found',
    });
  });
});

describe('taskTemplateCatalog while the catalog is unmanaged', () => {
  /** The list previews the library and reports it: no rows of our own, `totalAll: 0`. */
  const renderPreview = (items: unknown[] = [preview, secondPreview]) => {
    mocks.data = {
      items,
      origin: 'unmanaged',
      totalAll: 0,
      totalFiltered: items.length,
    };
    return renderPage();
  };

  it('shows what users see today instead of the "import first" empty state', () => {
    renderPreview();

    expect(screen.getByText('Daily briefing')).toBeTruthy();
    // The old copy told the operator the list was empty; it is not — it is just not ours yet.
    expect(screen.queryByText('taskTemplateCatalog.list.empty.default')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('taskTemplateCatalog.list.unmanagedPreview');
  });

  it('keeps both entry points, the only two writes a preview row allows', () => {
    renderPreview();

    expect(screen.getByText('taskTemplateCatalog.actions.import')).toBeTruthy();
    expect(screen.getByText('taskTemplateCatalog.actions.create')).toBeTruthy();
  });

  it('withdraws every per-row write: a preview row is not a catalog entry', () => {
    renderPreview();

    expect(screen.queryByText('taskTemplateCatalog.actions.edit')).toBeNull();
    expect(screen.queryByText('taskTemplateCatalog.actions.delete')).toBeNull();
    expect(
      screen
        .getAllByLabelText('taskTemplateCatalog.list.columns.enabled')
        .every((toggle) => (toggle as HTMLInputElement).disabled),
    ).toBe(true);
  });

  it('offers neither bulk selection nor drag reorder over preview rows', () => {
    renderPreview();

    expect(mocks.tableColumns?.includes(Table.SELECTION_COLUMN as never)).toBe(false);
    expect(mocks.tableRowSelection).toBeUndefined();
    expect(screen.queryByText('taskTemplateCatalog.list.bulk.delete')).toBeNull();
    // Two rows and full permissions would enable dragging on a managed catalog.
    expect(mocks.sortableDisabled).toBe(true);
  });

  it('still filters, and reports a filter miss as a filter miss', async () => {
    renderPreview();

    expect(screen.getByLabelText('taskTemplateCatalog.list.filters.query')).toBeTruthy();
    mocks.tableOnChange?.({ filters: { enabled: ['false'] } });
    await waitFor(() =>
      expect(mocks.listInput).toEqual(expect.objectContaining({ enabled: false, offset: 0 })),
    );
  });

  it('paginates the preview like any other page', () => {
    renderPreview();

    expect(mocks.tablePagination).toEqual({ current: 1, pageSize: 20, total: 2 });
  });

  it('names a filter miss instead of the empty-catalog copy', () => {
    renderPreview([]);

    expect(screen.getByText('taskTemplateCatalog.list.empty.filtered')).toBeTruthy();
    expect(screen.queryByText('taskTemplateCatalog.list.empty.default')).toBeNull();
  });

  it('resolves the preview in the console language, exactly like an import would', () => {
    renderPreview();

    expect(mocks.listInput).toEqual(expect.objectContaining({ locale: 'en-US' }));
  });

  it('drops the banner again once the catalog is managed', () => {
    renderPage();

    expect(screen.queryByText('taskTemplateCatalog.list.unmanagedPreview')).toBeNull();
    expect(screen.getByText('taskTemplateCatalog.actions.edit')).toBeTruthy();
    expect(mocks.tableColumns?.includes(Table.SELECTION_COLUMN as never)).toBe(true);
  });
});
