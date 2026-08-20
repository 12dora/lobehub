/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentProfilePopup from './AgentProfilePopup';

const mocks = vi.hoisted(() => ({
  effortSelectProps: undefined as Record<string, unknown> | undefined,
  fetched: undefined as Record<string, unknown> | null | undefined,
  getAgentConfigById: vi.fn(),
  updateMemberAgentConfig: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({ ModelIcon: () => <span /> }));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => <button type="button" />,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  // The real Popover is a portal; drive its open state through a plain button so the
  // content (and the SWR fetch it gates) is reachable.
  Popover: ({
    children,
    content,
    onOpenChange,
    open,
  }: {
    children?: ReactNode;
    content?: ReactNode;
    onOpenChange?: (next: boolean) => void;
    open?: boolean;
  }) => (
    <div>
      <button data-testid="popover-trigger" type="button" onClick={() => onOpenChange?.(!open)}>
        {children}
      </button>
      {open ? content : null}
    </div>
  ),
  Skeleton: Object.assign(() => <div />, { Button: () => <div /> }),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/icons', () => ({ SkillsIcon: () => <span /> }));

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

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/services/agent', () => ({
  agentService: { getAgentConfigById: (id: string) => mocks.getAgentConfigById(id) },
}));

vi.mock('@/store/agentGroup', () => ({
  useAgentGroupStore: (selector: (state: unknown) => unknown) =>
    selector({ updateMemberAgentConfig: mocks.updateMemberAgentConfig }),
}));

vi.mock('.', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

/** A fresh SWR cache per test — otherwise a later case would read the first case's fetch. */
const Isolated = ({ children }: { children?: ReactNode }) => (
  <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>{children}</SWRConfig>
);

const renderPopup = (props: { groupId?: string } = {}) =>
  render(
    <Isolated>
      <AgentProfilePopup agentId="agent-1" trigger="click" {...props}>
        <span>open</span>
      </AgentProfilePopup>
    </Isolated>,
  );

describe('AgentProfilePopup thinking effort', () => {
  beforeEach(() => {
    mocks.effortSelectProps = undefined;
    mocks.fetched = {
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      id: 'agent-1',
      model: 'gpt-5.6',
      provider: 'openai',
      title: 'Member',
    };
    mocks.getAgentConfigById.mockReset();
    mocks.getAgentConfigById.mockImplementation(async () => mocks.fetched);
    mocks.updateMemberAgentConfig.mockReset();
  });

  it('threads the persisted chatConfig into the picker instead of re-deriving it', async () => {
    renderPopup({ groupId: 'group-1' });

    fireEvent.click(screen.getByTestId('popover-trigger'));

    await waitFor(() => expect(screen.getByTestId('effort-select')).toBeInTheDocument());

    expect(mocks.effortSelectProps).toMatchObject({
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      model: 'gpt-5.6',
      provider: 'openai',
    });
  });

  it('holds the picker back until the agent is fetched, so a stored level is never clobbered', () => {
    // The fetch never settles here; the picker must not render off the prefilled preview.
    mocks.getAgentConfigById.mockImplementation(() => new Promise(() => {}));

    render(
      <Isolated>
        <AgentProfilePopup
          agent={{ model: 'gpt-5.6', provider: 'openai', title: 'Member' }}
          agentId="agent-1"
          groupId="group-1"
          trigger="click"
        >
          <span>open</span>
        </AgentProfilePopup>
      </Isolated>,
    );

    fireEvent.click(screen.getByTestId('popover-trigger'));

    expect(screen.queryByTestId('effort-select')).toBeNull();
  });

  it('writes the chosen level onto the group member agent', async () => {
    renderPopup({ groupId: 'group-1' });

    fireEvent.click(screen.getByTestId('popover-trigger'));
    await waitFor(() => expect(screen.getByTestId('effort-select')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('effort-select'));

    await waitFor(() =>
      expect(mocks.updateMemberAgentConfig).toHaveBeenCalledWith('group-1', 'agent-1', {
        chatConfig: { gpt5_6ReasoningEffort: 'high' },
      }),
    );
  });

  it('stays display-only without a groupId, where there is nothing to write to', async () => {
    renderPopup();

    fireEvent.click(screen.getByTestId('popover-trigger'));

    await waitFor(() => expect(mocks.getAgentConfigById).toHaveBeenCalled());

    expect(screen.queryByTestId('effort-select')).toBeNull();
    expect(screen.queryByTestId('model-select')).toBeNull();
  });
});
