/**
 * URL helpers for "conversation opened inside the home shell".
 *
 * The whole point of this feature is that the **pathname stays home** (`/` or
 * `/:workspaceSlug`) while the conversation is addressed through search params.
 * A pathname of `/agent/...` is what makes `NavPanel` swap the left nav,
 * `RouteTransition` change its key and the home overlay fade out — so recents
 * must never mint one.
 */

export interface HomeConversationTarget {
  agentId?: string;
  groupId?: string;
  topicId?: string;
}

export const HOME_CONVERSATION_AGENT_PARAM = 'agent';
export const HOME_CONVERSATION_GROUP_PARAM = 'group';
export const HOME_CONVERSATION_TOPIC_PARAM = 'topic';

/**
 * Agent sub-routes that are *not* topic ids. `/agent/:aid/:topicId` and
 * `/agent/:aid/task/:id` share a shape, so the second segment has to be
 * excluded explicitly before it is treated as a topic.
 */
const AGENT_RESERVED_SEGMENTS = new Set([
  'channel',
  'docs',
  'profile',
  'stats',
  'task',
  'tasks',
  'topics',
]);

const CHAT_PATH_REGEX = /^\/(agent|group)\/([^/?#]+)(?:\/([^/?#]+))?\/?$/;

/** Search params describing a home-context conversation. */
export const homeConversationSearchParams = ({
  agentId,
  groupId,
  topicId,
}: HomeConversationTarget): URLSearchParams | null => {
  const params = new URLSearchParams();

  if (groupId) params.set(HOME_CONVERSATION_GROUP_PARAM, groupId);
  else if (agentId) params.set(HOME_CONVERSATION_AGENT_PARAM, agentId);
  else return null;

  if (topicId) params.set(HOME_CONVERSATION_TOPIC_PARAM, topicId);

  return params;
};

/**
 * Build the home-context conversation URL for a target.
 *
 * Returned paths are always root-relative (`/?agent=…`); pass them through
 * `WorkspaceLink` / `buildWorkspaceAwarePath` to get the workspace-prefixed
 * form (`/:slug/?agent=…`).
 */
export const homeConversationUrl = (target: HomeConversationTarget): string => {
  const params = homeConversationSearchParams(target);

  return params ? `/?${params.toString()}` : '/';
};

/**
 * Translate a canonical chat path (`/agent/:aid`, `/agent/:aid/:topicId`,
 * `/group/:gid`, `/group/:gid/:topicId`) into a home-context target.
 *
 * Returns `null` when the path is not a chat path, so callers can fall back to
 * the original route (documents, tasks, agent sub-pages, …).
 */
export const homeConversationTargetFromChatPath = (
  routePath: string,
): HomeConversationTarget | null => {
  const match = CHAT_PATH_REGEX.exec(routePath);
  if (!match) return null;

  const [, kind, id, topicId] = match;

  if (kind === 'agent') {
    if (topicId && AGENT_RESERVED_SEGMENTS.has(topicId)) return null;
    return { agentId: id, topicId };
  }

  return { groupId: id, topicId };
};

/**
 * Convenience wrapper returning the root-relative home-context URL for a
 * canonical chat path, or `null` when the path is not a chat path.
 */
export const homeConversationUrlFromChatPath = (routePath: string): string | null => {
  const target = homeConversationTargetFromChatPath(routePath);

  return target ? homeConversationUrl(target) : null;
};
