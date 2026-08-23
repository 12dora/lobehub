import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { setAgentTemplatesFetcher } from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { AGENT_CHAT_TOPIC_URL } from '@lobechat/const';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useOnboardingAgentTemplates } from '@/hooks/useOnboardingAgentTemplates';
import { useClientDataSWR, useOnlyFetchOnceSWR } from '@/libs/swr';
import { onboardingKeys } from '@/libs/swr/keys';
import { fetchOnboardingAgentTemplates } from '@/services/agentMarketplace';
import { trackOnboardingStepViewed } from '@/services/onboardingMetrics';
import { topicService } from '@/services/topic';
import { userService } from '@/services/user';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { isDev } from '@/utils/env';

import { resolveAgentOnboardingContext } from './context';

/**
 * Resolves the onboarding agent, its bootstrap state and every topic pointer the page
 * derives from them. Also owns the dev-only history topics and the page-level UI state.
 */
export const useAgentOnboardingSession = () => {
  const useInitBuiltinAgent = useAgentStore((s) => s.useInitBuiltinAgent);
  const refreshBuiltinAgent = useAgentStore((s) => s.refreshBuiltinAgent);
  const onboardingAgentId = useAgentStore(
    builtinAgentSelectors.getBuiltinAgentId(BUILTIN_AGENT_SLUGS.webOnboarding),
  );
  const onboardingAgentConfig = useAgentStore((s) =>
    onboardingAgentId ? agentByIdSelectors.getAgentConfigById(onboardingAgentId)(s) : undefined,
  );
  const inboxAgentId = useAgentStore(
    builtinAgentSelectors.getBuiltinAgentId(BUILTIN_AGENT_SLUGS.inbox),
  );
  const [agentOnboarding, refreshUserState, resetAgentOnboarding] = useUserStore((s) => [
    s.agentOnboarding,
    s.refreshUserState,
    s.resetAgentOnboarding,
  ]);
  const [isResetting, setIsResetting] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string>();
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);

  useInitBuiltinAgent(BUILTIN_AGENT_SLUGS.webOnboarding);

  useEffect(() => {
    setAgentTemplatesFetcher(fetchOnboardingAgentTemplates);
  }, []);

  const { data: historyData, mutate: mutateHistoryTopics } = useClientDataSWR(
    isDev && onboardingAgentId ? onboardingKeys.agentHistoryTopics(onboardingAgentId) : null,
    () =>
      topicService.getTopics({
        agentId: onboardingAgentId,
        pageSize: 100,
      }),
  );

  const { data, error, isLoading, mutate } = useOnlyFetchOnceSWR(
    onboardingKeys.agentBootstrap(),
    () => userService.getOnboardingBootstrapState(),
    {
      onSuccess: async () => {
        await refreshUserState();
        if (isDev && onboardingAgentId) await mutateHistoryTopics();
      },
    },
  );

  const currentContext = useMemo(
    () =>
      resolveAgentOnboardingContext({
        bootstrapContext: data,
        storedAgentOnboarding: agentOnboarding,
      }),
    [agentOnboarding, data],
  );
  // bootstrap topicId is now `string | null` for fresh users — coerce null to
  // undefined so the rest of the code's optional-chaining behavior is preserved.
  const bootstrapTopicId = data?.topicId ?? undefined;
  const activeTopicId = currentContext.topicId || bootstrapTopicId;
  const hasMessages = !!data?.hasMessages;
  const historyTopics = historyData?.items || [];
  const effectiveTopicId = selectedTopicId || activeTopicId;
  const onboardingFinished = !!agentOnboarding?.finishedAt;
  const finishTargetUrl = useMemo(() => {
    if (!onboardingFinished || !inboxAgentId || !effectiveTopicId) return undefined;
    return AGENT_CHAT_TOPIC_URL(inboxAgentId, effectiveTopicId);
  }, [onboardingFinished, inboxAgentId, effectiveTopicId]);

  const viewingHistoricalTopic =
    !!activeTopicId && !!effectiveTopicId && effectiveTopicId !== activeTopicId;

  useOnboardingAgentTemplates(!onboardingFinished && !viewingHistoricalTopic);

  const conversationViewedRef = useRef(false);
  useEffect(() => {
    if (
      conversationViewedRef.current ||
      !onboardingAgentId ||
      onboardingFinished ||
      viewingHistoricalTopic
    ) {
      return;
    }

    conversationViewedRef.current = true;
    trackOnboardingStepViewed({
      flow: 'agent',
      step: 'conversation',
      stepIndex: 1,
    });
  }, [onboardingAgentId, onboardingFinished, viewingHistoricalTopic]);

  return {
    activeTopicId,
    agentOnboarding,
    data,
    effectiveTopicId,
    error,
    finishTargetUrl,
    hasMessages,
    historyDrawerOpen,
    historyTopics,
    inboxAgentId,
    isLoading,
    isResetting,
    mutate,
    mutateHistoryTopics,
    onboardingAgentConfig,
    onboardingAgentId,
    onboardingFinished,
    refreshBuiltinAgent,
    refreshUserState,
    resetAgentOnboarding,
    setHistoryDrawerOpen,
    setIsResetting,
    setSelectedTopicId,
    viewingHistoricalTopic,
  };
};
