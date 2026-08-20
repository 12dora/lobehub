import { taskDetailPath } from '@/features/AgentTasks/shared/taskDetailPath';
import { homeConversationUrlFromChatPath } from '@/features/HomeConversation/homeConversationPath';
import { type RecentItem } from '@/server/routers/lambda/recent';

/**
 * Click target for a recents row.
 *
 * Topics open **in place**: the server mints a canonical deep link
 * (`/agent/:aid/:topicId` / `/group/:gid/:topicId`) which every other consumer
 * still wants, but from the home sidebar that first path segment is exactly
 * what swaps the left nav to the agent sidebar. The override happens at the
 * click site so `routePath` stays canonical everywhere else.
 *
 * Documents keep `/page/:id` and tasks keep `taskDetailPath` — both are
 * different product surfaces with their own nav.
 */
export const getRecentRoute = (item: RecentItem): string => {
  if (item.type === 'task') {
    const taskId = item.id;
    if (!taskId) return item.routePath;

    return taskDetailPath(taskId, item.agentId ?? undefined);
  }

  if (item.type === 'topic')
    return homeConversationUrlFromChatPath(item.routePath) ?? item.routePath;

  return item.routePath;
};
