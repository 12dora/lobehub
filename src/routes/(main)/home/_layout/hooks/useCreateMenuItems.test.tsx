/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ZodModule from 'zod';

import { useCreateMenuItems } from './useCreateMenuItems';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

const createAgentMock = vi.hoisted(() => vi.fn().mockResolvedValue({ agentId: 'agent-codex' }));
const refreshAgentListMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const addGroupMock = vi.hoisted(() => vi.fn());
const switchToGroupMock = vi.hoisted(() => vi.fn());
const createGroupMock = vi.hoisted(() => vi.fn());
const loadGroupsMock = vi.hoisted(() => vi.fn());
const createNewPageMock = vi.hoisted(() => vi.fn());
const messageErrorMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const managedAgentsRef = vi.hoisted(() => ({ current: false }));

vi.mock(
  '@lobechat/const',
  () =>
    new Proxy(
      {
        COMPOSIO_APP_TYPES: [],
        DEFAULT_AGENT: {},
        DEFAULT_COMMON_SETTINGS: {},
        DEFAULT_HOTKEY_CONFIG: {},
        DEFAULT_IMAGE_CONFIG: {},
        DEFAULT_MEMORY_SETTINGS: {},
        DEFAULT_MINI_MODEL: 'mini-model',
        DEFAULT_MINI_PROVIDER: 'mini-provider',
        DEFAULT_MODEL: 'model',
        DEFAULT_NOTIFICATION_SETTINGS: {},
        DEFAULT_PROVIDER: 'provider',
        DEFAULT_SYSTEM_AGENT_CONFIG: {},
        DEFAULT_TOOL_CONFIG: {},
        DEFAULT_TTS_CONFIG: {},
        EDITOR_DEBOUNCE_TIME: 0,
        EDITOR_MAX_WAIT: 0,
        INTEREST_AREA_KEYS: [],
        LOBEHUB_SKILL_PROVIDERS: [],
        MARKDOWN_MIME_TYPES: [],
        RECOMMENDED_SKILLS: [],
        RecommendedSkillType: { Builtin: 'builtin', Composio: 'composio', Lobehub: 'lobehub' },
        isDesktop: true,
      },
      {
        // `then` must stay undefined: vitest awaits the mock factory's result, and a Proxy that
        // answers `'then' in ns` with a value looks like a thenable, so the await never settles
        // and the whole file hangs before a single test runs.
        get: (target, property: string) => {
          if (property === 'then') return undefined;
          if (property in target) return target[property as keyof typeof target];
          if (/(?:KEYS|MIME_TYPES|SKILLS|TYPES)$/.test(property)) return [];
          if (property.startsWith('DEFAULT_')) return {};
          return undefined;
        },
        has: (_target, property) => property !== 'then',
      },
    ),
);

vi.mock('@lobechat/heterogeneous-agents/client', () => ({
  HETEROGENEOUS_AGENT_CLIENT_CONFIGS: [
    {
      avatar: 'claude-avatar',
      command: 'claude',
      icon: () => null,
      iconId: 'ClaudeCode',
      menuKey: 'newClaudeCodeAgent',
      menuLabelKey: 'newClaudeCodeAgent',
      title: 'Claude Code',
      type: 'claude-code',
    },
    {
      avatar: 'avatar',
      command: 'codex',
      icon: () => null,
      iconId: 'Codex',
      menuKey: 'newCodexAgent',
      menuLabelKey: 'newCodexAgent',
      title: 'Codex',
      type: 'codex',
    },
  ],
}));

vi.mock(
  '@lobehub/ui',
  () =>
    new Proxy(
      { Icon: () => null },
      {
        // See the `@lobechat/const` mock above — `then` must not be answered by the Proxy.
        get: (target, property: string) => {
          if (property === 'then') return undefined;
          if (property in target) return target[property as keyof typeof target];
          return ({ children }: { children?: unknown }) => children;
        },
        has: (_target, property) => property !== 'then',
      },
    ),
);

vi.mock('@lobehub/ui/icons', () => ({
  GroupBotIcon: () => null,
  GroupBotSquareIcon: () => null,
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({
      message: { error: messageErrorMock },
      notification: { error: vi.fn() },
    }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('swr/mutation', () => ({
  default: () => ({
    isMutating: false,
    trigger: vi.fn(),
  }),
}));

vi.mock('@/components/ChatGroupWizard/templates', () => ({
  useGroupTemplates: () => [],
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

vi.mock('@/routes/(main)/home/_layout/Body/Agent/ModalProvider', () => ({
  useOptionalAgentModal: () => undefined,
}));

vi.mock('@/services/chatGroup', () => ({
  chatGroupService: {
    createGroupWithMembers: vi.fn(),
  },
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createAgent: createAgentMock,
    }),
}));

vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createGroup: createGroupMock,
      loadGroups: loadGroupsMock,
    }),
}));

vi.mock('@/store/home', () => ({
  useHomeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      addGroup: addGroupMock,
      refreshAgentList: refreshAgentListMock,
      switchToGroup: switchToGroupMock,
    }),
}));

vi.mock('@/store/page', () => ({
  usePageStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      createNewPage: createNewPageMock,
    }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ preference: { lab: {} } }),
}));

vi.mock('@/store/user/selectors', () => ({
  labPreferSelectors: {
    enablePlatformAgent: () => false,
  },
}));

const isActionItem = (
  item: unknown,
): item is {
  label?: unknown;
  key: string;
  onClick?: (info: { domEvent?: { stopPropagation?: () => void } }) => Promise<void> | void;
} => !!item && typeof item === 'object' && 'key' in item;

describe('useCreateMenuItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedAgentsRef.current = false;
  });

  it('removes every agent definition creation entry while keeping non-agent actions', () => {
    managedAgentsRef.current = true;
    const { result } = renderHook(() => useCreateMenuItems());

    expect(result.current.createAgentMenuItem()).toBeNull();
    expect(result.current.createMarketAgentMenuItem()).toBeNull();
    expect(result.current.createHeterogeneousAgentMenuItems()).toEqual([]);
    // Group chat is an agent create too — the wizard writes a supervisor agent and
    // `agentGroup.createGroup` is `deny` in the managed-resource mutation registry — so
    // `createGroupChatMenuItem()` nulls out as well and only the non-agent page action survives.
    expect(result.current.createGroupChatMenuItem()).toBeNull();
    expect(
      result.current
        .createTopLevelMenuItems()
        .flatMap((item) => (isActionItem(item) ? [item.key] : [])),
    ).toEqual(['newPage']);
  });

  it('adds the market agent entry to the top-level create menu', async () => {
    const { result } = renderHook(() => useCreateMenuItems());

    const items = result.current.createTopLevelMenuItems();
    const itemKeys = items.map((item) =>
      isActionItem(item)
        ? item.key
        : item && typeof item === 'object' && 'type' in item
          ? item.type
          : item,
    );

    expect(itemKeys).toEqual([
      'newAgent',
      'newGroupChat',
      'newPage',
      'divider',
      'newClaudeCodeAgent',
      'newCodexAgent',
      'divider',
      'addAgentFromMarket',
    ]);

    const marketItem = items.find(
      (item) => isActionItem(item) && item.key === 'addAgentFromMarket',
    );

    if (!isActionItem(marketItem)) {
      throw new Error('Expected market agent menu item');
    }

    expect(marketItem.label).toBe('addAgentFromMarket');

    const stopPropagation = vi.fn();
    await act(async () => {
      await marketItem.onClick?.({ domEvent: { stopPropagation } });
    });

    expect(stopPropagation).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/community/agent');
  });

  it('creates the Claude Code agent normally when the CLI is available', async () => {
    const { result } = renderHook(() => useCreateMenuItems());

    const claudeItem = result.current
      .createHeterogeneousAgentMenuItems()
      .find((item) => isActionItem(item) && item.key === 'newClaudeCodeAgent');

    if (!isActionItem(claudeItem)) {
      throw new Error('Expected Claude Code menu item');
    }

    await act(async () => {
      await claudeItem.onClick?.({ domEvent: { stopPropagation: vi.fn() } });
    });

    expect(createAgentMock).toHaveBeenCalledWith({
      config: {
        agencyConfig: {
          heterogeneousProvider: {
            command: 'claude',
            type: 'claude-code',
          },
        },
        avatar: 'claude-avatar',
        provider: 'claude-code',
        systemRole: '',
        title: 'Claude Code',
      },
      groupId: undefined,
    });
    expect(refreshAgentListMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/agent/agent-codex');
  });

  it('creates the Codex agent normally without preflight interception', async () => {
    const { result } = renderHook(() => useCreateMenuItems());

    const codexItem = result.current
      .createHeterogeneousAgentMenuItems()
      .find((item) => isActionItem(item) && item.key === 'newCodexAgent');

    if (!isActionItem(codexItem)) {
      throw new Error('Expected Codex menu item');
    }

    await act(async () => {
      await codexItem.onClick?.({ domEvent: { stopPropagation: vi.fn() } });
    });

    expect(createAgentMock).toHaveBeenCalledWith({
      config: {
        agencyConfig: {
          heterogeneousProvider: {
            command: 'codex',
            type: 'codex',
          },
        },
        avatar: 'avatar',
        provider: 'codex',
        systemRole: '',
        title: 'Codex',
      },
      groupId: undefined,
    });
    expect(refreshAgentListMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/agent/agent-codex');
  });
});
