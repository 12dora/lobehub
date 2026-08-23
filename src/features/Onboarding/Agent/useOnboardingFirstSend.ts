import type { SendMessageParams } from '@lobechat/types';
import { RequestTrigger } from '@lobechat/types';
import { useCallback, useRef } from 'react';

import { userService } from '@/services/user';
import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import type { useAgentOnboardingSession } from './useAgentOnboardingSession';

type Params = Pick<
  ReturnType<typeof useAgentOnboardingSession>,
  'effectiveTopicId' | 'mutate' | 'onboardingAgentId' | 'setSelectedTopicId'
>;

/**
 * `onBeforeSendMessage` for the onboarding chat. A fresh user has no topic yet, so the
 * first send is orchestrated here (server creates the topic + seed messages) and the
 * wrapping sendMessage path is blocked; every later send takes the normal path.
 */
export const useOnboardingFirstSend = ({
  effectiveTopicId,
  mutate,
  onboardingAgentId,
  setSelectedTopicId,
}: Params) => {
  // Re-entry latch for the fresh-state first-send orchestration. The combination
  // of advisory lock + this ref ensures rapid double-submit cannot create two
  // user messages: the second invocation awaits the same in-flight promise
  // instead of dispatching its own sendMessage. See spec Revision 3.
  const firstSendInFlightRef = useRef<Promise<void> | null>(null);

  return useCallback(
    async (params: SendMessageParams): Promise<boolean> => {
      params.metadata = { ...params.metadata, trigger: RequestTrigger.Onboarding };

      if (!onboardingAgentId) {
        // ChatInput is gated by `isInputReady`; this branch should be unreachable.
        return false;
      }

      // Returning / edge: topic exists — let the normal sendMessage path proceed.
      if (effectiveTopicId) return true;

      // Fresh: orchestrate first-send ourselves and block the wrapping path.
      if (firstSendInFlightRef.current) {
        await firstSendInFlightRef.current;
        return false;
      }

      const orchestration = (async () => {
        try {
          const { topicId: serverTopicId, messages } = await userService.sendOnboardingFirstMessage(
            {
              agentId: onboardingAgentId,
            },
          );

          const key = messageMapKey({ agentId: onboardingAgentId, topicId: serverTopicId });
          useChatStore.setState((state) => ({
            dbMessagesMap: { ...state.dbMessagesMap, [key]: messages },
          }));

          // Update the page's own topic pointer + the SWR cache so subsequent
          // renders route through the returning / edge branch.
          setSelectedTopicId(serverTopicId);
          await mutate(
            (prev) => (prev ? { ...prev, hasMessages: true, topicId: serverTopicId } : prev),
            { revalidate: false },
          );

          // Dispatch the real send directly into useChatStore.sendMessage with an
          // EXPLICIT context, bypassing the conversation-store wrapper whose
          // context still points at the (now-stale) undefined topicId. This avoids
          // accidentally entering sendMessageInServer's new-topic creation branch.
          await useChatStore.getState().sendMessage({
            ...params,
            context: { agentId: onboardingAgentId, topicId: serverTopicId },
            messages,
          });
        } finally {
          firstSendInFlightRef.current = null;
        }
      })();

      firstSendInFlightRef.current = orchestration;
      await orchestration;
      return false;
    },
    [effectiveTopicId, mutate, onboardingAgentId, setSelectedTopicId],
  );
};
