/**
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useManagedSkillMenuSections } from './ManagedSkillToolItems';
import { useManagedAgentSkills } from './useManagedAgentSkills';

const mocks = vi.hoisted(() => {
  // Typed with the real (agentId, config) signature so mock.calls[0] is a 2-tuple.
  const updateAgentConfigById = vi.fn(
    async (_agentId: string, _config: { plugins?: unknown }) => undefined,
  );
  const mutate = vi.fn();
  const toastError = vi.fn();
  const toolState = {
    installedBuiltinSkills: [{ identifier: 'builtin-a' }],
    marketAgentSkills: [{ identifier: 'market-a' }],
    platformSkillCatalog: {
      revision: 'r1',
      skills: [
        {
          checksum: 'a'.repeat(64),
          description: null,
          displayName: 'Approved',
          distribution: 'optional' as const,
          skillKey: 'approved.skill',
          source: 'uploaded' as const,
          version: '1.0.0',
        },
      ],
    },
    platformSkillRuntimeManaged: true,
    platformSkillRuntimeStatus: 'ready' as string,
    userAgentSkills: [{ identifier: 'user-a' }],
  };
  return { mutate, toastError, toolState, updateAgentConfigById };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    loading,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: (event: { stopPropagation: () => void }) => Promise<void>;
  }) =>
    createElement(
      'button',
      {
        'data-loading': loading ? 'true' : 'false',
        disabled,
        'onClick': () => void onClick?.({ stopPropagation: vi.fn() }),
        'type': 'button',
      },
      children,
    ),
  toast: { error: mocks.toastError },
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (
    selector: (s: { updateAgentConfigById: typeof mocks.updateAgentConfigById }) => unknown,
  ) => selector({ updateAgentConfigById: mocks.updateAgentConfigById }),
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (
    selector: (s: typeof mocks.toolState) => unknown,
    // equality fn optional
    _eq?: unknown,
  ) => selector(mocks.toolState),
}));

vi.mock('@/store/tool/selectors', () => ({
  agentSkillsSelectors: {
    getMarketAgentSkills: (s: typeof mocks.toolState) => s.marketAgentSkills,
    getPlatformSkillCatalog: (s: typeof mocks.toolState) => s.platformSkillCatalog,
    getUserAgentSkills: (s: typeof mocks.toolState) => s.userAgentSkills,
  },
  builtinToolSelectors: {
    installedBuiltinSkills: (s: typeof mocks.toolState) => s.installedBuiltinSkills,
  },
}));

vi.mock('@/enterprise/client/features/skills', () => ({
  // Mirror selectSkillRuntimeSources arbitration (real logic is unit-tested elsewhere).
  selectSkillRuntimeSources: (params: {
    builtin: unknown[];
    market: unknown[];
    platform: unknown;
    status: string;
    user: unknown[];
  }) => {
    if (params.status === 'unmanaged') {
      return {
        builtin: params.builtin,
        market: params.market,
        platform: null,
        user: params.user,
      };
    }
    if (params.status === 'ready') {
      return { builtin: [], market: [], platform: params.platform, user: [] };
    }
    return { builtin: [], market: [], platform: null, user: [] };
  },
  usePublishedSkillCatalog: () => ({ mutate: mocks.mutate }),
}));

describe('useManagedAgentSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolState.platformSkillRuntimeManaged = true;
    mocks.toolState.platformSkillRuntimeStatus = 'ready';
  });

  it('ready: arbitrated lists empty, raw lists preserved, platform catalog surfaced', () => {
    const { result } = renderHook(() => useManagedAgentSkills('agent-1', { plugins: [] }, true));

    expect(result.current.useLegacySkills).toBe(false);
    expect(result.current.installedBuiltinSkills).toEqual([]);
    expect(result.current.marketAgentSkills).toEqual([]);
    expect(result.current.userAgentSkills).toEqual([]);
    expect(result.current.platformSkillCatalog).toEqual(mocks.toolState.platformSkillCatalog);

    // Identity bookkeeping must keep raw store lists under managed ready
    expect(result.current.rawBuiltinSkills).toEqual([{ identifier: 'builtin-a' }]);
    expect(result.current.rawMarketSkills).toEqual([{ identifier: 'market-a' }]);
    expect(result.current.rawUserSkills).toEqual([{ identifier: 'user-a' }]);
    expect(result.current.rawPlatformCatalog).toEqual(mocks.toolState.platformSkillCatalog);
  });

  it('unmanaged: arbitrated lists equal raw lists and platform catalog is null', () => {
    mocks.toolState.platformSkillRuntimeManaged = false;
    mocks.toolState.platformSkillRuntimeStatus = 'unmanaged';

    const { result } = renderHook(() => useManagedAgentSkills('agent-1', { plugins: [] }, true));

    expect(result.current.useLegacySkills).toBe(true);
    expect(result.current.platformSkillCatalog).toBeNull();
    expect(result.current.installedBuiltinSkills).toEqual(result.current.rawBuiltinSkills);
    expect(result.current.marketAgentSkills).toEqual(result.current.rawMarketSkills);
    expect(result.current.userAgentSkills).toEqual(result.current.rawUserSkills);
  });

  it('loading/error: arbitrated empty, raw lists still available for bookkeeping', () => {
    for (const status of ['loading', 'error'] as const) {
      mocks.toolState.platformSkillRuntimeStatus = status;
      const { result } = renderHook(() => useManagedAgentSkills('agent-1', { plugins: [] }, true));
      expect(result.current.installedBuiltinSkills).toEqual([]);
      expect(result.current.platformSkillCatalog).toBeNull();
      expect(result.current.rawMarketSkills).toEqual([{ identifier: 'market-a' }]);
    }
  });

  it('togglePlatformSkill writes upsertPluginMode result via updateAgentConfigById', async () => {
    const skill = mocks.toolState.platformSkillCatalog.skills[0];
    const { result } = renderHook(() => useManagedAgentSkills('agent-1', { plugins: [] }, true));

    await act(async () => {
      await result.current.togglePlatformSkill(skill);
    });

    expect(mocks.updateAgentConfigById).toHaveBeenCalledTimes(1);
    const [agentId, patch] = mocks.updateAgentConfigById.mock.calls[0]!;
    expect(agentId).toBe('agent-1');
    // optional skill toggled on from absent → pinned (or equivalent enabled mode)
    expect(patch.plugins).toBeDefined();
    expect(JSON.stringify(patch.plugins)).toContain('approved.skill');
  });

  it('retryPlatformCatalog returns the catalog SWR mutation promise', async () => {
    mocks.mutate.mockResolvedValueOnce('refreshed');
    const { result } = renderHook(() => useManagedAgentSkills('agent-1', { plugins: [] }, true));
    await act(async () => {
      await expect(result.current.retryPlatformCatalog()).resolves.toBe('refreshed');
    });
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it('wires retry pending and failure feedback through the Profile managed-skill menu item', async () => {
    mocks.toolState.platformSkillRuntimeStatus = 'error';
    let rejectRetry!: (cause: unknown) => void;
    mocks.mutate.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );

    const { result: managedResult } = renderHook(() =>
      useManagedAgentSkills('agent-1', { plugins: [] }, true),
    );
    const { result: sectionsResult } = renderHook(() =>
      useManagedSkillMenuSections({
        canEdit: true,
        config: { plugins: [] },
        managed: managedResult.current,
        setUpdating: vi.fn(),
      }),
    );
    const retryItem = sectionsResult.current.platformSkillUnavailableItems[0];
    expect(retryItem?.key).toBe('platform-skill-runtime-unavailable');
    render(createElement('div', null, retryItem?.label));

    const retryButton = screen.getByText('retry');
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(retryButton).toBeDisabled();
      expect(retryButton).toHaveAttribute('data-loading', 'true');
    });
    await act(async () => rejectRetry(new Error('profile refresh failed')));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('platformSkills.runtime.refreshFailed');
  });
});
