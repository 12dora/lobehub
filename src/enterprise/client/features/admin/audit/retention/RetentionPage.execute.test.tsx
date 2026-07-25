/**
 * Execute-mode retention confirmation builds the expected mutation payload.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RetentionPage from './RetentionPage';

const retentionRun = vi.fn();
const retentionDryRun = vi.fn();
const openAuditReasonModal = vi.fn();
const openDangerConfirm = vi.fn();

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
  InputNumber: () => <input data-testid="input-number" />,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    danger,
  }: {
    children?: React.ReactNode;
    danger?: boolean;
    onClick?: () => void;
  }) => (
    <button data-danger={danger ? '1' : undefined} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Modal: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="modal">{children}</div> : null,
  Select: ({ onChange, value }: { onChange?: (v: string) => void; value?: string }) => (
    <select data-testid="scope-select" value={value} onChange={(e) => onChange?.(e.target.value)}>
      <option value="all">all</option>
      <option value="operation_logs">operation_logs</option>
    </select>
  ),
  Switch: () => <input type="checkbox" />,
}));

vi.mock('antd', () => ({
  Descriptions: Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    { Item: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
  ),
  Drawer: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  Progress: () => <div data-testid="progress" />,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: ['platform_audit:retention_operate:all', 'platform_audit:policy_update:all'],
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  refreshAuditPolicy: vi.fn(),
  useAdminAuditMutations: () => ({
    cancelRetentionRun: vi.fn(),
    retentionDryRun: (...args: unknown[]) => retentionDryRun(...args),
    retentionRun: (...args: unknown[]) => retentionRun(...args),
    updatePolicy: vi.fn(),
  }),
  useFetchAuditPolicy: () => ({
    data: {
      contentAccessMode: 'metadata_only',
      conversationRetentionDays: 90,
      expectedRevision: 1,
      exportArtifactRetentionDays: 30,
      maxExportRows: 10_000,
      maxListWindowDays: 30,
      operationLogRetentionDays: 90,
      revision: 1,
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
  useFetchAuditRetentionRuns: () => ({
    data: { items: [], nextCursor: null },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('../shared/openAuditReasonModal', () => ({
  openAuditReasonModal: (opts: unknown) => openAuditReasonModal(opts),
}));

vi.mock('../../primitives/DangerConfirm', () => ({
  openDangerConfirm: (opts: { onConfirm?: () => void }) => openDangerConfirm(opts),
}));

vi.mock('../shared/AuditStatusTag', () => ({
  default: () => null,
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: () => <div data-testid="runs-table" />,
}));

vi.mock('../shared/useCursorPagination', () => ({
  pollWhileInFlight: () => 0,
  useCursorPagination: () => ({
    cursor: null,
    limit: 20,
    resetCursor: vi.fn(),
    setLimit: vi.fn(),
  }),
}));

describe('RetentionPage execute confirmation payload', () => {
  beforeEach(() => {
    retentionRun.mockReset();
    retentionDryRun.mockReset();
    openAuditReasonModal.mockReset();
    openDangerConfirm.mockReset();
    retentionRun.mockResolvedValue({ items: [{ id: 'run-1' }] });

    openDangerConfirm.mockImplementation((opts: { onConfirm?: () => void }) => {
      opts.onConfirm?.();
    });

    openAuditReasonModal.mockImplementation(
      async (opts: {
        buildPayload: (reason: string) => unknown;
        onSubmit: (payload: unknown) => Promise<void>;
      }) => {
        const payload = opts.buildPayload('scheduled cleanup');
        await opts.onSubmit(payload);
      },
    );
  });

  it('confirms danger first, then submits retentionRun with reason + scope', async () => {
    render(<RetentionPage />);

    fireEvent.click(screen.getByText('audit.retention.cleanup.execute'));

    await waitFor(() => {
      expect(openDangerConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(openAuditReasonModal).toHaveBeenCalled();
    });
    expect(retentionRun).toHaveBeenCalledWith({
      reason: 'scheduled cleanup',
      scope: 'all',
    });
    expect(retentionDryRun).not.toHaveBeenCalled();

    // Modal was opened in danger mode for execute.
    const modalOpts = openAuditReasonModal.mock.calls[0]![0] as { danger?: boolean };
    expect(modalOpts.danger).toBe(true);
  });
});
