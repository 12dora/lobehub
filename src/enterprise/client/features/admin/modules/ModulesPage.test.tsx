import { toast } from '@lobehub/ui/base-ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_MODULES_ENABLED, type PlatformModuleStateMap } from '@/const/platform/modules';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminModulesState } from '@/enterprise/client/services/adminModules';

import ModulesPage from './ModulesPage';
import { refreshAdminModules } from './useAdminModules';

const access = {
  authMethod: 'password' as const,
  permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ, PLATFORM_PERMISSIONS.SYSTEM_OPERATE] as string[],
  status: 'allowed' as string,
};

let searchParams = new URLSearchParams();
const state = { data: undefined as AdminModulesState | undefined, error: undefined as unknown };
const update = vi.fn(async (..._args: unknown[]) => state.data!);
const restartRequest = vi.fn();
const dangerConfirm = vi.fn((options: { onConfirm: () => void }) => options.onConfirm());
const swrMutate = vi.fn();
/** i18n keys the (mocked) mutation runner would have shown as a toast. */
const mutationErrorKeys: string[] = [];
const infraStatus = {
  data: undefined as unknown,
  error: undefined as unknown,
  mutate: vi.fn(),
};

/**
 * base-ui's Button/Switch expect a ConfigProvider (motion) that no admin page mounts itself.
 * Substituting the two primitives keeps the page under test — the assertions are about draft
 * state, not about the design system's rendering.
 */
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: unknown;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children as never}
    </button>
  ),
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={Boolean(checked)}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onChange?.(!checked)}
    />
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const entries = Object.entries(options ?? {}).filter(([name]) => name !== 'defaultValue');
      if (entries.length === 0) return key;
      return `${key}(${entries.map(([name, value]) => `${name}=${String(value)}`).join(',')})`;
    },
  }),
}));

/**
 * Faithful stand-in for react-router@8's `useSearchParams`:
 * - a navigation re-renders every mounted consumer (the page reads the wizard flag off the query
 *   string alone, so a mock that only reassigns the variable could never prove it leaves);
 * - the setter closes over the params of the render that produced it, and the updater form is
 *   handed a copy of *those* params — a setter kept from an earlier render is therefore stale,
 *   exactly as in the real router;
 * - navigation options are recorded, so `{ replace: true }` is assertable.
 */
const router = {
  listeners: new Set<() => void>(),
  navigate(next: URLSearchParams, options?: { replace?: boolean }) {
    searchParams = next;
    this.navigations.push({ options, search: next.toString() });
    for (const listener of this.listeners) listener();
  },
  navigations: [] as { options?: { replace?: boolean }; search: string }[],
};

vi.mock('react-router', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    Link: ({ children }: { children: unknown }) => children,
    useSearchParams: () => {
      const [, rerender] = useReducer((tick: number) => tick + 1, 0);
      useEffect(() => {
        router.listeners.add(rerender);
        return () => {
          router.listeners.delete(rerender);
        };
      }, []);
      const current = searchParams;
      return [
        current,
        (
          next: URLSearchParams | ((previous: URLSearchParams) => URLSearchParams),
          options?: { replace?: boolean },
        ) => {
          router.navigate(
            typeof next === 'function'
              ? new URLSearchParams(next(new URLSearchParams(current)))
              : new URLSearchParams(next),
            options,
          );
        },
      ];
    },
  };
});

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => access,
}));

vi.mock('@/enterprise/client/services/adminModules', () => ({
  ADMIN_MODULES_SWR_KEY: 'admin.modules.get',
  adminModulesService: {
    get: vi.fn(),
    requestRestart: vi.fn(),
    update: (...args: unknown[]) => update(...args),
  },
}));

// Keep the real `isModuleRevisionConflict` — the point of the CAS test is that the page uses
// the production predicate, not a test-local re-implementation of it.
vi.mock('./useAdminModules', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshAdminModules: vi.fn(),
  useAdminModules: () => ({
    data: state.data,
    error: state.error,
    isLoading: !state.data && !state.error,
    mutate: swrMutate,
  }),
  useModuleRestart: () => ({ phase: 'idle', request: restartRequest, reset: vi.fn() }),
}));

vi.mock('../system/hooks/useAdminSystem', () => ({
  useAdminSystemStatus: () => infraStatus,
}));

/** Mirrors the real runner: one attempt, `mapErrorKey` decides the toast, false on failure. */
vi.mock('../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({
    mapErrorKey,
    onError,
    run,
  }: {
    mapErrorKey?: (error: unknown) => string;
    onError?: (error: unknown) => Promise<void> | void;
    run: () => Promise<void>;
  }) => {
    try {
      await run();
      return true;
    } catch (error) {
      mutationErrorKeys.push(mapErrorKey?.(error) ?? 'users.errors.generic');
      await onError?.(error);
      return false;
    }
  },
}));

vi.mock('../primitives/DangerConfirm', () => ({
  openDangerConfirm: (options: { onConfirm: () => void }) => dangerConfirm(options),
}));

const buildState = (overrides: Partial<AdminModulesState> = {}): AdminModulesState => ({
  instanceId: 'instance-1',
  pendingRestart: [],
  restart: { supported: true },
  snapshot: {
    db: null,
    effective: ALL_MODULES_ENABLED as PlatformModuleStateMap,
    envDisabled: [],
    envDisabledBy: {},
    preset: 'full',
    presetFromEnv: 'full',
    revision: 3,
    setupCompletedAt: '2026-08-17T00:00:00.000Z',
    ...overrides.snapshot,
  },
  ...overrides,
});

/** Every module row carries a stable `data-module`, so tests never depend on row order. */
const moduleSwitch = (id: string): HTMLElement =>
  document.querySelector(`[data-module="${id}"] [role="switch"]`) as HTMLElement;

const switches = () => screen.getAllByRole('switch');

beforeEach(() => {
  vi.clearAllMocks();
  mutationErrorKeys.length = 0;
  infraStatus.data = undefined;
  infraStatus.error = undefined;
  searchParams = new URLSearchParams();
  router.navigations.length = 0;
  router.listeners.clear();
  access.permissions = [PLATFORM_PERMISSIONS.SYSTEM_READ, PLATFORM_PERMISSIONS.SYSTEM_OPERATE];
  access.status = 'allowed';
  state.data = buildState();
  state.error = undefined;
});

describe('ModulesPage', () => {
  it('shows a skeleton while the first load is in flight, never an empty page', () => {
    state.data = undefined;
    render(<ModulesPage />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows only the failure and a retry when nothing could be loaded', () => {
    state.data = undefined;
    state.error = new Error('boom');
    render(<ModulesPage />);

    expect(screen.getByText('modules.errors.loadFailed')).toBeTruthy();
    expect(screen.getByText('access.error.retry')).toBeTruthy();
    // No editable surface over a state we never read: composing a change here would look like
    // it worked and then save nothing.
    expect(screen.queryAllByRole('switch')).toEqual([]);
    expect(screen.queryByText('modules.presets.full.title')).toBeNull();
    expect(screen.queryByText('modules.save')).toBeNull();
    expect(screen.queryByText('modules.summary.backgroundJobs')).toBeNull();
  });

  it('starts on the matching preset and switches to 自定义 after a change', () => {
    render(<ModulesPage />);
    const fullCard = screen.getByText('modules.presets.full.title').closest('button')!;
    expect(fullCard.dataset.active).toBe('true');

    fireEvent.click(switches()[0]);

    expect(fullCard.dataset.active).toBe('false');
    expect(screen.getByText('modules.presets.custom.title').parentElement!.dataset.active).toBe(
      'true',
    );
  });

  it('locks the switch of a module pinned off by the environment', () => {
    state.data = buildState({
      snapshot: {
        ...buildState().snapshot,
        effective: { ...ALL_MODULES_ENABLED, audit: false } as PlatformModuleStateMap,
        envDisabled: ['audit'],
        envDisabledBy: { audit: 'LOBE_MODULES_DISABLED' },
        preset: null,
      },
    });
    render(<ModulesPage />);

    const auditSwitch = moduleSwitch('audit');
    expect(auditSwitch.getAttribute('disabled')).not.toBeNull();
    expect(screen.getAllByText('modules.status.env').length).toBeGreaterThan(0);
  });

  it('keeps the summary in sync with the draft, before anything is saved', () => {
    render(<ModulesPage />);
    const before = screen.getByText('modules.summary.backgroundJobs').nextElementSibling!
      .textContent;

    // networkProxy owns background workers; switching it off must move the number immediately.
    fireEvent.click(moduleSwitch('networkProxy'));

    const after = screen.getByText('modules.summary.backgroundJobs').nextElementSibling!
      .textContent;
    expect(Number(after)).toBeLessThan(Number(before));
  });

  it('confirms before switching off a compliance module and only then saves', async () => {
    render(<ModulesPage />);
    fireEvent.click(moduleSwitch('audit'));
    fireEvent.click(screen.getByText('modules.save'));

    expect(dangerConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toEqual({ expectedRevision: 3, modules: { audit: false } });
  });

  it('saves a non-compliance change without a confirmation step', async () => {
    render(<ModulesPage />);
    fireEvent.click(moduleSwitch('taskTemplates'));
    fireEvent.click(screen.getByText('modules.save'));

    expect(dangerConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it('shows the restart banner with an actionable button when the platform supports it', () => {
    state.data = buildState({ pendingRestart: ['networkProxy'] });
    render(<ModulesPage />);

    expect(screen.getByText('modules.restart.title(n=1)')).toBeTruthy();
    fireEvent.click(screen.getByText('modules.restart.action'));
    expect(restartRequest).toHaveBeenCalledTimes(1);
  });

  it('replaces the restart button with an instruction when the deployment cannot restart itself', () => {
    state.data = buildState({
      pendingRestart: ['networkProxy'],
      restart: { reason: 'serverless', supported: false },
    });
    render(<ModulesPage />);

    expect(screen.queryByText('modules.restart.action')).toBeNull();
    expect(screen.getByText(/modules\.restart\.unsupported/)).toBeTruthy();
  });

  it('renders the three-step header only under ?wizard=1', () => {
    render(<ModulesPage />);
    expect(screen.queryByText('modules.wizard.step1')).toBeNull();

    searchParams = new URLSearchParams('wizard=1');
    render(<ModulesPage />);
    expect(screen.getByText('modules.wizard.step1')).toBeTruthy();
    expect(screen.getByText('modules.wizard.step3')).toBeTruthy();
  });

  it('read-only admins see the state but cannot change or save it', () => {
    access.permissions = [PLATFORM_PERMISSIONS.SYSTEM_READ];
    render(<ModulesPage />);
    expect(switches().every((node) => node.getAttribute('disabled') !== null)).toBe(true);
  });

  it('refuses the page outright without SYSTEM_READ', () => {
    access.permissions = [];
    render(<ModulesPage />);
    expect(screen.getByText('page.forbidden.desc')).toBeTruthy();
  });

  it('keeps the draft and lets the operator retry when a save fails for any other reason', async () => {
    update.mockRejectedValueOnce(new Error('offline'));
    render(<ModulesPage />);

    fireEvent.click(moduleSwitch('taskTemplates'));
    fireEvent.click(screen.getByText('modules.save'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // The server never changed, so throwing the operator's selection away would destroy work.
    expect(swrMutate).not.toHaveBeenCalled();
    expect(screen.getByText('modules.save')).toBeTruthy();
    expect(moduleSwitch('taskTemplates').getAttribute('aria-checked')).toBe('false');
    expect(mutationErrorKeys).toEqual(['modules.errors.saveFailed']);
  });

  it('reloads and drops the draft only on a revision conflict', async () => {
    update.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
    });
    render(<ModulesPage />);

    fireEvent.click(moduleSwitch('taskTemplates'));
    fireEvent.click(screen.getByText('modules.save'));

    await waitFor(() => expect(swrMutate).toHaveBeenCalled());
    expect(mutationErrorKeys).toEqual(['modules.errors.conflict']);
    await waitFor(() => expect(screen.queryByText('modules.save')).toBeNull());
    expect(moduleSwitch('taskTemplates').getAttribute('aria-checked')).toBe('true');
  });

  it('runs wizard completion through the same compliance confirmation', async () => {
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    render(<ModulesPage />);

    fireEvent.click(moduleSwitch('audit'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    // Finishing setup must not be a back door around the audit warning.
    expect(dangerConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toEqual({
      expectedRevision: 3,
      modules: { audit: false },
      setupCompleted: true,
    });
  });

  it('marks setup complete from the wizard even with nothing changed', async () => {
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    expect(dangerConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toEqual({
      expectedRevision: 3,
      modules: {},
      setupCompleted: true,
    });
  });

  it('returns to the module list once 完成 has saved, keeping the rest of the query', async () => {
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1&from=overview');
    infraStatus.data = { dependencies: {} };
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(searchParams.get('wizard')).toBeNull());
    expect(searchParams.get('from')).toBe('overview');
    // Ending the wizard is not a step in the history: 后退 must go where the operator came from.
    expect(router.navigations.at(-1)).toEqual({
      options: { replace: true },
      search: 'from=overview',
    });
    // Wizard chrome gone, the ordinary page back — not a dead step-3 panel.
    expect(screen.queryByText('modules.wizard.step1')).toBeNull();
    expect(screen.queryByText('modules.wizard.finish')).toBeNull();
    expect(screen.getByText('modules.presets.full.title')).toBeTruthy();
    expect(switches().length).toBeGreaterThan(0);
  });

  it('keeps a query param added while the finishing save was still in flight', async () => {
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    let finishSave: (value: AdminModulesState) => void = () => {};
    update.mockImplementationOnce(
      () =>
        new Promise<AdminModulesState>((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    // Another surface navigates while the save is pending — the finish must strip `wizard` from
    // the query as it stands then, not restore the one captured when the save began.
    act(() => {
      router.navigate(new URLSearchParams('wizard=1&highlight=audit'));
    });
    act(() => finishSave(state.data!));

    await waitFor(() => expect(searchParams.get('wizard')).toBeNull());
    expect(searchParams.get('highlight')).toBe('audit');
  });

  it('leaves the wizard before the module list is refetched', async () => {
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    let finishRefresh: () => void = () => {};
    vi.mocked(refreshAdminModules).mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
    );
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    // The refetch is the slow part: the operator must be back on the module list well before it
    // lands, rather than staring at a finished wizard.
    await waitFor(() => expect(searchParams.get('wizard')).toBeNull());
    expect(screen.queryByText('modules.wizard.finish')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();

    act(() => finishRefresh());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });

  it('stays in the wizard when the finishing save fails', async () => {
    update.mockRejectedValueOnce(new Error('offline'));
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(mutationErrorKeys).toEqual(['modules.errors.saveFailed']);
    expect(searchParams.get('wizard')).toBe('1');
    expect(screen.getByText('modules.wizard.finish')).toBeTruthy();
  });

  it('stays in the wizard when the compliance confirmation is cancelled', () => {
    dangerConfirm.mockImplementationOnce(() => {});
    state.data = buildState({
      snapshot: { ...buildState().snapshot, setupCompletedAt: null },
    });
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.data = { dependencies: {} };
    render(<ModulesPage />);

    fireEvent.click(moduleSwitch('audit'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.next'));
    fireEvent.click(screen.getByText('modules.wizard.finish'));

    expect(dangerConfirm).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(searchParams.get('wizard')).toBe('1');
    expect(screen.getByText('modules.wizard.finish')).toBeTruthy();
  });

  it('shows the measured resident-memory figure and the memory half of the preset comparison', () => {
    render(<ModulesPage />);
    // Every module in the constant table now carries a measured `idleRssMb` (0 for on-demand
    // modules), so the summary shows a real value — never the 未测量 fallback or a "≥" hedge.
    expect(screen.queryByText('modules.summary.unmeasured')).toBeNull();
    expect(screen.queryByText(/modules\.summary\.idleRssAtLeast/)).toBeNull();
    expect(screen.getByText(/modules\.summary\.idleRssValue/)).toBeTruthy();
    expect(screen.getByText(/modules\.summary\.compareStandard(?!Jobs)/)).toBeTruthy();
  });

  it('offers a retry and a way past a failed infrastructure probe', () => {
    searchParams = new URLSearchParams('wizard=1');
    infraStatus.error = new Error('probe unreachable');
    render(<ModulesPage />);

    fireEvent.click(screen.getByText('modules.wizard.next'));

    expect(screen.getByText('modules.wizard.infraFailed')).toBeTruthy();
    expect(screen.getByText('modules.wizard.infraFailedHint')).toBeTruthy();
    fireEvent.click(screen.getByText('access.error.retry'));
    expect(infraStatus.mutate).toHaveBeenCalledTimes(1);
    // Advisory check: a failed probe must not trap the operator in step 2.
    expect(screen.getByText('modules.wizard.next').getAttribute('disabled')).toBeNull();
  });

  it('holds 下一步 only while the probe is still in flight', () => {
    searchParams = new URLSearchParams('wizard=1');
    render(<ModulesPage />);
    fireEvent.click(screen.getByText('modules.wizard.next'));
    expect(screen.getByText('modules.wizard.next').getAttribute('disabled')).not.toBeNull();
  });

  it('translates the restart reason instead of printing the internal token', () => {
    state.data = buildState({
      pendingRestart: ['networkProxy'],
      restart: { reason: 'supervisor_not_configured', supported: false },
    });
    render(<ModulesPage />);

    expect(
      screen.getByText(
        'modules.restart.unsupportedBecause(reason=modules.restart.reason.supervisor_not_configured)',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('modules.restart.envHint(variable=PLATFORM_RESTART_MODE=supervisor)'),
    ).toBeTruthy();
    expect(screen.queryByText('（supervisor_not_configured）')).toBeNull();
  });

  it('falls back to generic copy for an unrecognized restart reason', () => {
    state.data = buildState({
      pendingRestart: ['networkProxy'],
      restart: { reason: 'brand_new_token', supported: false },
    });
    render(<ModulesPage />);

    expect(
      screen.getByText('modules.restart.unsupportedBecause(reason=modules.restart.reason.unknown)'),
    ).toBeTruthy();
    expect(screen.queryByText(/modules\.restart\.envHint/)).toBeNull();
  });
});
