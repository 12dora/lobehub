/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentProfilePopup from './AgentProfilePopup';

/**
 * `EffortSelect` is deliberately NOT mocked: the bug this suite guards is that the popup's
 * SWR snapshot is the only source feeding a *controlled* picker, so what the user ends up
 * seeing after a save can only be observed through the real component.
 */
const mocks = vi.hoisted(() => ({
  extendParamsByModel: {
    'gpt-5.6': ['gpt5_6ReasoningEffort'],
    'grok-4.5': ['grok4_5ReasoningEffort'],
  } as Record<string, string[] | undefined>,
  getAgentConfigById: vi.fn(),
  stored: undefined as Record<string, unknown> | null | undefined,
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
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/icons', () => ({ SkillsIcon: () => <span /> }));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    disabled,
    onChange,
    options,
    value,
  }: {
    disabled?: boolean;
    onChange?: (value: string) => void;
    options?: { label: ReactNode; value: string }[];
    value?: string;
  }) => (
    <select
      data-testid="effort-select"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {String(option.label)}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@/features/ModelSelect', () => ({
  default: ({ onChange }: { onChange?: (v: { model: string; provider: string }) => void }) => (
    <button
      data-testid="model-select"
      type="button"
      onClick={() => onChange?.({ model: 'grok-4.5', provider: 'xai' })}
    >
      switch model
    </button>
  ),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    modelExtendParams: (model: string) => () => mocks.extendParamsByModel[model],
  },
  useScopedAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
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

const renderPopup = (props: { agent?: Record<string, unknown>; groupId?: string } = {}) =>
  render(
    <Isolated>
      <AgentProfilePopup agentId="agent-1" trigger="click" {...(props as object)}>
        <span>open</span>
      </AgentProfilePopup>
    </Isolated>,
  );

const openPopup = () => fireEvent.click(screen.getByTestId('popover-trigger'));
const picker = () => screen.getByTestId('effort-select') as HTMLSelectElement;
const optionValues = () => [...picker().querySelectorAll('option')].map((option) => option.value);

describe('AgentProfilePopup thinking effort', () => {
  beforeEach(() => {
    mocks.stored = {
      chatConfig: { gpt5_6ReasoningEffort: 'low' },
      id: 'agent-1',
      model: 'gpt-5.6',
      provider: 'openai',
      title: 'Member',
    };
    mocks.getAgentConfigById.mockReset();
    // Reads always serve the current persisted row, so a write that skips the SWR cache is
    // observable as a revert once the popup refetches.
    mocks.getAgentConfigById.mockImplementation(async () => mocks.stored);
    mocks.updateMemberAgentConfig.mockReset();
    mocks.updateMemberAgentConfig.mockImplementation(
      async (_groupId: string, _agentId: string, patch: Record<string, any>) => {
        mocks.stored = {
          ...mocks.stored,
          ...patch,
          chatConfig: { ...(mocks.stored?.chatConfig as object), ...patch.chatConfig },
        };
      },
    );
  });

  it('shows the persisted level rather than the registry default', async () => {
    renderPopup({ groupId: 'group-1' });
    openPopup();

    await waitFor(() => expect(picker().value).toBe('low'));
    // gpt-5.6 defaults to `medium`; seeing it here would mean the stored level never arrived.
    expect(optionValues()).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps showing the chosen level after the write settles', async () => {
    renderPopup({ groupId: 'group-1' });
    openPopup();
    await waitFor(() => expect(picker().value).toBe('low'));

    fireEvent.change(picker(), { target: { value: 'xhigh' } });

    await waitFor(() =>
      expect(mocks.updateMemberAgentConfig).toHaveBeenCalledWith('group-1', 'agent-1', {
        chatConfig: { gpt5_6ReasoningEffort: 'xhigh' },
      }),
    );
    // Regression guard: a stale SWR snapshot would snap the controlled picker back to `low`.
    await waitFor(() => expect(picker().value).toBe('xhigh'));
  });

  it('re-offers the new model levels after a model switch, not the previous model ones', async () => {
    renderPopup({ groupId: 'group-1' });
    openPopup();
    await waitFor(() => expect(picker().value).toBe('low'));

    fireEvent.click(screen.getByTestId('model-select'));

    await waitFor(() =>
      expect(mocks.updateMemberAgentConfig).toHaveBeenCalledWith('group-1', 'agent-1', {
        model: 'grok-4.5',
        provider: 'xai',
      }),
    );
    // grok-4.5 offers low | medium | high and defaults to high; a stale snapshot would keep
    // gpt-5.6's six levels and let a pick write `gpt5_6ReasoningEffort`.
    await waitFor(() => expect(optionValues()).toEqual(['low', 'medium', 'high']));
    expect(picker().value).toBe('high');
  });

  it('writes the switched model effort field, not the previous model one', async () => {
    renderPopup({ groupId: 'group-1' });
    openPopup();
    await waitFor(() => expect(picker().value).toBe('low'));

    fireEvent.click(screen.getByTestId('model-select'));
    await waitFor(() => expect(optionValues()).toEqual(['low', 'medium', 'high']));

    fireEvent.change(picker(), { target: { value: 'medium' } });

    await waitFor(() =>
      expect(mocks.updateMemberAgentConfig).toHaveBeenLastCalledWith('group-1', 'agent-1', {
        chatConfig: { grok4_5ReasoningEffort: 'medium' },
      }),
    );
  });

  it('holds the picker back until the request settles, so a stored level is never clobbered', () => {
    // The fetch never settles here; the picker must not render off the prefilled preview.
    mocks.getAgentConfigById.mockImplementation(() => new Promise(() => {}));

    renderPopup({
      agent: { model: 'gpt-5.6', provider: 'openai', title: 'Member' },
      groupId: 'group-1',
    });
    openPopup();

    expect(screen.queryByTestId('effort-select')).toBeNull();
  });

  it('still offers the picker off the prefilled config when the fetch fails', async () => {
    mocks.getAgentConfigById.mockRejectedValue(new Error('offline'));

    renderPopup({
      agent: {
        chatConfig: { gpt5_6ReasoningEffort: 'high' },
        model: 'gpt-5.6',
        provider: 'openai',
        title: 'Member',
      },
      groupId: 'group-1',
    });
    openPopup();

    // A rejected load has still settled: hiding the control forever would be worse than
    // falling back to what the caller prefilled.
    await waitFor(() => expect(picker().value).toBe('high'));
  });

  it('stays display-only without a groupId, where there is nothing to write to', async () => {
    renderPopup();
    openPopup();

    await waitFor(() => expect(mocks.getAgentConfigById).toHaveBeenCalled());

    expect(screen.queryByTestId('effort-select')).toBeNull();
    expect(screen.queryByTestId('model-select')).toBeNull();
  });
});
