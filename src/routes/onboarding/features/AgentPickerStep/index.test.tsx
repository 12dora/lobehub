import {
  type AgentTemplate,
  MarketplaceCategory,
} from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { peekOnboardingCallbackUrl, stashOnboardingCallbackUrl } from '@/utils/onboardingRedirect';

import AgentPickerStep from './index';

const navigate = vi.fn();
const finishOnboarding = vi.fn().mockResolvedValue(undefined);
const installMarketplaceAgents = vi.fn().mockResolvedValue({
  installedAgentIds: [],
  skippedAgentIds: [],
  summaries: [],
});
const metrics = vi.hoisted(() => ({
  trackOnboardingCompleted: vi.fn(),
  trackOnboardingMarketplacePicked: vi.fn(),
  trackOnboardingMarketplaceShown: vi.fn(),
  trackOnboardingStepCompleted: vi.fn(),
}));

const templates: AgentTemplate[] = [
  {
    avatar: '🤖',
    category: MarketplaceCategory.Engineering,
    description: 'Reviews pull requests',
    id: 't1',
    title: 'Code Reviewer',
  },
  {
    avatar: '✍️',
    category: MarketplaceCategory.ContentCreation,
    description: 'Drafts marketing copy',
    id: 't2',
    title: 'Copywriter',
  },
];

let swrReturn: { data: AgentTemplate[]; error?: unknown; isLoading: boolean } = {
  data: templates,
  error: undefined,
  isLoading: false,
};
let searchParams = new URLSearchParams();

vi.mock('swr', () => ({ default: () => swrReturn }));

vi.mock('react-router', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../components/LobeMessage', () => ({
  default: ({ sentences }: { sentences: string[] }) => <div>{sentences.join(' / ')}</div>,
}));

vi.mock('@/services/agentMarketplace', () => ({
  fetchOnboardingAgentTemplates: vi.fn(),
}));

// `managed`, `error` and `loading` are modeled independently so the tests can hit the states the
// real hook produces — in particular "settled, errored, NOT managed", where `blocked` is true but
// auto-skipping onboarding would be wrong.
const managedAgents = {
  error: null as Error | null,
  loading: false,
  managed: false,
};
vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({
    // Mirrors the real `useManagedResource`: blocked === loading || error || managed.
    blocked: managedAgents.loading || managedAgents.error !== null || managedAgents.managed,
    error: managedAgents.error,
    loading: managedAgents.loading,
    managed: managedAgents.managed,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/services/installMarketplaceAgents', () => ({
  installMarketplaceAgents: (...args: unknown[]) => installMarketplaceAgents(...args),
}));

vi.mock('@/services/onboardingMetrics', () => ({
  trackOnboardingCompleted: metrics.trackOnboardingCompleted,
  trackOnboardingMarketplacePicked: metrics.trackOnboardingMarketplacePicked,
  trackOnboardingMarketplaceShown: metrics.trackOnboardingMarketplaceShown,
  trackOnboardingStepCompleted: metrics.trackOnboardingStepCompleted,
}));

const userState = { finishOnboarding, user: { interests: [] as string[] } };
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: typeof userState) => unknown) => selector(userState),
}));
vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: { interests: (s: typeof userState) => s.user?.interests ?? [] },
}));

beforeEach(() => {
  navigate.mockClear();
  finishOnboarding.mockClear();
  installMarketplaceAgents.mockClear();
  metrics.trackOnboardingCompleted.mockClear();
  metrics.trackOnboardingMarketplacePicked.mockClear();
  metrics.trackOnboardingMarketplaceShown.mockClear();
  metrics.trackOnboardingStepCompleted.mockClear();
  swrReturn = { data: templates, error: undefined, isLoading: false };
  searchParams = new URLSearchParams();
  managedAgents.error = null;
  managedAgents.loading = false;
  managedAgents.managed = false;
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('AgentPickerStep', () => {
  it('renders an agent card for each template', () => {
    render(<AgentPickerStep onBack={vi.fn()} />);
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Copywriter')).toBeInTheDocument();
  });

  it('installs the selected agents then finishes onboarding on Continue', async () => {
    render(<AgentPickerStep onBack={vi.fn()} />);

    fireEvent.click(screen.getByText('Code Reviewer'));
    const continueButton = screen.getByRole('button', { name: 'agentPicker.continue (1)' });
    fireEvent.click(continueButton);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(installMarketplaceAgents).toHaveBeenCalledWith(['t1']);
    expect(finishOnboarding).toHaveBeenCalledTimes(1);
    expect(metrics.trackOnboardingStepCompleted).toHaveBeenCalledWith({
      action: 'continue',
      entry: 'classic',
      flow: 'classic',
      selectedCount: 1,
      step: 'agentpicker',
      stepIndex: 4,
    });
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'classic',
      targetUrl: '/',
    });
  });

  it('finishes onboarding without installing on Skip', async () => {
    render(<AgentPickerStep onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'agentPicker.skip' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(finishOnboarding).toHaveBeenCalledTimes(1);
    expect(installMarketplaceAgents).not.toHaveBeenCalled();
    expect(metrics.trackOnboardingStepCompleted).toHaveBeenCalledWith({
      action: 'skip',
      entry: 'classic',
      flow: 'classic',
      selectedCount: 0,
      step: 'agentpicker',
      stepIndex: 4,
    });
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'classic',
      targetUrl: '/',
    });
  });

  it('navigates to the stashed signup callbackUrl on finish and clears it', async () => {
    stashOnboardingCallbackUrl('?callbackUrl=%2Fagent%2Fabc%3Fmessage%3Dhi');
    render(<AgentPickerStep onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'agentPicker.skip' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/agent/abc?message=hi'));
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'classic',
      targetUrl: '/agent/abc?message=hi',
    });
    expect(peekOnboardingCallbackUrl()).toBeUndefined();
  });

  describe('when the org hosts the agent catalog', () => {
    it('skips the marketplace step instead of offering installs that always 403', async () => {
      managedAgents.managed = true;
      render(<AgentPickerStep onBack={vi.fn()} />);

      // No picker, and onboarding auto-completes as a `skip` so the user is not parked on a
      // dead-end step.
      expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
      expect(installMarketplaceAgents).not.toHaveBeenCalled();
      expect(finishOnboarding).toHaveBeenCalledTimes(1);
      expect(metrics.trackOnboardingMarketplaceShown).not.toHaveBeenCalled();
      expect(metrics.trackOnboardingStepCompleted).toHaveBeenCalledWith({
        action: 'skip',
        entry: 'classic',
        flow: 'classic',
        selectedCount: 0,
        step: 'agentpicker',
        stepIndex: 4,
      });
    });

    it('waits for the capability payload before deciding (no auto-skip on the loading flicker)', () => {
      // `blocked` is optimistically true while loading — auto-skipping then would end onboarding
      // for every user, managed or not.
      managedAgents.loading = true;
      render(<AgentPickerStep onBack={vi.fn()} />);

      expect(navigate).not.toHaveBeenCalled();
      expect(finishOnboarding).not.toHaveBeenCalled();
      expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument();
    });

    it('never auto-skips on a settled capabilities ERROR for an unmanaged user', async () => {
      // Regression: `blocked` is also true on error. Treating that as "managed" would silently and
      // irreversibly finish onboarding for an ordinary user whose capabilities request flaked.
      managedAgents.error = new Error('capabilities unreachable');
      const { rerender } = render(<AgentPickerStep onBack={vi.fn()} />);

      expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
      expect(finishOnboarding).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();

      // Give the auto-skip effect every chance to fire on a re-render before asserting.
      rerender(<AgentPickerStep onBack={vi.fn()} />);
      await waitFor(() => expect(finishOnboarding).not.toHaveBeenCalled());
    });

    it('still refuses the install mutation while the capability state is unknown', async () => {
      // Fail closed on the write, but do not strand the user: the step completes without firing a
      // request the server might refuse.
      managedAgents.error = new Error('capabilities unreachable');
      render(<AgentPickerStep onBack={vi.fn()} />);

      fireEvent.click(screen.getByText('Code Reviewer'));
      fireEvent.click(screen.getByRole('button', { name: 'agentPicker.continue (1)' }));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
      expect(installMarketplaceAgents).not.toHaveBeenCalled();
      expect(finishOnboarding).toHaveBeenCalledTimes(1);
    });

    it('does not auto-skip when loading settles to an unmanaged, healthy state', async () => {
      managedAgents.loading = true;
      const { rerender } = render(<AgentPickerStep onBack={vi.fn()} />);
      expect(finishOnboarding).not.toHaveBeenCalled();

      managedAgents.loading = false;
      managedAgents.managed = false;
      rerender(<AgentPickerStep onBack={vi.fn()} />);

      expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
      await waitFor(() => expect(finishOnboarding).not.toHaveBeenCalled());
      expect(navigate).not.toHaveBeenCalled();
    });

    it('auto-skips once loading settles to a KNOWN managed state', async () => {
      managedAgents.loading = true;
      const { rerender } = render(<AgentPickerStep onBack={vi.fn()} />);
      expect(finishOnboarding).not.toHaveBeenCalled();

      managedAgents.loading = false;
      managedAgents.managed = true;
      rerender(<AgentPickerStep onBack={vi.fn()} />);

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
      expect(finishOnboarding).toHaveBeenCalledTimes(1);
      expect(installMarketplaceAgents).not.toHaveBeenCalled();
    });
  });

  it('shows a Back button that calls onBack for a normal classic entry', () => {
    const onBack = vi.fn();
    render(<AgentPickerStep onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hides the Back button when entered via agent-onboarding skip', () => {
    searchParams = new URLSearchParams('entry=skip');
    render(<AgentPickerStep onBack={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'back' })).not.toBeInTheDocument();
  });

  it('attributes entry=skip completion to the agent flow', async () => {
    searchParams = new URLSearchParams('entry=skip');
    render(<AgentPickerStep onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'agentPicker.skip' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(metrics.trackOnboardingStepCompleted).toHaveBeenCalledWith({
      action: 'skip',
      entry: 'agent_skip',
      flow: 'agent',
      selectedCount: 0,
      step: 'agentpicker',
      stepIndex: 4,
    });
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'agent',
      targetUrl: '/',
    });
  });
});
