import type {
  TaskTemplate,
  TaskTemplateConnector,
  TaskTemplateConnectorSource,
} from '@lobechat/const';
import { TASK_TEMPLATE_RECOMMEND_COUNT } from '@lobechat/const';
import { createNanoId } from '@lobechat/utils';
import { useSessionStorageState } from 'ahooks';
import { App } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { usePlatformTaskTemplates } from '@/enterprise/client/hooks/usePlatformTaskTemplates';
import { taskTemplateKeys } from '@/libs/swr/keys';
import { taskTemplateService } from '@/services/taskTemplate';
import { useBriefStore } from '@/store/brief';
import { briefListSelectors } from '@/store/brief/selectors';
import { useToolStore } from '@/store/tool';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

import { getProviderMeta } from './providerMeta';
import { useResolvedInterestKeys } from './useResolvedInterestKeys';

const REFRESH_SEED_STORAGE_KEY = 'lobehub:taskTemplate:refreshSeed';
const nextRefreshSeed = createNanoId(8);

export type DailyBriefRecommendationsUIState =
  | { mode: 'hidden' }
  | { mode: 'skeleton'; skeletonCount: number }
  | {
      mode: 'cards';
      onCreated: (templateId: number | string) => void;
      onDismiss: (templateId: number | string) => void;
      /**
       * Absent when the list is not refreshable. A platform-managed catalog has no per-user
       * reshuffle, so the surface must hide its refresh control instead of showing a dead button.
       */
      onRefresh?: () => void;
      templates: TaskTemplate[];
    };

interface UseDailyBriefRecommendationsUIOptions {
  count?: number;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

const isTaskTemplateConnectorSource = (value: unknown): value is TaskTemplateConnectorSource =>
  value === 'composio' || value === 'lobehub';

const isTaskTemplateConnector = (value: unknown): value is TaskTemplateConnector => {
  if (!isRecord(value)) return false;
  if (typeof value.identifier !== 'string') return false;
  if (!isTaskTemplateConnectorSource(value.source)) return false;
  return (
    typeof value.required === 'boolean' &&
    Boolean(getProviderMeta({ identifier: value.identifier, source: value.source }))
  );
};

const isTaskTemplateRecommendationCandidate = (value: unknown): value is TaskTemplate => {
  if (!isRecord(value)) return false;
  return (
    typeof value.category === 'string' &&
    Array.isArray(value.connectors) &&
    value.connectors.every(isTaskTemplateConnector) &&
    typeof value.cronPattern === 'string' &&
    typeof value.description === 'string' &&
    // Market rows carry a numeric id; platform-managed rows carry their table id (text).
    (typeof value.id === 'number' || typeof value.id === 'string') &&
    typeof value.identifier === 'string' &&
    typeof value.instruction === 'string' &&
    Array.isArray(value.interests) &&
    typeof value.title === 'string'
  );
};

/**
 * v2.2.6 returned legacy recommendation rows before `connectors` and text fields existed.
 * Drop legacy rows from version-skewed self-host servers so they cannot crash the home screen.
 */
const normalizeTaskTemplateRecommendation = (template: unknown): TaskTemplate | undefined => {
  if (!isTaskTemplateRecommendationCandidate(template)) return undefined;
  return template;
};

/**
 * Persisted SWR data can be stale or corrupted, for example `{ data: { ... } }`.
 * Treat non-array payloads as empty so home rendering and cache mutations stay defensive.
 */
const normalizeTaskTemplateRecommendations = (templates: unknown): TaskTemplate[] => {
  if (!Array.isArray(templates)) return [];

  return templates.flatMap((template) => {
    const normalized = normalizeTaskTemplateRecommendation(template);
    return normalized ? [normalized] : [];
  });
};

interface ResolveDailyBriefRecommendationRequestParams {
  interestKeys: string[] | null;
  isLogin: boolean | undefined;
  locale: string;
  recommendationCount: number;
  refreshSeed?: string;
}

export const resolveDailyBriefRecommendationRequest = ({
  interestKeys,
  isLogin,
  locale,
  recommendationCount,
  refreshSeed,
}: ResolveDailyBriefRecommendationRequestParams) => {
  const enabled = isLogin === true;

  return {
    key: enabled
      ? taskTemplateKeys.listDailyRecommend(refreshSeed ?? '', recommendationCount, locale)
      : null,
    shouldFetch: enabled && interestKeys !== null,
  };
};

interface ResolveDailyBriefRecommendationDisplayModeParams {
  canFetchRecommendations: boolean;
  hasRecommendationKey: boolean;
  hasTemplates: boolean;
  isInit: boolean;
  isLoading: boolean;
  isValidating: boolean;
  isWaitingForInterestsFetch: boolean;
}

export const resolveDailyBriefRecommendationDisplayMode = ({
  canFetchRecommendations,
  hasRecommendationKey,
  hasTemplates,
  isInit,
  isLoading,
  isValidating,
  isWaitingForInterestsFetch,
}: ResolveDailyBriefRecommendationDisplayModeParams): DailyBriefRecommendationsUIState['mode'] => {
  if (!hasRecommendationKey) return 'hidden';
  if (hasTemplates) return 'cards';
  if (
    !isInit ||
    isLoading ||
    isValidating ||
    !canFetchRecommendations ||
    isWaitingForInterestsFetch
  ) {
    return 'skeleton';
  }

  return 'hidden';
};

export function useDailyBriefRecommendationsUI(
  options: UseDailyBriefRecommendationsUIOptions = {},
): DailyBriefRecommendationsUIState {
  const { count } = options;
  const recommendationCount = count ?? TASK_TEMPLATE_RECOMMEND_COUNT;
  const { i18n, t } = useTranslation('common');
  const locale = i18n.resolvedLanguage || i18n.language;
  const { message } = App.useApp();
  const isLogin = useUserStore(authSelectors.isLogin);
  const useFetchBriefs = useBriefStore((s) => s.useFetchBriefs);
  useFetchBriefs(isLogin);

  const isInit = useBriefStore(briefListSelectors.isBriefsInit);

  const interestKeys = useResolvedInterestKeys();
  const [refreshSeed, setRefreshSeed] = useSessionStorageState<string>(REFRESH_SEED_STORAGE_KEY, {
    defaultValue: '',
  });

  /**
   * When the platform admin manages a task-template catalog, that list is authoritative and the
   * market is never consulted. An empty table (or a disabled/failed policy read) means
   * `managed: false`, which keeps the original market recommendations exactly as they were.
   */
  const platform = usePlatformTaskTemplates();
  const [dismissedPlatformIds, setDismissedPlatformIds] = useState<string[]>([]);

  const recommendationRequest = useMemo(
    () =>
      resolveDailyBriefRecommendationRequest({
        interestKeys,
        // Platform-managed: never touch the market. Still unresolved: keep the cache key (so the
        // block renders a skeleton rather than flashing market cards) but hold the fetch below.
        isLogin: platform.managed ? false : isLogin,
        locale,
        recommendationCount,
        refreshSeed,
      }),
    [interestKeys, isLogin, locale, platform.managed, recommendationCount, refreshSeed],
  );
  const canFetchRecommendations =
    recommendationRequest.shouldFetch && interestKeys !== null && platform.resolved;
  const recommendationFetcher = canFetchRecommendations
    ? async () =>
        taskTemplateService.listDailyRecommend(interestKeys, {
          count: recommendationCount,
          locale,
          refreshSeed: refreshSeed || undefined,
        })
    : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR(
    recommendationRequest.key,
    recommendationFetcher,
    {
      keepPreviousData: true,
      revalidateIfStale: canFetchRecommendations,
      revalidateOnFocus: false,
      revalidateOnMount: canFetchRecommendations,
      revalidateOnReconnect: false,
    },
  );
  const waitedForInterestsRef = useRef(false);

  useEffect(() => {
    if (!recommendationRequest.key) {
      waitedForInterestsRef.current = false;
      return;
    }

    if (interestKeys === null) {
      waitedForInterestsRef.current = true;
      return;
    }

    if (!waitedForInterestsRef.current) return;
    waitedForInterestsRef.current = false;
    void mutate();
  }, [interestKeys, mutate, recommendationRequest.key]);

  useEffect(() => {
    if (error) console.error('[taskTemplate:listDailyRecommend]', error);
  }, [error]);

  const handleRefresh = useCallback(() => {
    setRefreshSeed(nextRefreshSeed());
  }, [setRefreshSeed]);

  const removeTemplateFromList = useCallback(
    (templateId: number | string) => {
      // Platform-managed rows are not backed by the market SWR cache; hide them locally.
      if (typeof templateId === 'string') {
        setDismissedPlatformIds((current) =>
          current.includes(templateId) ? current : [...current, templateId],
        );
        return;
      }
      mutate(
        (current) =>
          current
            ? {
                ...current,
                data: normalizeTaskTemplateRecommendations(current.data).filter(
                  (tmpl) => tmpl.id !== templateId,
                ),
              }
            : current,
        { revalidate: false },
      );
    },
    [mutate],
  );

  const handleCreated = useCallback(
    (templateId: number | string) => {
      removeTemplateFromList(templateId);
    },
    [removeTemplateFromList],
  );

  const handleDismiss = useCallback(
    async (templateId: number | string) => {
      removeTemplateFromList(templateId);
      // Only market rows have a server-side dismiss endpoint.
      if (typeof templateId !== 'number') return;
      try {
        await taskTemplateService.dismiss(templateId);
      } catch (error) {
        console.error('[taskTemplate:dismiss]', error);
        message.error(t('taskTemplate.action.dismiss.error'));
        mutate();
      }
    },
    [message, mutate, removeTemplateFromList, t],
  );

  const marketTemplates = useMemo(
    () => normalizeTaskTemplateRecommendations(data?.data ?? []),
    [data],
  );
  const platformTemplates = useMemo(
    () =>
      normalizeTaskTemplateRecommendations(platform.templates)
        .filter((tmpl) => !dismissedPlatformIds.includes(String(tmpl.id)))
        .slice(0, recommendationCount),
    [dismissedPlatformIds, platform.templates, recommendationCount],
  );
  const templates = platform.managed ? platformTemplates : marketTemplates;
  const requiredSources = useMemo(() => {
    const sources = new Set<TaskTemplateConnectorSource>();
    for (const tmpl of templates) {
      for (const connector of tmpl.connectors) sources.add(connector.source);
    }
    return sources;
  }, [templates]);
  const useFetchUserComposioConnections = useToolStore((s) => s.useFetchUserComposioConnections);
  const useFetchLobehubConnectorConnections = useToolStore(
    (s) => s.useFetchLobehubSkillConnections,
  );
  useFetchUserComposioConnections(requiredSources.has('composio'));
  useFetchLobehubConnectorConnections(requiredSources.has('lobehub'));

  // Platform-managed: the admin list is the whole answer — no market call, no error path, and no
  // refresh (the catalog is not reshuffled per user).
  if (platform.managed) {
    if (templates.length === 0) return { mode: 'hidden' };
    return {
      mode: 'cards',
      onCreated: handleCreated,
      onDismiss: handleDismiss,
      templates,
    };
  }

  // Until the platform policy answers, market rows — even cached ones — may be the wrong list.
  // Show the skeleton rather than cards that could be replaced a tick later.
  if (!platform.resolved) {
    return recommendationRequest.key
      ? { mode: 'skeleton', skeletonCount: recommendationCount }
      : { mode: 'hidden' };
  }

  const displayMode = resolveDailyBriefRecommendationDisplayMode({
    canFetchRecommendations,
    hasRecommendationKey: Boolean(recommendationRequest.key),
    hasTemplates: templates.length > 0,
    isInit,
    isLoading,
    isValidating,
    isWaitingForInterestsFetch: interestKeys !== null && waitedForInterestsRef.current,
  });
  if (error) return { mode: 'hidden' };
  if (displayMode === 'hidden') return { mode: 'hidden' };
  if (displayMode === 'skeleton') return { mode: 'skeleton', skeletonCount: recommendationCount };

  return {
    mode: 'cards',
    onCreated: handleCreated,
    onDismiss: handleDismiss,
    onRefresh: handleRefresh,
    templates,
  };
}
