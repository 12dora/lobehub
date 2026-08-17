// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fingerprintObjectStorageDraft,
  type ObjectStorageDraft,
  settleObjectStorageDraft,
  toObjectStorageConfig,
  toObjectStorageDisableConfig,
  toObjectStorageDraft,
  validateObjectStorageDraft,
} from './draft';
import type { InfraObjectStorageView } from './types';
import { useInfraSettingsEditor } from './useInfraSettingsEditor';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  invalidate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

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
  runAdminMutation: async ({
    onError,
    run,
  }: {
    onError?: (error: unknown) => Promise<void> | void;
    run: () => Promise<void>;
  }) => {
    try {
      await run();
      return true;
    } catch (error) {
      await onError?.(error);
      return false;
    }
  },
}));

vi.mock('../../primitives/DangerConfirm', () => ({
  openDangerConfirm: (options: { onConfirm: () => Promise<void> | void }) => {
    mocks.confirm(options);
    return options.onConfirm();
  },
}));

vi.mock('./invalidate', () => ({
  invalidateAdminInfraSettings: () => {
    mocks.invalidate();
    return Promise.resolve();
  },
}));

const view = (overrides: Partial<InfraObjectStorageView> = {}): InfraObjectStorageView => ({
  accessId: 'AKIAFULL',
  errorCategory: null,
  status: 'unknown',
  bucket: 'files',
  enabled: true,
  endpoint: 'https://s3.example.com',
  hasSecretAccessKey: true,
  pathStyle: false,
  previewUrlExpireIn: null,
  publicDomain: null,
  region: 'us-east-1',
  revision: 4,
  setAcl: false,
  source: 'db',
  ...overrides,
});

const service = (overrides: Record<string, unknown> = {}) =>
  ({
    testDependency: vi.fn().mockResolvedValue({ checkedAt: new Date(), latencyMs: 5, ok: true }),
    updateInfraSettings: vi
      .fn()
      .mockResolvedValue({ appliedAt: new Date(), revision: 5, source: 'db' }),
    ...overrides,
  }) as never;

const setup = (input: InfraObjectStorageView, options: { canOperate?: boolean } = {}) => {
  const injected = service();
  const rendered = renderHook(
    ({ current }: { current: InfraObjectStorageView }) =>
      useInfraSettingsEditor<ObjectStorageDraft>({
        canOperate: options.canOperate ?? true,
        dependency: 'objectStorage',
        fingerprint: fingerprintObjectStorageDraft,
        revision: current.revision,
        seed: toObjectStorageDraft(current),
        service: injected,
        settle: settleObjectStorageDraft,
        source: current.source,
        toConfig: toObjectStorageConfig,
        toDisableConfig: toObjectStorageDisableConfig,
        validate: validateObjectStorageDraft,
      }),
    { initialProps: { current: input } },
  );
  return { ...rendered, service: injected as unknown as Record<string, ReturnType<typeof vi.fn>> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useInfraSettingsEditor', () => {
  it('hydrates a clean draft from the server snapshot', () => {
    const { result } = setup(view());

    expect(result.current.draft.bucket).toBe('files');
    expect(result.current.dirty).toBe(false);
    expect(result.current.editing).toBe(true);
  });

  it('keeps the card read-only without SYSTEM_OPERATE', () => {
    const { result } = setup(view(), { canOperate: false });
    expect(result.current.editing).toBe(false);
  });

  it('only opens the form after 改为在管理端配置 when the environment owns the card', () => {
    const { result } = setup(view({ source: 'env' }));
    expect(result.current.editing).toBe(false);

    act(() => result.current.beginEdit());
    expect(result.current.editing).toBe(true);

    act(() => result.current.cancelEdit());
    expect(result.current.editing).toBe(false);
  });

  it('adopts a background refresh while the draft is clean', () => {
    const { rerender, result } = setup(view());

    rerender({ current: view({ bucket: 'archive', revision: 6 }) });
    expect(result.current.draft.bucket).toBe('archive');
    expect(result.current.stale).toBe(false);
  });

  it('protects a dirty draft from a background refresh and reports staleness', () => {
    const { rerender, result } = setup(view());

    act(() => result.current.patch({ bucket: 'mine' }));
    expect(result.current.dirty).toBe(true);

    rerender({ current: view({ bucket: 'theirs', revision: 6 }) });
    expect(result.current.draft.bucket).toBe('mine');
    expect(result.current.stale).toBe(true);
  });

  it('adopts a newer CAS token when the content did not change', () => {
    const { rerender, result } = setup(view());

    rerender({ current: view({ revision: 9 }) });
    expect(result.current.baseRevision).toBe(9);
    expect(result.current.stale).toBe(false);
  });

  it('refuses to submit an invalid draft', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ bucket: '' }));
    await act(async () => {
      await result.current.save();
    });

    expect(injected.updateInfraSettings).not.toHaveBeenCalled();
    expect(result.current.errors.bucket).toBe('systemGeneral.errors.required');
    expect(mocks.toastError).toHaveBeenCalledWith('systemGeneral.edit.invalidDraft');
  });

  it('writes the draft with the current CAS token and settles the secret', async () => {
    const { result, service: injected } = setup(view());

    act(() =>
      result.current.patch({
        secretAccessKey: { cleared: false, stored: true, value: 'fresh' },
      }),
    );
    await act(async () => {
      await result.current.save();
    });

    expect(injected.updateInfraSettings).toHaveBeenCalledWith({
      config: expect.objectContaining({
        bucket: 'files',
        enabled: true,
        secretAccessKey: { action: 'replace', value: 'fresh' },
      }),
      dependency: 'objectStorage',
      expectedRevision: 4,
    });
    expect(result.current.baseRevision).toBe(5);
    // Plaintext must not survive the request.
    expect(result.current.draft.secretAccessKey).toEqual({
      cleared: false,
      stored: true,
      value: '',
    });
    expect(result.current.dirty).toBe(false);
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it('turns a CAS mismatch into a reload offer instead of a retry', async () => {
    const { result, service: injected } = setup(view());
    injected.updateInfraSettings.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
    });

    act(() => result.current.patch({ publicDomain: 'https://files.example.com' }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.conflict).toBe(true);
    // The local edit survives so it can be re-applied after the reload.
    expect(result.current.draft.publicDomain).toBe('https://files.example.com');
  });

  it('surfaces a rejected field next to its control', async () => {
    const { result, service: injected } = setup(view());
    injected.updateInfraSettings.mockRejectedValueOnce({
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { field: 'config.bucket' },
        },
      },
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.errors.bucket).toBe('systemGeneral.edit.saveRejected');
  });

  it('reverts to the environment with the last saved values, not the unsaved ones', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ bucket: 'unsaved' }));
    await act(async () => {
      result.current.revertToEnv();
    });

    expect(mocks.confirm).toHaveBeenCalled();
    expect(injected.updateInfraSettings).toHaveBeenCalledWith({
      config: expect.objectContaining({
        bucket: 'files',
        enabled: false,
        // Disabling never changes the credential.
        secretAccessKey: { action: 'keep' },
      }),
      dependency: 'objectStorage',
      expectedRevision: 4,
    });
  });

  it('can still disable an override whose configuration would not pass validation', async () => {
    // Fail-open shape: the saved override is on, but almost nothing about it is readable.
    const unreadable = view({ accessId: null, enabled: true, hasSecretAccessKey: false });
    const { result, service: injected } = setup(unreadable);

    expect(result.current.errors.accessKeyId ?? result.current.draft.accessKeyId).toBeDefined();
    await act(async () => {
      result.current.revertToEnv();
    });

    expect(injected.updateInfraSettings).toHaveBeenCalledWith({
      config: expect.objectContaining({ enabled: false, secretAccessKey: { action: 'keep' } }),
      dependency: 'objectStorage',
      expectedRevision: 4,
    });
    // No required-field validation stood in the way.
    expect(mocks.toastError).not.toHaveBeenCalledWith('systemGeneral.edit.invalidDraft');
  });

  it('probes the draft rather than the stored configuration', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ publicDomain: 'https://files.example.com' }));
    await act(async () => {
      await result.current.test();
    });

    expect(injected.testDependency).toHaveBeenCalledWith({
      dependency: 'objectStorage',
      draft: expect.objectContaining({ publicDomain: 'https://files.example.com' }),
    });
    expect(result.current.probe).toMatchObject({ ok: true });
  });

  it('blocks writing and probing when a stored secret would follow a moved destination', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ bucket: 'somewhere-else' }));

    expect(result.current.blocked).toBe(true);
    // Shown straight away — the admin cannot discover this by pressing 保存 and failing.
    expect(result.current.errors.secretAccessKey).toBe(
      'systemGeneral.errors.secretReenterRequired',
    );

    await act(async () => {
      await result.current.save();
    });
    await act(async () => {
      await result.current.test();
    });
    expect(injected.updateInfraSettings).not.toHaveBeenCalled();
    expect(injected.testDependency).not.toHaveBeenCalled();
  });

  it('unblocks once the credential for the new destination is entered', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ bucket: 'somewhere-else' }));
    act(() =>
      result.current.patch({
        secretAccessKey: { cleared: false, stored: true, value: 'new-secret' },
      }),
    );

    expect(result.current.blocked).toBe(false);
    await act(async () => {
      await result.current.save();
    });
    expect(injected.updateInfraSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          bucket: 'somewhere-else',
          secretAccessKey: { action: 'replace', value: 'new-secret' },
        }),
      }),
    );
  });

  it('shows validation up front in the fail-open recovery state', () => {
    const failOpen = view({ enabled: true, hasSecretAccessKey: false, source: 'env' });
    const { result } = renderHook(() =>
      useInfraSettingsEditor<ObjectStorageDraft>({
        canOperate: true,
        dependency: 'objectStorage',
        fingerprint: fingerprintObjectStorageDraft,
        revealErrors: true,
        revision: failOpen.revision,
        seed: toObjectStorageDraft(failOpen),
        service: service(),
        settle: settleObjectStorageDraft,
        source: failOpen.source,
        toConfig: toObjectStorageConfig,
        toDisableConfig: toObjectStorageDisableConfig,
        validate: validateObjectStorageDraft,
      }),
    );

    expect(result.current.errors.secretAccessKey).toBe('systemGeneral.errors.secretRequired');
    expect(result.current.errors.accessKeyId).toBe('systemGeneral.errors.required');
  });

  it('surfaces a refused draft probe on the credential instead of as "unreachable"', async () => {
    const { result, service: injected } = setup(view());
    injected.testDependency.mockRejectedValueOnce({
      data: {
        errorData: { code: 'PLATFORM_INVALID_INPUT', details: { field: 'config.secretAccessKey' } },
      },
    });

    await act(async () => {
      await result.current.test();
    });

    expect(result.current.errors.secretAccessKey).toBe(
      'systemGeneral.errors.secretReenterRequired',
    );
    expect(result.current.probe).toBeUndefined();
  });

  it('does not probe an invalid draft', async () => {
    const { result, service: injected } = setup(view());

    act(() => result.current.patch({ bucket: '' }));
    await act(async () => {
      await result.current.test();
    });

    expect(injected.testDependency).not.toHaveBeenCalled();
  });
});
