/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommandMenu } from './useCommandMenu';

const managedAgentsRef = vi.hoisted(() => ({ current: false }));
const canCreateRef = vi.hoisted(() => ({ current: true }));

const createAgentMock = vi.hoisted(() => vi.fn().mockResolvedValue({ agentId: 'agt_new' }));
const refreshAgentListMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const openGroupWizardMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const onCloseMock = vi.hoisted(() => vi.fn());

vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

vi.mock('swr', () => ({ default: () => ({ data: undefined, isLoading: false }) }));

vi.mock('./CommandMenuContext', () => ({
  useCommandMenuContext: () => ({
    activeAgentId: undefined,
    menuContext: 'home',
    mounted: true,
    onClose: onCloseMock,
    page: undefined,
    pages: [],
    pathname: '/',
    search: '',
    selectedAgent: undefined,
    setPages: vi.fn(),
    setSearch: vi.fn(),
    setSelectedAgent: vi.fn(),
    setTypeFilter: vi.fn(),
    setViewMode: vi.fn(),
    typeFilter: undefined,
    viewMode: 'default',
  }),
}));

vi.mock('@/features/LibraryModal', () => ({
  useCreateNewModal: () => ({ open: vi.fn() }),
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({
    blocked: managedAgentsRef.current,
    error: null,
    loading: false,
    managed: managedAgentsRef.current,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => navigateMock,
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: canCreateRef.current }),
}));

vi.mock('@/layout/GlobalProvider/GroupWizardProvider', () => ({
  useGroupWizard: () => ({ openGroupWizard: openGroupWizardMock }),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: { search: { query: { query: vi.fn() } } },
}));

vi.mock('@/routes/(main)/home/_layout/hooks', () => ({
  useCreateMenuItems: () => ({
    createGroupFromTemplate: vi.fn(),
    createGroupWithMembers: vi.fn(),
    createPage: vi.fn(),
  }),
}));

vi.mock('@/services/electron/system', () => ({ electronSystemService: {} }));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ createAgent: createAgentMock }),
}));

vi.mock('@/store/agent/selectors/builtinAgentSelectors', () => ({
  builtinAgentSelectors: { inboxAgentId: () => 'inbox' },
}));

vi.mock('@/store/chat', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openNewTopicOrSaveTopic: vi.fn() });
  useChatStore.getState = () => ({});
  return { useChatStore };
});

vi.mock('@/store/chat/selectors', () => ({
  topicSelectors: { isNewTopicSendInFlight: () => false },
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ status: { showCommandMenu: true } }),
}));

vi.mock('@/store/global/helpers', () => ({
  globalHelpers: { getCurrentLanguage: () => 'en-US' },
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ refreshAgentList: refreshAgentListMock }),
}));

describe('useCommandMenu agent-creation gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
    canCreateRef.current = true;
  });

  it('allows the new-agent and new-agent-team commands when agents are not org-hosted', async () => {
    const { result } = renderHook(() => useCommandMenu());

    expect(result.current.agentCreationAllowed).toBe(true);

    await act(async () => {
      await result.current.handleCreateSession();
    });
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/agent/agt_new');

    act(() => {
      result.current.handleCreateAgentTeam();
    });
    expect(openGroupWizardMock).toHaveBeenCalledTimes(1);
  });

  it('blocks both create commands from reaching the API while agents are org-hosted', async () => {
    managedAgentsRef.current = true;
    const { result } = renderHook(() => useCommandMenu());

    expect(result.current.agentCreationAllowed).toBe(false);

    await act(async () => {
      await result.current.handleCreateSession();
    });
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(refreshAgentListMock).not.toHaveBeenCalled();

    act(() => {
      result.current.handleCreateAgentTeam();
    });
    expect(openGroupWizardMock).not.toHaveBeenCalled();
  });

  it('still blocks the create commands when the permission check alone would allow them', () => {
    managedAgentsRef.current = true;
    canCreateRef.current = true;
    const { result } = renderHook(() => useCommandMenu());

    expect(result.current.agentCreationAllowed).toBe(false);
  });
});
