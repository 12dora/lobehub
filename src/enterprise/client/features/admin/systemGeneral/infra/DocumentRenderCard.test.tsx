// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
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
  confirmModal: vi.fn(),
  Input: (props: Record<string, unknown>) => <input {...props} />,
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

vi.mock('../InfraSettingsCard', () => ({
  InfraSettingsCard: ({
    banner,
    canTest,
    editor,
    extraActions,
    fields,
    notice,
    onTest,
    status,
    title,
  }: {
    banner?: ReactNode;
    canTest?: boolean;
    editor?: ReactNode;
    extraActions?: ReactNode;
    fields?: Array<{ label: string; value: ReactNode }>;
    notice?: ReactNode;
    onTest?: () => void;
    status?: string;
    title: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {status ? <span>{`card-status:${status}`}</span> : null}
      {notice}
      {banner}
      {canTest ? (
        <button type="button" onClick={onTest}>
          test-connection
        </button>
      ) : null}
      {editor ??
        fields?.map((field) => (
          <div key={field.label}>
            {field.label}: {field.value}
          </div>
        ))}
      {extraActions}
    </section>
  ),
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
  testDocumentRender: vi.fn().mockResolvedValue({ checkedAt: new Date(), latencyMs: 1, ok: true }),
  updateDocumentRenderSettings: vi.fn(),
  ...overrides,
});

const renderCard = (ui: ReactNode) => {
  const router = createMemoryRouter([{ element: ui, path: '/' }], { initialEntries: ['/'] });
  return render(<RouterProvider router={router} />);
};

describe('DocumentRenderCard', () => {
  it('shows a modules-page hint when the module is switched off', () => {
    statusMock.data = undefined;
    renderCard(<DocumentRenderCard canOperate moduleEnabled={false} view={view()} />);

    expect(screen.getByText('systemGeneral.documentRender.moduleDisabled')).toBeTruthy();
    expect(screen.getByText('systemGeneral.documentRender.openModules')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.edit.switchToDb')).toBeNull();
  });

  it('renders the effective values and saves an override built from them', () => {
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

    expect(screen.getByText(/systemGeneral.documentRender.fields.endpoint/)).toBeTruthy();
    // The size limit is edited and displayed in MiB, never in bytes.
    expect(screen.getByText(/systemGeneral.documentRender.fields.maxFileBytesMib/)).toBeTruthy();
    expect(screen.getByText(/32/)).toBeTruthy();

    fireEvent.click(screen.getByText('systemGeneral.edit.switchToDb'));
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

    fireEvent.click(screen.getByText('test-connection'));
    expect(testDocumentRender).toHaveBeenCalled();
  });

  it('summarises the sidecar and queue, and offers retry on a failed job', async () => {
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

    expect(screen.getByText('card-status:healthy')).toBeTruthy();
    expect(screen.getByText('systemGeneral.documentRender.status.up')).toBeTruthy();
    expect(screen.getByText(/systemGeneral.documentRender.status.version/)).toBeTruthy();
    expect(screen.getByText('systemGeneral.documentRender.queue.pending')).toBeTruthy();
    expect(screen.getByText('file-012.pptx')).toBeTruthy();

    fireEvent.click(screen.getByText('systemGeneral.documentRender.actions.retry'));
    expect(retryDocumentRenderJob).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('never offers queue actions to a read-only admin', () => {
    statusMock.data = status();
    renderCard(
      <DocumentRenderCard moduleEnabled canOperate={false} service={service()} view={view()} />,
    );

    expect(screen.queryByText('systemGeneral.documentRender.actions.retry')).toBeNull();
    expect(screen.queryByText('systemGeneral.edit.switchToDb')).toBeNull();
    expect(screen.queryByText('test-connection')).toBeNull();
  });
});
