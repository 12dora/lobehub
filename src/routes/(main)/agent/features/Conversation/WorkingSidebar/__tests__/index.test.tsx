import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AgentWorkingSidebar from '../index';

/** ParamsSection is `lazy()`-loaded; wrap so the active-params path can settle. */
const renderSidebar = () =>
  render(
    <Suspense fallback={null}>
      <AgentWorkingSidebar />
    </Suspense>,
  );

// ─── captured RightPanel props ────────────────────────────────────────────────
// The real RightPanel is a controlled DraggablePanel; here we stub it so the test
// can read back the `width` it receives and drive its `onSizeChange` directly.

interface CapturedRightPanelProps {
  children?: ReactNode;
  onSizeChange?: (size?: { height?: number | string; width?: number | string }) => void;
  width?: number | string;
}

const rightPanel = vi.hoisted(() => ({
  current: undefined as CapturedRightPanelProps | undefined,
}));

const agentStore = vi.hoisted(() => ({
  activeAgentId: undefined as string | undefined,
  isHeterogeneous: false,
  isChatMode: false,
  isLocalSystemEnabled: false,
  rawAgencyConfig: undefined as
    { boundDeviceId?: string; executionTarget?: 'device' | 'local' } | undefined,
}));

const reviewState = vi.hoisted(() => ({
  repoType: undefined as string | undefined,
  setRepoType: undefined as ((repoType?: string) => void) | undefined,
  showTree: false,
  workingDirectory: undefined as string | undefined,
}));

const globalStore = vi.hoisted(() => ({
  toggleRightPanel: vi.fn(),
  setWorkingSidebarTab: vi.fn(),
  status: {
    showRightPanel: true,
    workingSidebarTab: undefined as string | undefined,
  },
}));

vi.mock('@/features/RightPanel', () => ({
  default: (props: CapturedRightPanelProps) => {
    rightPanel.current = props;
    return <div data-testid="right-panel">{props.children}</div>;
  },
}));

// ─── stub every downstream dependency so the sidebar renders deterministically ──

vi.mock('../Files', () => ({ default: () => <div /> }));
vi.mock('../Review', () => ({ default: () => <div /> }));
vi.mock('../ProgressSection', () => ({ default: () => <div /> }));
vi.mock('../ResourcesSection', () => ({ default: () => <div /> }));
vi.mock('../ParamsSection', () => ({ default: () => <div /> }));

vi.mock('@/store/agent', () => ({
  getAgentStoreState: () => agentStore,
  useAgentStore: (selector: (s: typeof agentStore) => unknown) => selector(agentStore),
}));
vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: () => () => agentStore.rawAgencyConfig,
    isWorkspaceAgentById: () => () => false,
  },
  agentSelectors: {
    getAgentConfigById: () => () => undefined,
    isCurrentAgentHeterogeneous: (s: typeof agentStore) => s.isHeterogeneous,
  },
  chatConfigByIdSelectors: {
    isChatModeById: () => () => agentStore.isChatMode,
    isLocalSystemEnabledById: () => () => agentStore.isLocalSystemEnabled,
  },
}));
vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (s: typeof globalStore) => unknown) => selector(globalStore),
}));
vi.mock('@/store/electron', () => ({ useElectronStore: () => undefined }));

vi.mock('@/features/ChatInput/ControlBar/useRepoType', async () => {
  const { useState } = await import('react');

  return {
    useRepoType: () => {
      const [repoType, setRepoType] = useState(reviewState.repoType);
      reviewState.setRepoType = setRepoType;
      return repoType;
    },
  };
});
vi.mock('@/hooks/useEffectiveWorkingDirectory', () => ({
  useEffectiveWorkingDirectory: () => reviewState.workingDirectory,
}));
vi.mock('@/hooks/useLocalStorageState', () => ({
  useLocalStorageState: () => [reviewState.showTree, vi.fn()],
}));
vi.mock('@/helpers/agentWorkingDirectory', () => ({ resolveTargetDeviceId: () => undefined }));
vi.mock('@/helpers/executionTarget', () => ({ resolveExecutionTarget: () => 'local' }));
vi.mock('@/helpers/gatewayMode', () => ({ useIsGatewayModeEnabled: () => false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => <button type="button" />,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => () => ({}),
}));

beforeEach(() => {
  agentStore.activeAgentId = undefined;
  agentStore.isHeterogeneous = false;
  agentStore.isChatMode = false;
  agentStore.isLocalSystemEnabled = false;
  agentStore.rawAgencyConfig = undefined;
  reviewState.repoType = undefined;
  reviewState.setRepoType = undefined;
  reviewState.showTree = false;
  reviewState.workingDirectory = undefined;
  globalStore.status.showRightPanel = true;
  globalStore.status.workingSidebarTab = undefined;
  globalStore.toggleRightPanel.mockReset();
  globalStore.setWorkingSidebarTab.mockReset();
});

afterEach(() => {
  rightPanel.current = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AgentWorkingSidebar — controlled panel width', () => {
  it('seeds the RightPanel with the default width', () => {
    renderSidebar();

    expect(rightPanel.current?.width).toBe(360);
  });

  // Regression: DraggablePanel reports the dragged width as a `"480px"` string on
  // drag-stop. A `typeof width === 'number'` guard silently dropped it, so the
  // controlled width never updated and the panel snapped back — appearing
  // impossible to resize. The handler must parse the px string.
  it('applies a "480px" string width from a drag so the panel actually resizes', () => {
    renderSidebar();

    act(() => {
      rightPanel.current?.onSizeChange?.({ width: '480px' });
    });

    expect(rightPanel.current?.width).toBe(480);
  });

  it('applies a numeric drag width unchanged', () => {
    renderSidebar();

    act(() => {
      rightPanel.current?.onSizeChange?.({ width: 500 });
    });

    expect(rightPanel.current?.width).toBe(500);
  });

  it('ignores a size update with no width', () => {
    renderSidebar();

    act(() => {
      rightPanel.current?.onSizeChange?.({ height: '100%' });
    });

    expect(rightPanel.current?.width).toBe(360);
  });
});

describe('AgentWorkingSidebar — tab strip', () => {
  // Regression: at the 300px minimum panel width, labels such as “Deployments”
  // were allowed to shrink and wrap inside words. Tabs now stay on one line in a
  // horizontal strip, so a persisted tab near the end must be brought into view.
  it('scrolls an overflowed active tab into view', async () => {
    globalStore.status.workingSidebarTab = 'params';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this instanceof HTMLButtonElement && this.getAttribute('aria-pressed') === 'true'
        ? ({ left: 220, right: 280 } as DOMRect)
        : ({ left: 0, right: 200 } as DOMRect);
    });
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);

    renderSidebar();
    const paramsTab = await screen.findByRole('button', {
      name: 'settingModel.params.panel.tab',
    });

    expect(paramsTab).toHaveAttribute('aria-pressed', 'true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('reveals the active tab again when an async tab becomes available', async () => {
    agentStore.activeAgentId = 'agent';
    agentStore.isLocalSystemEnabled = true;
    reviewState.workingDirectory = '/repo';
    globalStore.status.workingSidebarTab = 'params';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this instanceof HTMLButtonElement && this.getAttribute('aria-pressed') === 'true'
        ? ({ left: 220, right: 280 } as DOMRect)
        : ({ left: 0, right: 200 } as DOMRect);
    });
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);

    renderSidebar();
    await screen.findByRole('button', { name: 'settingModel.params.panel.tab' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => reviewState.setRepoType?.('git'));

    expect(screen.getByRole('button', { name: 'workingPanel.review.title' })).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
