import { isDesktop } from '@lobechat/const';
import {
  getWorkingDirEffectivePath,
  isTopicApprovalMode,
  type TopicApprovalMode,
} from '@lobechat/types';
import { t } from 'i18next';

import {
  type ChatTopic,
  type ChatTopicSummary,
  type GroupedTopic,
  type TopicGroupMode,
  type TopicSortBy,
} from '@/types/topic';
import {
  getTopicSortTime,
  groupTopicsByProject,
  groupTopicsByStatus,
  groupTopicsByTime,
  groupTopicsByUpdatedTime,
} from '@/utils/client/topic';

import { type ChatStoreState } from '../../initialState';
import { topicMapKey } from '../../utils/topicMapKey';
import { operationSelectors } from '../operation/selectors';
import { type TopicData } from './initialState';

// Helper selector: get current topic data based on session context
const currentTopicData = (s: ChatStoreState): TopicData | undefined => {
  const key = topicMapKey({
    agentId: s.activeAgentId,
    groupId: s.activeGroupId,
  });
  return s.topicDataMap[key];
};

const currentTopics = (s: ChatStoreState): ChatTopic[] | undefined => currentTopicData(s)?.items;

// Get topics without cron-triggered ones
const currentTopicsWithoutCron = (s: ChatStoreState): ChatTopic[] | undefined => {
  const topics = currentTopics(s);
  if (!topics) return undefined;
  return topics.filter((topic) => topic.trigger !== 'cron');
};

const currentActiveTopic = (s: ChatStoreState): ChatTopic | undefined => {
  const fromList = currentTopics(s)?.find((topic) => topic.id === s.activeTopicId);
  if (fromList || !s.activeTopicId) return fromList;
  // Search / deep-link navigation leaves the row outside the paginated bucket.
  return s.topicDetailMap?.[topicDetailKey(s.activeTopicId, activeTopicScope(s))];
};
const searchTopics = (s: ChatStoreState): ChatTopic[] => s.searchTopics;

const displayTopics = (s: ChatStoreState): ChatTopic[] | undefined => currentTopicsWithoutCron(s);

const currentUnFavTopics = (s: ChatStoreState): ChatTopic[] =>
  currentTopicsWithoutCron(s)?.filter((s) => !s.favorite) || [];

const currentTopicLength = (s: ChatStoreState): number => currentTopicsWithoutCron(s)?.length || 0;

const currentTopicCount = (s: ChatStoreState): number => currentTopicData(s)?.total || 0;

/** Scope a topic lookup to an owning agent/group bucket. */
export interface TopicScope {
  agentId?: string;
  groupId?: string;
}

const activeTopicScope = (s: ChatStoreState): TopicScope => ({
  agentId: s.activeAgentId,
  groupId: s.activeGroupId,
});

/** Cache key of a by-id topic row inside `topicDetailMap`. */
export const topicDetailKey = (topicId: string, scope: TopicScope): string =>
  `${topicMapKey(scope)}::${topicId}`;

/**
 * Resolve a topic in a specific bucket: the paginated list first, then the
 * authoritative by-id cache. Search results and deep links routinely land on a
 * topic outside the first page, where the list alone answers `undefined`.
 */
const getTopicByIdInScope =
  (id: string | null | undefined, scope?: TopicScope) =>
  (s: ChatStoreState): ChatTopic | undefined => {
    if (!id) return undefined;
    const container = scope ?? activeTopicScope(s);
    const fromList = s.topicDataMap[topicMapKey(container)]?.items?.find(
      (topic) => topic.id === id,
    );
    return fromList ?? s.topicDetailMap?.[topicDetailKey(id, container)];
  };

const getTopicById =
  (id: string) =>
  (s: ChatStoreState): ChatTopic | undefined =>
    getTopicByIdInScope(id)(s); // Don't filter here, need to access all topics by ID

/**
 * Get topics by specific agentId (for AgentBuilder scenarios where agentId differs from activeAgentId)
 */
const getTopicsByAgentId =
  (agentId: string) =>
  (s: ChatStoreState): ChatTopic[] | undefined => {
    const key = topicMapKey({ agentId });
    return s.topicDataMap[key]?.items;
  };

const currentActiveTopicSummary = (s: ChatStoreState): ChatTopicSummary | undefined => {
  const activeTopic = currentActiveTopic(s);
  if (!activeTopic) return undefined;

  return {
    content: activeTopic.historySummary || '',
    model: activeTopic.metadata?.model || '',
    provider: activeTopic.metadata?.provider || '',
  };
};

const currentTopicMetadata = (s: ChatStoreState) => currentActiveTopic(s)?.metadata;

/**
 * Per-conversation tool-approval snapshot of the active topic, when it has one.
 * Legacy topics (and topics created before the feature landed) return
 * `undefined` and fall through to the user preference.
 */
const currentTopicApprovalMode = (s: ChatStoreState): TopicApprovalMode | undefined =>
  getTopicApprovalMode(s.activeTopicId)(s);

/**
 * Same as `currentTopicApprovalMode`, for an explicit topic id (and optionally
 * an explicit owning scope — an agent-run transport knows its own context and
 * must not be resolved against whatever bucket is active by then).
 */
const getTopicApprovalMode =
  (id?: string | null, scope?: TopicScope) =>
  (s: ChatStoreState): TopicApprovalMode | undefined => {
    if (!id) return undefined;
    const mode = getTopicByIdInScope(id, scope)(s)?.metadata?.approvalMode;
    return isTopicApprovalMode(mode) ? mode : undefined;
  };

/**
 * Get current active topic's working directory.
 * On desktop: local filesystem path.
 * On web (cloud): primary GitHub repo URL (repos[0]), or workingDirectory if set directly.
 */
const extractTopicWorkingDirectory = (topic: ChatTopic | undefined): string | undefined => {
  if (!topic) return;

  if (isDesktop) {
    return (
      getWorkingDirEffectivePath(topic.metadata?.workingDirectoryConfig) ??
      topic.metadata?.workingDirectory
    );
  }

  // Web: return primary repo from repos list, or workingDirectory if set directly
  const meta = topic.metadata;
  return (
    meta?.repos?.[0] ??
    getWorkingDirEffectivePath(meta?.workingDirectoryConfig) ??
    meta?.workingDirectory
  );
};

const getTopicWorkingDirectory =
  (id?: string | null) =>
  (s: ChatStoreState): string | undefined =>
    extractTopicWorkingDirectory(id ? getTopicById(id)(s) : currentActiveTopic(s));

const currentTopicWorkingDirectory = (s: ChatStoreState): string | undefined =>
  extractTopicWorkingDirectory(currentActiveTopic(s));

const isCreatingTopic = (s: ChatStoreState) => s.creatingTopic;

/**
 * Whether a send from the new-topic view is still in flight — no active topic
 * yet, while the running send owns creation of the real topic (the `_new`
 * context only holds optimistic tmp_* messages until then). While true,
 * `openNewTopicOrSaveTopic` is a no-op, so its entry buttons should be
 * disabled to make the blocked window visible instead of silently ignoring
 * the click.
 */
const isNewTopicSendInFlight = (s: ChatStoreState): boolean =>
  !s.activeTopicId &&
  operationSelectors.isInputLoadingByContext({
    agentId: s.activeAgentId,
    groupId: s.activeGroupId,
    threadId: s.activeThreadId,
    topicId: s.activeTopicId,
  })(s);
const isUndefinedTopics = (s: ChatStoreState) => !currentTopics(s);
const isInSearchMode = (s: ChatStoreState) => s.inSearchingMode;
const isSearchingTopic = (s: ChatStoreState) => s.isSearchingTopic;

const sortTopics = (topics: ChatTopic[], sortBy: TopicSortBy): ChatTopic[] => {
  const field = sortBy === 'createdAt' ? 'createdAt' : 'updatedAt';
  return [...topics].sort((a, b) => getTopicSortTime(b, field) - getTopicSortTime(a, field));
};

// Limit topics for sidebar display based on user's page size preference
const displayTopicsForSidebar =
  (pageSize: number, sortBy: TopicSortBy = 'updatedAt') =>
  (s: ChatStoreState): ChatTopic[] | undefined => {
    const topics = currentTopicsWithoutCron(s);
    if (!topics) return undefined;

    // Favorites first, then sorted by the chosen timestamp, then page-sliced
    const favTopics = topics.filter((t) => t.favorite);
    const rest = topics.filter((t) => !t.favorite);
    return [...sortTopics(favTopics, sortBy), ...sortTopics(rest, sortBy)].slice(0, pageSize);
  };

const getGroupFn = (
  groupMode: TopicGroupMode,
  sortBy: TopicSortBy,
  loadingTopicIds?: ReadonlySet<string>,
) => {
  const field: 'createdAt' | 'updatedAt' = sortBy === 'createdAt' ? 'createdAt' : 'updatedAt';
  if (groupMode === 'byProject') {
    return (topics: ChatTopic[]) =>
      groupTopicsByProject(topics, field).map((group) =>
        group.id === 'no-project'
          ? { ...group, title: t('groupTitle.byProject.noProject', { ns: 'topic' }) }
          : group,
      );
  }
  if (groupMode === 'byStatus') {
    return (topics: ChatTopic[]) =>
      groupTopicsByStatus(topics, field, loadingTopicIds).map((group) => ({
        ...group,
        title: t(`groupTitle.byStatus.${group.id}` as any, { ns: 'topic' }),
      }));
  }
  return sortBy === 'updatedAt' ? groupTopicsByUpdatedTime : groupTopicsByTime;
};

/**
 * Build grouped topics from a topic list, splitting favorites into a separate group
 */
const buildGroupedTopics = (
  topics: ChatTopic[],
  groupFn: (topics: ChatTopic[]) => GroupedTopic[],
): GroupedTopic[] => {
  const favTopics = topics.filter((topic) => topic.favorite);
  const unfavTopics = topics.filter((topic) => !topic.favorite);

  // Favorites stay pinned at the very top. The "needs attention" bucket
  // (byStatus mode only) follows right below, ahead of the remaining status
  // groups, since groupTopicsByStatus emits `pending` first (STATUS_GROUP_ORDER).
  return favTopics.length > 0
    ? [
        {
          children: favTopics,
          id: 'favorite',
          title: t('favorite', { ns: 'topic' }),
        },
        ...groupFn(unfavTopics),
      ]
    : groupFn(topics);
};

const groupedTopicsSelector =
  (groupFn: typeof groupTopicsByTime = groupTopicsByTime) =>
  (s: ChatStoreState): GroupedTopic[] => {
    const topics = displayTopics(s);
    if (!topics) return [];
    return buildGroupedTopics(topics, groupFn);
  };

const groupedTopicsForSidebar =
  (pageSize: number, sortBy: TopicSortBy = 'updatedAt', groupMode: TopicGroupMode = 'byTime') =>
  (s: ChatStoreState): GroupedTopic[] => {
    const limitedTopics = displayTopicsForSidebar(pageSize, sortBy)(s);
    if (!limitedTopics) return [];
    // Topics actively streaming on this client surface under "running" even
    // though their persisted status says otherwise — that's the one client-only
    // overlay (see resolveStatusBucket). Unread is now a persisted status, so it
    // buckets straight from `topic.status`.
    const loadingTopicIds = groupMode === 'byStatus' ? new Set(s.topicLoadingIds) : undefined;
    return buildGroupedTopics(limitedTopics, getGroupFn(groupMode, sortBy, loadingTopicIds));
  };

const hasMoreTopics = (s: ChatStoreState): boolean => {
  const topicData = currentTopicData(s);
  if (!topicData) return false;

  return topicData.hasMore;
};

const hasMoreTopicsForSidebar = (s: ChatStoreState): boolean => {
  const topicData = currentTopicData(s);
  if (!topicData) return false;

  return topicData.hasMore || topicData.total > topicData.pageSize;
};

const isLoadingMoreTopics = (s: ChatStoreState): boolean =>
  currentTopicData(s)?.isLoadingMore ?? false;

const loadMoreTopicsError = (s: ChatStoreState): unknown => currentTopicData(s)?.loadMoreError;

const isExpandingPageSize = (s: ChatStoreState): boolean =>
  currentTopicData(s)?.isExpandingPageSize ?? false;

// Selectors for the Agent Topics management page's dedicated bucket.
// Always agent-scoped (no group), keyed by `agentId` via `topicMapKey`.
const agentTopicsViewData = (s: ChatStoreState): TopicData | undefined => {
  if (!s.activeAgentId) return undefined;
  return s.agentTopicsViewMap[topicMapKey({ agentId: s.activeAgentId })];
};

const agentTopicsViewTopics = (s: ChatStoreState): ChatTopic[] =>
  agentTopicsViewData(s)?.items ?? [];

const agentTopicsViewHasMore = (s: ChatStoreState): boolean =>
  agentTopicsViewData(s)?.hasMore ?? false;

const agentTopicsViewIsLoadingMore = (s: ChatStoreState): boolean =>
  agentTopicsViewData(s)?.isLoadingMore ?? false;

const agentTopicsViewLoadMoreError = (s: ChatStoreState): unknown =>
  agentTopicsViewData(s)?.loadMoreError;

export const topicSelectors = {
  agentTopicsViewHasMore,
  agentTopicsViewIsLoadingMore,
  agentTopicsViewLoadMoreError,
  agentTopicsViewTopics,
  currentActiveTopic,
  currentActiveTopicSummary,
  currentTopicApprovalMode,
  currentTopicCount,
  currentTopicData,
  currentTopicLength,
  currentTopicMetadata,
  currentTopicWorkingDirectory,
  currentTopics,
  currentTopicsWithoutCron,
  currentUnFavTopics,
  displayTopics,
  displayTopicsForSidebar,
  getTopicApprovalMode,
  getTopicById,
  getTopicByIdInScope,
  getTopicWorkingDirectory,
  getTopicsByAgentId,
  groupedTopicsForSidebar,
  groupedTopicsSelector,
  hasMoreTopics,
  hasMoreTopicsForSidebar,
  isCreatingTopic,
  isExpandingPageSize,
  isInSearchMode,
  isLoadingMoreTopics,
  isNewTopicSendInFlight,
  isSearchingTopic,
  isUndefinedTopics,
  loadMoreTopicsError,
  searchTopics,
};
