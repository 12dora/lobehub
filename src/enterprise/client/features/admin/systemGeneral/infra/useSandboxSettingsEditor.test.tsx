// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemSandboxSettings } from '@/enterprise/client/services/adminSystem';

import { useSandboxSettingsEditor } from './useSandboxSettingsEditor';

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
  invalidateAdminSandboxSettings: () => Promise.resolve(),
}));

const view = (overrides: Partial<AdminSystemSandboxSettings> = {}): AdminSystemSandboxSettings => ({
  cpus: 1,
  dockerHost: null,
  dockerSocket: '/var/run/docker.sock',
  enabled: true,
  idleTtlSec: 1800,
  image: 'aihub-sandbox:latest',
  maxContainers: 8,
  maxOutputBytes: 1_048_576,
  memoryMb: 1024,
  moduleEnabled: true,
  network: 'bridge',
  pidsLimit: 256,
  provider: 'local',
  pullPolicy: 'if-missing',
  revision: 4,
  source: 'db',
  timeoutMs: 120_000,
  ...overrides,
});

const setup = (initial: AdminSystemSandboxSettings) => {
  const updateSandboxSettings = vi.fn().mockResolvedValue(view({ revision: 9 }));
  const service = {
    getSandboxPackageStats: vi.fn(),
    getSandboxSettings: vi.fn(),
    updateSandboxSettings,
  };
  const rendered = renderHook(
    ({ current }: { current: AdminSystemSandboxSettings }) =>
      useSandboxSettingsEditor({ canOperate: true, service, view: current }),
    { initialProps: { current: initial } },
  );
  return { ...rendered, updateSandboxSettings };
};

describe('useSandboxSettingsEditor', () => {
  it('discards a stale draft onto the CURRENT snapshot, not the baseline it started from', async () => {
    const { rerender, result, updateSandboxSettings } = setup(view());

    act(() => result.current.beginEdit());
    act(() => result.current.patch({ image: 'edited:local' }));
    expect(result.current.dirty).toBe(true);

    // Someone else saves while this draft is open: the snapshot is parked rather than applied.
    rerender({ current: view({ image: 'upstream:2', revision: 7 }) });
    expect(result.current.stale).toBe(true);

    act(() => result.current.cancelEdit());

    // Throwing the draft away must land on what the server holds NOW. Restoring the old baseline
    // left the card showing values nobody has any more, still locked behind the reload banner.
    expect(result.current.draft.image).toBe('upstream:2');
    expect(result.current.dirty).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.conflict).toBe(false);

    // …and reopening is a working form, whose next write carries the new CAS token.
    act(() => result.current.beginEdit());
    expect(result.current.editing).toBe(true);
    act(() => result.current.patch({ image: 'edited-again:local' }));
    await act(async () => {
      await result.current.save();
    });
    expect(updateSandboxSettings).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 7 }),
    );
  });

  it('still restores the snapshot when nothing moved underneath the draft', () => {
    const { result } = setup(view());

    act(() => result.current.beginEdit());
    act(() => result.current.patch({ image: 'edited:local' }));
    act(() => result.current.cancelEdit());

    expect(result.current.draft.image).toBe('aihub-sandbox:latest');
    expect(result.current.dirty).toBe(false);
    expect(result.current.editing).toBe(false);
  });
});
