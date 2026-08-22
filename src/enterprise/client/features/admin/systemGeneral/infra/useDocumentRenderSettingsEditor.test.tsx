// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderSettings,
} from '@/enterprise/client/services/adminSystem';

import { useDocumentRenderSettingsEditor } from './useDocumentRenderSettingsEditor';

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: [] }),
}));

vi.mock('../../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => undefined,
}));

vi.mock('../../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({ run }: { run: () => Promise<void> }) => {
    await run();
    return true;
  },
}));

vi.mock('../../primitives/DangerConfirm', () => ({
  openDangerConfirm: (options: { onConfirm: () => Promise<void> | void }) => options.onConfirm(),
}));

vi.mock('./invalidate', () => ({
  invalidateAdminDocumentRenderSettings: () => Promise.resolve(),
  invalidateAdminDocumentRenderStatus: () => Promise.resolve(),
}));

const view = (
  overrides: Partial<AdminSystemDocumentRenderSettings['config']> = {},
  revision = 4,
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
    ...overrides,
  },
  enabled: true,
  moduleEnabled: true,
  revision,
  source: 'db',
});

const setup = (initial: AdminSystemDocumentRenderSettings) => {
  const updateDocumentRenderSettings = vi.fn().mockResolvedValue(view({}, 9));
  const service = {
    cancelDocumentRenderJob: vi.fn(),
    getDocumentRenderSettings: vi.fn(),
    getDocumentRenderStatus: vi.fn(),
    retryDocumentRenderJob: vi.fn(),
    runDocumentRenderGc: vi.fn(),
    testDocumentRender: vi.fn(),
    updateDocumentRenderSettings,
  } as unknown as AdminDocumentRenderSettingsService;
  const rendered = renderHook(
    ({ current }: { current: AdminSystemDocumentRenderSettings }) =>
      useDocumentRenderSettingsEditor({ canOperate: true, service, view: current }),
    { initialProps: { current: initial } },
  );
  return { ...rendered, updateDocumentRenderSettings };
};

describe('useDocumentRenderSettingsEditor', () => {
  it('discards a stale draft onto the CURRENT snapshot, not the baseline it started from', async () => {
    const { rerender, result, updateDocumentRenderSettings } = setup(view());

    act(() => result.current.beginEdit());
    act(() => result.current.patch({ endpoint: 'http://typed-by-hand:3000' }));
    expect(result.current.dirty).toBe(true);

    rerender({ current: view({ endpoint: 'http://moved-upstream:3000' }, 7) });
    expect(result.current.stale).toBe(true);

    act(() => result.current.cancelEdit());

    expect(result.current.draft.endpoint).toBe('http://moved-upstream:3000');
    expect(result.current.dirty).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.conflict).toBe(false);

    act(() => result.current.beginEdit());
    expect(result.current.editing).toBe(true);
    act(() => result.current.patch({ endpoint: 'http://typed-again:3000' }));
    await act(async () => {
      await result.current.save();
    });
    expect(updateDocumentRenderSettings).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 7 }),
    );
  });
});
