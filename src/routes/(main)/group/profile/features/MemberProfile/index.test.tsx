/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MemberProfile from './index';

const mocks = vi.hoisted(() => ({
  agentId: 'agent-1',
  config: undefined as Record<string, unknown> | undefined,
  effortSelectProps: undefined as Record<string, unknown> | undefined,
  permission: { allowed: true, reason: undefined as string | undefined },
  updateAgentConfigById: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: () => <div />,
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
}));

vi.mock('antd', () => ({ Divider: () => <hr /> }));

vi.mock('react-router', () => ({ useParams: () => ({ gid: 'group-1' }) }));

vi.mock('@/features/EditorCanvas', () => ({ EditorCanvas: () => <div /> }));

vi.mock('@/features/ModelSelect', () => ({
  default: () => <div data-testid="model-select" />,
}));

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

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => mocks.permission }));

vi.mock('@/hooks/useQueryRoute', () => ({ useQueryRoute: () => ({ push: vi.fn() }) }));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ updateAgentConfigById: mocks.updateAgentConfigById }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: { getAgentConfigById: () => () => mocks.config },
}));

vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agentGroup/selectors', () => ({
  agentGroupSelectors: {
    activeGroupId: () => 'group-1',
    getGroupAgents: () => () => [],
    getGroupById: () => () => undefined,
  },
}));

vi.mock('@/store/groupProfile', () => ({
  useGroupProfileStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentBuilderContentUpdate: undefined,
      activeTabId: mocks.agentId,
      editor: undefined,
      handleContentChange: vi.fn(),
      setAgentBuilderContent: vi.fn(),
    }),
}));

vi.mock('../Header/AutoSaveHint', () => ({ default: () => <div /> }));
vi.mock('./AgentHeader', () => ({ default: () => <div /> }));
vi.mock('./AgentTool', () => ({ default: () => <div /> }));

describe('MemberProfile thinking effort', () => {
  beforeEach(() => {
    mocks.agentId = 'agent-1';
    mocks.config = {
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      model: 'gpt-5.6',
      provider: 'openai',
    };
    mocks.effortSelectProps = undefined;
    mocks.permission = { allowed: true, reason: undefined };
    mocks.updateAgentConfigById.mockClear();
  });

  it('renders the picker next to the model picker, fed from the member config', () => {
    render(<MemberProfile />);

    expect(screen.getByTestId('model-select')).toBeInTheDocument();
    expect(mocks.effortSelectProps).toMatchObject({
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      model: 'gpt-5.6',
      provider: 'openai',
    });
  });

  it('writes the chosen level to this member agent, not the active agent', () => {
    render(<MemberProfile />);

    fireEvent.click(screen.getByTestId('effort-select'));

    expect(mocks.updateAgentConfigById).toHaveBeenCalledWith('agent-1', {
      chatConfig: { gpt5_6ReasoningEffort: 'high' },
    });
  });

  it('tolerates a member config that has not loaded yet', () => {
    mocks.config = undefined;

    render(<MemberProfile />);

    expect(mocks.effortSelectProps).toMatchObject({ chatConfig: {}, model: '', provider: '' });
  });

  it('disables the picker and refuses the write when editing is not allowed', () => {
    mocks.permission = { allowed: false, reason: 'read only' };

    render(<MemberProfile />);

    expect(mocks.effortSelectProps?.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('effort-select'));

    expect(mocks.updateAgentConfigById).not.toHaveBeenCalled();
  });
});
