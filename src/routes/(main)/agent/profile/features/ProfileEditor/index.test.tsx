/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileEditor from './index';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  effortSelectProps: undefined as Record<string, unknown> | undefined,
  isHeterogeneous: false,
  modelSelectProps: undefined as Record<string, unknown> | undefined,
  permission: { allowed: true, reason: undefined as string | undefined },
  updateAgentConfig: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tabs: ({ items }: { items?: { children?: ReactNode; key: string }[] }) => (
    <div data-testid="hetero-tabs">{items?.map((item) => item.key).join(',')}</div>
  ),
}));

vi.mock('@lobechat/const', () => ({ isDesktop: false }));

vi.mock('@lobechat/heterogeneous-agents', () => ({
  isRemoteHeterogeneousType: () => false,
}));

vi.mock('@/features/ModelSelect', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.modelSelectProps = props;
    return <div data-testid="model-select" />;
  },
}));

// Levels come from the real component's registry lookup; here only the contract with
// this surface matters — which props it receives and what a selection persists.
vi.mock('@/features/ServiceModel/EffortSelect', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.effortSelectProps = props;
    return (
      <button
        data-testid="effort-select"
        type="button"
        onClick={() =>
          (props.onChange as (level: string, key: string) => void)('high', 'gpt5_6ReasoningEffort')
        }
      >
        effort
      </button>
    );
  },
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => mocks.permission,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ updateAgentConfig: mocks.updateAgentConfig }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentSelectors: {
    currentAgentConfig: () => mocks.config,
    isCurrentAgentHeterogeneous: () => mocks.isHeterogeneous,
  },
}));

vi.mock('../EditorCanvas', () => ({ default: () => <div data-testid="editor-canvas" /> }));
vi.mock('./AgentHeader', () => ({ default: () => <div /> }));
vi.mock('./AgentTool', () => ({ default: () => <div data-testid="agent-tool" /> }));
vi.mock('./CloudHeterogeneousConfig', () => ({ default: () => <div /> }));
vi.mock('./HeterogeneousAgentStatusCard', () => ({ default: () => <div /> }));
vi.mock('./RemoteAgentConfigCard', () => ({ default: () => <div /> }));

describe('ProfileEditor runtime config panel', () => {
  beforeEach(() => {
    mocks.config = {
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      model: 'gpt-5.6',
      provider: 'openai',
    };
    mocks.effortSelectProps = undefined;
    mocks.isHeterogeneous = false;
    mocks.modelSelectProps = undefined;
    mocks.permission = { allowed: true, reason: undefined };
    mocks.updateAgentConfig.mockClear();
  });

  it('renders the thinking-effort picker next to the model picker', () => {
    render(<ProfileEditor />);

    expect(screen.getByTestId('model-select')).toBeInTheDocument();
    expect(screen.getByTestId('effort-select')).toBeInTheDocument();
  });

  it('feeds the picker the agent model, provider and stored chatConfig', () => {
    render(<ProfileEditor />);

    expect(mocks.effortSelectProps).toMatchObject({
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      model: 'gpt-5.6',
      provider: 'openai',
    });
  });

  it('passes an empty provider rather than undefined when the agent has none', () => {
    mocks.config = { chatConfig: {}, model: 'gpt-5.6' };

    render(<ProfileEditor />);

    expect(mocks.effortSelectProps?.provider).toBe('');
  });

  it('persists a chosen level onto the chatConfig key the control declares', () => {
    render(<ProfileEditor />);

    fireEvent.click(screen.getByTestId('effort-select'));

    expect(mocks.updateAgentConfig).toHaveBeenCalledWith({
      chatConfig: { gpt5_6ReasoningEffort: 'high' },
    });
  });

  it('disables the picker and refuses the write when editing is not allowed', () => {
    mocks.permission = { allowed: false, reason: 'read only' };

    render(<ProfileEditor />);

    expect(mocks.effortSelectProps?.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('effort-select'));

    expect(mocks.updateAgentConfig).not.toHaveBeenCalled();
  });

  it('shows no picker for heterogeneous agents, which have no built-in model runtime', () => {
    mocks.isHeterogeneous = true;
    mocks.config = {
      agencyConfig: { heterogeneousProvider: { type: 'claude-code' } },
      chatConfig: {},
      model: 'gpt-5.6',
    };

    render(<ProfileEditor />);

    expect(screen.queryByTestId('effort-select')).toBeNull();
    expect(screen.queryByTestId('model-select')).toBeNull();
  });
});
