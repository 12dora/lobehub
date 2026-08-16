// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  data: undefined as unknown,
  deleteTemplate: vi.fn(),
  importRecommendations: vi.fn(),
  mutate: vi.fn(),
  openEditor: vi.fn(),
  permissions: [] as string[],
  refreshLists: vi.fn(),
  setEnabled: vi.fn(),
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
    t: (key: string) => key,
  }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: null, permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/services/adminTaskTemplates', () => ({
  adminTaskTemplatesService: {
    delete: (...args: unknown[]) => mocks.deleteTemplate(...args),
    importRecommendations: (...args: unknown[]) => mocks.importRecommendations(...args),
    setEnabled: (...args: unknown[]) => mocks.setEnabled(...args),
  },
}));

vi.mock('./openTaskTemplateEditorModal', () => ({
  openTaskTemplateEditorModal: (...args: unknown[]) => mocks.openEditor(...args),
}));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (error: unknown) =>
    (error as { code?: string })?.code ? { code: (error as { code: string }).code } : null,
}));

vi.mock('./useAdminTaskTemplates', () => ({
  refreshAdminTaskTemplateLists: () => mocks.refreshLists(),
  useFetchAdminTaskTemplates: () => ({
    data: mocks.data,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
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

vi.mock('../primitives/DataTable', () => ({
  default: ({ columns, dataSource, emptyDescription }: any) => {
    if (!dataSource?.length) return <div>{emptyDescription}</div>;
    return (
      <table>
        <tbody>
          {dataSource.map((row: any) => (
            <tr key={row.id}>
              {columns.map((column: any) => (
                <td key={column.key}>
                  {column.render
                    ? column.render(column.dataIndex ? row[column.dataIndex] : undefined, row)
                    : String(row[column.dataIndex])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <TaskTemplateListPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = { items: [item], totalAll: 1, totalFiltered: 1 };
  mocks.refreshLists.mockResolvedValue([item]);
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

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
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

  it('hides import from a create-only operator (it also overwrites existing rows)', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_CREATE];
    renderPage();

    expect(screen.getByText('taskTemplateCatalog.actions.create')).toBeTruthy();
    expect(screen.queryByText('taskTemplateCatalog.actions.import')).toBeNull();
  });

  it('reports a stale toggle as a conflict and refreshes instead of a generic failure', async () => {
    mocks.setEnabled.mockRejectedValue(
      Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
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
});
