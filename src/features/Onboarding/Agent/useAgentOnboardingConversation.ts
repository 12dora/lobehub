import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { AGENT_CHAT_TOPIC_URL } from '@lobechat/const';
import { useCallback, useMemo } from 'react';

import { ONBOARDING_PRODUCTION_DEFAULT_MODEL } from '@/const/onboarding';
import { type ConversationHooks } from '@/features/Conversation/types';
import { mergeConversationHooks } from '@/features/Conversation/utils/mergeConversationHooks';
import {
  trackOnboardingCompleted,
  trackOnboardingStepCompleted,
} from '@/services/onboardingMetrics';
import { userService } from '@/services/user';
import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';
import { isDev } from '@/utils/env';
import { peekOnboardingCallbackUrl } from '@/utils/onboardingRedirect';

import type { useAgentOnboardingSession } from './useAgentOnboardingSession';
import { useOnboardingFirstSend } from './useOnboardingFirstSend';
import { useOnboardingFollowUp } from './useOnboardingFollowUp';

type AgentOnboardingSession = ReturnType<typeof useAgentOnboardingSession>;

/**
 * Builds the conversation hooks the onboarding chat runs with: the fresh-user first-send
 * orchestration, the per-turn context resync, and the follow-up suggestions.
 */
export const useAgentOnboardingConversation = (session: AgentOnboardingSession) => {
  const {
    agentOnboarding,
    data,
    effectiveTopicId,
    inboxAgentId,
    mutate,
    mutateHistoryTopics,
    onboardingAgentConfig,
    onboardingAgentId,
    onboardingFinished,
    refreshBuiltinAgent,
    refreshUserState,
    setSelectedTopicId,
    viewingHistoricalTopic,
  } = session;

  const onboardingChatKey = useMemo(
    () => messageMapKey({ agentId: onboardingAgentId || '', topicId: effectiveTopicId }),
    [onboardingAgentId, effectiveTopicId],
  );
  const messagesForOnboarding = useChatStore((s) => s.dbMessagesMap[onboardingChatKey]);
  // No persisted welcome message: greeting = no messages yet.
  const isGreeting = useMemo(
    () => !messagesForOnboarding || messagesForOnboarding.length === 0,
    [messagesForOnboarding],
  );
  const onboardingFollowUpModelConfig = useMemo(
    () => ({
      model: onboardingAgentConfig?.model ?? ONBOARDING_PRODUCTION_DEFAULT_MODEL.model,
      provider: onboardingAgentConfig?.provider ?? ONBOARDING_PRODUCTION_DEFAULT_MODEL.provider,
    }),
    [onboardingAgentConfig?.model, onboardingAgentConfig?.provider],
  );

  const onboardingFollowUpHooks = useOnboardingFollowUp({
    enabled: !onboardingFinished && !viewingHistoricalTopic,
    isGreeting,
    modelConfig: onboardingFollowUpModelConfig,
    onboardingAgentId,
    phase: data?.context?.phase,
    topicId: effectiveTopicId,
  });

  const composedOnBeforeSendMessage = useOnboardingFirstSend({
    effectiveTopicId,
    mutate,
    onboardingAgentId,
    setSelectedTopicId,
  });

  const syncOnboardingContext = useCallback(async () => {
    const nextContext = await userService.getOnboardingBootstrapState();
    await mutate(nextContext, { revalidate: false });
    if (isDev && onboardingAgentId) await mutateHistoryTopics();

    return nextContext;
  }, [mutate, mutateHistoryTopics, onboardingAgentId]);

  const trackAgentOnboardingCompletion = useCallback(
    (topicId: string | undefined) => {
      trackOnboardingStepCompleted({
        flow: 'agent',
        step: 'conversation',
        stepIndex: 1,
      });
      trackOnboardingCompleted({
        flow: 'agent',
        hasTopic: !!topicId,
        targetUrl:
          // A threaded signup target (if any) wins over the onboarding topic on finish
          peekOnboardingCallbackUrl() ??
          (inboxAgentId && topicId ? AGENT_CHAT_TOPIC_URL(inboxAgentId, topicId) : undefined),
      });
    },
    [inboxAgentId],
  );

  const handleAfterWrapUp = useCallback(async () => {
    const nextContext = await syncOnboardingContext();
    trackAgentOnboardingCompletion(nextContext.topicId ?? effectiveTopicId);
  }, [effectiveTopicId, syncOnboardingContext, trackAgentOnboardingCompletion]);

  const onboardingTurnSettledHook = useMemo<ConversationHooks>(() => {
    if (onboardingFinished || viewingHistoricalTopic) return {};

    return {
      onAssistantTurnSettled: async () => {
        if (!effectiveTopicId) return;

        const prevPhase = data?.context?.phase;
        const prevFinishedAt = agentOnboarding?.finishedAt;

        const nextContext = await syncOnboardingContext();
        const newPhase = nextContext?.context?.phase;
        const newFinishedAt = nextContext?.agentOnboarding?.finishedAt;

        const refreshes: Promise<unknown>[] = [];
        if (newFinishedAt && newFinishedAt !== prevFinishedAt) {
          trackAgentOnboardingCompletion(effectiveTopicId);
        }
        if (newFinishedAt !== prevFinishedAt) refreshes.push(refreshUserState());
        if (newPhase !== prevPhase) {
          refreshes.push(refreshBuiltinAgent(BUILTIN_AGENT_SLUGS.webOnboarding));
        }
        if (refreshes.length > 0) await Promise.all(refreshes);
      },
    };
  }, [
    onboardingFinished,
    viewingHistoricalTopic,
    effectiveTopicId,
    data?.context?.phase,
    agentOnboarding?.finishedAt,
    refreshBuiltinAgent,
    refreshUserState,
    syncOnboardingContext,
    trackAgentOnboardingCompletion,
  ]);

  const conversationHooks = useMemo(() => {
    if (onboardingFinished) return undefined;
    return mergeConversationHooks(
      { onBeforeSendMessage: composedOnBeforeSendMessage },
      onboardingTurnSettledHook,
      onboardingFollowUpHooks,
    );
  }, [
    onboardingFinished,
    composedOnBeforeSendMessage,
    onboardingTurnSettledHook,
    onboardingFollowUpHooks,
  ]);

  return { conversationHooks, handleAfterWrapUp, syncOnboardingContext };
};
