import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/store/chat';
import { useUserStore } from '@/store/user';
import { USER_SELECTABLE_APPROVAL_MODES } from '@/store/user/slices/settings/selectors';

import ModeSelector from './ApprovalMode';

const platformMeta = vi.hoisted(() => ({
  current: { enabled: false, hidden: false, locked: false, status: 'disabled' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true, reason: undefined }),
}));

vi.mock('@/features/PlatformSettingSourceBadge/usePlatformSettingMeta', () => ({
  usePlatformSettingMeta: () => platformMeta.current,
}));

vi.mock('@/features/PlatformSettingSourceBadge/ManagedSettingField', () => ({
  ManagedSettingFieldContent: ({ children }: { children: () => ReactNode }) => children(),
}));

vi.mock('@lobehub/ui', () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  Center: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenu: ({
    children,
    items,
  }: {
    children: ReactNode;
    items: Array<{ extra?: ReactNode; key: string; label: ReactNode; onClick?: () => void }>;
  }) => (
    <div>
      {children}
      <div data-testid="approval-menu">
        {items.map((item) => (
          <div data-mode={item.key} data-selected={item.extra ? 'true' : 'false'} key={item.key}>
            {/* No text content: keeps `getByRole('button', { name })` unambiguous. */}
            <span data-testid={`select-${item.key}`} role="none" onClick={item.onClick} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  ),
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const initialUserStoreState = useUserStore.getState();
const initialChatStoreState = useChatStore.getState();

const TOPIC_ID = 'topic-1';
const AGENT_ID = 'agent-1';

const ensureTopicDetail = vi.fn().mockResolvedValue(undefined);

const setActiveTopic = (approvalMode?: string, topicId: string = TOPIC_ID) => {
  useChatStore.setState({
    activeAgentId: AGENT_ID,
    activeTopicId: topicId,
    internal_ensureTopicDetail: ensureTopicDetail,
    topicDataMap: {
      [`agent_${AGENT_ID}`]: {
        items: [
          {
            id: topicId,
            metadata: approvalMode ? { approvalMode } : undefined,
            title: 'T',
          },
        ],
      },
    },
    topicDetailMap: {},
  } as any);
};

afterEach(() => {
  ensureTopicDetail.mockClear();
  useUserStore.setState(initialUserStoreState, true);
  useChatStore.setState(initialChatStoreState, true);
  platformMeta.current = { enabled: false, hidden: false, locked: false, status: 'disabled' };
});

describe('ApprovalMode managed headless presentation', () => {
  it('shows the real Headless label as disabled when the effective platform value is headless', () => {
    const updateHumanIntervention = vi.fn();
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention,
    });
    platformMeta.current = { enabled: true, hidden: false, locked: true, status: 'ready' };

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.headless' })).toBeDisabled();
    expect(updateHumanIntervention).not.toHaveBeenCalled();
  });

  it('preserves the legacy Auto Approve fallback for raw headless when the feature is off', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention: vi.fn(),
    });

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.autoRun' })).toBeEnabled();
  });

  it('shows Headless without locking a platform-default value that users may override', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'headless' } } },
      updateHumanIntervention: vi.fn(),
    });
    platformMeta.current = { enabled: true, hidden: false, locked: false, status: 'ready' };

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.headless' })).toBeEnabled();
    expect(screen.getByTestId('approval-menu').querySelector('[data-mode="headless"]')).toBeNull();
  });

  it('never exposes headless as a user-selectable menu mutation', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention: vi.fn(),
    });

    render(<ModeSelector />);

    const menu = screen.getByTestId('approval-menu');
    expect(USER_SELECTABLE_APPROVAL_MODES).toEqual(['auto-run', 'allow-list', 'manual']);
    expect(menu.querySelector('[data-mode="headless"]')).toBeNull();
  });
});

describe('ApprovalMode per-conversation resolution', () => {
  it("displays the topic's own mode over the user preference", () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention: vi.fn(),
    });
    setActiveTopic('auto-run');

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.autoRun' })).toBeEnabled();
    expect(
      screen.getByTestId('approval-menu').querySelector('[data-mode="auto-run"]'),
    ).toHaveAttribute('data-selected', 'true');
  });

  it('displays the user preference when the conversation has no snapshot', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'allow-list' } } },
      updateHumanIntervention: vi.fn(),
    });
    setActiveTopic(undefined);

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.allowList' })).toBeEnabled();
  });

  it('lets a locked platform policy win over the topic snapshot', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention: vi.fn(),
    });
    setActiveTopic('auto-run');
    platformMeta.current = { enabled: true, hidden: false, locked: true, status: 'ready' };

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.manual' })).toBeDisabled();
  });
});

describe('ApprovalMode write target', () => {
  it('writes the topic metadata — not the user preference — inside a conversation', () => {
    const updateHumanIntervention = vi.fn();
    const updateTopicApprovalMode = vi.fn().mockResolvedValue(undefined);
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention,
    });
    setActiveTopic(undefined);
    useChatStore.setState({ updateTopicApprovalMode } as any);

    render(<ModeSelector />);
    fireEvent.click(screen.getByTestId('select-auto-run'));

    expect(updateTopicApprovalMode).toHaveBeenCalledWith(TOPIC_ID, 'auto-run');
    expect(updateHumanIntervention).not.toHaveBeenCalled();
  });

  it('writes the user preference when there is no conversation yet', () => {
    const updateHumanIntervention = vi.fn().mockResolvedValue(undefined);
    const updateTopicApprovalMode = vi.fn();
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention,
    });
    useChatStore.setState({ activeTopicId: null, updateTopicApprovalMode } as any);

    render(<ModeSelector />);
    fireEvent.click(screen.getByTestId('select-allow-list'));

    expect(updateHumanIntervention).toHaveBeenCalledWith({ approvalMode: 'allow-list' });
    expect(updateTopicApprovalMode).not.toHaveBeenCalled();
  });

  it('never PATCHes a client-only optimistic topic placeholder', () => {
    const updateHumanIntervention = vi.fn().mockResolvedValue(undefined);
    const updateTopicApprovalMode = vi.fn();
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention,
    });
    setActiveTopic(undefined, 'tmp_topic_abc');
    useChatStore.setState({ updateTopicApprovalMode } as any);

    render(<ModeSelector />);
    fireEvent.click(screen.getByTestId('select-auto-run'));

    expect(updateTopicApprovalMode).not.toHaveBeenCalled();
    expect(updateHumanIntervention).toHaveBeenCalledWith({ approvalMode: 'auto-run' });
  });
});

describe('ApprovalMode topics outside the paginated page', () => {
  it('displays the stored mode of a topic that is only in the by-id detail cache', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'auto-run' } } },
      updateHumanIntervention: vi.fn(),
    });
    useChatStore.setState({
      activeAgentId: AGENT_ID,
      activeTopicId: 'topic-old',
      internal_ensureTopicDetail: ensureTopicDetail,
      topicDataMap: {},
      topicDetailMap: {
        [`agent_${AGENT_ID}::topic-old`]: {
          id: 'topic-old',
          metadata: { approvalMode: 'manual' },
          title: 'Found via search',
        },
      },
    } as any);

    render(<ModeSelector />);

    expect(screen.getByRole('button', { name: 'tool.intervention.mode.manual' })).toBeEnabled();
  });

  it('asks the store to resolve the authoritative row for the active topic', () => {
    useUserStore.setState({
      settings: { tool: { humanIntervention: { approvalMode: 'manual' } } },
      updateHumanIntervention: vi.fn(),
    });
    useChatStore.setState({
      activeAgentId: AGENT_ID,
      activeTopicId: 'topic-old',
      internal_ensureTopicDetail: ensureTopicDetail,
      topicDataMap: {},
      topicDetailMap: {},
    } as any);

    render(<ModeSelector />);

    expect(ensureTopicDetail).toHaveBeenCalledWith('topic-old');
  });
});
