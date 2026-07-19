import { INBOX_SESSION_ID } from '@lobechat/const';
import type { AgentItem, LobeAgentConfig } from '@lobechat/types';
import type { SWRResponse } from 'swr';
import type { PartialDeep } from 'type-fest';

import { useOnlyFetchOnceSWR } from '@/libs/swr';
import { builtinAgentKeys } from '@/libs/swr/keys';
import { getCacheScope, useCacheScope } from '@/libs/swr/useCacheScope';
import { agentService } from '@/services/agent';
import type { StoreSetter } from '@/store/types';
import { getUserStoreState } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

import type { AgentStore } from '../../store';

interface UseInitBuiltinAgentContext {
  /** Published branding revision; only participates in the inbox cache key. */
  brandingRevision?: string | null;
  /**
   * Whether the user is logged in.
   * When false or undefined, the hook will not fetch the agent.
   */
  isLogin?: boolean;
}

/**
 * Builtin Agent Slice Actions
 * Handles initialization and management of builtin agents (page-agent, inbox, etc.)
 */

type Setter = StoreSetter<AgentStore>;
export const createBuiltinAgentSlice = (set: Setter, get: () => AgentStore, _api?: unknown) =>
  new BuiltinAgentSliceActionImpl(set, get, _api);

export class BuiltinAgentSliceActionImpl {
  readonly #get: () => AgentStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => AgentStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  #isCurrentInboxScope = (scope: string): boolean =>
    getCacheScope() === scope && authSelectors.isLogin(getUserStoreState()) === true;

  #setScopedInboxProjection = (data: AgentItem, scope: string): void => {
    this.#set(
      (state) => ({
        agentMap: {
          ...state.agentMap,
          [data.id]: data as PartialDeep<LobeAgentConfig>,
        },
        builtinAgentIdMap: { ...state.builtinAgentIdMap, [INBOX_SESSION_ID]: data.id },
        inboxProjectionScope: scope,
      }),
      false,
      'setScopedInboxProjection',
    );
  };

  refreshBuiltinAgent = async (slug: string): Promise<void> => {
    const inboxRequestScope = slug === INBOX_SESSION_ID ? getCacheScope() : undefined;
    const data = await agentService.getBuiltinAgent(slug);
    if (data?.id) {
      if (inboxRequestScope) {
        if (!this.#isCurrentInboxScope(inboxRequestScope)) return;
        this.#setScopedInboxProjection(data as AgentItem, inboxRequestScope);
        return;
      }

      this.#get().internal_dispatchAgentMap(data.id, data as PartialDeep<LobeAgentConfig>);
      // Mirror useInitBuiltinAgent's onSuccess: keep builtinAgentIdMap in sync
      // so callers can rely on this as a real "ensure" path instead of just a
      // post-init refresh.
      this.#set(
        { builtinAgentIdMap: { ...this.#get().builtinAgentIdMap, [slug]: data.id } },
        false,
        `refreshBuiltinAgent/${slug}`,
      );
    }
  };

  /**
   * Atomically hide a previously loaded Inbox before the next identity/workspace paints.
   * Non-Inbox projections are intentionally untouched.
   */
  syncInboxProjectionScope = (scope: string, isLogin: boolean): void => {
    const current = this.#get();
    if (isLogin && current.inboxProjectionScope === scope) return;

    const inboxAgentId = current.builtinAgentIdMap[INBOX_SESSION_ID];
    if (!inboxAgentId && current.inboxProjectionScope === undefined) return;

    this.#set(
      (state) => {
        const agentMap = { ...state.agentMap };
        const builtinAgentIdMap = { ...state.builtinAgentIdMap };
        const currentInboxAgentId = builtinAgentIdMap[INBOX_SESSION_ID];

        delete builtinAgentIdMap[INBOX_SESSION_ID];
        if (currentInboxAgentId) delete agentMap[currentInboxAgentId];

        return {
          agentMap,
          builtinAgentIdMap,
          inboxProjectionScope: undefined,
        };
      },
      false,
      'syncInboxProjectionScope/invalidate',
    );
  };

  useInitBuiltinAgent = (
    slug: string,
    context?: UseInitBuiltinAgentContext,
  ): SWRResponse<AgentItem | null> => {
    const cacheScope = useCacheScope();
    const cacheKey = builtinAgentKeys.init(
      slug,
      slug === INBOX_SESSION_ID ? (context?.brandingRevision ?? null) : undefined,
      slug === INBOX_SESSION_ID ? cacheScope : undefined,
    );

    return useOnlyFetchOnceSWR(
      context?.isLogin === false ? null : cacheKey,
      async () => {
        const data = await agentService.getBuiltinAgent(slug);

        return data as AgentItem | null;
      },
      {
        onSuccess: (data: AgentItem | null) => {
          if (data?.id) {
            if (slug === INBOX_SESSION_ID) {
              if (!this.#isCurrentInboxScope(cacheScope)) return;
              this.#setScopedInboxProjection(data, cacheScope);
              return;
            }

            // Update builtinAgentIdMap with the agent id
            // Update agentMap with the agent config
            // AgentItem contains all fields needed for LobeAgentConfig
            this.#get().internal_dispatchAgentMap(data.id, data as PartialDeep<LobeAgentConfig>);

            this.#set(
              { builtinAgentIdMap: { ...this.#get().builtinAgentIdMap, [slug]: data.id } },
              false,
              `useInitBuiltinAgent/${slug}`,
            );
          }
        },
      },
    );
  };
}

export type BuiltinAgentSliceAction = Pick<
  BuiltinAgentSliceActionImpl,
  keyof BuiltinAgentSliceActionImpl
>;
