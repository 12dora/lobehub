/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ThinkingEffort from './index';

/** Shape of the menu items the component hands to `ActionDropdown`. */
interface MenuItemProbe {
  closeOnClick?: boolean;
  key: string;
  onClick: () => void;
}

const mocks = vi.hoisted(() => ({
  agentId: 'agent-1',
  chatConfigByAgent: {} as Record<string, Record<string, unknown>>,
  extendParams: undefined as string[] | undefined,
  menuItems: [] as { closeOnClick?: boolean; key: string; onClick: () => void }[],
  model: 'gpt-5.5',
  permission: { allowed: true, reason: undefined as string | undefined },
  provider: 'openai',
  updateAgentChatConfig: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.level ? `${key}:${options.level}` : key,
  }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => mocks.permission,
}));

vi.mock('../../hooks/useAgentId', () => ({ useAgentId: () => mocks.agentId }));

vi.mock('../../hooks/useUpdateAgentConfig', () => ({
  useUpdateAgentConfig: () => ({ updateAgentChatConfig: mocks.updateAgentChatConfig }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgentModelById: () => () => mocks.model,
    getAgentModelProviderById: () => () => mocks.provider,
  },
  chatConfigByIdSelectors: {
    // Keyed by agentId so an agent switch is observable through the pill.
    getChatConfigById: (agentId: string) => () => mocks.chatConfigByAgent[agentId] ?? {},
  },
}));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    modelExtendParams: () => () => mocks.extendParams,
  },
  useAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
}));

// Base UI + portals are out of scope here; capture the menu the component builds
// so the selection contract can be exercised directly.
vi.mock('../components/ActionDropdown', () => ({
  default: ({ children, menu }: { children?: ReactNode; menu?: { items?: unknown } }) => {
    mocks.menuItems = (menu?.items ?? []) as MenuItemProbe[];

    return <div data-testid="effort-dropdown">{children}</div>;
  },
}));

// The real Tooltip only paints its title on hover; render it inline so both the
// level tooltip and the permission-denial reason are assertable.
vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  return {
    ...actual,
    Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
      <div data-testid="tooltip" data-title={String(title)}>
        {children}
      </div>
    ),
  };
});

const menuItem = (level: string) => {
  const item = mocks.menuItems.find((entry) => entry.key === level);
  if (!item) throw new Error(`no menu item for level "${level}"`);

  return item;
};

describe('ThinkingEffort', () => {
  beforeEach(() => {
    mocks.agentId = 'agent-1';
    mocks.chatConfigByAgent = {};
    mocks.extendParams = undefined;
    mocks.menuItems = [];
    mocks.model = 'gpt-5.5';
    mocks.permission = { allowed: true, reason: undefined };
    mocks.updateAgentChatConfig.mockClear();
  });

  describe('visibility', () => {
    it('renders nothing when the model declares no extend params', () => {
      const { container } = render(<ThinkingEffort />);

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when no declared extend param is an effort control', () => {
      mocks.extendParams = ['disableContextCaching', 'reasoningBudgetToken', 'urlContext'];

      const { container } = render(<ThinkingEffort />);

      expect(container).toBeEmptyDOMElement();
    });

    it('renders the model-specific default level when nothing is persisted', () => {
      mocks.extendParams = ['gpt5_2ReasoningEffort'];

      render(<ThinkingEffort />);

      expect(screen.getByText('medium')).toBeInTheDocument();
    });

    it('renders the persisted level', () => {
      mocks.extendParams = ['gpt5_2ReasoningEffort'];
      mocks.chatConfigByAgent = { 'agent-1': { gpt5_2ReasoningEffort: 'xhigh' } };

      render(<ThinkingEffort />);

      expect(screen.getByText('xhigh')).toBeInTheDocument();
    });

    it('prefers a real effort key over the tri-state thinking toggle', () => {
      mocks.extendParams = ['thinking', 'reasoningEffort'];

      render(<ThinkingEffort />);

      expect(screen.getByText('medium')).toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('offers every level the control declares, in registry order', () => {
      mocks.extendParams = ['gpt5_2ReasoningEffort'];

      render(<ThinkingEffort />);

      expect(mocks.menuItems.map((item) => item.key)).toEqual([
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      expect(mocks.menuItems.every((item) => item.closeOnClick === true)).toBe(true);
    });

    it('writes exactly the chosen level to the control config key', () => {
      mocks.extendParams = ['gpt5_2ReasoningEffort'];
      mocks.chatConfigByAgent = { 'agent-1': { gpt5_2ReasoningEffort: 'low' } };

      render(<ThinkingEffort />);
      menuItem('xhigh').onClick();

      expect(mocks.updateAgentChatConfig).toHaveBeenCalledTimes(1);
      expect(mocks.updateAgentChatConfig).toHaveBeenCalledWith({ gpt5_2ReasoningEffort: 'xhigh' });
    });

    it('writes to the key the model actually declares, not a sibling family key', () => {
      mocks.extendParams = ['grok4_3ReasoningEffort'];
      mocks.model = 'grok-4.3';

      render(<ThinkingEffort />);
      menuItem('high').onClick();

      expect(mocks.updateAgentChatConfig).toHaveBeenCalledWith({ grok4_3ReasoningEffort: 'high' });
    });

    it('does not write when the already-selected level is picked again', () => {
      mocks.extendParams = ['reasoningEffort'];
      mocks.chatConfigByAgent = { 'agent-1': { reasoningEffort: 'high' } };

      render(<ThinkingEffort />);
      menuItem('high').onClick();

      expect(mocks.updateAgentChatConfig).not.toHaveBeenCalled();
    });
  });

  describe('permission', () => {
    it('renders a tooltip with the level when content creation is allowed', () => {
      mocks.extendParams = ['reasoningEffort'];
      mocks.chatConfigByAgent = { 'agent-1': { reasoningEffort: 'low' } };

      render(<ThinkingEffort />);

      expect(screen.getByTestId('tooltip')).toHaveAttribute(
        'data-title',
        'thinkingEffort.tooltip:low',
      );
    });

    it('drops the dropdown and shows the denial reason when create_content is denied', () => {
      mocks.extendParams = ['reasoningEffort'];
      mocks.permission = { allowed: false, reason: 'Your role cannot create content' };

      render(<ThinkingEffort />);

      expect(screen.queryByTestId('effort-dropdown')).toBeNull();
      expect(screen.getByTestId('tooltip')).toHaveAttribute(
        'data-title',
        'Your role cannot create content',
      );
      // The level is still readable, it just cannot be changed.
      expect(screen.getByText('medium')).toBeInTheDocument();
    });
  });

  it('reflects the new agent after an agent switch', () => {
    mocks.extendParams = ['reasoningEffort'];
    mocks.chatConfigByAgent = {
      'agent-1': { reasoningEffort: 'low' },
      'agent-2': { reasoningEffort: 'high' },
    };

    // The component is `memo`'d with no props, so a plain rerender would bail out —
    // in the app the agentId change arrives through a store subscription. Keying the
    // element reproduces the same "new agent is active" observation.
    const { rerender } = render(<ThinkingEffort key={mocks.agentId} />);

    expect(screen.getByText('low')).toBeInTheDocument();

    mocks.agentId = 'agent-2';
    rerender(<ThinkingEffort key={mocks.agentId} />);

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.queryByText('low')).toBeNull();
  });
});
