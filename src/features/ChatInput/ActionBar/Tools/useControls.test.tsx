/**
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useControls } from './useControls';

const mocks = vi.hoisted(() => {
  const mutatePlatformCatalog = vi.fn();
  const toastError = vi.fn();
  const emptyAsyncAction = vi.fn(async () => undefined);
  const emptyHook = vi.fn();
  const toolState = {
    deleteAgentSkill: emptyAsyncAction,
    deleteConnector: emptyAsyncAction,
    fetchConnectors: emptyAsyncAction,
    installCustomPlugin: emptyAsyncAction,
    isConnectorsInit: true,
    platformSkillRuntimeManaged: true,
    platformSkillRuntimeStatus: 'error',
    removeComposioConnection: emptyAsyncAction,
    uninstallBuiltinTool: emptyAsyncAction,
    uninstallCustomPlugin: emptyAsyncAction,
    updateNewCustomPlugin: vi.fn(),
    useFetchAgentSkills: emptyHook,
    useFetchLobehubSkillConnections: emptyHook,
    useFetchUninstalledBuiltinTools: emptyHook,
    useFetchUserComposioConnections: emptyHook,
  };
  return { emptyAsyncAction, mutatePlatformCatalog, toastError, toolState };
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
  confirmModal: vi.fn(),
  toast: { error: mocks.toastError },
}));

vi.mock('@/enterprise/client/features/skills', () => ({
  selectSkillRuntimeSources: () => ({ builtin: [], market: [], platform: null, user: [] }),
  usePublishedSkillCatalog: () => ({ mutate: mocks.mutatePlatformCatalog }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'LobeHub' }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/useCheckPluginsIsInstalled', () => ({
  useCheckPluginsIsInstalled: vi.fn(),
}));

vi.mock('@/hooks/useFetchInstalledPlugins', () => ({
  useFetchInstalledPlugins: vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (
    selector: (state: {
      setPluginModeById: typeof mocks.emptyAsyncAction;
      togglePlugin: typeof mocks.emptyAsyncAction;
    }) => unknown,
  ) =>
    selector({
      setPluginModeById: mocks.emptyAsyncAction,
      togglePlugin: mocks.emptyAsyncAction,
    }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentConfigById: () => () => ({ plugins: [] }),
    getAgentPluginsById: () => () => [],
  },
  chatConfigByIdSelectors: {
    getSkillActivateModeById: () => () => 'auto',
  },
}));

vi.mock('@/store/serverConfig', () => ({
  serverConfigSelectors: {
    enableComposio: () => false,
    enableLobehubSkill: () => false,
  },
  useServerConfigStore: (selector: (state: object) => unknown) => selector({}),
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (state: typeof mocks.toolState) => unknown) => selector(mocks.toolState),
}));

vi.mock('@/store/tool/selectors', () => ({
  agentSkillsSelectors: {
    getMarketAgentSkills: () => [],
    getPlatformSkillCatalog: () => null,
    getUserAgentSkills: () => [],
  },
  builtinToolSelectors: {
    fixedDisplayMetaList: () => () => [],
    installedBuiltinSkills: () => [],
    metaList: () => [],
    metaListIncludingHidden: () => [],
  },
  composioStoreSelectors: { getServers: () => [] },
  lobehubSkillStoreSelectors: { getServers: () => [] },
  pluginSelectors: {
    getCustomPluginById: () => () => undefined,
    installedPluginMetaList: () => [],
  },
}));

vi.mock('@/store/tool/slices/connector', () => ({
  connectorSelectors: { customConnectors: () => [] },
}));

vi.mock('../../hooks/useAgentId', () => ({
  useAgentId: () => 'agent-1',
}));

vi.mock('../../hooks/useUpdateAgentConfig', () => ({
  useUpdateAgentConfig: () => ({ updateAgentChatConfig: mocks.emptyAsyncAction }),
}));

describe('useControls managed skill retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolState.platformSkillRuntimeManaged = true;
    mocks.toolState.platformSkillRuntimeStatus = 'error';
  });

  it('wires retry pending and failure feedback through the Chat tools menu item', async () => {
    let rejectRetry!: (cause: unknown) => void;
    mocks.mutatePlatformCatalog.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );

    const { result } = renderHook(() => useControls());
    const autoGroup = result.current.marketItems.find((item) => item?.key === 'auto');
    const retryItem =
      autoGroup && 'children' in autoGroup
        ? autoGroup.children?.find((item) => item?.key === 'platform-skill-runtime-unavailable')
        : undefined;

    expect(retryItem?.key).toBe('platform-skill-runtime-unavailable');
    render(createElement('div', null, retryItem && 'label' in retryItem ? retryItem.label : null));

    const retryButton = screen.getByText('retry');
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(retryButton).toBeDisabled();
      expect(retryButton).toHaveAttribute('data-loading', 'true');
    });

    await act(async () => rejectRetry(new Error('chat refresh failed')));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('platformSkills.runtime.refreshFailed'),
    );
    expect(mocks.mutatePlatformCatalog).toHaveBeenCalledTimes(1);
  });
});
