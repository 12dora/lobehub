/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentDropdownMenu } from './useDropdownMenu';

const managedAgentsRef = vi.hoisted(() => ({ current: false }));
const transferItemsRef = vi.hoisted(() => ({ current: null as unknown }));

const pinAgentMock = vi.hoisted(() => vi.fn());
const duplicateAgentMock = vi.hoisted(() => vi.fn());
const updateAgentGroupMock = vi.hoisted(() => vi.fn());
const removeAgentMock = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/builtin-agents', () => ({ BUILTIN_AGENT_SLUGS: { inbox: 'lobe-inbox' } }));

vi.mock('@lobechat/types', () => ({ SessionDefaultGroup: { Default: 'default' } }));

vi.mock(
  '@lobehub/ui',
  () =>
    new Proxy(
      { Icon: () => null },
      {
        // `then` must stay undefined: vitest awaits the mock factory's result, and a Proxy that
        // answers `'then' in ns` with a function looks like a thenable and never settles.
        get: (target, property: string) => {
          if (property === 'then') return undefined;
          if (property in target) return target[property as keyof typeof target];
          return () => null;
        },
        has: (_target, property) => property !== 'then',
      },
    ),
);

vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: vi.fn() }));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), success: vi.fn() } }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => undefined,
}));

vi.mock('@/business/client/hooks/useAgentTransferMenuItem', () => ({
  useAgentTransferMenuItem: () => transferItemsRef.current,
}));

vi.mock('@/business/client/hooks/useIsWorkspaceOwner', () => ({
  useIsWorkspaceOwner: () => false,
}));

vi.mock('@/features/EditingPopover/store', () => ({ openEditingPopover: vi.fn() }));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({
    blocked: managedAgentsRef.current,
    error: null,
    loading: false,
    managed: managedAgentsRef.current,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/features/VisibilityConfirmContent', () => ({ default: () => null }));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/services/agent', () => ({ agentService: {} }));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openAgentInNewWindow: vi.fn() }),
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      duplicateAgent: duplicateAgentMock,
      pinAgent: pinAgentMock,
      privateAgentGroups: [],
      refreshAgentList: vi.fn(),
      removeAgent: removeAgentMock,
      sessionGroups: [],
      updateAgentGroup: updateAgentGroupMock,
    }),
}));

vi.mock('@/store/home/selectors', () => ({
  homeAgentListSelectors: {
    agentGroups: () => [],
    privateAgentGroups: () => [],
  },
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ userId: 'user-1' }),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: { userId: (s: { userId: string }) => s.userId },
}));

const renderMenuKeys = (managed?: boolean) => {
  const { result } = renderHook(() =>
    useAgentDropdownMenu({
      anchor: null,
      group: undefined,
      id: 'agt_local',
      managed,
      openCreateGroupModal: vi.fn(),
      pinned: false,
      title: 'Local agent',
    }),
  );
  return (result.current() ?? []).map((item) =>
    item && typeof item === 'object' && 'key' in item ? (item.key as string) : 'divider',
  );
};

describe('useAgentDropdownMenu under an org-hosted agent catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
    transferItemsRef.current = null;
  });

  it('offers the full mutating menu when agents are not org-hosted', () => {
    const keys = renderMenuKeys();

    expect(keys).toContain('pin');
    expect(keys).toContain('rename');
    expect(keys).toContain('duplicate');
    expect(keys).toContain('moveGroup');
    expect(keys).toContain('delete');
    expect(keys).toContain('openInNewWindow');
  });

  it('drops every denied definition mutation and keeps pin + open-in-new-window', () => {
    managedAgentsRef.current = true;
    const keys = renderMenuKeys();

    // `agent.updateAgentPinned` is `exempt` in the mutation registry and
    // "open in new window" is a pure read, so those two survive.
    expect(keys).toEqual(['pin', 'openInNewWindow']);
    // Everything the registry marks `deny` is gone.
    for (const denied of [
      'rename',
      'duplicate',
      'moveGroup',
      'delete',
      'publishToWorkspace',
      'makePrivate',
    ]) {
      expect(keys).not.toContain(denied);
    }
  });

  it('drops the cross-workspace transfer entries too (agent.transferAgent is denied)', () => {
    managedAgentsRef.current = true;
    transferItemsRef.current = [{ key: 'transferAgent', label: 'transfer' }];

    expect(renderMenuKeys()).toEqual(['pin', 'openInNewWindow']);
  });

  it('keeps the platform-agent menu read-only regardless of the policy', () => {
    managedAgentsRef.current = true;

    expect(renderMenuKeys(true)).toEqual(['openInNewWindow']);
  });
});
