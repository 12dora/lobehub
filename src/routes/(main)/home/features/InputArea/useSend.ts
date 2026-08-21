import { useCallback } from 'react';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import type { SendButtonHandler } from '@/features/ChatInput/store/initialState';
import { buildMessageContextSelections } from '@/features/ChatInput/utils/contextSelections';
import { homeConversationUrl } from '@/features/HomeConversation/homeConversationPath';
import { useHomeDailyBrief } from '@/hooks/useHomeDailyBrief';
import { useQueryRoute } from '@/hooks/useQueryRoute';
import { agentService } from '@/services/agent';
import { useAgentStore } from '@/store/agent';
import { useChatStore } from '@/store/chat';
import { fileChatSelectors, useFileStore } from '@/store/file';
import { useHomeStore } from '@/store/home';

import { useResolvedHomeAgentId } from '../AgentSelect/useResolvedHomeAgentId';

/**
 * Trim trailing ellipsis the LLM uses on hint placeholders so the sent
 * message doesn't carry the cosmetic suffix.
 */
const stripHintEllipsis = (hint: string): string => hint.replace(/\s*(?:\.{3,}|…)\s*$/, '').trim();

/**
 * Make sure the agent's config is hydrated into `agentMap` before we call
 * `sendMessage`. Without this, sending to an agent the user just picked from
 * the home AgentSelect (and never opened in this session) silently fails:
 * `sendMessage` reaches `getAgentConfigById(agentId)` which returns `undefined`
 * from `agentMap`, the `{ model, provider }` destructure throws, and the
 * surrounding catch swallows it — so the chat page mounts with optimistic
 * messages but the runtime never starts.
 */
const ensureAgentConfigLoaded = async (agentId: string): Promise<void> => {
  const agentState = useAgentStore.getState();
  if (agentState.agentMap[agentId]) return;
  const config = await agentService.getAgentConfigById(agentId);
  if (config) agentState.internal_dispatchAgentMap(agentId, config);
};

export const useSend = () => {
  const router = useQueryRoute();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const sendMessage = useChatStore((s) => s.sendMessage);
  const clearChatUploadFileList = useFileStore((s) => s.clearChatUploadFileList);
  const clearChatContextSelections = useFileStore((s) => s.clearChatContextSelections);

  const homeInputLoading = useHomeStore((s) => s.homeInputLoading);

  // Resolve the agent that the home input is currently bound to. Defaults to the
  // inbox agent; AgentSelect can override via systemStatus.homeSelectedAgentId.
  // The hook also rewrites stale ids (e.g. left over from a different account
  // on the same browser) back to inbox so we don't try to send to a missing id.
  const { agentId: activeAgentId } = useResolvedHomeAgentId();

  // Daily-brief hint paired with the home WelcomeText. Pressing Enter on an
  // empty input "accepts" the hint as the message — like a smart-compose
  // suggestion — and rotates to the next pair.
  const { currentPair, advance } = useHomeDailyBrief();

  const send = useCallback<SendButtonHandler>(
    async ({ getEditorData, getMarkdownContent }) => {
      const { inputMessage, mainInputEditor } = useChatStore.getState();
      // Prefer the live editor content over the cached `inputMessage`.
      // `onMarkdownContentChange` is wired through the editor's async
      // `onChange`, so a fast type-then-Enter sequence can fire before the
      // cache catches up and the empty-message guard would bail incorrectly.
      const typed = (getMarkdownContent?.() ?? inputMessage ?? '').trim();
      const fileList = fileChatSelectors.chatUploadFileList(useFileStore.getState());
      const contextList = fileChatSelectors.chatContextSelections(useFileStore.getState());
      const { sendAsAgent, sendAsGroup, sendAsWrite, sendAsResearch, inputActiveMode } =
        useHomeStore.getState();

      // If the user pressed Enter on an empty input, fall back to the
      // currently displayed daily-brief hint (with cosmetic ellipsis stripped)
      // and rotate the carousel so the next press shows / sends a different
      // pair.
      const hint = currentPair?.hint ? stripHintEllipsis(currentPair.hint) : '';
      const usedHint = !typed && !!hint;
      const message = typed || hint;
      if (usedHint) advance();

      // When falling back to the hint, the editor is empty — but its JSON
      // state still contains root nodes (e.g. `{ type: 'doc' }`), which is
      // truthy under `Object.keys(editorData).length > 0`. That makes the
      // user-message renderer take the RichTextMessage branch and draw
      // nothing, so the chat shows a blank user bubble while the agent
      // happily processes the hint text. Skip editorData in that case so
      // the renderer falls back to the markdown `content`.
      const editorData = usedHint
        ? undefined
        : (getEditorData?.() ?? mainInputEditor?.getJSONState());

      // Require input content (except for default inbox which can have files/context)
      if (!message && fileList.length === 0 && contextList.length === 0) return;

      try {
        const { contextSelections, pageSelections } = buildMessageContextSelections(contextList);

        switch (inputActiveMode) {
          case 'agent': {
            await sendAsAgent({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            break;
          }

          case 'group': {
            await sendAsGroup({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            break;
          }

          case 'write': {
            await sendAsWrite({
              contextSelections,
              editorData,
              message,
              pageSelections,
              workspaceSlug: activeWorkspaceSlug,
            });
            break;
          }

          case 'research': {
            await sendAsResearch(message);
            break;
          }

          default: {
            // Default behavior: send to currently selected agent (inbox by default,
            // overridable via the home AgentSelect dropdown).
            if (!activeAgentId) return;

            // First-time selections from AgentSelect have no entry in `agentMap`
            // yet — block on the fetch so sendMessage finds a real config below.
            await ensureAgentConfigLoaded(activeAgentId);

            // Claim the conversation identity BEFORE the surface can mount.
            // `useAgentContext` reads `activeAgentId` from the **chat** store,
            // while the landing's `HomeAgentIdSync` only owns the agent store —
            // so on a warm chunk the right column's first render would build
            // `main_undefined_new`, paint an avatar skeleton, and then remount
            // the whole ConversationProvider once hydration's layout effect
            // corrected the id. `activeTopicId` / `activeThreadId` are cleared
            // for the same reason: a leftover id from the previously open
            // conversation would key the first render onto the wrong bucket.
            useChatStore.setState(
              { activeAgentId, activeThreadId: undefined, activeTopicId: undefined },
              false,
              'HomeSend/seedConversation',
            );
            if (useAgentStore.getState().activeAgentId !== activeAgentId)
              useAgentStore.setState({ activeAgentId }, false, 'HomeSend/seedConversation');

            // Resolved by `onOptimisticReady`, i.e. once the optimistic user +
            // assistant messages are in `dbMessagesMap['main_<id>_new']`.
            let markOptimisticReady: () => void = () => {};
            const optimisticReady = new Promise<void>((resolve) => {
              markOptimisticReady = () => resolve();
            });

            const sending = Promise.resolve(
              sendMessage({
                context: {
                  agentId: activeAgentId,
                  isolatedTopic: true,
                  ...(activeWorkspaceSlug ? { workspaceSlug: activeWorkspaceSlug } : {}),
                },
                contextSelections,
                contexts: contextList,
                editorData,
                files: fileList,
                message,
                onOptimisticReady: () => markOptimisticReady(),
                onTopicCreated: (topicId) => {
                  // Same in-place contract, now addressing the created topic. The
                  // pathname is still home, so this only swaps search params.
                  router.replace(homeConversationUrl({ agentId: activeAgentId, topicId }), {
                    replace: true,
                  });
                },
                pageSelections,
                // The home conversation *is* this agent's main topic list, so the
                // created topic has to land in `topicDataMap` — otherwise the
                // header stays on "New topic" after the `?topic=` swap.
                registerCreatedTopic: true,
              }),
            ).catch((error) => {
              console.error('[HomeSend] sendMessage failed', error);
            });

            // Swap the column only once there is something to render. Racing the
            // send promise keeps the early-return paths (queued send, empty
            // message) from hanging the navigation, and never waits for the
            // persist / topic creation — `onTopicCreated` still arrives later and
            // only rewrites the search params.
            await Promise.race([optimisticReady, sending]);

            // Stay on the home pathname and open the conversation in place
            // (`/?agent=<id>`, the same URL shape the Recents rows use). Pushing a
            // `/agent/...` path here would swap the left nav away from home.
            //
            // `replace: true` is a `useQueryRoute` option meaning "don't merge the
            // current search params into the target" — without it a leftover
            // `?agent=…&topic=…` from a previous conversation would win over the
            // params we just built. History semantics stay `push` (Back returns to
            // the bare home URL).
            router.push(homeConversationUrl({ agentId: activeAgentId }), { replace: true });
          }
        }
      } finally {
        // Clear input and files after send
        clearChatUploadFileList();
        clearChatContextSelections();
        mainInputEditor?.clearContent();
      }
    },
    [
      activeAgentId,
      activeWorkspaceSlug,
      sendMessage,
      clearChatContextSelections,
      clearChatUploadFileList,
      router,
      currentPair,
      advance,
    ],
  );

  return {
    agentId: activeAgentId,
    loading: homeInputLoading,
    send,
  };
};
