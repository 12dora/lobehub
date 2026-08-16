/**
 * Exports list header filter maps requester enum → the same `mine` list param.
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ExportsPage from './ExportsPage';

const exportsAccess = vi.hoisted(() => ({
  listInputs: [] as unknown[],
  permissions: ['platform_audit:export:all'] as string[],
  tableOnChange: undefined as ((meta: { filters: Record<string, unknown> }) => void) | undefined,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { success: vi.fn() },
}));

vi.mock('antd', () => ({
  Drawer: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: exportsAccess.permissions,
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  useAdminAuditMutations: () => ({
    cancelExport: vi.fn(),
    createExport: vi.fn(),
    downloadExport: vi.fn(),
  }),
  useFetchAuditExportsList: (params: unknown) => {
    exportsAccess.listInputs.push(params);
    return {
      data: {
        items: [
          {
            artifactBytes: 12,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: null,
            finishedAt: null,
            id: 'exp-1',
            kind: 'operation_logs',
            requestedBy: 'admin-1',
            rowCount: 3,
            status: 'completed',
          },
        ],
        nextCursor: null,
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    title,
  }: {
    actions?: React.ReactNode;
    children?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({
    dataSource,
    onChange,
  }: {
    dataSource?: { id: string }[];
    onChange?: (meta: { filters: Record<string, unknown> }) => void;
  }) => {
    exportsAccess.tableOnChange = onChange;
    return (
      <div data-testid="exports-table">
        {(dataSource ?? []).map((row) => (
          <div data-testid={`export-${row.id}`} key={row.id} />
        ))}
      </div>
    );
  },
}));

vi.mock('../shared/AuditStatusTag', () => ({
  default: ({ value }: { value?: string }) => <span>{value}</span>,
}));

vi.mock('./CreateExportModal', () => ({
  default: () => null,
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <ExportsPage />
    </MemoryRouter>,
  );

describe('ExportsPage', () => {
  beforeEach(() => {
    exportsAccess.permissions = ['platform_audit:export:all'];
    exportsAccess.listInputs.length = 0;
    exportsAccess.tableOnChange = undefined;
  });

  it('keeps create in the page header and applies the requester header filter', async () => {
    renderPage();

    expect(screen.getByText('audit.exports.actions.create')).toBeTruthy();
    expect(exportsAccess.listInputs.at(-1)).toEqual(expect.objectContaining({ mine: false }));

    exportsAccess.tableOnChange?.({ filters: { requestedBy: ['mine'] } });

    await waitFor(() => {
      expect(exportsAccess.listInputs.at(-1)).toEqual(expect.objectContaining({ mine: true }));
    });
  });
});
