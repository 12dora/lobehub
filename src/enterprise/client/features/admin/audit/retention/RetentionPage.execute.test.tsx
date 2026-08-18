/**
 * Execute-mode retention confirmation builds the expected mutation payload.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RetentionPage from './RetentionPage';

const retentionRun = vi.fn();
const retentionDryRun = vi.fn();
const openAuditReasonModal = vi.fn();
const openDangerConfirm = vi.fn();
const refreshAuditPolicy = vi.fn();
const toastError = vi.fn();
const updatePolicy = vi.fn();
let policyData = {
  contentAccessMode: 'metadata_only' as const,
  conversationRetentionDays: 90,
  exportArtifactRetentionDays: 30,
  maxExportRows: 10_000,
  maxListWindowDays: 30,
  messageBodyInExport: false,
  operationLogRetentionDays: 90,
  redactionProfile: 'standard' as const,
  revision: 1,
};
let runsData: { items: any[]; nextCursor: null } | undefined = {
  items: [],
  nextCursor: null,
};
const policyListeners = new Set<() => void>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  // Return the style key itself so class-name wiring stays assertable in tests.
  createStaticStyles: () =>
    new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : '') }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    description,
    message,
  }: {
    action?: React.ReactNode;
    description?: React.ReactNode;
    message?: React.ReactNode;
  }) => (
    <div role="alert">
      {message}
      {description}
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  InputNumber: ({ onChange, value }: { onChange?: (value: number) => void; value?: number }) => (
    <input
      data-testid="input-number"
      value={value}
      onChange={(event) => onChange?.(Number(event.target.value))}
    />
  ),
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
  Modal: ({
    children,
    onOk,
    open,
  }: {
    children?: React.ReactNode;
    onOk?: () => void;
    open?: boolean;
  }) =>
    open ? (
      <div data-testid="modal">
        {children}
        <button data-testid="policy-save" type="button" onClick={onOk}>
          save
        </button>
      </div>
    ) : null,
  Select: ({ onChange, value }: { onChange?: (v: string) => void; value?: string }) => (
    <select data-testid="scope-select" value={value} onChange={(e) => onChange?.(e.target.value)}>
      <option value="all">all</option>
      <option value="operation_logs">operation_logs</option>
    </select>
  ),
  Switch: () => <input type="checkbox" />,
  toast: { error: (...args: unknown[]) => toastError(...args) },
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

vi.mock('../hooks/useAdminAudit', async () => {
  const React = await import('react');
  return {
    refreshAuditPolicy: (...args: unknown[]) => refreshAuditPolicy(...args),
    useAdminAuditMutations: () => ({
      cancelRetentionRun: vi.fn(),
      retentionDryRun: (...args: unknown[]) => retentionDryRun(...args),
      retentionRun: (...args: unknown[]) => retentionRun(...args),
      updatePolicy: (...args: unknown[]) => updatePolicy(...args),
    }),
    useFetchAuditPolicy: () => {
      const data = React.useSyncExternalStore(
        (listener) => {
          policyListeners.add(listener);
          return () => policyListeners.delete(listener);
        },
        () => policyData,
        () => policyData,
      );
      return {
        data,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    },
    useFetchAuditRetentionRuns: () => ({
      data: runsData,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    }),
  };
});

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
  default: ({
    dataSource,
    onRowActivate,
    rowClassName,
  }: {
    dataSource?: Array<{ id: string }>;
    onRowActivate?: (row: { id: string }) => void;
    rowClassName?: (row: { id: string }, index: number) => string | undefined;
  }) => (
    <div data-testid="runs-table">
      {(dataSource ?? []).map((row, index) => (
        <button
          data-row-class={rowClassName?.(row, index) ?? ''}
          key={row.id}
          type="button"
          onClick={() => onRowActivate?.(row)}
        >
          {row.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../shared/useCursorPagination', () => ({
  AUDIT_LIST_POLL_MS: 4000,
  pollWhileInFlight: () => 0,
  useCursorPagination: () => ({
    cursor: null,
    limit: 20,
    reset: vi.fn(),
    setLimit: vi.fn(),
  }),
}));

describe('RetentionPage execute confirmation payload', () => {
  beforeEach(() => {
    retentionRun.mockReset();
    retentionDryRun.mockReset();
    openAuditReasonModal.mockReset();
    openDangerConfirm.mockReset();
    refreshAuditPolicy.mockReset();
    toastError.mockReset();
    updatePolicy.mockReset();
    policyData = {
      contentAccessMode: 'metadata_only',
      conversationRetentionDays: 90,
      exportArtifactRetentionDays: 30,
      maxExportRows: 10_000,
      maxListWindowDays: 30,
      messageBodyInExport: false,
      operationLogRetentionDays: 90,
      redactionProfile: 'standard',
      revision: 1,
    };
    runsData = { items: [], nextCursor: null };
    retentionRun.mockResolvedValue({ items: [{ id: 'run-1', status: 'pending' }] });

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

  it('preserves policy fields and retries a conflict with the refreshed revision', async () => {
    openAuditReasonModal.mockReset();
    updatePolicy
      .mockRejectedValueOnce(new Error('revision conflict'))
      .mockResolvedValueOnce(undefined);
    refreshAuditPolicy.mockImplementation(async () => {
      policyData = {
        ...policyData,
        conversationRetentionDays: 365,
        revision: 2,
      };
      for (const listener of policyListeners) listener();
    });

    render(<RetentionPage />);
    fireEvent.click(screen.getByText('audit.retention.policy.edit'));
    fireEvent.change(screen.getAllByTestId('input-number')[0], { target: { value: '45' } });
    fireEvent.click(screen.getByTestId('policy-save'));

    const reasonOptions = openAuditReasonModal.mock.calls[0]![0] as {
      buildPayload: (reason: string) => {
        conversationRetentionDays: number;
        expectedRevision: number;
      };
      onSubmit: (payload: unknown) => Promise<void>;
    };
    const firstPayload = reasonOptions.buildPayload('change retention');
    expect(firstPayload).toMatchObject({
      conversationRetentionDays: 45,
      expectedRevision: 1,
    });
    await act(async () => {
      await expect(reasonOptions.onSubmit(firstPayload)).rejects.toThrow('revision conflict');
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'audit.retention.policy.conflictTitle',
      ),
    );
    expect((screen.getAllByTestId('input-number')[0] as HTMLInputElement).value).toBe('45');
    expect(reasonOptions.buildPayload('retry')).toMatchObject({
      conversationRetentionDays: 45,
      expectedRevision: 2,
    });
  });

  it('highlights new runs via rowClassName, drops the caption and injected style, then clears', async () => {
    // happy-dom does not always implement scrollIntoView; the page schedules one after submit.
    (Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => {};
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      runsData = {
        items: [
          { id: 'run-1', status: 'pending' },
          { id: 'run-old', status: 'succeeded' },
        ],
        nextCursor: null,
      };

      const { container } = render(<RetentionPage />);
      fireEvent.click(screen.getByText('audit.retention.cleanup.execute'));
      await act(async () => {
        await openAuditReasonModal.mock.results[0]!.value;
      });

      // Only the freshly created run carries the animation class.
      expect(screen.getByText('run-1').getAttribute('data-row-class')).toBe('newRunRow');
      expect(screen.getByText('run-old').getAttribute('data-row-class')).toBe('');
      // No raw <style> injection and no "new run(s): …" caption any more.
      expect(container.querySelector('style')).toBeNull();
      expect(screen.queryByText('audit.retention.runs.highlighted')).toBeNull();

      // Highlight is dropped once the animation has played, so polling cannot replay it.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText('run-1').getAttribute('data-row-class')).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a mutation-seeded run that fails in the first list response exactly once', async () => {
    const pendingRun = {
      counts: {},
      createdAt: new Date(),
      cutoffAt: new Date(),
      error: null,
      id: 'run-failed',
      progressDone: 0,
      progressTotal: 1,
      requestedBy: 'admin',
      scope: 'conversations',
      status: 'pending',
    };
    runsData = undefined;
    retentionDryRun.mockResolvedValue({ items: [pendingRun] });
    render(<RetentionPage />);
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('audit.retention.cleanup.dryRun'));
    await act(async () => {
      await openAuditReasonModal.mock.results[0]!.value;
    });

    runsData = {
      items: [
        {
          ...pendingRun,
          error: { code: 'RETENTION_FAILED' },
          status: 'failed',
        },
      ],
      nextCursor: null,
    };
    fireEvent.change(screen.getByTestId('scope-select'), {
      target: { value: 'operation_logs' },
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('run-failed'));
    expect(screen.getByRole('alert').textContent).toContain('audit.retention.runs.failureTitle');
    expect(screen.getByText('audit.retention.runs.runDryCheck')).toBeTruthy();

    fireEvent.change(screen.getByTestId('scope-select'), {
      target: { value: 'all' },
    });
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
