/**
 * @vitest-environment happy-dom
 */
import type { TaskTemplate } from '@lobechat/const';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_TEMPLATE_RECOMMENDATION_CACHE_VERSION, taskTemplateKeys } from '@/libs/swr/keys';
import { taskTemplateService } from '@/services/taskTemplate';

import type { DailyBriefRecommendationsUIState } from './useDailyBriefRecommendationsUI';
import {
  resolveDailyBriefRecommendationDisplayMode,
  resolveDailyBriefRecommendationRequest,
  useDailyBriefRecommendationsUI,
} from './useDailyBriefRecommendationsUI';

const {
  mockMutate,
  mockRefreshSeed,
  mockSeedCounter,
  mockSetRefreshSeed,
  mockUseFetchBriefs,
  mockUseFetchLobehubConnectorConnections,
  mockUseFetchUserComposioConnections,
  mockUsePlatformTaskTemplates,
  mockUseResolvedInterestKeys,
  mockUseSWR,
} = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockRefreshSeed: { value: '' },
  mockSeedCounter: { value: 0 },
  mockSetRefreshSeed: vi.fn(),
  mockUseFetchBriefs: vi.fn(),
  mockUseFetchLobehubConnectorConnections: vi.fn(),
  mockUseFetchUserComposioConnections: vi.fn(),
  mockUsePlatformTaskTemplates: vi.fn(),
  mockUseResolvedInterestKeys: vi.fn(),
  mockUseSWR: vi.fn(),
}));

vi.mock('@/enterprise/client/hooks/usePlatformTaskTemplates', () => ({
  usePlatformTaskTemplates: mockUsePlatformTaskTemplates,
}));

// Stateful stand-in for session storage: writing a seed both persists it across mounts and
// re-renders the caller, exactly like the real `useSessionStorageState`.
vi.mock('ahooks', async () => {
  const { useCallback, useState } = await import('react');

  return {
    useSessionStorageState: () => {
      const [value, setValue] = useState(() => mockRefreshSeed.value);
      const setSeed = useCallback((next: string) => {
        mockRefreshSeed.value = next;
        mockSetRefreshSeed(next);
        setValue(next);
      }, []);

      return [value, setSeed];
    },
  };
});

// Deterministic per-mount seeds so the shuffled platform order is reproducible in tests.
vi.mock('@lobechat/utils', () => ({
  createNanoId: () => () => `mount-seed-${++mockSeedCounter.value}`,
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({ message: { error: vi.fn() } }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string) => key,
  }),
}));

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

vi.mock('@/store/brief', () => ({
  useBriefStore: (selector: (state: any) => unknown) =>
    selector({
      isBriefsInit: true,
      useFetchBriefs: mockUseFetchBriefs,
    }),
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (state: any) => unknown) =>
    selector({
      useFetchLobehubSkillConnections: mockUseFetchLobehubConnectorConnections,
      useFetchUserComposioConnections: mockUseFetchUserComposioConnections,
    }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: any) => unknown) =>
    selector({
      isLoaded: true,
      isSignedIn: true,
      user: { interests: ['coding'] },
    }),
}));

vi.mock('@/services/taskTemplate', () => ({
  taskTemplateService: {
    dismiss: vi.fn(),
    listDailyRecommend: vi.fn(),
    recordCreated: vi.fn(),
  },
}));

vi.mock('./useResolvedInterestKeys', () => ({
  useResolvedInterestKeys: mockUseResolvedInterestKeys,
}));

const template = {
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Description',
  id: 101,
  identifier: 'daily-engineering',
  instruction: 'Instruction',
  interests: ['coding'],
  title: 'Title',
} satisfies TaskTemplate;

const platformCatalog = Array.from({ length: 8 }, (_, index) => ({
  ...template,
  id: `tpl-${index + 1}`,
  identifier: `platform-${index + 1}`,
})) satisfies TaskTemplate[];

const cardIds = (state: DailyBriefRecommendationsUIState): (number | string)[] => {
  if (state.mode !== 'cards') throw new Error('expected cards');
  return state.templates.map((tmpl) => tmpl.id);
};

/** Renders a fresh mount, reads the card order, then unmounts. */
const renderPlatformIds = (count = 8): (number | string)[] => {
  const { result, unmount } = renderHook(() => useDailyBriefRecommendationsUI({ count }));
  const ids = cardIds(result.current);
  unmount();
  return ids;
};

/** A single mount whose recommendation count can change without losing the mount seed. */
const renderPlatformHook = (count: number) =>
  renderHook((props: { count: number }) => useDailyBriefRecommendationsUI(props), {
    initialProps: { count },
  });

describe('resolveDailyBriefRecommendationRequest', () => {
  it('keeps the cache key available while interests are still initializing', () => {
    const loading = resolveDailyBriefRecommendationRequest({
      interestKeys: null,
      isLogin: true,
      locale: 'zh-CN',
      recommendationCount: 3,
      refreshSeed: '',
    });
    const ready = resolveDailyBriefRecommendationRequest({
      interestKeys: ['ai'],
      isLogin: true,
      locale: 'zh-CN',
      recommendationCount: 3,
      refreshSeed: '',
    });

    expect(loading.key).toEqual(ready.key);
    expect(loading.shouldFetch).toBe(false);
    expect(ready.shouldFetch).toBe(true);
  });

  it('does not include interests in the persisted recommendation cache key', () => {
    const ai = resolveDailyBriefRecommendationRequest({
      interestKeys: ['ai'],
      isLogin: true,
      locale: 'zh-CN',
      recommendationCount: 3,
      refreshSeed: 'seed',
    });
    const research = resolveDailyBriefRecommendationRequest({
      interestKeys: ['research'],
      isLogin: true,
      locale: 'zh-CN',
      recommendationCount: 3,
      refreshSeed: 'seed',
    });

    expect(ai.key).toEqual(research.key);
    expect(ai.key).toEqual(taskTemplateKeys.listDailyRecommend('seed', 3, 'zh-CN'));
    expect(ai.key?.[0]).toBe(
      `taskTemplate:listDailyRecommend:v${TASK_TEMPLATE_RECOMMENDATION_CACHE_VERSION}`,
    );
  });

  it('keeps refresh seed, count, and locale in the cache key', () => {
    expect(
      resolveDailyBriefRecommendationRequest({
        interestKeys: [],
        isLogin: true,
        locale: 'zh-CN',
        recommendationCount: 3,
        refreshSeed: 'seed-a',
      }).key,
    ).not.toEqual(
      resolveDailyBriefRecommendationRequest({
        interestKeys: [],
        isLogin: true,
        locale: 'en-US',
        recommendationCount: 6,
        refreshSeed: 'seed-b',
      }).key,
    );
  });

  it('disables the cache key before login', () => {
    expect(
      resolveDailyBriefRecommendationRequest({
        interestKeys: [],
        isLogin: false,
        locale: 'zh-CN',
        recommendationCount: 3,
        refreshSeed: '',
      }),
    ).toEqual({ key: null, shouldFetch: false });
  });
});

describe('resolveDailyBriefRecommendationDisplayMode', () => {
  it('keeps cached cards visible while interests are still initializing', () => {
    expect(
      resolveDailyBriefRecommendationDisplayMode({
        canFetchRecommendations: false,
        hasRecommendationKey: true,
        hasTemplates: true,
        isInit: false,
        isLoading: false,
        isValidating: false,
        isWaitingForInterestsFetch: false,
      }),
    ).toBe('cards');
  });

  it('keeps skeleton visible while the first ready-interest fetch is pending', () => {
    expect(
      resolveDailyBriefRecommendationDisplayMode({
        canFetchRecommendations: true,
        hasRecommendationKey: true,
        hasTemplates: false,
        isInit: true,
        isLoading: false,
        isValidating: true,
        isWaitingForInterestsFetch: false,
      }),
    ).toBe('skeleton');
  });

  it('keeps skeleton visible before the first ready-interest fetch starts', () => {
    expect(
      resolveDailyBriefRecommendationDisplayMode({
        canFetchRecommendations: true,
        hasRecommendationKey: true,
        hasTemplates: false,
        isInit: true,
        isLoading: false,
        isValidating: false,
        isWaitingForInterestsFetch: true,
      }),
    ).toBe('skeleton');
  });

  it('hides an initialized empty recommendation result only when idle', () => {
    expect(
      resolveDailyBriefRecommendationDisplayMode({
        canFetchRecommendations: true,
        hasRecommendationKey: true,
        hasTemplates: false,
        isInit: true,
        isLoading: false,
        isValidating: false,
        isWaitingForInterestsFetch: false,
      }),
    ).toBe('hidden');
  });
});

describe('useDailyBriefRecommendationsUI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshSeed.value = '';
    mockSeedCounter.value = 0;
    mockUseResolvedInterestKeys.mockReturnValue(['coding']);
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: false,
      resolved: true,
      templates: [],
    });
    mockUseSWR.mockReturnValue({
      data: { data: [template], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });
  });

  it('returns cards when recommendations are loaded and forwards locale/count inputs', async () => {
    vi.mocked(taskTemplateService.listDailyRecommend).mockResolvedValue({
      data: [template],
      success: true,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI({ count: 2 }));

    expect(result.current).toMatchObject({ mode: 'cards', templates: [template] });
    expect(mockUseSWR.mock.calls[0][0]).toEqual(
      taskTemplateKeys.listDailyRecommend('', 2, 'en-US'),
    );

    const fetcher = mockUseSWR.mock.calls[0][1];
    await fetcher();

    expect(taskTemplateService.listDailyRecommend).toHaveBeenCalledWith(['coding'], {
      count: 2,
      locale: 'en-US',
      refreshSeed: undefined,
    });
  });

  it('drops recommendations that are missing connectors', () => {
    const templateWithoutConnectors = {
      category: 'engineering',
      cronPattern: '0 9 * * *',
      description: 'Description',
      id: 102,
      identifier: 'legacy-daily-engineering',
      instruction: 'Instruction',
      interests: ['coding'],
      title: 'Legacy title',
    } satisfies Omit<TaskTemplate, 'connectors'>;
    mockUseSWR.mockReturnValue({
      data: { data: [templateWithoutConnectors], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
    expect(mockUseFetchUserComposioConnections).toHaveBeenCalledWith(false);
    expect(mockUseFetchLobehubConnectorConnections).toHaveBeenCalledWith(false);
  });

  it('drops recommendations with malformed connector entries', () => {
    const templateWithMalformedConnectors = {
      ...template,
      connectors: [null],
    };
    mockUseSWR.mockReturnValue({
      data: { data: [templateWithMalformedConnectors], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
    expect(mockUseFetchUserComposioConnections).toHaveBeenCalledWith(false);
    expect(mockUseFetchLobehubConnectorConnections).toHaveBeenCalledWith(false);
  });

  it('drops recommendations with unknown connector identifiers', () => {
    const templateWithUnknownConnector = {
      ...template,
      connectors: [{ identifier: 'nonexistent-x', required: true, source: 'lobehub' }],
    };
    mockUseSWR.mockReturnValue({
      data: { data: [templateWithUnknownConnector], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
    expect(mockUseFetchUserComposioConnections).toHaveBeenCalledWith(false);
    expect(mockUseFetchLobehubConnectorConnections).toHaveBeenCalledWith(false);
  });

  it('treats non-array recommendation payloads as empty data', () => {
    mockUseSWR.mockReturnValue({
      data: { data: { ...template }, success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
    expect(mockUseFetchUserComposioConnections).toHaveBeenCalledWith(false);
    expect(mockUseFetchLobehubConnectorConnections).toHaveBeenCalledWith(false);
  });

  it('normalizes cached rows before removing a card', () => {
    mockUseSWR.mockReturnValue({
      data: { data: [template, null], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current.mode).toBe('cards');
    if (result.current.mode !== 'cards') return;

    result.current.onCreated(template.id);

    const updater = mockMutate.mock.calls[0][0] as (current?: {
      data: unknown;
      success: boolean;
    }) => unknown;
    expect(updater({ data: [template, null], success: true })).toEqual({
      data: [],
      success: true,
    });
    expect(updater({ data: { ...template }, success: true })).toEqual({
      data: [],
      success: true,
    });
    expect(mockMutate.mock.calls[0][1]).toEqual({ revalidate: false });
  });

  it('drops legacy recommendations from pre-Market task-template servers', () => {
    const legacyServerTemplate = {
      category: 'engineering',
      cronPattern: '0 9 * * *',
      id: 'oss-intel-daily',
      interests: ['coding'],
      requiresSkills: [{ provider: 'github', source: 'lobehub' }],
    };
    mockUseSWR.mockReturnValue({
      data: { data: [legacyServerTemplate], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
    expect(mockUseFetchUserComposioConnections).toHaveBeenCalledWith(false);
    expect(mockUseFetchLobehubConnectorConnections).toHaveBeenCalledWith(false);
  });

  it('serves the platform-managed list instead of the market once the table has rows', () => {
    const platformTemplate = { ...template, id: 'tpl-1', identifier: 'platform-daily' };
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: [platformTemplate, { ...template, id: 'tpl-2', identifier: 'platform-weekly' }],
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI({ count: 1 }));

    expect(result.current).toMatchObject({ mode: 'cards', templates: [platformTemplate] });
    // The market request must not even be keyed while the platform list is authoritative.
    expect(mockUseSWR.mock.calls[0][0]).toBeNull();
  });

  it('hides the block when every platform-managed template is disabled', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({ managed: true, resolved: true, templates: [] });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    expect(result.current).toEqual({ mode: 'hidden' });
  });

  it('dismisses a platform template locally without calling the market endpoint', async () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: [{ ...template, id: 'tpl-1', identifier: 'platform-daily' }],
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());
    if (result.current.mode !== 'cards') throw new Error('expected cards');

    await result.current.onDismiss('tpl-1');

    expect(taskTemplateService.dismiss).not.toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('holds the skeleton while the platform policy read is still unresolved', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: false,
      resolved: false,
      templates: [],
    });
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI({ count: 3 }));

    // Skeleton, not the "no recommendations" hidden state — the answer is not known yet.
    expect(result.current).toEqual({ mode: 'skeleton', skeletonCount: 3 });
    expect(mockUseSWR.mock.calls[0][1]).toBeNull();
  });

  it('does not show cached market cards before the platform policy answers', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: false,
      resolved: false,
      templates: [],
    });
    // A warm SWR cache from a previous visit — it must not win the race and flash in.
    mockUseSWR.mockReturnValue({
      data: { data: [template], success: true },
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI({ count: 3 }));

    expect(result.current).toEqual({ mode: 'skeleton', skeletonCount: 3 });
  });

  it('reshuffles the platform-managed catalog when the refresh control is used', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });

    // Full catalog so the assertion compares orderings, not which slice survives the cut.
    const { result } = renderHook(() =>
      useDailyBriefRecommendationsUI({ count: platformCatalog.length }),
    );
    if (result.current.mode !== 'cards') throw new Error('expected cards');
    expect(result.current.onRefresh).toBeDefined();

    const before = cardIds(result.current);

    act(() => {
      if (result.current.mode !== 'cards') throw new Error('expected cards');
      result.current.onRefresh?.();
    });

    // Refreshing writes a new seed, which reshuffles the catalog on the next render.
    expect(mockSetRefreshSeed).toHaveBeenCalledTimes(1);
    expect(mockSetRefreshSeed.mock.calls[0][0]).toEqual(expect.any(String));
    expect(mockSetRefreshSeed.mock.calls[0][0]).not.toBe('');

    const after = cardIds(result.current);
    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('varies the platform-managed order between mounts', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });

    const first = renderPlatformIds();
    const second = renderPlatformIds();

    expect(first).not.toEqual(second);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it('varies the platform-managed order between mounts even with a stored refresh seed', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });
    // A refresh seed left in session storage by an earlier visit must not freeze the order.
    mockRefreshSeed.value = 'seed-a';

    const first = renderPlatformIds();
    const second = renderPlatformIds();

    expect(first).not.toEqual(second);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it('keeps the platform-managed order stable within a mount', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });
    mockRefreshSeed.value = 'seed-a';

    const { result, rerender } = renderPlatformHook(8);
    const first = cardIds(result.current);

    rerender({ count: 8 });

    expect(cardIds(result.current)).toEqual(first);
  });

  it('limits the shuffled platform-managed list to the recommendation count', () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });

    const { result, rerender } = renderPlatformHook(platformCatalog.length);
    const fullOrder = cardIds(result.current);

    rerender({ count: 3 });
    const ids = cardIds(result.current);

    expect(ids).toHaveLength(3);
    expect(ids).toEqual(fullOrder.slice(0, 3));
  });

  it('excludes dismissed platform templates and pulls the next one in', async () => {
    mockUsePlatformTaskTemplates.mockReturnValue({
      managed: true,
      resolved: true,
      templates: platformCatalog,
    });
    // Same mount throughout: the shuffle order only stays comparable within one mount seed.
    const { result, rerender } = renderPlatformHook(platformCatalog.length);
    const fullOrder = cardIds(result.current);

    rerender({ count: 3 });
    const state = result.current;
    if (state.mode !== 'cards') throw new Error('expected cards');
    expect(cardIds(state)).toEqual(fullOrder.slice(0, 3));

    await act(async () => {
      await state.onDismiss(fullOrder[0]);
    });

    const remaining = cardIds(result.current);
    expect(remaining).not.toContain(fullOrder[0]);
    expect(remaining).toEqual(fullOrder.slice(1, 4));
  });

  it('logs recommendation request errors instead of treating them as normal empty data', async () => {
    const error = new Error('market down');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUseSWR.mockReturnValue({
      error,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    });

    const { result } = renderHook(() => useDailyBriefRecommendationsUI());

    try {
      expect(result.current).toEqual({ mode: 'hidden' });
      await waitFor(() =>
        expect(consoleErrorSpy).toHaveBeenCalledWith('[taskTemplate:listDailyRecommend]', error),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
