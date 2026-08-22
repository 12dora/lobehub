// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderSettings,
  AdminSystemDocumentRenderStatus,
} from '@/enterprise/client/services/adminSystem';

import { DocumentRenderCard } from './DocumentRenderCard';

const statusMock = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }));
const uiMocks = vi.hoisted(() => ({ confirmModal: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  m: { span: ({ children }: { children?: ReactNode }) => <span>{children}</span> },
  useReducedMotion: () => true,
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: (props: unknown) => uiMocks.confirmModal(props),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  // Rendered only while open, exactly as base-ui does — so "behind 详情" is a real assertion.
  Modal: ({
    children,
    footer,
    open,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    open?: boolean;
    title?: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <h3>{title}</h3>
        {children}
        {footer}
      </div>
    ) : null,
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Segmented: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (next: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {(options ?? []).map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.label}
        </option>
      ))}
    </select>
  ),
  Switch: ({ checked, onChange }: { checked?: boolean; onChange?: (next: boolean) => void }) => (
    <button role="switch" type="button" onClick={() => onChange?.(!checked)}>
      {String(checked)}
    </button>
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: [] }),
}));

vi.mock('../../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock('./invalidate', () => ({
  invalidateAdminDocumentRenderSettings: () => Promise.resolve(),
  invalidateAdminDocumentRenderStatus: () => Promise.resolve(),
}));

vi.mock('../hooks', () => ({
  useAdminDocumentRenderStatus: () => statusMock,
}));

const view = (
  overrides: Partial<AdminSystemDocumentRenderSettings> = {},
): AdminSystemDocumentRenderSettings => ({
  config: {
    concurrency: 2,
    contactSheetCols: 3,
    contactSheetRows: 4,
    endpoint: 'http://document-render:3000',
    longEdgePx: 1800,
    maxDocsPerRequest: 2,
    maxFileBytes: 32 * 1024 * 1024,
    maxImagesDefault: 6,
    maxPages: 200,
    mediaThresholdT2: 3,
    pptxAlwaysT2: true,
    retentionDays: 0,
    thumbEdgePx: 512,
    tilesForDensePages: true,
    timeoutSec: 120,
    trigger: 'onUpload',
  },
  enabled: false,
  moduleEnabled: true,
  revision: 0,
  source: 'env',
  ...overrides,
});

const status = (
  overrides: Partial<AdminSystemDocumentRenderStatus> = {},
): AdminSystemDocumentRenderStatus => ({
  configured: true,
  feed: {
    docsFed: 7,
    imagesFed: 41,
    pendingFallbacks: 1,
    pendingWaits: 3,
    requestsWithImages: 5,
    since: '2026-08-22T00:00:00.000Z',
    toolPageViews: 2,
  },
  maintenance: {
    artifactBytes: 5 * 1024 * 1024,
    artifactObjects: 120,
    expiredFiles: 4,
    jobStatus: 'succeeded',
    lastError: null,
    lastRunAt: '2026-08-22T00:00:00.000Z',
    orphanBytes: 2048,
    orphanObjects: 3,
    tempDirBytes: 1024,
  },
  moduleEnabled: true,
  queue: {
    avgMs: 1200,
    failed24h: 1,
    p95Ms: 4000,
    pending: 2,
    recent: [
      {
        durationMs: 900,
        error: null,
        ext: 'pptx',
        fileId: 'file-0123456789',
        finishedAt: '2026-08-22T00:00:00.000Z',
        id: 'job-1',
        pages: 15,
        status: 'failed',
      },
    ],
    running: 1,
    succeeded24h: 9,
  },
  sidecar: {
    checkedAt: '2026-08-22T00:00:00.000Z',
    latencyMs: 12,
    status: 'up',
    version: '8.5.0',
  },
  ...overrides,
});

const service = (
  overrides: Partial<AdminDocumentRenderSettingsService> = {},
): AdminDocumentRenderSettingsService => ({
  cancelDocumentRenderJob: vi.fn().mockResolvedValue({ ok: true }),
  getDocumentRenderSettings: vi.fn(),
  getDocumentRenderStatus: vi.fn(),
  retryDocumentRenderJob: vi.fn().mockResolvedValue({ ok: true }),
  runDocumentRenderGc: vi.fn().mockResolvedValue({ jobId: 'gc-1', ok: true }),
  testDocumentRender: vi.fn().mockResolvedValue({ checkedAt: new Date(), latencyMs: 1, ok: true }),
  updateDocumentRenderSettings: vi.fn(),
  ...overrides,
});

const renderCard = (ui: ReactNode) => {
  const router = createMemoryRouter([{ element: ui, path: '/' }], { initialEntries: ['/'] });
  return render(<RouterProvider router={router} />);
};

const openDetails = () => fireEvent.click(screen.getByText('systemGeneral.card.details'));
const openEditor = () => fireEvent.click(screen.getByText('systemGeneral.card.edit'));

describe('DocumentRenderCard', () => {
  it('shows a modules-page hint when the module is switched off', () => {
    statusMock.data = undefined;
    renderCard(<DocumentRenderCard canOperate moduleEnabled={false} view={view()} />);

    expect(screen.getByText('systemGeneral.documentRender.moduleDisabled')).toBeTruthy();
    expect(screen.getByText('systemGeneral.documentRender.openModules')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.card.edit')).toBeNull();
  });

  it('summarises the configuration in five rows and keeps the rest in 详情', () => {
    statusMock.data = status();
    renderCard(<DocumentRenderCard canOperate moduleEnabled service={service()} view={view()} />);

    expect(screen.getByText('systemGeneral.documentRender.fields.endpoint')).toBeTruthy();
    expect(
      screen.getByText('systemGeneral.documentRender.queue.summary:{"pending":2,"running":1}'),
    ).toBeTruthy();
    // The size limit is a 详情 reading; the card would not stay one glance tall with fifteen rows.
    expect(screen.queryByText('systemGeneral.documentRender.fields.maxFileBytesMib')).toBeNull();

    openDetails();

    expect(screen.getByText('systemGeneral.documentRender.fields.maxFileBytesMib')).toBeTruthy();
    expect(screen.getByText('32')).toBeTruthy();
    expect(screen.getByText('DOCUMENT_RENDER_URL')).toBeTruthy();
  });

  it('saves an override built from the effective values, from inside the 编辑 modal', () => {
    statusMock.data = undefined;
    const updateDocumentRenderSettings = vi
      .fn()
      .mockResolvedValue(view({ enabled: true, revision: 1, source: 'db' }));
    renderCard(
      <DocumentRenderCard
        canOperate
        moduleEnabled
        service={service({ updateDocumentRenderSettings })}
        view={view()}
      />,
    );

    expect(screen.queryByText('systemGeneral.edit.save')).toBeNull();
    openEditor();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('systemGeneral.edit.save'));

    expect(updateDocumentRenderSettings).toHaveBeenCalledWith({
      config: expect.objectContaining({
        enabled: true,
        endpoint: 'http://document-render:3000',
        maxFileBytes: 32 * 1024 * 1024,
        trigger: 'onUpload',
      }),
      expectedRevision: 0,
    });
  });

  it('probes the sidecar through the card action', () => {
    statusMock.data = undefined;
    const testDocumentRender = vi
      .fn()
      .mockResolvedValue({ checkedAt: new Date(), latencyMs: 1, ok: true });
    renderCard(
      <DocumentRenderCard
        canOperate
        moduleEnabled
        service={service({ testDocumentRender })}
        view={view()}
      />,
    );

    fireEvent.click(screen.getByText('systemGeneral.testConnection'));
    expect(testDocumentRender).toHaveBeenCalled();
  });

  it('summarises the sidecar and queue in 详情, and offers retry on a failed job', () => {
    statusMock.data = status();
    const retryDocumentRenderJob = vi.fn().mockResolvedValue({ ok: true });
    renderCard(
      <DocumentRenderCard
        canOperate
        moduleEnabled
        service={service({ retryDocumentRenderJob })}
        view={view()}
      />,
    );

    // Sidecar health is the one monitoring reading the card itself carries.
    expect(screen.getByText('systemGeneral.status.healthy')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.documentRender.queue.pending')).toBeNull();

    openDetails();

    expect(screen.getByText('systemGeneral.documentRender.status.up')).toBeTruthy();
    expect(screen.getByText(/systemGeneral.documentRender.status.version/)).toBeTruthy();
    expect(screen.getByText('systemGeneral.documentRender.queue.pending')).toBeTruthy();
    expect(screen.getByText('file-012.pptx')).toBeTruthy();
    // One screenful at a time: the table scrolls and says how much of the queue it shows.
    expect(screen.getByText('systemGeneral.card.showingLatest:{"count":1}')).toBeTruthy();

    fireEvent.click(screen.getByText('systemGeneral.documentRender.actions.retry'));
    expect(retryDocumentRenderJob).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('never offers queue actions, an editor or a probe to a read-only admin', () => {
    statusMock.data = status();
    renderCard(
      <DocumentRenderCard moduleEnabled canOperate={false} service={service()} view={view()} />,
    );

    expect(screen.queryByText('systemGeneral.card.edit')).toBeNull();
    expect(screen.queryByText('systemGeneral.testConnection')).toBeNull();

    openDetails();

    expect(screen.queryByText('systemGeneral.documentRender.actions.retry')).toBeNull();
    expect(screen.queryByText('systemGeneral.documentRender.maintenance.run')).toBeNull();
  });

  it('summarises the last sweep and the per-process feed counters in 详情', () => {
    statusMock.data = status();
    renderCard(<DocumentRenderCard canOperate moduleEnabled service={service()} view={view()} />);
    openDetails();

    expect(screen.getByText('systemGeneral.documentRender.maintenance.title')).toBeTruthy();
    // objects · human-readable bytes, on one line.
    expect(screen.getByText('120 · 5.0 MB')).toBeTruthy();
    expect(screen.getByText('3 · 2.0 KB')).toBeTruthy();
    expect(screen.getByText('1.0 KB')).toBeTruthy();
    expect(screen.getByText('system.values.status.succeeded')).toBeTruthy();

    expect(screen.getByText('systemGeneral.documentRender.feed.title')).toBeTruthy();
    expect(screen.getByText(/systemGeneral.documentRender.feed.since/)).toBeTruthy();
    expect(screen.getByText('41')).toBeTruthy();
  });

  it('renders an em dash for every reading the sweep has never produced', () => {
    statusMock.data = status({
      maintenance: {
        artifactBytes: null,
        artifactObjects: null,
        expiredFiles: null,
        jobStatus: null,
        lastError: null,
        lastRunAt: null,
        orphanBytes: null,
        orphanObjects: null,
        tempDirBytes: null,
      },
    });
    renderCard(<DocumentRenderCard canOperate moduleEnabled service={service()} view={view()} />);
    openDetails();

    expect(screen.getByText('systemGeneral.documentRender.maintenance.never')).toBeTruthy();
    expect(screen.getAllByText('— · —').length).toBe(2);
  });

  it('runs a cleanup sweep behind a confirmation', async () => {
    statusMock.data = status();
    const runDocumentRenderGc = vi.fn().mockResolvedValue({ jobId: 'gc-1', ok: true });
    uiMocks.confirmModal.mockImplementation(
      async (props: { onOk?: () => Promise<void> | void }) => {
        await props.onOk?.();
      },
    );
    renderCard(
      <DocumentRenderCard
        canOperate
        moduleEnabled
        service={service({ runDocumentRenderGc })}
        view={view()}
      />,
    );
    openDetails();

    fireEvent.click(screen.getByText('systemGeneral.documentRender.maintenance.run'));
    await waitFor(() => expect(runDocumentRenderGc).toHaveBeenCalledWith({}));
  });
});
