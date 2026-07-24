/**
 * @vitest-environment happy-dom
 *
 * Consumer regression for shared-infra/F5: HeterogeneousChatInput must render
 * discrete cloud-credential states from useHeteroAgentCloudConfig — loading must
 * NOT look like "not configured", and error must offer retry with a fail-closed
 * (disabled) send path.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeteroAgentCloudConfig } from '@/enterprise/client/hooks/useHeteroAgentCloudConfig';

import HeterogeneousChatInput from './index';

const cloudConfig = vi.hoisted(
  () =>
    ({
      error: null as unknown,
      goToConfig: vi.fn(),
      isConfigured: false,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
      status: 'not-configured' as HeteroAgentCloudConfig['status'],
    }) satisfies HeteroAgentCloudConfig & {
      goToConfig: ReturnType<typeof vi.fn>;
      refetch: ReturnType<typeof vi.fn>;
    },
);

const setCloudStatus = (partial: Partial<HeteroAgentCloudConfig>) => {
  Object.assign(cloudConfig, {
    error: null,
    isConfigured: false,
    isError: false,
    isLoading: false,
    status: 'not-configured',
    ...partial,
  });
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ aid: 'agt_test' }),
}));

vi.mock('@/business/client/hooks/useHeteroAgentCloudConfig', () => ({
  useHeteroAgentCloudConfig: () => cloudConfig,
}));

vi.mock('@/features/Conversation/store', () => ({
  contextSelectors: { agentId: () => 'agt_test' },
  useConversationStore: (selector: (s: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) =>
    selector({
      // Minimal shape for agencyConfig / workspace selectors used by the component.
    }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    isWorkspaceAgentById: () => () => false,
  },
  agentSelectors: {
    getAgentConfigById: () => () => ({
      agencyConfig: {
        // Sandbox path (no bound device) so cloud-cred guard is active.
        heterogeneousProvider: { type: 'claude-code' },
      },
    }),
  },
}));

vi.mock('@/helpers/executionTarget', () => ({
  resolveExecutionTarget: () => 'sandbox',
}));

vi.mock('@/hooks/useRemoteAgentDeviceGuard', () => ({
  useRemoteAgentDeviceGuard: () => ({ refresh: vi.fn(), status: 'ok' }),
}));

vi.mock('@/const/version', () => ({
  isDesktop: false,
}));

vi.mock('@/store/chat', () => ({
  useChatStore: Object.assign(vi.fn(), { setState: vi.fn() }),
}));

vi.mock('@/features/ChatInput/ControlBar/HeteroModel', () => ({
  default: () => null,
}));

vi.mock('./HeteroControlBar', () => ({
  default: () => <div data-testid="hetero-control-bar" />,
}));

vi.mock('./shouldShowHeteroModelSelector', () => ({
  shouldShowHeteroModelSelector: () => false,
}));

vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, title, type }: { action?: ReactNode; title?: ReactNode; type?: string }) => (
    <div data-testid="guard-alert" data-type={type ?? 'warning'}>
      <div data-testid="guard-title">{title}</div>
      {action ? <div data-testid="guard-action">{action}</div> : null}
    </div>
  ),
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/Conversation', () => ({
  ChatInput: ({ sendButtonProps }: { sendButtonProps?: { disabled?: boolean } }) => (
    <div data-testid="chat-input">
      <button data-testid="send-button" disabled={!!sendButtonProps?.disabled} type="button">
        send
      </button>
    </div>
  ),
}));

beforeEach(() => {
  cloudConfig.goToConfig.mockReset();
  cloudConfig.refetch.mockReset();
  setCloudStatus({ isConfigured: false, status: 'not-configured' });
});

describe('HeterogeneousChatInput cloud credential guard (shared-infra/F5)', () => {
  it('loading: shows neutral loading strip, not the configure banner; input disabled', () => {
    setCloudStatus({ isConfigured: false, isLoading: true, status: 'loading' });

    render(<HeterogeneousChatInput />);

    expect(screen.getByText('Checking cloud credentials…')).toBeTruthy();
    expect(screen.queryByText('Cloud credentials required')).toBeNull();
    expect(screen.queryByText('heteroAgent.cloudNotConfigured.title')).toBeNull();
    expect(screen.getByTestId('guard-alert').getAttribute('data-type')).toBe('info');
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('error: shows retryable error, keeps send disabled (fail-closed), offers refetch', () => {
    setCloudStatus({ isConfigured: false, isError: true, status: 'error' });

    render(<HeterogeneousChatInput />);

    expect(screen.getByText('Could not verify cloud credentials')).toBeTruthy();
    expect(screen.queryByText('Cloud credentials required')).toBeNull();
    expect(screen.getByTestId('guard-alert').getAttribute('data-type')).toBe('error');
    expect(screen.getByTestId('send-button')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(cloudConfig.refetch).toHaveBeenCalledTimes(1);
  });

  it('not-configured: shows the configure banner and disables send', () => {
    setCloudStatus({ isConfigured: false, status: 'not-configured' });

    render(<HeterogeneousChatInput />);

    expect(screen.getByText('heteroAgent.cloudNotConfigured.title')).toBeTruthy();
    expect(screen.getByText('heteroAgent.cloudNotConfigured.action')).toBeTruthy();
    expect(screen.queryByText('Checking cloud credentials…')).toBeNull();
    expect(screen.queryByText('Could not verify cloud credentials')).toBeNull();
    expect(screen.getByTestId('send-button')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'heteroAgent.cloudNotConfigured.action' }));
    expect(cloudConfig.goToConfig).toHaveBeenCalledTimes(1);
  });

  it('configured: no cloud guard banner and send enabled', () => {
    setCloudStatus({ isConfigured: true, status: 'configured' });

    render(<HeterogeneousChatInput />);

    expect(screen.queryByTestId('guard-alert')).toBeNull();
    expect(screen.queryByText('Checking cloud credentials…')).toBeNull();
    expect(screen.queryByText('Could not verify cloud credentials')).toBeNull();
    expect(screen.queryByText('heteroAgent.cloudNotConfigured.title')).toBeNull();
    expect(screen.getByTestId('send-button')).not.toBeDisabled();
  });
});
