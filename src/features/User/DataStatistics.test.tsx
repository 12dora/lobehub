/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DataStatistics from './DataStatistics';

type SwrResult = { data?: unknown; isLoading: boolean };

const swr = vi.hoisted(() => ({
  results: {} as Record<string, SwrResult>,
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown) => {
    const name = Array.isArray(key) ? String(key[0]) : String(key);
    return swr.results[name] ?? { data: undefined, isLoading: true };
  },
}));

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div data-testid={'stats-loading'} />,
}));

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: { isMobile: boolean }) => unknown) =>
    selector({ isMobile: false }),
}));

vi.mock('@/services/agent', () => ({ agentService: { countAgents: vi.fn() } }));
vi.mock('@/services/message', () => ({ messageService: { countMessages: vi.fn() } }));
vi.mock('@/services/topic', () => ({ topicService: { countTopics: vi.fn() } }));

describe('DataStatistics', () => {
  beforeEach(() => {
    swr.results = {};
  });

  it('shows the loader only on a cold read', () => {
    render(<DataStatistics />);

    expect(screen.getAllByTestId('stats-loading')).toHaveLength(3);
  });

  it('keeps cached counts visible while SWR revalidates', () => {
    swr.results = {
      'stats:countAgents': { data: 7, isLoading: true },
      'stats:countMessages': { data: { messages: 42, messagesToday: 0 }, isLoading: true },
      'stats:countTopics': { data: 13, isLoading: true },
    };

    render(<DataStatistics />);

    expect(screen.queryByTestId('stats-loading')).not.toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});
